import { XMLParser } from 'fast-xml-parser';
import type { FeedMapping } from './schema.js';

/** A feed's body couldn't be parsed in the expected format. */
export class FeedParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FeedParseError';
  }
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep values as text: IDs like "007" or job titles like "1234" must not become numbers.
  parseTagValue: false,
  trimValues: true,
});

export function parseFeed(body: string, format: FeedMapping['format']): unknown {
  if (format === 'json') {
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new FeedParseError("The feed isn't valid JSON.", { cause: error });
    }
  }
  // The XML parser is lenient; a feed with no elements at all is treated as invalid.
  const parsed = xml.parse(body) as Record<string, unknown>;
  if (Object.keys(parsed).filter((key) => key !== '?xml').length === 0) {
    throw new FeedParseError("The feed isn't valid XML.");
  }
  return parsed;
}
