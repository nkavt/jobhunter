import { describe, expect, it } from 'vitest';
import { ServerSettings, type ChatRequest } from '../../../src/llm/openai/server-settings.js';

const request: ChatRequest = {
  model: 'm',
  maxTokens: 100,
  messages: [{ role: 'user', content: 'Hi' }],
};
const jsonRequest: ChatRequest = {
  ...request,
  response_format: { type: 'json_schema', json_schema: { name: 'r', schema: {} } },
};
const cloud = () => new ServerSettings({ local: false, thinkingAllowed: true });
const local = () => new ServerSettings({ local: true, thinkingAllowed: false });

const MAX_TOKENS_ERROR = {
  message:
    "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
  param: 'max_tokens',
};
const FORMAT_ERROR = { message: 'response_format is not supported by this model' };

describe('ServerSettings', () => {
  it('starts with what most servers know', () => {
    expect(cloud().prepare(jsonRequest)).toEqual({
      model: 'm',
      max_tokens: 100,
      messages: request.messages,
      response_format: jsonRequest.response_format,
    });
  });

  it('gives a local server room to think, and asks it not to unless the user allows it', () => {
    expect(local().prepare(request)).toMatchObject({
      max_tokens: 100 + 16_384,
      reasoning_effort: 'none',
    });
    const thinking = new ServerSettings({ local: true, thinkingAllowed: true });
    expect(thinking.prepare(request)).not.toHaveProperty('reasoning_effort');
  });

  it('switches to max_completion_tokens, with room to think, when max_tokens is rejected', () => {
    const settings = cloud();
    expect(settings.thinkingAllowance).toBe(0);

    expect(settings.adaptTo(MAX_TOKENS_ERROR, settings.prepare(request))).toBe(true);

    expect(settings.thinkingAllowance).toBe(16_384);
    const params = settings.prepare(request);
    expect(params).toMatchObject({ max_completion_tokens: 100 + 16_384 });
    expect(params).not.toHaveProperty('max_tokens');
  });

  it('steps the JSON format down one level per rejection', () => {
    const settings = cloud();
    const formats = [];
    for (let i = 0; i < 3; i++) {
      const sent = settings.prepare(jsonRequest);
      formats.push(sent.response_format?.type);
      settings.adaptTo(FORMAT_ERROR, sent);
    }
    expect(formats).toEqual(['json_schema', 'json_object', undefined]);
  });

  it('does not skip a JSON format when parallel requests are rejected together', () => {
    const settings = cloud();
    const first = settings.prepare(jsonRequest);
    const second = settings.prepare(jsonRequest);

    expect(settings.adaptTo(FORMAT_ERROR, first)).toBe(true);
    expect(settings.adaptTo(FORMAT_ERROR, second)).toBe(true);

    expect(settings.prepare(jsonRequest).response_format).toEqual({ type: 'json_object' });
  });

  it('stops asking to skip thinking once the server rejects the setting', () => {
    const settings = local();
    const rejection = { message: 'Unrecognized request argument supplied: reasoning_effort' };

    expect(settings.adaptTo(rejection, settings.prepare(request))).toBe(true);
    expect(settings.prepare(request)).not.toHaveProperty('reasoning_effort');
  });

  it('leaves other bad requests, and settings it no longer sends, alone', () => {
    const settings = cloud();
    expect(settings.adaptTo({ message: 'Invalid image URL' }, settings.prepare(request))).toBe(
      false,
    );
    // A JSON-format complaint about a request that sent no format isn't worth a retry.
    expect(settings.adaptTo(FORMAT_ERROR, settings.prepare(request))).toBe(false);

    settings.adaptTo(MAX_TOKENS_ERROR, settings.prepare(request));
    const again = settings.prepare(request);
    expect(settings.adaptTo(MAX_TOKENS_ERROR, again)).toBe(false);
  });
});
