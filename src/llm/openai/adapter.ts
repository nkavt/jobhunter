import OpenAI from 'openai';
import { getProviderName } from '../describe.js';
import { LLMError, WebSearchUnavailableError } from '../errors.js';
import { asObjectSchema, generateValidated, parseJson, toJsonSchema } from '../structured.js';
import type {
  FileInput,
  JsonRequest,
  JsonResult,
  LLMAdapter,
  ModelInfo,
  SearchResult,
  TextRequest,
  TextResult,
  Usage,
} from '../types.js';
import { mapOpenAIError, type ErrorContext } from './errors.js';

const DEFAULT_MAX_TOKENS = 4096;

export interface OpenAIAdapterOptions {
  apiKey: string;
  /** e.g. `https://openrouter.ai/api/v1`; there is no default, it always comes from config. */
  baseURL: string;
  /** There's no sensible default across providers; without one only `listModels` works. */
  model?: string;
  /** SDK retries on connection errors, 408/409/429 and 5xx. */
  maxRetries?: number;
  timeoutMs?: number;
}

type ChatParams = OpenAI.ChatCompletionCreateParamsNonStreaming;

/**
 * Any API that speaks OpenAI's Chat Completions: OpenAI itself, OpenRouter, Groq, Ollama,
 * LM Studio, vLLM… Only the common subset is used, so it works across them.
 */
export class OpenAIAdapter implements LLMAdapter {
  readonly provider = 'openai' as const;
  readonly providerName: string;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(options: OpenAIAdapterOptions) {
    this.model = options.model ?? '';
    this.providerName = getProviderName('openai', options.baseURL);
    // Everything is passed explicitly so OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_ORG_ID /
    // OPENAI_PROJECT_ID in the environment are never picked up: the key lives in config.json only.
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      organization: null,
      project: null,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 120_000,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    try {
      for await (const model of this.client.models.list()) {
        models.push(toModelInfo(model));
      }
    } catch (error) {
      throw this.mapError(error);
    }
    return models.sort(
      (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id),
    );
  }

  async validateKey(): Promise<void> {
    await this.listModels();
  }

  async checkModelAccess(model = this.model): Promise<void> {
    // A few tokens rather than 1: some reasoning models reject a limit that small.
    await this.send({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }, model);
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const response = await this.send(this.baseParams(request), this.model);
    this.assertComplete(response, request);
    return { text: textOf(response), usage: usageOf(response) };
  }

  async generateJSON<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    const { schema, unwrap } = asObjectSchema(toJsonSchema(request.schema));
    const params = this.baseParams(request);
    const messages = [...params.messages];
    // Not `strict`: it needs every property required, and support for it varies by provider.
    // The answer is validated (and retried once) either way.
    const responseFormat: ChatParams['response_format'] = {
      type: 'json_schema',
      json_schema: { name: request.schemaName ?? 'response', schema },
    };

    return generateValidated(this.provider, request.schema, async (feedback) => {
      if (feedback !== undefined) messages.push({ role: 'user', content: feedback });
      const response = await this.send(
        { ...params, messages, response_format: responseFormat },
        this.model,
      );
      this.assertComplete(response, request);
      const text = textOf(response);
      messages.push({ role: 'assistant', content: text });
      return { value: unwrap(parseJson(text)), usage: usageOf(response) };
    });
  }

  /** Chat Completions has no web search that works across providers. */
  searchJSON<T>(): Promise<SearchResult<T>> {
    return Promise.reject(
      new WebSearchUnavailableError(
        `Web search isn't supported with ${this.providerName}.`,
        this.provider,
      ),
    );
  }

  private mapError(error: unknown, model?: string): Error {
    const context: ErrorContext = {
      provider: this.provider,
      providerName: this.providerName,
      ...(model !== undefined ? { model } : {}),
    };
    return mapOpenAIError(error, context);
  }

  private baseParams(request: TextRequest): ChatParams & { messages: ChatParams['messages'] } {
    // The system prompt is sent unchanged on every call; OpenAI-style APIs cache repeated
    // prefixes on their own, so `cacheSystem` needs no extra markup here.
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (request.system !== undefined) messages.push({ role: 'system', content: request.system });
    messages.push({
      role: 'user',
      content: request.files?.length
        ? [
            ...request.files.map((file) => this.filePart(file)),
            { type: 'text', text: request.prompt },
          ]
        : request.prompt,
    });
    // `max_tokens` rather than `max_completion_tokens`: it's the one every compatible API knows.
    return {
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    };
  }

  private filePart(file: FileInput): OpenAI.ChatCompletionContentPart {
    const dataUrl = `data:${file.mimeType};base64,${Buffer.from(file.data).toString('base64')}`;
    if (file.mimeType.startsWith('image/')) {
      return { type: 'image_url', image_url: { url: dataUrl } };
    }
    if (file.mimeType === 'text/plain') {
      return { type: 'text', text: Buffer.from(file.data).toString('utf8') };
    }
    if (file.mimeType === 'application/pdf') {
      return { type: 'file', file: { filename: file.name ?? 'document.pdf', file_data: dataUrl } };
    }
    throw new LLMError(
      `${this.providerName} can't read files of type ${file.mimeType}.`,
      this.provider,
    );
  }

  private assertComplete(response: OpenAI.ChatCompletion, request: TextRequest): void {
    if (response.choices[0]?.finish_reason === 'length') {
      throw new LLMError(
        `The response was cut off at ${String(request.maxTokens ?? DEFAULT_MAX_TOKENS)} tokens. Try a larger limit.`,
        this.provider,
      );
    }
  }

  private async send(params: ChatParams, model: string): Promise<OpenAI.ChatCompletion> {
    try {
      return await this.client.chat.completions.create(params);
    } catch (error) {
      throw this.mapError(error, model);
    }
  }
}

function textOf(response: OpenAI.ChatCompletion): string {
  return response.choices[0]?.message.content ?? '';
}

/** `prompt_tokens` includes cached tokens; split them out to match how Claude reports usage. */
function usageOf(response: OpenAI.ChatCompletion): Usage {
  const usage = response.usage;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: (usage?.prompt_tokens ?? 0) - cached,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    webSearches: 0,
  };
}

function toModelInfo(model: OpenAI.Model): ModelInfo {
  return {
    id: model.id,
    displayName: model.id,
    // Some compatible APIs leave `created` out or set it to 0.
    ...(model.created ? { createdAt: new Date(model.created * 1000).toISOString() } : {}),
  };
}
