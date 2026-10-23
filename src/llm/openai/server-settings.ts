import type OpenAI from 'openai';

/**
 * Thinking models count their reasoning against the token limit, so they get this on top of the
 * answer's limit: on a local server (Qwen, DeepSeek-R1…), for when thinking is on or can't be
 * turned off, and on a cloud API once it asks for `max_completion_tokens`, which only reasoning
 * models do. Not for other cloud models: they reject a limit above their output cap, 16k on some.
 */
export const THINKING_ALLOWANCE = 16_384;

/** How strictly the answer's JSON is requested, strictest first. */
const JSON_FORMATS = ['json_schema', 'json_object', 'none'] as const;
type JsonFormat = (typeof JSON_FORMATS)[number];

export type ChatParams = OpenAI.ChatCompletionCreateParamsNonStreaming;

/**
 * A request before it's fitted to the server. `maxTokens` is the answer's own limit; it's sent
 * as `max_tokens` or `max_completion_tokens`, with room for thinking where that's needed.
 */
export type ChatRequest = Omit<ChatParams, 'max_tokens' | 'max_completion_tokens'> & {
  messages: ChatParams['messages'];
  maxTokens: number;
};

export interface ServerSettingsOptions {
  /** The server runs on the user's own machine or network. */
  local: boolean;
  /** The user lets the model think. When false, the server is asked to skip thinking. */
  thinkingAllowed: boolean;
}

/**
 * What one OpenAI-compatible server accepts. Servers differ in which parameters they take, so
 * each starts from what most of them know and switches when the server rejects it (`adaptTo`).
 */
export class ServerSettings {
  private readonly local: boolean;
  /** Sends `reasoning_effort: none`. Stops if the server rejects it; then the model just thinks. */
  private sendThinkingOff: boolean;
  /** Sends `max_completion_tokens` instead of `max_tokens`, as OpenAI's reasoning models need. */
  private useMaxCompletionTokens = false;
  private jsonFormat: JsonFormat = 'json_schema';

  constructor(options: ServerSettingsOptions) {
    this.local = options.local;
    this.sendThinkingOff = !options.thinkingAllowed;
  }

  /** Tokens added to each answer's limit for the model's thinking. */
  get thinkingAllowance(): number {
    return this.local || this.useMaxCompletionTokens ? THINKING_ALLOWANCE : 0;
  }

  /** `request` as this server takes it. */
  prepare(request: ChatRequest): ChatParams {
    const { maxTokens, response_format: responseFormat, ...rest } = request;
    const limit = maxTokens + this.thinkingAllowance;
    // `max_tokens` until the server asks otherwise: it's the one every compatible API knows.
    const params: ChatParams = this.useMaxCompletionTokens
      ? { ...rest, max_completion_tokens: limit }
      : { ...rest, max_tokens: limit };
    if (responseFormat !== undefined) {
      if (responseFormat.type !== 'json_schema' || this.jsonFormat === 'json_schema') {
        params.response_format = responseFormat;
      } else if (this.jsonFormat === 'json_object') {
        params.response_format = { type: 'json_object' };
      }
      // 'none': the schema in the prompt has to do.
    }
    if (this.sendThinkingOff) params.reasoning_effort = 'none';
    return params;
  }

  /**
   * The server rejected `sent` as a bad request: stop sending the setting it objected to.
   * Returns true if there was one, so the request is worth sending again. Each retry drops a
   * setting, so retrying can't loop.
   */
  adaptTo(
    error: { message: string; param?: string | null | undefined },
    sent: ChatParams,
  ): boolean {
    const message = `${error.param ?? ''} ${error.message}`;
    // OpenAI's reasoning models: "Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens'".
    if ('max_tokens' in sent && /max_completion_tokens/i.test(message)) {
      this.useMaxCompletionTokens = true;
      return true;
    }
    // Servers and models without structured output: plain JSON mode, then the prompt alone.
    const format = sent.response_format?.type;
    if (
      (format === 'json_schema' || format === 'json_object') &&
      /response_format|json_schema|json_object|structured output|json mode/i.test(message)
    ) {
      // One step down from what was sent; a parallel request may have stepped down already.
      const next = format === 'json_schema' ? 'json_object' : 'none';
      if (JSON_FORMATS.indexOf(next) > JSON_FORMATS.indexOf(this.jsonFormat)) {
        this.jsonFormat = next;
      }
      return true;
    }
    // Not every server knows `reasoning_effort: none`.
    if (sent.reasoning_effort === 'none' && /reasoning|think/i.test(message)) {
      this.sendThinkingOff = false;
      return true;
    }
    return false;
  }
}
