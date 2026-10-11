import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROMPTS,
  PromptError,
  renderPrompt,
  renderSystemPrompt,
  renderUserPrompt,
} from '../../src/prompts/index.js';

const PROMPTS_DIR = fileURLToPath(new URL('../../src/prompts/', import.meta.url));

describe('renderPrompt', () => {
  it('fills every placeholder, including repeated ones, and trims', () => {
    expect(
      renderPrompt('\nHi {{name}}, {{name}} works at {{company}}.\n', {
        name: 'Alex',
        company: 'Acme',
      }),
    ).toBe('Hi Alex, Alex works at Acme.');
  });

  it('inserts values as-is, even if they look like placeholders or contain $ patterns', () => {
    expect(renderPrompt('Job: {{job}}', { job: '{{not_a_placeholder}} costs $& $1' })).toBe(
      'Job: {{not_a_placeholder}} costs $& $1',
    );
  });

  it('throws when a placeholder has no value', () => {
    expect(() => renderPrompt('Hi {{name}}', {}, 'greeting/user.md')).toThrow(
      new PromptError('greeting/user.md: missing value for {{name}}'),
    );
  });

  it('throws when a value is never used', () => {
    expect(() => renderPrompt('Hi', { name: 'Alex', typo: 'x' })).toThrow(
      'prompt: unused value(s) "name", "typo"',
    );
  });

  it('allows empty values', () => {
    expect(renderPrompt('A{{x}}B', { x: '' })).toBe('AB');
  });
});

describe('prompt files', () => {
  it('registers every folder in src/prompts, each with system.md and user.md', async () => {
    const entries = await readdir(PROMPTS_DIR, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(Object.keys(PROMPTS).sort()).toEqual(folders);
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    expect(files).toEqual(['index.ts', 'registry.ts', 'render.ts', 'types.ts']);

    for (const folder of folders) {
      expect((await readdir(`${PROMPTS_DIR}${folder}`)).sort(), folder).toEqual([
        'system.md',
        'user.md',
      ]);
    }
  });

  it('loads every prompt as non-empty text', () => {
    for (const [name, { system, user }] of Object.entries(PROMPTS)) {
      expect(system.trim(), `${name}/system.md`).not.toBe('');
      expect(user.trim(), `${name}/user.md`).not.toBe('');
    }
  });
});

describe('cv-to-markdown', () => {
  it('keeps the CV facts unchanged and explains Word extraction', () => {
    const system = renderSystemPrompt('cv-to-markdown');
    expect(system).toMatch(/^You convert CVs/);
    expect(system).toContain('Do not summarise, rephrase, translate');
    expect(system).toContain('extracted from a Word document');
  });

  it('needs the CV text, which is empty when the PDF is attached instead', () => {
    expect(renderUserPrompt('cv-to-markdown', { cv: '' })).toBe('Convert this CV to Markdown.');
    expect(() => renderUserPrompt('cv-to-markdown')).toThrow('missing value for {{cv}}');
  });
});
