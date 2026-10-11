import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addUsage,
  emptyUsage,
  generateValidated,
  InvalidResponseError,
  toJsonSchema,
  type Usage,
} from '../../src/llm/index.js';

const Schema = z.object({ score: z.number().min(0).max(100), verdict: z.enum(['good', 'bad']) });
const usage = (inputTokens: number): Usage => ({ ...emptyUsage(), inputTokens, outputTokens: 1 });

describe('generateValidated', () => {
  it('returns the data when the first answer is valid', async () => {
    const feedbacks: (string | undefined)[] = [];
    const result = await generateValidated('claude', Schema, (feedback) => {
      feedbacks.push(feedback);
      return Promise.resolve({ value: { score: 80, verdict: 'good' }, usage: usage(10) });
    });

    expect(result.data).toEqual({ score: 80, verdict: 'good' });
    expect(result.usage.inputTokens).toBe(10);
    expect(feedbacks).toEqual([undefined]);
  });

  it('retries once with the validation problems and sums usage', async () => {
    const feedbacks: (string | undefined)[] = [];
    const answers = [
      { score: 150, verdict: 'great' },
      { score: 90, verdict: 'good' },
    ];

    const result = await generateValidated('claude', Schema, (feedback) => {
      feedbacks.push(feedback);
      return Promise.resolve({ value: answers[feedbacks.length - 1], usage: usage(10) });
    });

    expect(result.data).toEqual({ score: 90, verdict: 'good' });
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 2 });
    expect(feedbacks[1]).toContain('score:');
    expect(feedbacks[1]).toContain('verdict:');
  });

  it('throws InvalidResponseError with the issues when the retry is invalid too', async () => {
    const call = generateValidated('claude', Schema, () =>
      Promise.resolve({ value: { score: 'high' }, usage: emptyUsage() }),
    );

    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidResponseError);
    const { provider, issues } = error as InvalidResponseError;
    expect(provider).toBe('claude');
    expect(issues.some((issue) => issue.startsWith('score:'))).toBe(true);
  });
});

describe('toJsonSchema', () => {
  it('produces a plain JSON Schema without the $schema key', () => {
    const schema = toJsonSchema(Schema);
    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({
      type: 'object',
      properties: { verdict: { enum: ['good', 'bad'] } },
      required: ['score', 'verdict'],
    });
  });

  it('keeps fields with defaults optional, since the model output is parsed input', () => {
    const schema = toJsonSchema(
      z.object({ tags: z.array(z.string()).default([]), id: z.string() }),
    );
    expect(schema.required).toEqual(['id']);
  });
});

describe('usage', () => {
  it('adds every counter', () => {
    const a: Usage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      webSearches: 5,
    };
    expect(addUsage(a, a)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 8,
      webSearches: 10,
    });
    expect(addUsage()).toEqual(emptyUsage());
  });
});
