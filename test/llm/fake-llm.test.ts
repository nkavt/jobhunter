import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InvalidKeyError, InvalidResponseError } from '../../src/llm/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';

const Schema = z.object({ ok: z.boolean() });

describe('FakeLLM', () => {
  it('records calls and returns configured text', async () => {
    const llm = new FakeLLM({ text: (request) => `echo: ${request.prompt}` });
    const result = await llm.generateText({ prompt: 'hi' });
    expect(result.text).toBe('echo: hi');
    expect(llm.calls).toEqual([{ method: 'generateText', request: { prompt: 'hi' } }]);
  });

  it('validates JSON like a real adapter, including the retry', async () => {
    const llm = new FakeLLM({
      json: (attempt: number) => (attempt === 0 ? { ok: 'yes' } : { ok: true }),
    });
    const result = await llm.generateJSON({ prompt: 'p', schema: Schema });
    expect(result.data).toEqual({ ok: true });
    expect(llm.calls.map((call) => call.method)).toEqual(['generateJSON', 'generateJSON']);
    expect(llm.calls[1]?.feedback).toContain('ok:');
  });

  it('fails like a real adapter when the JSON never matches', async () => {
    const llm = new FakeLLM({ json: { ok: 'nope' } });
    await expect(llm.generateJSON({ prompt: 'p', schema: Schema })).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it('throws configured errors', async () => {
    const llm = new FakeLLM({ errors: { validateKey: new InvalidKeyError('bad', 'claude') } });
    await expect(llm.validateKey()).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('returns search data with sources', async () => {
    const llm = new FakeLLM({
      search: { data: { ok: true }, sources: [{ url: 'https://example.com' }] },
    });
    const result = await llm.searchJSON({ prompt: 'p', schema: Schema });
    expect(result).toMatchObject({ data: { ok: true }, sources: [{ url: 'https://example.com' }] });
  });
});
