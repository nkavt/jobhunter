import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../../config/fs.js';
import { cacheDir } from '../../config/paths.js';
import { ATS_IDS } from './ats.js';

const SearchSchema = z.object({
  searchedAt: z.iso.datetime(),
  found: z.number().int().nonnegative(),
});
const BoardSchema = z.object({
  ats: z.enum(ATS_IDS),
  board: z.string().min(1),
  foundAt: z.iso.datetime(),
  lastFetchedAt: z.iso.datetime().optional(),
});
export type KnownBoard = z.infer<typeof BoardSchema>;

export interface BoardState {
  /** Keyed by the full query, `site:` included. */
  searches: Record<string, z.infer<typeof SearchSchema>>;
  /** Keyed by `boardKey()`. */
  boards: Record<string, KnownBoard>;
}

/** The file as read: entries are checked one by one, so one bad entry doesn't lose the rest. */
const StoredStateSchema = z.object({
  searches: z.record(z.string(), z.unknown()).catch({}),
  boards: z.record(z.string(), z.unknown()).catch({}),
});

export const boardKey = (board: Pick<KnownBoard, 'ats' | 'board'>): string =>
  `${board.ats}:${board.board.toLowerCase()}`;

/**
 * Company boards found by web search, and when each search ran. Cache, not config: losing it
 * just means running `jobhunter companies find` again.
 */
export const boardStateFile = (): string => join(cacheDir(), 'boards.json');

export async function loadBoardState(): Promise<BoardState> {
  let stored: z.infer<typeof StoredStateSchema> | undefined;
  try {
    stored = await readJsonFile(boardStateFile(), StoredStateSchema);
  } catch {
    // Not even JSON: nothing to keep, and not worth failing a hunt over.
    return { searches: {}, boards: {} };
  }
  if (!stored) return { searches: {}, boards: {} };
  // Entries this version can't read (a hand edit, an ATS it doesn't know) are dropped alone.
  return {
    searches: validEntries(stored.searches, SearchSchema),
    boards: validEntries(stored.boards, BoardSchema),
  };
}

function validEntries<T>(
  entries: Record<string, unknown>,
  schema: z.ZodType<T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, value]) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? [[key, parsed.data] as const] : [];
    }),
  );
}

export async function saveBoardState(state: BoardState): Promise<void> {
  await writeJsonFile(boardStateFile(), state);
}
