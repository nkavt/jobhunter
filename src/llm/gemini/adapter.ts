import {
  FinishReason,
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Model,
  type Part,
} from '@google/genai';
import { PROVIDER_NAMES } from '../describe.js';
import { LLMError } from '../errors.js';
import { asObjectSchema, generateValidated, parseJson, toJsonSchema } from '../structured.js';
import type {
  FileInput,
  JsonRequest,
  JsonResult,
  LLMAdapter,
  ModelInfo,
  SearchRequest,
  SearchResult,
  Source,
  TextRequest,
  TextResult,
  Usage,
} from '../types.js';
import { addUsage } from '../usage.js';
import { mapGeminiError, type ErrorContext } from './errors.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_MAX_TOKENS = 4096;
/**
 * Gemini's thinking tokens count against `maxOutputTokens`. They're added on top of the
 * answer's limit so thinking can't crowd out the answer; only tokens actually used are billed.
 */
const THINKING_ALLOWANCE = 16_384;

/** Gemini models that aren't for text chat: image/video/audio generation, … */
const NON_CHAT_MODEL = /image|imagen|veo|tts|audio|live|robotics|computer-use|aqa/i;

export interface GeminiAdapterOptions {
  apiKey: string;
  model?: string;
  /** Retries on connection errors, 408/429 and 5xx. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Only for tests; real use always goes to Google's endpoint. */
  baseURL?: string;
}

export class GeminiAdapter implements LLMAdapter {
  readonly provider = 'gemini' as const;
  readonly providerName = PROVIDER_NAMES.gemini;
  readonly model: string;
  private readonly client: GoogleGenAI;

  constructor(options: GeminiAdapterOptions) {
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    // Everything is passed explicitly so GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_USE_VERTEXAI /
    // GOOGLE_GEMINI_BASE_URL in the environment are never picked up: the key lives in config.json only.
    const maxRetries = options.maxRetries ?? 2;
    this.client = new GoogleGenAI({
      vertexai: false,
      apiKey: options.apiKey,
      httpOptions: {
        baseUrl: options.baseURL ?? GEMINI_BASE_URL,
        timeout: options.timeoutMs ?? 120_000,
        ...(maxRetries > 0 ? { retryOptions: { attempts: maxRetries + 1 } } : {}),
      },
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    try {
      const pager = await this.client.models.list({ config: { pageSize: 100 } });
      for await (const model of pager) {
        const info = toModelInfo(model);
        if (info) models.push(info);
      }
    } catch (error) {
      throw mapGeminiError(error);
    }
    // Newest version first: Google doesn't send creation dates.
    return models.sort((a, b) => versionOf(b.id) - versionOf(a.id) || a.id.localeCompare(b.id));
  }

  async validateKey(): Promise<void> {
    try {
      await this.client.models.list({ config: { pageSize: 1 } });
    } catch (error) {
      throw mapGeminiError(error);
    }
  }

  async checkModelAccess(model = this.model): Promise<void> {
    await this.send(
      { model, contents: 'Hi', config: { maxOutputTokens: THINKING_ALLOWANCE } },
      { model },
    );
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const response = await this.send(
      { model: this.model, contents: [userContent(request)], config: this.baseConfig(request) },
      { model: this.model },
    );
    this.assertComplete(response, request);
    return { text: response.text ?? '', usage: usageOf(response) };
  }

  async generateJSON<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    const { schema, unwrap } = asObjectSchema(toJsonSchema(request.schema));
    const config: GenerateContentConfig = {
      ...this.baseConfig(request),
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    };
    const contents: Content[] = [userContent(request)];

    return generateValidated(this.provider, request.schema, async (feedback) => {
      if (feedback !== undefined) contents.push({ role: 'user', parts: [{ text: feedback }] });
      const response = await this.send(
        { model: this.model, contents, config },
        { model: this.model },
      );
      this.assertComplete(response, request);
      const text = response.text ?? '';
      contents.push({ role: 'model', parts: [{ text }] });
      return { value: unwrap(parseJson(text)), usage: usageOf(response) };
    });
  }

  /**
   * Two steps, like the Claude adapter: research grounded in Google Search (free-form notes
   * + sources), then turn the notes into structured output.
   */
  async searchJSON<T>(request: SearchRequest<T>): Promise<SearchResult<T>> {
    const response = await this.send(
      {
        model: this.model,
        contents: [
          userContent({
            ...request,
            prompt: `${request.prompt}\n\nUse Google Search. Include the source URL for every item you mention.`,
          }),
        ],
        config: { ...this.baseConfig(request), tools: [{ googleSearch: {} }] },
      },
      { model: this.model, webSearch: true },
    );
    this.assertComplete(response, request);

    const research = (response.text ?? '').trim();
    if (!research) {
      throw new LLMError('Web search finished without any findings.', this.provider);
    }

    const structured = await this.generateJSON({
      ...request,
      prompt: `${request.prompt}\n\nBase your answer only on these research notes:\n<research_notes>\n${research}\n</research_notes>`,
    });

    return {
      data: structured.data,
      usage: addUsage(usageOf(response), structured.usage),
      sources: sourcesOf(response),
    };
  }

  private baseConfig(request: TextRequest): GenerateContentConfig {
    // Gemini caches repeated prompt prefixes on its own, so `cacheSystem` needs nothing here.
    return {
      maxOutputTokens: (request.maxTokens ?? DEFAULT_MAX_TOKENS) + THINKING_ALLOWANCE,
      ...(request.system !== undefined ? { systemInstruction: request.system } : {}),
    };
  }

  private assertComplete(response: GenerateContentResponse, request: TextRequest): void {
    const candidate = response.candidates?.[0];
    const reason = candidate?.finishReason;
    if (reason === FinishReason.MAX_TOKENS) {
      throw new LLMError(
        `The response was cut off at ${String(request.maxTokens ?? DEFAULT_MAX_TOKENS)} tokens. Try a larger limit.`,
        this.provider,
      );
    }
    const blocked = response.promptFeedback?.blockReason;
    if (blocked !== undefined || (reason !== undefined && reason !== FinishReason.STOP)) {
      throw new LLMError(
        `Gemini stopped without an answer (${String(blocked ?? reason)}).`,
        this.provider,
      );
    }
  }

  private async send(
    params: Parameters<GoogleGenAI['models']['generateContent']>[0],
    context: ErrorContext,
  ): Promise<GenerateContentResponse> {
    try {
      return await this.client.models.generateContent(params);
    } catch (error) {
      throw mapGeminiError(error, context);
    }
  }
}

function userContent(request: TextRequest): Content {
  return {
    role: 'user',
    parts: [...(request.files ?? []).map(filePart), { text: request.prompt }],
  };
}

const INLINE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function filePart(file: FileInput): Part {
  if (file.mimeType === 'text/plain') return { text: Buffer.from(file.data).toString('utf8') };
  if (!INLINE_TYPES.includes(file.mimeType)) {
    throw new LLMError(`Gemini can't read files of type ${file.mimeType}.`, 'gemini');
  }
  return {
    inlineData: { mimeType: file.mimeType, data: Buffer.from(file.data).toString('base64') },
  };
}

/** One entry of the model list; `undefined` hides it from the picker. */
function toModelInfo(model: Model): ModelInfo | undefined {
  // The list names models `models/gemini-…`; requests take the bare id.
  const id = model.name?.replace(/^models\//, '');
  if (!id?.startsWith('gemini-') || NON_CHAT_MODEL.test(id)) return undefined;
  if (model.supportedActions && !model.supportedActions.includes('generateContent')) {
    return undefined;
  }
  const family = familyOf(id);
  return { id, displayName: model.displayName ?? id, ...(family ? { family } : {}) };
}

/** `gemini-3.8-flash` → 3.8; 0 when there's no version. */
function versionOf(id: string): number {
  return Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
}

function familyOf(id: string): string | undefined {
  if (id.includes('flash-lite')) return 'flash-lite';
  if (id.includes('flash')) return 'flash';
  if (id.includes('pro')) return 'pro';
  return undefined;
}

function sourcesOf(response: GenerateContentResponse): Source[] {
  const sources = new Map<string, Source>();
  for (const chunk of response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    if (!url || sources.has(url)) continue;
    const title = chunk.web?.title;
    sources.set(url, title ? { url, title } : { url });
  }
  return [...sources.values()];
}

/** Thinking tokens are billed as output. `promptTokenCount` includes cached tokens. */
function usageOf(response: GenerateContentResponse): Usage {
  const usage = response.usageMetadata;
  const cached = usage?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: (usage?.promptTokenCount ?? 0) - cached,
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    webSearches: response.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length ?? 0,
  };
}
