import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../../config/fs.js';
import { cacheDir } from '../../config/paths.js';
import { ATS_IDS } from './ats.js';

const BoardStateSchema = z.object({
  /** Keyed by the full query, `site:` included. */
  searches: z.record(
    z.string(),
    z.object({ searchedAt: z.iso.datetime(), found: z.number().int().nonnegative() }),
  ),
  /** Keyed by `boardKey()`. */
  boards: z.record(
    z.string(),
    z.object({
      ats: z.enum(ATS_IDS),
      board: z.string().min(1),
      foundAt: z.iso.datetime(),
      lastFetchedAt: z.iso.datetime().optional(),
    }),
  ),
});
export type BoardState = z.infer<typeof BoardStateSchema>;
export type KnownBoard = BoardState['boards'][string];

export const boardKey = (board: Pick<KnownBoard, 'ats' | 'board'>): string =>
  `${board.ats}:${board.board.toLowerCase()}`;

/**
 * Company boards found by web search, and when each search ran. Cache, not config: losing it
 * means searching again, which DuckDuckGo only allows slowly, so a few searches per run.
 */
export const boardStateFile = (): string => join(cacheDir(), 'boards.json');

export async function loadBoardState(): Promise<BoardState> {
  try {
    return (await readJsonFile(boardStateFile(), BoardStateSchema)) ?? { searches: {}, boards: {} };
  } catch {
    // A broken cache file is not worth failing a hunt over.
    return { searches: {}, boards: {} };
  }
}

export async function saveBoardState(state: BoardState): Promise<void> {
  await writeJsonFile(boardStateFile(), state);
}
