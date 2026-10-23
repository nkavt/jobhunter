import mammoth from 'mammoth';
import { extractText } from 'unpdf';

/** A document that can't be read, or has no text in it. The message is meant for the user. */
export class DocumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocumentError';
  }
}

/** The text of a PDF, all pages joined. `name` is how messages refer to the file. */
export async function pdfText(data: Uint8Array, name = 'this PDF'): Promise<string> {
  let text: string;
  try {
    // A copy: PDF.js takes ownership of the buffer it's given.
    ({ text } = await extractText(new Uint8Array(data), { mergePages: true }));
  } catch (error) {
    throw new DocumentError(`Can't read ${name}. Is it a valid PDF?`, { cause: error });
  }
  if (!text.trim()) {
    throw new DocumentError(
      `No text found in ${name}; it may be scanned images. Try a .docx, .md or .txt version.`,
    );
  }
  return text.trim();
}

/** The text of a Word (.docx) document. `name` is how messages refer to the file. */
export async function docxText(data: Uint8Array, name = 'this Word document'): Promise<string> {
  let value: string;
  try {
    ({ value } = await mammoth.extractRawText({ buffer: Buffer.from(data) }));
  } catch (error) {
    throw new DocumentError(`Can't read ${name}. Is it a valid .docx file?`, { cause: error });
  }
  if (!value.trim()) throw new DocumentError(`No text found in ${name}.`);
  return value;
}
