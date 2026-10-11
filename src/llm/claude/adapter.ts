import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { LLMError } from '../errors.js';
import { generateValidated, toJsonSchema } from '../structured.js';
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
import { mapClaudeError, type ErrorContext } from './errors.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_SEARCHES = 5;
/** A long research run can pause; how many times we continue before giving up. */
const MAX_SEARCH_CONTINUATIONS = 5;

export interface ClaudeAdapterOptions {
  apiKey: string;
  model?: string;
  /** SDK retries on connection errors, 408/409/429 and 5xx. */
  maxRetries?: number;
  timeoutMs?: number;
  baseURL?: string;
}

type MessageParams = Anthropic.MessageCreateParamsNonStreaming;

export class ClaudeAdapter implements LLMAdapter {
  readonly provider = 'claude' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: ClaudeAdapterOptions) {
    this.model = options.model ?? DEFAULT_CLAUDE_MODEL;
    // Everything is passed explicitly so ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
    // ANTHROPIC_BASE_URL in the environment are never picked up: the key lives in config.json only.
    this.client = new Anthropic({
      apiKey: options.apiKey,
      authToken: null,
      baseURL: options.baseURL ?? 'https://api.anthropic.com',
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 120_000,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    try {
      for await (const model of this.client.models.list({ limit: 100 })) {
        if (model.lifecycle === 'retired') continue;
        models.push({
          id: model.id,
          displayName: model.display_name,
          createdAt: model.created_at,
          deprecated: model.lifecycle === 'deprecated',
          ...(model.line ? { family: model.line } : {}),
        });
      }
    } catch (error) {
      throw mapClaudeError(error);
    }
    return models.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  async validateKey(): Promise<void> {
    try {
      await this.client.models.list({ limit: 1 });
    } catch (error) {
      throw mapClaudeError(error);
    }
  }

  async checkModelAccess(model = this.model): Promise<void> {
    await this.send(
      { model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] },
      { model },
    );
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const response = await this.send(this.baseParams(request), { model: this.model });
    return { text: textOf(response), usage: usageOf(response) };
  }

  async generateJSON<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    const { schema, unwrap } = asObjectSchema(toJsonSchema(request.schema));
    const { type, schema: formatSchema } = jsonSchemaOutputFormat(
      schema as Parameters<typeof jsonSchemaOutputFormat>[0],
    );
    const params = this.baseParams(request);
    const messages = [...params.messages];

    return generateValidated(this.provider, request.schema, async (feedback) => {
      if (feedback !== undefined) messages.push({ role: 'user', content: feedback });
      const response = await this.send(
        { ...params, messages, output_config: { format: { type, schema: formatSchema } } },
        { model: this.model },
      );
      if (response.stop_reason === 'max_tokens') {
        throw new LLMError(
          `The response was cut off at ${String(params.max_tokens)} tokens. Try a larger limit.`,
          this.provider,
        );
      }
      const text = textOf(response);
      messages.push({ role: 'assistant', content: text });
      return { value: unwrap(parseJson(text)), usage: usageOf(response) };
    });
  }

  /**
   * Two steps: research with the web search tool (free-form notes + cited sources), then
   * turn the notes into structured output. Keeping search and structured output in separate
   * calls avoids mixing citations with a JSON format.
   */
  async searchJSON<T>(request: SearchRequest<T>): Promise<SearchResult<T>> {
    const params = this.baseParams({
      ...request,
      prompt: `${request.prompt}\n\nUse web search. Include the source URL for every item you mention.`,
    });
    const messages = [...params.messages];
    const tools: Anthropic.ToolUnion[] = [
      {
        type: 'web_search_20260318',
        name: 'web_search',
        max_uses: request.maxSearches ?? DEFAULT_MAX_SEARCHES,
      },
    ];

    const usages: Usage[] = [];
    const notes: string[] = [];
    const sources = new Map<string, Source>();

    for (let turn = 0; turn <= MAX_SEARCH_CONTINUATIONS; turn++) {
      const response = await this.send(
        { ...params, messages, tools },
        { model: this.model, webSearch: true },
      );
      usages.push(usageOf(response));
      collectResearch(response.content, notes, sources);
      if (response.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: response.content });
    }

    const research = notes.join('').trim();
    if (!research) {
      throw new LLMError('Web search finished without any findings.', this.provider);
    }

    const structured = await this.generateJSON({
      ...request,
      prompt: `${request.prompt}\n\nBase your answer only on these research notes:\n<research_notes>\n${research}\n</research_notes>`,
    });

    return {
      data: structured.data,
      usage: addUsage(...usages, structured.usage),
      sources: [...sources.values()],
    };
  }

  private baseParams(request: TextRequest): MessageParams {
    const content: Anthropic.ContentBlockParam[] = [
      ...(request.files ?? []).map(fileBlock),
      { type: 'text', text: request.prompt },
    ];
    return {
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content }],
      ...(request.system !== undefined
        ? {
            system: request.cacheSystem
              ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]
              : request.system,
          }
        : {}),
    };
  }

  private async send(params: MessageParams, context: ErrorContext): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(params);
    } catch (error) {
      throw mapClaudeError(error, context);
    }
  }
}

function fileBlock(file: FileInput): Anthropic.ContentBlockParam {
  const data = Buffer.from(file.data).toString('base64');
  if (file.mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (file.mimeType === 'text/plain') {
    return {
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: Buffer.from(file.data).toString('utf8'),
      },
    };
  }
  if (isImageType(file.mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: file.mimeType, data } };
  }
  throw new LLMError(`Claude can't read files of type ${file.mimeType}.`, 'claude');
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
function isImageType(type: string): type is (typeof IMAGE_TYPES)[number] {
  return (IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * Structured output needs an object at the root; wrap anything else in `{ result }`.
 * `$defs` stay at the root so `#/$defs/...` references keep resolving.
 */
function asObjectSchema(schema: Record<string, unknown>): {
  schema: Record<string, unknown>;
  unwrap: (value: unknown) => unknown;
} {
  if (schema.type === 'object') return { schema, unwrap: (value) => value };
  const { $defs, ...inner } = schema;
  return {
    schema: {
      type: 'object',
      properties: { result: inner },
      required: ['result'],
      additionalProperties: false,
      ...($defs !== undefined ? { $defs } : {}),
    },
    unwrap: (value) =>
      typeof value === 'object' && value !== null && 'result' in value ? value.result : value,
  };
}

/** Invalid JSON is returned as the raw string, so schema validation reports a useful issue. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function collectResearch(
  content: Anthropic.ContentBlock[],
  notes: string[],
  sources: Map<string, Source>,
): void {
  for (const block of content) {
    if (block.type === 'text') {
      notes.push(block.text);
      for (const citation of block.citations ?? []) {
        if (citation.type === 'web_search_result_location') {
          addSource(sources, citation.url, citation.title);
        }
      }
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) addSource(sources, result.url, result.title);
    }
  }
}

function addSource(sources: Map<string, Source>, url: string, title: string | null): void {
  if (sources.has(url)) return;
  sources.set(url, title ? { url, title } : { url });
}

function usageOf(message: Anthropic.Message): Usage {
  const { usage } = message;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  };
}
