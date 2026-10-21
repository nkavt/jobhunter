import { z, type ZodType } from 'zod';
import type { Provider } from '../config/config.js';
import { renderSnippet } from '../prompts/index.js';
import { InvalidResponseError } from './errors.js';
import type { JsonResult, Usage } from './types.js';
import { addUsage } from './usage.js';

/** JSON Schema for a zod schema, in the shape providers' structured-output APIs expect. */
export function toJsonSchema(schema: ZodType): Record<string, unknown> {
  // `io: 'input'`: the model's output is the *input* we parse, so defaults stay optional.
  const jsonSchema = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

/**
 * Structured output needs an object at the root; wrap anything else in `{ result }`.
 * `$defs` stay at the root so `#/$defs/...` references keep resolving.
 */
export function asObjectSchema(schema: Record<string, unknown>): {
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

/**
 * Invalid JSON is returned as the raw string, so schema validation reports a useful issue.
 * A ```json fence around the answer is tolerated; some models add one despite the format.
 */
export function parseJson(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text);
  try {
    return JSON.parse(fenced?.[1] ?? text);
  } catch {
    return text;
  }
}

/** Human-readable zod issues, e.g. `jobs.0.score: Too big: expected number to be <=100`. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

export interface Attempt {
  /** The model's parsed (but not yet validated) output. */
  value: unknown;
  usage: Usage;
}

/**
 * Run a structured-output call and validate it. If validation fails, call again once with
 * the problems fed back to the model; if it still fails, throw `InvalidResponseError`.
 * Usage from every attempt is summed.
 */
export async function generateValidated<T>(
  provider: Provider,
  schema: ZodType<T>,
  attempt: (feedback?: string) => Promise<Attempt>,
  maxAttempts = 2,
): Promise<JsonResult<T>> {
  const usages: Usage[] = [];
  let issues: string[] = [];

  for (let i = 0; i < maxAttempts; i++) {
    const feedback =
      i === 0
        ? undefined
        : renderSnippet('retry-feedback', {
            issues: issues.map((issue) => `- ${issue}`).join('\n'),
          });
    const { value, usage } = await attempt(feedback);
    usages.push(usage);

    const result = schema.safeParse(value);
    if (result.success) return { data: result.data, usage: addUsage(...usages) };
    issues = formatIssues(result.error);
  }

  throw new InvalidResponseError(
    `The AI response did not match the expected format after ${String(maxAttempts)} attempts`,
    provider,
    issues,
  );
}
