import type { Job } from './job.js';

/** One job posted several times on a source, once per location. */
export interface SameJob<T> {
  /** The copy that represents the job: a remote or worldwide one if there is one. */
  first: T;
  /** The other copies, in the order they came. */
  others: T[];
}

/** Words that say how, not what: "Lead Engineer (Remote)" is "Lead Engineer". */
const HOW = /\b(remote|hybrid|on-?site|in-?office|fully)\b/gi;

/**
 * Jobs with the same source, company and title, once the title's place names are taken out:
 * "Lead Engineer - Vietnam" and "Lead Engineer (Singapore)" are the same job.
 */
export function sameJobKey(job: Job): string {
  let title = job.title.toLowerCase();
  for (const place of [job.location.text, ...job.location.regions]) {
    if (place && place.trim().length > 1) title = title.split(place.trim().toLowerCase()).join(' ');
  }
  const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return [job.source, plain(job.company), plain(title.replace(HOW, ' '))].join('\n');
}

const open = (job: Job) => job.workMode === 'remote' || job.location.worldwide === true;

/**
 * Group copies of the same job (see `sameJobKey`), keeping the order the jobs came in.
 *
 * @example
 * groupSameJobs([vietnam, singapore, other], (job) => job)
 * // [{ first: vietnam, others: [singapore] }, { first: other, others: [] }]
 */
export function groupSameJobs<T>(items: readonly T[], jobOf: (item: T) => Job): SameJob<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = sameJobKey(jobOf(item));
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].flatMap((group) => {
    const first = group.find((item) => open(jobOf(item))) ?? group[0];
    return first === undefined ? [] : [{ first, others: group.filter((item) => item !== first) }];
  });
}

/** "Vietnam (remote)", "anywhere (remote)", "not stated". */
function place(job: Job): string {
  const where = job.location.worldwide
    ? 'anywhere'
    : (job.location.text ?? (job.location.regions.join(', ') || 'not stated'));
  return job.workMode ? `${where} (${job.workMode})` : where;
}

/**
 * The job as the AI sees it: the first copy, with every copy's location in its Location line
 * ("Vietnam (remote); Germany (remote)"), so the job is judged once against all of them.
 */
export function withAllLocations(group: SameJob<Job>): Job {
  if (group.others.length === 0) return group.first;
  const places = [...new Set([group.first, ...group.others].map(place))];
  const regions = [
    ...new Set([group.first, ...group.others].flatMap((job) => job.location.regions)),
  ];
  // Each place says its own work mode.
  const job: Job = { ...group.first, location: { text: places.join('; '), regions } };
  delete job.workMode;
  return job;
}
