import type { Preferences } from '../config/index.js';
import type { Job } from '../jobs/index.js';
import { formatSalary, formatTimezone } from '../profile/preferences.js';

const label = (value: string) => value.replace(/_/g, '-');

/** The user's preferences as plain sentences for the AI. */
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

/** One job as text for the AI, under a short uid; long descriptions are cut. */
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
