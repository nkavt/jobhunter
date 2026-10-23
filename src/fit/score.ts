import { z } from 'zod';
import type { Preferences } from '../config/index.js';
import type { Job } from '../jobs/index.js';
import { addUsage, emptyUsage, type LLMAdapter, type Usage } from '../llm/index.js';
import { renderSystemPrompt, renderUserPrompt } from '../prompts/index.js';
import { describeJob, describePreferences } from './describe.js';

/** Score a job needs to land in "To apply" when the user hasn't set `preferences.minScore`. */
export const DEFAULT_MIN_SCORE = 50;
/** Jobs sent to the AI in one request. */
export const BATCH_SIZE = 5;

/** The user's cut-off: their `minScore` preference, or the default. */
export function minScoreFor(preferences: Preferences | undefined): number {
  return preferences?.minScore ?? DEFAULT_MIN_SCORE;
}

export interface Candidate {
  /** `instructions.md`: the candidate profile written for scoring. */
  instructions: string;
  cv: string;
  preferences?: Preferences | undefined;
}

export interface Fit {
  score: number;
  note: string;
}

export interface ScoreOptions {
  batchSize?: number;
  /** Batches scored at the same time, after the first (default 4). */
  concurrency?: number;
  maxDescriptionChars?: number;
  /** Other postings of each job, by index (the same job in other locations), shown with it. */
  copies?: readonly (readonly Job[])[];
  /** Called after each batch, e.g. to update a progress line. */
  onBatch?: (done: number, total: number) => void;
}

const ResultSchema = z.object({
  uid: z.string(),
  score: z.number().int().min(0).max(100),
  note: z.string().min(1),
});

/** One result per job sent, no unknown or repeated uids. */
function batchSchema(uids: readonly string[]) {
  return z.object({ results: z.array(ResultSchema) }).superRefine((value, ctx) => {
    const seen = value.results.map((result) => result.uid);
    const missing = uids.filter((uid) => !seen.includes(uid));
    const unknown = seen.filter((uid) => !uids.includes(uid));
    const repeated = seen.filter((uid, index) => seen.indexOf(uid) !== index);
    if (missing.length)
      ctx.addIssue({
        code: 'custom',
        path: ['results'],
        message: `missing results for ${missing.join(', ')}`,
      });
    if (unknown.length)
      ctx.addIssue({
        code: 'custom',
        path: ['results'],
        message: `unknown uids ${unknown.join(', ')}`,
      });
    if (repeated.length)
      ctx.addIssue({
        code: 'custom',
        path: ['results'],
        message: `repeated uids ${repeated.join(', ')}`,
      });
  });
}

/**
 * Ask the AI how well each job fits. The system prompt (rules + candidate + preferences) is the
 * same for every batch, so it's cached; only the jobs change. Results follow the order of `jobs`.
 *
 * The first batch runs alone so it writes the prompt cache; the rest then run a few at a time and
 * read it. Starting them all at once would make each one pay to write the cache, and would run
 * into the provider's per-minute limits on smaller accounts.
 */
export async function scoreJobs(
  jobs: readonly Job[],
  candidate: Candidate,
  llm: LLMAdapter,
  options: ScoreOptions = {},
): Promise<{ fits: Fit[]; usage: Usage }> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxDescriptionChars = options.maxDescriptionChars ?? 4000;
  const system = renderSystemPrompt('job-fit', {
    candidate: candidate.instructions.trim(),
    cv: candidate.cv.trim(),
    preferences: describePreferences(candidate.preferences),
    // Same cut-off hunt uses for To apply vs Skipped, so "Declined:" notes match the status.
    minScore: String(minScoreFor(candidate.preferences)),
  });

  const batches: Job[][] = [];
  for (let start = 0; start < jobs.length; start += batchSize) {
    batches.push(jobs.slice(start, start + batchSize));
  }

  const results: Fit[][] = [];
  let usage = emptyUsage();
  let done = 0;
  const score = async (index: number) => {
    const batch = batches[index] ?? [];
    const uids = batch.map((_, i) => `j${String(i + 1)}`);
    const { data, usage: batchUsage } = await llm.generateJSON({
      system,
      cacheSystem: true,
      prompt: renderUserPrompt('job-fit', {
        jobs: batch
          .map((job, i) =>
            describeJob(
              job,
              uids[i] ?? '',
              maxDescriptionChars,
              options.copies?.[index * batchSize + i],
            ),
          )
          .join('\n\n'),
      }),
      schema: batchSchema(uids),
      schemaName: 'job_fit',
      // A ceiling, not a cost: notes run long with some models, and a cut-off loses the whole batch.
      maxTokens: 1000 + batch.length * 500,
    });
    const byUid = new Map(data.results.map((result) => [result.uid, result]));
    results[index] = uids.flatMap((uid) => {
      const result = byUid.get(uid);
      return result ? [{ score: result.score, note: result.note }] : [];
    });
    usage = addUsage(usage, batchUsage);
    done += batch.length;
    options.onBatch?.(done, jobs.length);
  };

  if (batches.length > 0) await score(0);
  let next = 1;
  let failed = false;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const index = next++;
      try {
        await score(index);
      } catch (error) {
        // Stop starting new batches; the run fails with this error.
        failed = true;
        throw error;
      }
    }
  };
  const workers = Math.min(Math.max(options.concurrency ?? 4, 1), batches.length - 1);
  await Promise.all(Array.from({ length: Math.max(workers, 0) }, worker));

  const fits = results.flat();
  return { fits, usage };
}
