import { describe, expect, it } from 'vitest';
import { parseLocation } from '../../src/jobs/index.js';
import { eligibleFor, recognisePlace } from '../../src/filter/index.js';

const regions = (text: string) => parseLocation(text).regions;

describe('recognisePlace', () => {
  it('knows countries by name, alias or code, and regions by alias', () => {
    expect(recognisePlace('USA')).toEqual({ country: 'US' });
    expect(recognisePlace('United States')).toEqual({ country: 'US' });
    expect(recognisePlace('ge')).toEqual({ country: 'GE' });
    expect(recognisePlace('Northern America')).toEqual({ region: 'north america' });
    expect(recognisePlace('EMEA')).toEqual({ region: 'emea' });
    expect(recognisePlace('USA timezones')).toBeUndefined();
    expect(recognisePlace('Neuruppin')).toBeUndefined();
  });
});

describe('eligibleFor (real location strings from the boards)', () => {
  it.each([
    ['USA', ['GE'], false],
    ['North America', ['GE'], false],
    [
      'USA, UK, India, Australia, Ireland, New Zealand, Philippines, Pakistan, Singapore, Mexico',
      ['GE'],
      false,
    ],
    ['Europe, USA, Canada, APAC', ['GE'], true],
    ['Northern America, LATAM, Europe, APAC', ['GE'], true],
    ['Americas, Europe, Israel', ['GE'], true],
    ['EMEA', ['GE'], true],
    [
      'USA, UK, India, Australia, Ireland, New Zealand, Philippines, Pakistan, Singapore, Mexico',
      ['DE', 'IE'],
      true,
    ],
    ['France, Japan, Turkey, Vietnam, Mexico, Norway', ['US'], false],
  ] as const)('%s for %j → %s', (text, countries, expected) => {
    expect(eligibleFor(regions(text), countries)).toBe(expected);
  });

  it('is unsure when a place is not recognised, so the job goes to the AI', () => {
    expect(eligibleFor(regions('USA, Canada, USA timezones'), ['GE'])).toBeUndefined();
    expect(eligibleFor(regions('Neuruppin'), ['GE'])).toBeUndefined();
    expect(eligibleFor([], ['GE'])).toBeUndefined();
  });
});
