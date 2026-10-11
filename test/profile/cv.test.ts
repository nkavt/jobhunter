import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  convertCv,
  CV_TO_MARKDOWN_SYSTEM,
  CvError,
  loadCv,
  MAX_CV_BYTES,
  resolveCvPath,
  summariseCv,
  type LoadedCv,
} from '../../src/profile/cv.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { useTempHome } from '../helpers/temp-home.js';

vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(({ buffer }: { buffer: Buffer }) => {
      const text = buffer.toString();
      if (text === 'corrupt') return Promise.reject(new Error('Could not find file in options'));
      return Promise.resolve({
        value: text === 'blank' ? '  ' : 'Alex Example\nEngineer at Acme',
        messages: [],
      });
    }),
  },
}));

const SAMPLE_MD = `# Alex Example
alex@example.com

## Experience
### Senior Engineer — Acme
Remote · 2021–present
- Built things

### Engineer — Initech
- Fixed things

## Skills
TypeScript, React
`;

const cvOf = (kind: LoadedCv['kind'], data: string): LoadedCv => ({
  path: `/tmp/cv.${kind}`,
  kind,
  data: Buffer.from(data),
  sha256: 'x',
});

describe('resolveCvPath', () => {
  it('handles paths typed or dragged into the terminal', () => {
    expect(resolveCvPath('cv.pdf', '/work')).toBe('/work/cv.pdf');
    expect(resolveCvPath('  ~/Docs/cv.pdf  ')).toBe(join(homedir(), 'Docs/cv.pdf'));
    expect(resolveCvPath("'/Users/alex/My CV.pdf'")).toBe('/Users/alex/My CV.pdf');
    expect(resolveCvPath('"/Users/alex/My CV.pdf"')).toBe('/Users/alex/My CV.pdf');
    expect(resolveCvPath('/Users/alex/My\\ CV.pdf')).toBe('/Users/alex/My CV.pdf');
  });
});

describe('loadCv', () => {
  const home = useTempHome();
  const file = async (name: string, content: string | Buffer) => {
    const path = join(home(), name);
    await mkdir(home(), { recursive: true });
    await writeFile(path, content);
    return path;
  };

  it('reads a supported file and fingerprints it', async () => {
    const cv = await loadCv(await file('cv.md', SAMPLE_MD));
    expect(cv).toMatchObject({ kind: 'markdown', path: join(home(), 'cv.md') });
    expect(cv.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await loadCv(await file('CV.PDF', '%PDF-1.7'))).kind).toBe('pdf');
  });

  it('explains what is wrong with unusable files', async () => {
    await expect(loadCv(join(home(), 'missing.pdf'))).rejects.toThrow("Can't find");
    await expect(loadCv(home() + '/')).rejects.toThrow(CvError);
    await expect(loadCv(await file('cv.pages', 'x'))).rejects.toThrow(
      'Unsupported CV format. Use one of: .pdf, .docx',
    );
    await expect(loadCv(await file('empty.txt', ''))).rejects.toThrow('is empty');
    await expect(loadCv(await file('huge.txt', Buffer.alloc(MAX_CV_BYTES + 1)))).rejects.toThrow(
      'larger than 10 MB',
    );
  });

  it('rejects directories', async () => {
    await mkdir(join(home(), 'folder.pdf'), { recursive: true });
    await expect(loadCv(join(home(), 'folder.pdf'))).rejects.toThrow('is not a file');
  });
});

describe('CV prompt', () => {
  it('loads from src/prompts/cv-to-markdown.md as plain text', () => {
    expect(CV_TO_MARKDOWN_SYSTEM).toMatch(/^You convert CVs/);
    expect(CV_TO_MARKDOWN_SYSTEM).toContain('Do not summarise, rephrase, translate');
    expect(CV_TO_MARKDOWN_SYSTEM).toMatch(/no code fences\.$/);
  });
});

describe('convertCv', () => {
  it('uses Markdown and text files as they are, without the AI', async () => {
    const llm = new FakeLLM();
    const result = await convertCv(cvOf('markdown', `\r\n${SAMPLE_MD}\r\n\r\n`), llm);
    expect(result.markdown).toBe(SAMPLE_MD);
    expect(llm.calls).toEqual([]);
  });

  it('sends PDFs to the model as a document with the conversion instructions', async () => {
    const llm = new FakeLLM({ text: SAMPLE_MD });
    const result = await convertCv(cvOf('pdf', '%PDF-1.7'), llm);

    expect(result.markdown).toBe(SAMPLE_MD);
    expect(llm.calls[0]?.request).toMatchObject({
      system: CV_TO_MARKDOWN_SYSTEM,
      maxTokens: 8192,
      files: [{ mimeType: 'application/pdf' }],
    });
  });

  it('extracts Word documents to text before structuring them', async () => {
    const llm = new FakeLLM({ text: SAMPLE_MD });
    await convertCv(cvOf('docx', 'ok'), llm);
    const request = llm.calls[0]?.request as { prompt: string; files?: unknown };
    expect(request.prompt).toContain('<cv>\nAlex Example\nEngineer at Acme\n</cv>');
    expect(request.files).toBeUndefined();
  });

  it('reports unreadable or empty Word documents', async () => {
    await expect(convertCv(cvOf('docx', 'corrupt'), new FakeLLM())).rejects.toThrow(
      "Can't read this Word document",
    );
    await expect(convertCv(cvOf('docx', 'blank'), new FakeLLM())).rejects.toThrow('No text found');
  });

  it('strips code fences the model adds anyway', async () => {
    const llm = new FakeLLM({ text: `\`\`\`markdown\n${SAMPLE_MD}\`\`\`` });
    expect((await convertCv(cvOf('pdf', '%PDF'), llm)).markdown).toBe(SAMPLE_MD);
  });

  it('fails when the conversion comes back empty', async () => {
    await expect(convertCv(cvOf('pdf', '%PDF'), new FakeLLM({ text: '  ' }))).rejects.toThrow(
      'came back empty',
    );
  });
});

describe('summariseCv', () => {
  it('finds the name, sections and roles', () => {
    expect(summariseCv(SAMPLE_MD)).toEqual({
      name: 'Alex Example',
      sections: ['Experience', 'Skills'],
      roles: 2,
      characters: SAMPLE_MD.length,
    });
  });

  it('copes with CVs that have no structure', () => {
    expect(summariseCv('just some text\n')).toEqual({ sections: [], roles: 0, characters: 15 });
  });
});
