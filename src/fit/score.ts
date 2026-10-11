import { z } from 'zod';
import type { Preferences } from '../config/index.js';
import type { Job } from '../jobs/index.js';
import { addUsage, emptyUsage, type LLMAdapter, type Usage } from '../llm/index.js';
import { renderSystemPrompt, renderUserPrompt } from '../prompts/index.js';
import { describeJob, describePreferences } from './describe.js';

/** Score a job needs to land in "To apply" when the user hasn't set `preferences.minScore`. */
export const DEFAULT_MIN_SCORE = 50;

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
  maxDescriptionChars?: number;
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
 */
export async function scoreJobs(
  jobs: readonly Job[],
  candidate: Candidate,
  llm: LLMAdapter,
  options: ScoreOptions = {},
): Promise<{ fits: Fit[]; usage: Usage }> {
  const batchSize = options.batchSize ?? 8;
  const maxDescriptionChars = options.maxDescriptionChars ?? 4000;
  const system = renderSystemPrompt('job-fit', {
    candidate: candidate.instructions.trim(),
    cv: candidate.cv.trim(),
    preferences: describePreferences(candidate.preferences),
    // Same cut-off hunt uses for To apply vs Skipped, so "Declined:" notes match the status.
    minScore: String(minScoreFor(candidate.preferences)),
  });

  const fits: Fit[] = [];
  let usage = emptyUsage();
  for (let start = 0; start < jobs.length; start += batchSize) {
    const batch = jobs.slice(start, start + batchSize);
    const uids = batch.map((_, index) => `j${String(index + 1)}`);
    const { data, usage: batchUsage } = await llm.generateJSON({
      system,
      cacheSystem: true,
      prompt: renderUserPrompt('job-fit', {
        jobs: batch
          .map((job, index) => describeJob(job, uids[index] ?? '', maxDescriptionChars))
          .join('\n\n'),
      }),
      schema: batchSchema(uids),
      schemaName: 'job_fit',
      // A ceiling, not a cost: notes run long with some models, and a cut-off loses the whole batch.
      maxTokens: 1000 + batch.length * 500,
    });
    const byUid = new Map(data.results.map((result) => [result.uid, result]));
    for (const uid of uids) {
      const result = byUid.get(uid);
      if (result) fits.push({ score: result.score, note: result.note });
    }
    usage = addUsage(usage, batchUsage);
    options.onBatch?.(Math.min(start + batchSize, jobs.length), jobs.length);
  }
  return { fits, usage };
}
