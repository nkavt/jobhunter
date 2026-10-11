import type { ZodType } from 'zod';
import type { Provider } from '../config/config.js';

export interface ModelInfo {
  id: string;
  displayName: string;
  /** e.g. `opus`, `sonnet`, `haiku`; used for picker hints. */
  family?: string;
  createdAt?: string;
  deprecated?: boolean;
}

/** A binary attachment; only used to read a PDF CV once during import. */
export interface FileInput {
  mimeType: string;
  data: Uint8Array;
  name?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export interface TextRequest {
  system?: string;
  prompt: string;
  files?: FileInput[];
  maxTokens?: number;
  /** Mark the system prompt as cacheable (it's identical across many calls, e.g. the fit check). */
  cacheSystem?: boolean;
}

export interface JsonRequest<T> extends TextRequest {
  schema: ZodType<T>;
  /** Short identifier for the output shape, e.g. `job_fit`. Some providers require one. */
  schemaName?: string;
}

export interface SearchRequest<T> extends Omit<JsonRequest<T>, 'files'> {
  /** Upper bound on web searches the model may run for this request. */
  maxSearches?: number;
}

export interface Source {
  url: string;
  title?: string;
}

export interface TextResult {
  text: string;
  usage: Usage;
}

export interface JsonResult<T> {
  data: T;
  usage: Usage;
}

export interface SearchResult<T> extends JsonResult<T> {
  sources: Source[];
}

/**
 * Everything Jobhunter needs from an AI provider. The rest of the code depends only on
 * this interface, never on a vendor SDK.
 */
export interface LLMAdapter {
  readonly provider: Provider;
  /** Model used by the generate/search calls. */
  readonly model: string;

  /** Live list of models this key can use. Needs a valid key, so it doubles as the key test. */
  listModels(): Promise<ModelInfo[]>;
  /** Throws `InvalidKeyError` / `NetworkError`. */
  validateKey(): Promise<void>;
  /** Tiny real request; surfaces billing/permission problems the model list can't show. */
  checkModelAccess(model?: string): Promise<void>;

  generateText(request: TextRequest): Promise<TextResult>;
  /** Structured output, validated against `request.schema`. */
  generateJSON<T>(request: JsonRequest<T>): Promise<JsonResult<T>>;
  /** Like `generateJSON`, with the provider's built-in web search enabled. */
  searchJSON<T>(request: SearchRequest<T>): Promise<SearchResult<T>>;
}
