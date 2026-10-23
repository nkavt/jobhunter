import OpenAI from 'openai';
import { renderSnippet } from '../../prompts/index.js';
import { DocumentError, pdfText } from '../../util/document-text.js';
import { getProviderName } from '../describe.js';
import { LLMError, WebSearchUnavailableError } from '../errors.js';
import { isLocalURL } from '../local.js';
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
import {
  ServerSettings,
  THINKING_ALLOWANCE,
  type ChatParams,
  type ChatRequest,
} from './server-settings.js';

const DEFAULT_MAX_TOKENS = 4096;
const CLOUD_TIMEOUT_MS = 120_000;
/** A model on the user's own machine can take minutes for one batch of jobs. */
const LOCAL_TIMEOUT_MS = 10 * 60_000;

export interface OpenAIAdapterOptions {
  apiKey: string;
  /** e.g. `https://openrouter.ai/api/v1`; there is no default, it always comes from config. */
  baseURL: string;
  /** There's no sensible default across providers; without one only `listModels` works. */
  model?: string;
  /** SDK retries on connection errors, 408/409/429 and 5xx. Default: 2, none for a local server. */
  maxRetries?: number;
  /** Default: 2 minutes, 10 for a local server. */
  timeoutMs?: number;
  /**
   * `false` asks the server to skip thinking (`reasoning_effort: none`), `true` leaves it to the
   * model. Default: off on a local server, where thinking takes minutes per batch; the API's own
   * default elsewhere.
   */
  thinking?: boolean;
}

/**
 * Any API that speaks OpenAI's Chat Completions: OpenAI itself, OpenRouter, Groq, Ollama,
 * LM Studio, vLLM… Only the common subset is used, so it works across them.
 */
export class OpenAIAdapter implements LLMAdapter {
  readonly provider = 'openai' as const;
  readonly providerName: string;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly local: boolean;
  /** The user lets the model think. */
  private readonly thinkingAllowed: boolean;
  private readonly settings: ServerSettings;

  constructor(options: OpenAIAdapterOptions) {
    this.model = options.model ?? '';
    this.providerName = getProviderName('openai', options.baseURL);
    // A local server is slow rather than flaky: retrying a timed-out request only repeats the wait.
    const local = isLocalURL(options.baseURL);
    this.local = local;
    this.thinkingAllowed = options.thinking ?? !local;
    this.settings = new ServerSettings({ local, thinkingAllowed: this.thinkingAllowed });
    this.timeoutMs = options.timeoutMs ?? (local ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS);
    // Everything is passed explicitly so OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_ORG_ID /
    // OPENAI_PROJECT_ID in the environment are never picked up: the key lives in config.json only.
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      organization: null,
      project: null,
      maxRetries: options.maxRetries ?? (local ? 0 : 2),
      timeout: this.timeoutMs,
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
    await this.send({ model, maxTokens: 16, messages: [{ role: 'user', content: 'Hi' }] }, model);
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const response = await this.send(await this.baseParams(request), this.model);
    this.assertComplete(response, request);
    return { text: this.textOf(response), usage: usageOf(response) };
  }

  async generateJSON<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    const { schema, unwrap } = asObjectSchema(toJsonSchema(request.schema));
    // Some hosts accept `response_format` but don't enforce it (Ollama's cloud), so the schema
    // is in the prompt too. At the end of the user message, so the system prompt stays cacheable.
    const params = await this.baseParams({
      ...request,
      prompt: `${request.prompt}\n\n${renderSnippet('json-schema', { schema: JSON.stringify(schema) })}`,
    });
    const messages = [...params.messages];
    // Not `strict`: it needs every property required, and support for it varies by provider.
    // The answer is validated (and retried once) either way, so `send` may also loosen this
    // for servers that reject it.
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
      const text = this.textOf(response);
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
      timeoutMs: this.timeoutMs,
      local: this.local,
      ...(model !== undefined ? { model } : {}),
    };
    return mapOpenAIError(error, context);
  }

  private async baseParams(request: TextRequest): Promise<ChatRequest> {
    // The system prompt is sent unchanged on every call; OpenAI-style APIs cache repeated
    // prefixes on their own, so `cacheSystem` needs no extra markup here.
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (request.system !== undefined) messages.push({ role: 'system', content: request.system });
    messages.push({
      role: 'user',
      content: request.files?.length
        ? [
            ...(await Promise.all(request.files.map((file) => this.filePart(file)))),
            { type: 'text', text: request.prompt },
          ]
        : request.prompt,
    });
    return { model: this.model, maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS, messages };
  }

  private async filePart(file: FileInput): Promise<OpenAI.ChatCompletionContentPart> {
    const dataUrl = `data:${file.mimeType};base64,${Buffer.from(file.data).toString('base64')}`;
    if (file.mimeType.startsWith('image/')) {
      return { type: 'image_url', image_url: { url: dataUrl } };
    }
    if (file.mimeType === 'text/plain') {
      return { type: 'text', text: Buffer.from(file.data).toString('utf8') };
    }
    if (file.mimeType === 'application/pdf') {
      // Most compatible APIs (OpenRouter, Ollama, …) don't take PDF parts, so the text goes instead.
      return { type: 'text', text: await this.pdfText(file) };
    }
    throw new LLMError(
      `${this.providerName} can't read files of type ${file.mimeType}.`,
      this.provider,
    );
  }

  private async pdfText(file: FileInput): Promise<string> {
    const name = file.name ?? 'the PDF';
    try {
      return `<document name="${name}">\n${await pdfText(file.data, name)}\n</document>`;
    } catch (error) {
      if (error instanceof DocumentError) {
        throw new LLMError(error.message, this.provider, { cause: error });
      }
      throw error;
    }
  }

  private assertComplete(response: OpenAI.ChatCompletion, request: TextRequest): void {
    if (response.choices[0]?.finish_reason !== 'length') return;
    const limit = String(request.maxTokens ?? DEFAULT_MAX_TOKENS);
    if (this.settings.thinkingAllowance === 0) {
      throw new LLMError(`The response was cut off at ${limit} tokens.`, this.provider);
    }
    // Thinking on by choice can be turned off in init (local servers only); on because the
    // server ignores the setting, or on a cloud reasoning model, only another model helps.
    const hint =
      this.local && this.thinkingAllowed
        ? 'Turn thinking off with `jobhunter init` → AI provider, key or model, or try a model that thinks less.'
        : 'Try a model that thinks less.';
    throw new LLMError(
      `The model ran out of tokens before finishing its answer (${limit}, plus ${String(THINKING_ALLOWANCE)} for thinking). ${hint}`,
      this.provider,
    );
  }

  private async send(request: ChatRequest, model: string): Promise<OpenAI.ChatCompletion> {
    const sent = this.settings.prepare(request);
    try {
      return await this.client.chat.completions.create(sent);
    } catch (error) {
      if (error instanceof OpenAI.BadRequestError && this.settings.adaptTo(error, sent)) {
        return this.send(request, model);
      }
      throw this.mapError(error, model);
    }
  }

  /** Some servers put a thinking model's reasoning in the answer as a leading `<think>` block. */
  private textOf(response: OpenAI.ChatCompletion): string {
    const message = response.choices[0]?.message;
    if (message?.content == null && message?.refusal) {
      throw new LLMError(`The model declined to answer: ${message.refusal}`, this.provider);
    }
    return (message?.content ?? '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
  }
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
