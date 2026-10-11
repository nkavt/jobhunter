import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  loadProfile,
  NotInitializedError,
  PreferencesSchema,
  profileFile,
  ProfileNameSchema,
  readProfile,
  saveProfile,
  type Profile,
} from '../../src/config/index.js';
import { useTempHome } from '../helpers/temp-home.js';

const fullProfile: Profile = {
  version: 1,
  name: 'default',
  cv: {
    sourcePath: '/home/test/cv.pdf',
    sha256: 'a'.repeat(64),
    parsedAt: '2026-10-11T10:00:00.000Z',
  },
  derived: {
    roles: ['Senior Frontend Engineer'],
    seniority: 'senior',
    yearsOfExperience: 8,
    tech: { primary: ['TypeScript', 'React'], secondary: ['AWS'] },
    domains: ['fintech'],
    languages: ['English'],
    location: 'Tbilisi, GE',
  },
  preferences: {
    workModes: ['remote', 'hybrid'],
    remote: { eligibleCountries: ['GE'], timezone: { base: 'UTC+4', toleranceHours: 3 } },
    onsite: { cities: ['Tbilisi'], relocation: 'no' },
    visaSponsorshipNeeded: false,
    employmentTypes: ['full_time', 'contract'],
    minSalary: { amount: 60000, currency: 'EUR', period: 'year' },
    avoid: { industries: ['gambling'], companies: [] },
  },
  sheet: { spreadsheetId: 'sheet-123', folderId: 'folder-1', columns: null, statusMap: null },
};

describe('profile.json', () => {
  useTempHome();

  it('stores a full profile under profiles/<name>/ and reads it back', async () => {
    await saveProfile(fullProfile);
    await expect(access(profileFile('default'))).resolves.toBeUndefined();
    expect(await loadProfile('default')).toEqual(fullProfile);
  });

  it('accepts a freshly started profile with only identity fields', async () => {
    await saveProfile({ version: 1, name: 'default' });
    expect(await loadProfile('default')).toEqual({ version: 1, name: 'default' });
  });

  it('distinguishes local-only tracking (sheet: null) from not set up', async () => {
    await saveProfile({ version: 1, name: 'default', sheet: null });
    expect((await loadProfile('default')).sheet).toBeNull();
  });

  it('throws NotInitializedError naming the missing profile', async () => {
    expect(await readProfile('backend')).toBeUndefined();
    await expect(loadProfile('backend')).rejects.toThrow(NotInitializedError);
    await expect(loadProfile('backend')).rejects.toThrow('Profile "backend"');
  });

  it('rejects profile names that are unsafe as directory names', async () => {
    for (const name of ['../evil', 'Default', 'a/b', '', '-x']) {
      expect(ProfileNameSchema.safeParse(name).success, name).toBe(false);
    }
    await expect(readProfile('../evil')).rejects.toThrow();
  });
});

describe('PreferencesSchema', () => {
  const base = {
    workModes: ['onsite'],
    visaSponsorshipNeeded: true,
    employmentTypes: ['full_time'],
  };

  it('accepts relocation as no, yes, or a list of countries', () => {
    for (const relocation of ['no', 'yes', ['DE', 'NL']]) {
      const result = PreferencesSchema.safeParse({
        ...base,
        onsite: { cities: ['Berlin'], relocation },
      });
      expect(result.success, JSON.stringify(relocation)).toBe(true);
    }
  });

  it('rejects malformed country, currency and timezone values', () => {
    const invalid = [
      { remote: { eligibleCountries: ['Georgia'] } },
      { minSalary: { amount: 1, currency: 'euro', period: 'year' } },
      { remote: { eligibleCountries: ['GE'], timezone: { base: 'GMT+4', toleranceHours: 3 } } },
      { workModes: [] },
    ];
    for (const patch of invalid) {
      expect(
        PreferencesSchema.safeParse({ ...base, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it('fills empty avoid lists when only one is given', () => {
    const result = PreferencesSchema.parse({ ...base, avoid: { industries: ['crypto'] } });
    expect(result.avoid).toEqual({ industries: ['crypto'], companies: [] });
  });
});
