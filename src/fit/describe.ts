import type { Preferences } from '../config/index.js';
import type { Job } from '../jobs/index.js';
import { formatSalary, formatTimezone } from '../profile/preferences.js';

const label = (value: string) => value.replace(/_/g, '-');

/**
 * The user's preferences as plain sentences for the AI. Lines for things the user didn't set
 * (onsite, salary, avoid lists) are left out.
 *
 * @example
 * describePreferences(preferences)
 * // Work mode: remote.
 * // Remote: can legally work from GE, timezone UTC+4 ±3h.
 * // Visa sponsorship needed: no.
 * // Employment type: full-time.
 * // Minimum salary: 60000 USD/year.
 *
 * // With hybrid work and avoid lists:
 * // Work mode: hybrid.
 * // Onsite/hybrid: Tbilisi, Berlin; relocating only to DE, NL.
 * // …
 * // Avoid industries: gambling.
 * // Avoid companies: Initech.
 */
export function describePreferences(preferences: Preferences | undefined): string {
  if (!preferences) return 'No preferences given.';
  const lines = [`Work mode: ${preferences.workModes.join(', ')}.`];
  if (preferences.remote) {
    const zone = preferences.remote.timezone
      ? `, timezone ${formatTimezone(preferences.remote.timezone)}`
      : '';
    lines.push(
      `Remote: can legally work from ${preferences.remote.eligibleCountries.join(', ')}${zone}.`,
    );
  }
  if (preferences.onsite) {
    const relocation =
      preferences.onsite.relocation === 'yes'
        ? 'open to relocating anywhere'
        : preferences.onsite.relocation === 'no'
          ? 'not relocating'
          : `relocating only to ${preferences.onsite.relocation.join(', ')}`;
    lines.push(`Onsite/hybrid: ${preferences.onsite.cities.join(', ')}; ${relocation}.`);
  }
  lines.push(`Visa sponsorship needed: ${preferences.visaSponsorshipNeeded ? 'yes' : 'no'}.`);
  lines.push(`Employment type: ${preferences.employmentTypes.map(label).join(', ')}.`);
  if (preferences.minSalary) lines.push(`Minimum salary: ${formatSalary(preferences.minSalary)}.`);
  if (preferences.avoid?.industries.length)
    lines.push(`Avoid industries: ${preferences.avoid.industries.join(', ')}.`);
  if (preferences.avoid?.companies.length)
    lines.push(`Avoid companies: ${preferences.avoid.companies.join(', ')}.`);
  return lines.join('\n');
}

/**
 * One job as text for the AI, under a short uid. Fields the job doesn't have are left out;
 * descriptions longer than `maxDescriptionChars` are cut and marked.
 *
 * @example
 * describeJob(job, 'j1', 4000)
 * // <job uid="j1">
 * // Title: Frontend Engineer 1
 * // Company: Acme
 * // Location: anywhere
 * // Work mode: remote
 * // Employment type: full-time
 * // Salary: $80k - $150k
 * // Tags: react
 * //
 * // We are hiring a frontend engineer to…
 * // </job>
 *
 * // Sparse job: no location text, salary only as numbers, no description:
 * // Location: not stated
 * // Salary: 40–48 USD/hour
 * // (no description)
 *
 * // Cut description: "…first 4000 characters… [cut]"
 */
export function describeJob(job: Job, uid: string, maxDescriptionChars: number): string {
  const salary = job.salary
    ? (job.salary.text ??
      [job.salary.min, job.salary.max].filter((n) => n !== undefined).join('–') +
        ` ${job.salary.currency ?? ''}/${job.salary.period ?? 'year'}`)
    : undefined;
  const description =
    job.description.length > maxDescriptionChars
      ? `${job.description.slice(0, maxDescriptionChars)}… [cut]`
      : job.description;
  const fields = [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location.worldwide ? 'anywhere' : (job.location.text ?? 'not stated')}`,
    job.workMode ? `Work mode: ${job.workMode}` : undefined,
    job.employmentType ? `Employment type: ${label(job.employmentType)}` : undefined,
    salary ? `Salary: ${salary.trim()}` : undefined,
    job.tags.length > 0 ? `Tags: ${job.tags.join(', ')}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return `<job uid="${uid}">\n${fields.join('\n')}\n\n${description || '(no description)'}\n</job>`;
}
