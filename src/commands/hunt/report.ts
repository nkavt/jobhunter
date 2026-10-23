import type { TrackedJob } from '../../tracker/index.js';
import { dim, type Ui } from '../../ui/index.js';
import type { HuntOptions, HuntSummary } from './types.js';

/** "12 Skipped · 3 To apply"; optional counts are left out when they are zero. */
const counts = (parts: [number, string, 'optional'?][]) =>
  parts
    .filter(([count, , optional]) => count > 0 || !optional)
    .map(([count, label]) => `${String(count)} ${label}`)
    .join(' · ');

/** The end of a run: the best matches, what happened to every job, and the AI tokens used. */
export function report(
  ui: Ui,
  summary: HuntSummary,
  tracked: TrackedJob[],
  maxAiJobs: number,
  options: HuntOptions,
): void {
  const best = tracked.filter((item) => item.status === 'To apply').slice(0, 10);
  if (best.length > 0) {
    ui.info('');
    ui.info('Best matches:');
    for (const item of best) {
      const score = item.score === undefined ? '  –' : String(item.score).padStart(3);
      ui.info(`${score}  ${item.job.title} · ${item.job.company} ${dim(`(${item.channel})`)}`);
      if (item.note) ui.info(dim(`     ${item.note}`));
    }
  }

  ui.info('');
  const fresh = summary.fetched - summary.known - summary.duplicates;
  ui.success(
    counts([
      [summary.fetched, 'jobs'],
      [summary.known, 'already in your sheet'],
      [summary.duplicates, 'duplicates', 'optional'],
      [fresh, 'new'],
    ]) +
      ' → ' +
      counts([
        [summary.ignored, 'ignored by your filters'],
        [summary.sameJob, 'copies for other locations', 'optional'],
        [summary.toApply, 'To apply'],
        [summary.skipped, 'Skipped'],
      ]),
  );
  if (summary.usage) {
    const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
    const { inputTokens, cacheReadTokens, outputTokens } = summary.usage;
    ui.info(
      dim(
        `AI tokens: ${k(inputTokens + cacheReadTokens)} in (${k(cacheReadTokens)} from cache), ${k(outputTokens)} out`,
      ),
    );
  }
  if (summary.deferred > 0) {
    ui.info(
      `${String(summary.deferred)} more jobs passed your filters but weren't scored (limit ${String(maxAiJobs)} per run); a later run picks them up while they're still listed. To score more now, run \`jobhunter hunt --force --max-ai-jobs <n>\`: --force fetches them again, since every source was just checked.`,
    );
  }
  if (options.dryRun) ui.info(dim('Dry run: nothing was written to your sheet.'));
}
