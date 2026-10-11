import type { Provider } from '../../src/config/config.js';
import {
  emptyUsage,
  generateValidated,
  type JsonRequest,
  type JsonResult,
  type LLMAdapter,
  type ModelInfo,
  type SearchRequest,
  type SearchResult,
  type Source,
  type TextRequest,
  type TextResult,
} from '../../src/llm/index.js';

type Method = Exclude<keyof LLMAdapter, 'provider' | 'model'>;

export interface FakeCall {
  method: Method;
  request?: unknown;
  /** Validation feedback sent on a structured-output retry. */
  feedback?: string;
}

export interface FakeLLMOptions {
  model?: string;
  models?: ModelInfo[];
  text?: string | ((request: TextRequest) => string);
  /** Raw (unvalidated) JSON the "model" returns; a function gets the attempt number (0, 1). */
  json?: unknown;
  search?: { data: unknown; sources?: Source[] };
  /** Make a method throw instead of answering. */
  errors?: Partial<Record<Method, Error>>;
}

/** Deterministic stand-in for a real provider. Records every call for assertions. */
export class FakeLLM implements LLMAdapter {
  readonly provider: Provider = 'claude';
  readonly model: string;
  readonly calls: FakeCall[] = [];

  constructor(private readonly options: FakeLLMOptions = {}) {
    this.model = options.model ?? 'fake-model';
  }

  listModels(): Promise<ModelInfo[]> {
    return this.answer('listModels', undefined, () =>
      Promise.resolve(this.options.models ?? [{ id: this.model, displayName: 'Fake Model' }]),
    );
  }

  validateKey(): Promise<void> {
    return this.answer('validateKey', undefined, () => Promise.resolve());
  }

  checkModelAccess(model?: string): Promise<void> {
    return this.answer('checkModelAccess', model, () => Promise.resolve());
  }

  generateText(request: TextRequest): Promise<TextResult> {
    return this.answer('generateText', request, () => {
      const { text = '' } = this.options;
      return Promise.resolve({
        text: typeof text === 'function' ? text(request) : text,
        usage: emptyUsage(),
      });
    });
  }

  generateJSON<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    return this.answer('generateJSON', request, () => this.validated('generateJSON', request));
  }

  searchJSON<T>(request: SearchRequest<T>): Promise<SearchResult<T>> {
    return this.answer('searchJSON', request, async () => {
      const search = this.options.search ?? { data: undefined };
      const { data, usage } = await generateValidated(this.provider, request.schema, () =>
        Promise.resolve({ value: search.data, usage: emptyUsage() }),
      );
      return { data, usage, sources: search.sources ?? [] };
    });
  }

  private validated<T>(method: Method, request: JsonRequest<T>): Promise<JsonResult<T>> {
    let attempt = 0;
    return generateValidated(this.provider, request.schema, (feedback) => {
      if (feedback !== undefined) this.calls.push({ method, request, feedback });
      const { json } = this.options;
      const value: unknown =
        typeof json === 'function' ? (json as (n: number) => unknown)(attempt) : json;
      attempt++;
      return Promise.resolve({ value, usage: emptyUsage() });
    });
  }

  private answer<R>(method: Method, request: unknown, produce: () => Promise<R>): Promise<R> {
    this.calls.push({ method, request });
    const error = this.options.errors?.[method];
    return error ? Promise.reject(error) : produce();
  }
}
