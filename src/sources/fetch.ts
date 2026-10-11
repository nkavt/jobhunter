import { applyMapping, parseFeed, type FeedMapping, type MappingResult } from '../mapping/index.js';
import { VERSION } from '../version.js';
import type { SourceDefinition } from './builtin.js';

const TIMEOUT_MS = 30_000;
export const USER_AGENT = `jobhunter/${VERSION} (+https://github.com/nkavt/jobhunter)`;

/** A source couldn't be fetched; the message names the source. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly source: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SourceError';
  }
}

export interface SourceResult extends MappingResult {
  source: SourceDefinition;
}

/** Download a source's feed and convert it into jobs with its mapping. */
export async function fetchSource(
  source: SourceDefinition,
  mappings: Record<string, FeedMapping>,
): Promise<SourceResult> {
  const mapping = mappings[source.mappingKey];
  if (!mapping) throw new SourceError(`No mapping for ${source.name}.`, source.id);

  let response: Response;
  try {
    response = await fetch(source.feedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          mapping.format === 'json' ? 'application/json' : 'application/rss+xml, application/xml',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SourceError(`Couldn't reach ${source.name}.`, source.id, { cause: error });
  }
  if (!response.ok) {
    throw new SourceError(
      `${source.name} answered with HTTP ${String(response.status)}.`,
      source.id,
    );
  }

  try {
    const feed = parseFeed(await response.text(), mapping.format);
    return { source, ...applyMapping(feed, mapping, source.id) };
  } catch (error) {
    throw new SourceError(
      `${source.name}: ${error instanceof Error ? error.message : String(error)}`,
      source.id,
      {
        cause: error,
      },
    );
  }
}
