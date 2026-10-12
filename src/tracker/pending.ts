import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { writeJsonFile } from '../config/fs.js';
import type { Cell } from './rows.js';

/**
 * Rows that couldn't be written because the tracking sheet was open, kept until the next run.
 * Stored as cells by header, so AI results already paid for are never lost.
 */
export interface PendingRows {
  applications: Record<string, Cell>[];
  ignored: Record<string, Cell>[];
}

const RowSchema = z.record(z.string(), z.union([z.string(), z.number()]));
const PendingSchema = z.object({
  applications: z.array(RowSchema).default([]),
  ignored: z.array(RowSchema).default([]),
});

export const pendingCount = (pending: PendingRows): number =>
  pending.applications.length + pending.ignored.length;

/** What's waiting, or `undefined` when nothing is (or the file is unreadable). */
export async function loadPending(file: string): Promise<PendingRows | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const pending = PendingSchema.parse(JSON.parse(raw));
    return pendingCount(pending) > 0 ? pending : undefined;
  } catch {
    return undefined;
  }
}

/** Add rows to what's already waiting. */
export async function savePending(file: string, rows: Partial<PendingRows>): Promise<void> {
  const pending = (await loadPending(file)) ?? { applications: [], ignored: [] };
  pending.applications.push(...(rows.applications ?? []));
  pending.ignored.push(...(rows.ignored ?? []));
  await writeJsonFile(file, pending);
}

export async function clearPending(file: string): Promise<void> {
  await rm(file, { force: true });
}
