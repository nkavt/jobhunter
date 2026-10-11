import { describe, expect, it } from 'vitest';
import type { Preferences } from '../../src/config/index.js';
import { filterJob, type FilterProfile } from '../../src/filter/index.js';
import type { Job } from '../../src/jobs/index.js';

const now = new Date('2026-10-11T12:00:00Z');
const options = { now, maxAgeDays: 30 };

const preferences: Preferences = {
  workModes: ['remote'],
  remote: { eligibleCountries: ['GE'] },
  visaSponsorshipNeeded: false,
  employmentTypes: ['full_time', 'contract'],
  minSalary: { amount: 60000, currency: 'USD', period: 'year' },
  avoid: { industries: ['gambling'], companies: ['Initech'] },
};
const profile: FilterProfile = {
  derived: { roles: ['Senior Frontend Engineer'], tech: { primary: ['React'], secondary: [] } },
  preferences,
};

const job = (patch: Partial<Job> = {}): Job => ({
  source: 'remotive',
  sourceId: '1',
  url: 'https://remotive.com/remote-jobs/1',
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: { text: 'Worldwide', worldwide: true, regions: [] },
  workMode: 'remote',
  employmentType: 'full_time',
  postedAt: '2026-10-08T10:00:00.000Z',
  description: '',
  tags: [],
  ...patch,
});

describe('filterJob', () => {
  it('passes a job that fits every preference', () => {
    expect(filterJob(job(), profile, options)).toEqual([]);
  });

  it.each([
    [{ title: 'Inside Sales Contractor' }, "title doesn't match your roles"],
    [{ postedAt: '2026-08-01T00:00:00.000Z' }, 'posted 71 days ago'],
    [{ employmentType: 'part_time' as const }, 'employment type: part-time'],
    [{ workMode: 'onsite' as const }, 'work mode: onsite'],
    [
      {
        salary: {
          min: 40000,
          max: 50000,
          currency: 'USD',
          period: 'year' as const,
          text: '$40k - $50k',
        },
      },
      'salary below your minimum ($40k - $50k)',
    ],
    [
      { salary: { min: 20, max: 25, currency: 'USD', period: 'hour' as const } },
      'salary below your minimum (25 USD/hour)',
    ],
    [{ company: 'Initech Ltd' }, 'company on your avoid list'],
    [{ tags: ['Online Gambling'] }, 'industry on your avoid list: gambling'],
  ])('drops %j', (patch, reason) => {
    expect(filterJob(job(patch), profile, options)).toEqual([reason]);
  });

  it('passes when data is missing or unclear', () => {
    expect(
      filterJob(
        job({
          employmentType: undefined,
          postedAt: undefined,
          location: { text: 'USA timezones', regions: ['USA timezones'] },
          salary: { text: 'Competitive' },
        }),
        profile,
        options,
      ),
    ).toEqual([]);
  });

  it('leaves location limits to the AI', () => {
    expect(
      filterJob(
        job({ location: { text: 'North America Only', regions: ['North America'] } }),
        profile,
        options,
      ),
    ).toEqual([]);
    expect(
      filterJob(job({ location: { text: 'USA', regions: ['USA'] } }), profile, options),
    ).toEqual([]);
  });

  it('does not compare salaries in different currencies, and accepts hourly pay above the minimum', () => {
    expect(
      filterJob(job({ salary: { max: 40000, currency: 'EUR', period: 'year' } }), profile, options),
    ).toEqual([]);
    expect(
      filterJob(
        job({ salary: { min: 45, max: 120, currency: 'USD', period: 'hour' } }),
        profile,
        options,
      ),
    ).toEqual([]);
  });

  it('collects every reason', () => {
    expect(
      filterJob(job({ title: 'Account Executive', employmentType: 'part_time' }), profile, options),
    ).toEqual(["title doesn't match your roles", 'employment type: part-time']);
  });

  it('uses extra keywords and works without preferences', () => {
    expect(
      filterJob(job({ title: 'Vue Developer' }), profile, { ...options, keywords: ['vue'] }),
    ).toEqual([]);
    expect(
      filterJob(job({ employmentType: 'part_time' }), { derived: profile.derived }, options),
    ).toEqual([]);
  });
});
