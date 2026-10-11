import type { Derived, Preferences } from '../config/index.js';
import type { Job } from '../jobs/index.js';
import type { SalaryPeriod } from '../schema/enums.js';
import { titleKeywords, titleMatches, squash } from './keywords.js';
import { eligibleFor } from './places.js';

export interface FilterOptions {
  now: Date;
  /** Jobs posted longer ago than this are dropped. */
  maxAgeDays: number;
  /** Extra title keywords on top of the ones from the CV. */
  keywords?: readonly string[];
}

export interface FilterProfile {
  derived?: Pick<Derived, 'roles' | 'tech'> | undefined;
  preferences?: Preferences | undefined;
}

const HOURS_PER_YEAR = 2080;
const toYearly = (amount: number, period: SalaryPeriod | undefined) =>
  period === 'hour' ? amount * HOURS_PER_YEAR : period === 'month' ? amount * 12 : amount;

const label = (value: string) => value.replace(/_/g, '-');

/**
 * The code pre-filter: reasons to drop a job, or `[]` to send it on to the AI.
 * Every rule only drops a job when it's sure; missing or unclear data passes.
 */
export function filterJob(job: Job, profile: FilterProfile, options: FilterOptions): string[] {
  const { preferences } = profile;
  const reasons: string[] = [];

  if (!titleMatches(job.title, titleKeywords(profile.derived, options.keywords))) {
    reasons.push("title doesn't match your roles");
  }

  if (job.postedAt) {
    const days = Math.floor(
      (options.now.getTime() - new Date(job.postedAt).getTime()) / 86_400_000,
    );
    if (days > options.maxAgeDays) reasons.push(`posted ${String(days)} days ago`);
  }

  if (!preferences) return reasons;

  if (job.employmentType && !preferences.employmentTypes.includes(job.employmentType)) {
    reasons.push(`employment type: ${label(job.employmentType)}`);
  }

  if (job.workMode && !preferences.workModes.includes(job.workMode)) {
    reasons.push(`work mode: ${job.workMode}`);
  }

  if (job.workMode === 'remote' && preferences.remote && !job.location.worldwide) {
    const eligible = eligibleFor(job.location.regions, preferences.remote.eligibleCountries);
    if (eligible === false) {
      reasons.push(`remote only in ${job.location.text ?? job.location.regions.join(', ')}`);
    }
  }

  const minimum = preferences.minSalary;
  const top = job.salary?.max ?? job.salary?.min;
  if (minimum && top !== undefined && job.salary?.currency === minimum.currency) {
    if (toYearly(top, job.salary.period) < toYearly(minimum.amount, minimum.period)) {
      reasons.push(
        `salary below your minimum (${job.salary.text ?? `${String(top)} ${minimum.currency}/${job.salary.period ?? 'year'}`})`,
      );
    }
  }

  const company = job.company.toLowerCase();
  if (preferences.avoid?.companies.some((avoided) => company.includes(avoided.toLowerCase()))) {
    reasons.push('company on your avoid list');
  }
  const haystack = squash([job.title, job.company, ...job.tags].join(' '));
  const industry = preferences.avoid?.industries.find((avoided) =>
    haystack.includes(squash(avoided)),
  );
  if (industry) reasons.push(`industry on your avoid list: ${industry}`);

  return reasons;
}
