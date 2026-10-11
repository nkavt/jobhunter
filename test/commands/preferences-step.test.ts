import { describe, expect, it } from 'vitest';
import { askPreferences } from '../../src/commands/init/preferences-step.js';
import type { Preferences } from '../../src/config/index.js';
import { DEFAULT, FakeUi } from '../helpers/fake-ui.js';

describe('preference questions', () => {
  it('asks only the remote questions for remote-only work', async () => {
    const ui = new FakeUi([
      ['remote'],
      'GE, de',
      'UTC+4 ±3h',
      false,
      ['full_time', 'contract'],
      '60k EUR',
      'gambling',
      '',
    ]);

    const preferences = await askPreferences(ui, { suggestions: {} });

    expect(preferences).toEqual({
      workModes: ['remote'],
      remote: { eligibleCountries: ['GE', 'DE'], timezone: { base: 'UTC+4', toleranceHours: 3 } },
      visaSponsorshipNeeded: false,
      employmentTypes: ['full_time', 'contract'],
      minSalary: { amount: 60000, currency: 'EUR', period: 'year' },
      avoid: { industries: ['gambling'], companies: [] },
    });
    expect(ui.prompts.map((p) => p.message)).not.toContain('Open to relocating?');
  });

  it('asks the onsite questions, including which countries to relocate to', async () => {
    const ui = new FakeUi([
      ['hybrid'],
      'Tbilisi, Berlin',
      'some',
      'de, nl',
      true,
      DEFAULT,
      '',
      '',
      '',
    ]);

    const preferences = await askPreferences(ui, { suggestions: {} });

    expect(preferences).toEqual({
      workModes: ['hybrid'],
      onsite: { cities: ['Tbilisi', 'Berlin'], relocation: ['DE', 'NL'] },
      visaSponsorshipNeeded: true,
      employmentTypes: ['full_time'],
    });
  });

  it('pre-fills answers from what the CV suggests', async () => {
    const ui = new FakeUi([DEFAULT, DEFAULT, '', DEFAULT, DEFAULT, '', '', '']);

    const preferences = await askPreferences(ui, {
      suggestions: { countryCode: 'GE', workModes: ['remote'], employmentTypes: ['contract'] },
    });

    expect(preferences).toMatchObject({
      workModes: ['remote'],
      remote: { eligibleCountries: ['GE'] },
      employmentTypes: ['contract'],
    });
  });

  it('pre-fills saved answers over suggestions and keeps minScore', async () => {
    const saved: Preferences = {
      workModes: ['remote', 'onsite'],
      remote: { eligibleCountries: ['DE'], timezone: { base: 'UTC+1', toleranceHours: 2 } },
      onsite: { cities: ['Berlin'], relocation: 'yes' },
      visaSponsorshipNeeded: true,
      employmentTypes: ['freelance'],
      minSalary: { amount: 5000, currency: 'EUR', period: 'month' },
      avoid: { industries: ['crypto'], companies: ['Initech'] },
      minScore: 70,
    };
    // Accept every default.
    const ui = new FakeUi(Array.from({ length: 11 }, () => DEFAULT));

    expect(
      await askPreferences(ui, {
        saved,
        suggestions: { countryCode: 'GE', workModes: ['hybrid'] },
      }),
    ).toEqual(saved);
    expect(ui.remainingAnswers).toBe(1);
  });

  it('asks again when an answer is invalid', async () => {
    const ui = new FakeUi([
      ['remote'],
      'Georgia',
      'GE',
      'Tbilisi time',
      '',
      false,
      DEFAULT,
      '60000',
      '60000 EUR',
      '',
      '',
    ]);

    const preferences = await askPreferences(ui, { suggestions: {} });

    expect(ui.rejected).toEqual([
      'Use 2-letter country codes (e.g. GE, DE, US). Not valid: GEORGIA',
      'Use a format like UTC+4 or UTC+4 ±3h',
      'Add a currency, e.g. 60000 EUR',
    ]);
    expect(preferences.remote).toEqual({ eligibleCountries: ['GE'] });
    expect(preferences.minSalary).toEqual({ amount: 60000, currency: 'EUR', period: 'year' });
  });

  it('requires at least one work mode', async () => {
    await expect(askPreferences(new FakeUi([[]]), { suggestions: {} })).rejects.toThrow(
      'needs at least one choice',
    );
  });
});
