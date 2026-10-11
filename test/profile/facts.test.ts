import { describe, expect, it } from 'vitest';
import { InvalidResponseError } from '../../src/llm/index.js';
import { extractCvFacts } from '../../src/profile/facts.js';
import { generateInstructions } from '../../src/profile/instructions.js';
import { renderSystemPrompt } from '../../src/prompts/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { DERIVED_ANSWER, FACTS_ANSWER } from '../helpers/fixtures.js';

const CV = '# Alex Example\n\n## Experience\n### Senior Engineer — Acme\n- React, TypeScript\n';

describe('extractCvFacts', () => {
  it('sends the CV with the extraction prompt and splits facts from suggestions', async () => {
    const llm = new FakeLLM({ json: FACTS_ANSWER });

    const { derived, suggestions } = await extractCvFacts(CV, llm);

    expect(derived).toEqual(DERIVED_ANSWER);
    expect(suggestions).toEqual({ countryCode: 'GE', city: 'Tbilisi', workModes: ['remote'] });
    expect(llm.calls[0]?.request).toMatchObject({
      system: renderSystemPrompt('extract-cv-facts'),
      prompt: `Extract the facts from this CV.\n\n<cv>\n${CV}\n</cv>`,
    });
  });

  it('accepts an answer with no suggestions', async () => {
    const llm = new FakeLLM({ json: { ...FACTS_ANSWER, suggestions: {} } });
    expect((await extractCvFacts(CV, llm)).suggestions).toEqual({});
  });

  it('rejects answers that do not match the schema', async () => {
    const llm = new FakeLLM({ json: { ...FACTS_ANSWER, seniority: 'wizard' } });
    await expect(extractCvFacts(CV, llm)).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('generateInstructions', () => {
  it('sends the facts and the CV, and returns the profile', async () => {
    const llm = new FakeLLM({
      text: '  # Candidate profile\n\n## Summary\nSenior frontend engineer.  ',
    });
    const { markdown } = await generateInstructions(CV, DERIVED_ANSWER, llm);

    expect(markdown).toBe('# Candidate profile\n\n## Summary\nSenior frontend engineer.\n');
    const request = llm.calls[0]?.request as { system: string; prompt: string };
    expect(request.system).toBe(renderSystemPrompt('candidate-instructions'));
    expect(request.prompt).toContain('"roles": [');
    expect(request.prompt).toContain(`<cv>\n${CV}\n</cv>`);
  });

  it('keeps search preferences out of the profile instructions', () => {
    expect(renderSystemPrompt('candidate-instructions')).toContain(
      'Do not include location, work mode, salary, employment type',
    );
  });

  it('fails when the profile comes back empty', async () => {
    await expect(generateInstructions(CV, {} as never, new FakeLLM({ text: ' ' }))).rejects.toThrow(
      'came back empty',
    );
  });
});
