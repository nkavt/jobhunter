import { describe, expect, it, vi } from 'vitest';
import { DocumentError, docxText, pdfText } from '../../src/util/document-text.js';
import { pdfWithText } from '../helpers/pdf.js';

vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(({ buffer }: { buffer: Buffer }) => {
      const text = buffer.toString();
      if (text === 'corrupt') return Promise.reject(new Error('Could not find file in options'));
      return Promise.resolve({ value: text === 'blank' ? '  ' : 'Alex Example', messages: [] });
    }),
  },
}));

const bytes = (text: string) => new TextEncoder().encode(text);

describe('pdfText', () => {
  it('returns the text of the PDF', async () => {
    await expect(pdfText(pdfWithText('Alex Doe, Engineer'))).resolves.toBe('Alex Doe, Engineer');
  });

  it('reads a PDF that makes PDF.js warn, keeping the warning out of the terminal', async () => {
    // A wrong `startxref` offset: PDF.js warns "Indexing all PDF objects" and reads it anyway.
    const pdf = new TextDecoder().decode(pdfWithText('Alex'));
    const damaged = bytes(pdf.replace(/startxref\n\d+/, 'startxref\n9'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(pdfText(damaged)).resolves.toBe('Alex');
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('fails clearly on a file that is not a PDF, naming it', async () => {
    const error = pdfText(new Uint8Array([1, 2, 3]), 'cv.pdf');
    await expect(error).rejects.toThrow(DocumentError);
    await expect(error).rejects.toThrow("Can't read cv.pdf. Is it a valid PDF?");
  });

  it('fails clearly on a PDF without text', async () => {
    await expect(pdfText(pdfWithText(''))).rejects.toThrow(
      'No text found in this PDF; it may be scanned images.',
    );
  });
});

describe('docxText', () => {
  it('returns the text of the document', async () => {
    await expect(docxText(bytes('ok'))).resolves.toBe('Alex Example');
  });

  it('fails clearly on an unreadable or empty document', async () => {
    await expect(docxText(bytes('corrupt'))).rejects.toThrow(
      "Can't read this Word document. Is it a valid .docx file?",
    );
    await expect(docxText(bytes('blank'), 'cv.docx')).rejects.toThrow('No text found in cv.docx.');
  });
});
