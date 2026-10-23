import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { LLMAdapter, Usage } from '../llm/index.js';
import { emptyUsage } from '../llm/index.js';
import { renderSystemPrompt, renderUserPrompt } from '../prompts/index.js';
import { DocumentError, docxText } from '../util/document-text.js';
import { resolveUserPath } from '../util/user-path.js';

export const MAX_CV_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_CV_EXTENSIONS = ['.pdf', '.docx', '.md', '.markdown', '.txt'] as const;

/** A problem with the CV file the user can fix (wrong path, unsupported type…). */
export class CvError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CvError';
  }
}

export interface LoadedCv {
  /** Absolute path of the original file. */
  path: string;
  kind: 'pdf' | 'docx' | 'markdown' | 'text';
  data: Buffer;
  sha256: string;
}

export interface ConvertedCv {
  markdown: string;
  usage: Usage;
}

/** Resolve a CV path the user typed or dragged into the terminal. */
export const resolveCvPath = resolveUserPath;

export async function loadCv(input: string, cwd?: string): Promise<LoadedCv> {
  const path = resolveCvPath(input, cwd);
  const kind = kindOf(path);

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new CvError(`${path} is not a file.`);
    size = info.size;
  } catch (error) {
    if (error instanceof CvError) throw error;
    throw new CvError(`Can't find ${path}.`, { cause: error });
  }
  if (size === 0) throw new CvError(`${path} is empty.`);
  if (size > MAX_CV_BYTES) {
    throw new CvError(`${path} is larger than ${String(MAX_CV_BYTES / 1024 / 1024)} MB.`);
  }

  const data = await readFile(path);
  return { path, kind, data, sha256: createHash('sha256').update(data).digest('hex') };
}

function kindOf(path: string): LoadedCv['kind'] {
  switch (extname(path).toLowerCase()) {
    case '.pdf':
      return 'pdf';
    case '.docx':
      return 'docx';
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.txt':
      return 'text';
    default:
      throw new CvError(
        `Unsupported CV format. Use one of: ${SUPPORTED_CV_EXTENSIONS.join(', ')}.`,
      );
  }
}

/**
 * Convert the CV to Markdown. PDFs go to the model as documents, DOCX is extracted to text
 * first; both are then structured by the model. Markdown and plain text are used as-is.
 */
export async function convertCv(cv: LoadedCv, llm: LLMAdapter): Promise<ConvertedCv> {
  if (cv.kind === 'markdown' || cv.kind === 'text') {
    return { markdown: normalise(cv.data.toString('utf8')), usage: emptyUsage() };
  }

  // PDFs are attached as a document; Word files are extracted to text and sent inline.
  const { text, usage } = await llm.generateText({
    system: renderSystemPrompt('cv-to-markdown'),
    maxTokens: 8192,
    ...(cv.kind === 'pdf'
      ? {
          prompt: renderUserPrompt('cv-to-markdown', { cv: '' }),
          files: [{ mimeType: 'application/pdf', data: cv.data, name: 'cv.pdf' }],
        }
      : {
          prompt: renderUserPrompt('cv-to-markdown', {
            cv: `\n<cv>\n${await wordText(cv.data)}\n</cv>`,
          }),
        }),
  });

  const markdown = normalise(stripCodeFence(text));
  if (!markdown) throw new CvError('The CV came back empty after conversion.');
  return { markdown, usage };
}

async function wordText(data: Buffer): Promise<string> {
  try {
    return await docxText(data);
  } catch (error) {
    if (error instanceof DocumentError) throw new CvError(error.message, { cause: error });
    throw error;
  }
}

/** Models sometimes wrap the answer in ```markdown fences despite instructions. */
function stripCodeFence(text: string): string {
  const match = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return match?.[1] ?? text;
}

function normalise(markdown: string): string {
  return `${markdown.replace(/\r\n?/g, '\n').trim()}\n`.replace(/^\n$/, '');
}

export interface CvSummary {
  name?: string;
  sections: string[];
  roles: number;
  characters: number;
}

/** What the preview shows: the `#` name, `##` sections and number of `###` roles. */
export function summariseCv(markdown: string): CvSummary {
  const lines = markdown.split('\n');
  const name = lines
    .find((line) => line.startsWith('# '))
    ?.slice(2)
    .trim();
  return {
    ...(name ? { name } : {}),
    sections: lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim()),
    roles: lines.filter((line) => line.startsWith('### ')).length,
    characters: markdown.length,
  };
}
