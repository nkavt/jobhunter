import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../config/fs.js';
import { cacheDir } from '../config/paths.js';
import type { SourceDefinition } from './builtin.js';

const SourceStateSchema = z.record(
  z.string(),
  z.object({ lastFetchedAt: z.iso.datetime(), lastJobCount: z.number().int().nonnegative() }),
);
export type SourceState = z.infer<typeof SourceStateSchema>;

/** When each source was last fetched. Cache, not config: losing it only means fetching again. */
export const sourceStateFile = (): string => join(cacheDir(), 'sources.json');

export async function loadSourceState(): Promise<SourceState> {
  try {
    return (await readJsonFile(sourceStateFile(), SourceStateSchema)) ?? {};
  } catch {
    // A broken cache file is not worth failing a hunt over.
    return {};
  }
}

export async function saveSourceState(state: SourceState): Promise<void> {
  await writeJsonFile(sourceStateFile(), state);
}

/** When a source may be fetched again, or `undefined` if it's due now. */
export function nextFetchAt(
  source: SourceDefinition,
  state: SourceState,
  now: Date,
): Date | undefined {
  const last = state[source.id]?.lastFetchedAt;
  if (!last) return undefined;
  const next = new Date(new Date(last).getTime() + source.minIntervalHours * 3_600_000);
  return next > now ? next : undefined;
}
