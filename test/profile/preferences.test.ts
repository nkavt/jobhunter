import { describe, expect, it } from 'vitest';
import {
  asValidation,
  formatSalary,
  formatTimezone,
  parseCountryCodes,
  parseList,
  parseSalary,
  parseTimezone,
} from '../../src/profile/preferences.js';

describe('parseList', () => {
  it('trims, drops empties and duplicates', () => {
    expect(parseList(' gambling, crypto,, gambling ')).toEqual(['gambling', 'crypto']);
    expect(parseList('')).toEqual([]);
  });
});

describe('parseCountryCodes', () => {
  it('accepts 2-letter codes in any case', () => {
    expect(parseCountryCodes('ge, de ,Us')).toEqual({ ok: true, value: ['GE', 'DE', 'US'] });
  });

  it('explains what is wrong', () => {
    expect(parseCountryCodes('')).toEqual({
      ok: false,
      error: 'Enter at least one country code, e.g. GE',
    });
    expect(parseCountryCodes('GE, Georgia, DEU')).toEqual({
      ok: false,
      error: 'Use 2-letter country codes (e.g. GE, DE, US). Not valid: GEORGIA, DEU',
    });
  });
});

describe('parseTimezone', () => {
  it.each([
    ['UTC+4 ±3h', { base: 'UTC+4', toleranceHours: 3 }],
    ['utc+04', { base: 'UTC+4', toleranceHours: 0 }],
    ['GMT-5 +-2', { base: 'UTC-5', toleranceHours: 2 }],
    ['UTC+5:30 +/- 1h', { base: 'UTC+5:30', toleranceHours: 1 }],
    ['UTC', { base: 'UTC', toleranceHours: 0 }],
  ])('reads %s', (text, expected) => {
    expect(parseTimezone(text)).toEqual({ ok: true, value: expected });
  });

  it('treats empty as no timezone', () => {
    expect(parseTimezone('  ')).toEqual({ ok: true, value: undefined });
  });

  it('rejects things that are not a timezone', () => {
    expect(parseTimezone('Tbilisi').ok).toBe(false);
    expect(parseTimezone('UTC+15').ok).toBe(false);
    expect(parseTimezone('UTC+4 ±13h').ok).toBe(false);
  });

  it('round-trips through formatTimezone', () => {
    expect(formatTimezone({ base: 'UTC+4', toleranceHours: 3 })).toBe('UTC+4 ±3h');
    expect(formatTimezone({ base: 'UTC+4', toleranceHours: 0 })).toBe('UTC+4');
  });
});

describe('parseSalary', () => {
  it.each([
    ['60000 EUR', { amount: 60000, currency: 'EUR', period: 'year' }],
    ['60k eur/year', { amount: 60000, currency: 'EUR', period: 'year' }],
    ['€5,500/month', { amount: 5500, currency: 'EUR', period: 'month' }],
    ['$120 000', { amount: 120000, currency: 'USD', period: 'year' }],
    ['40 USD per hour', { amount: 40, currency: 'USD', period: 'hour' }],
    ['3000 GEL/mo', { amount: 3000, currency: 'GEL', period: 'month' }],
  ])('reads %s', (text, expected) => {
    expect(parseSalary(text)).toEqual({ ok: true, value: expected });
  });

  it('treats empty as no minimum', () => {
    expect(parseSalary('')).toEqual({ ok: true, value: undefined });
  });

  it('asks for a currency and a real amount', () => {
    expect(parseSalary('60000')).toEqual({ ok: false, error: 'Add a currency, e.g. 60000 EUR' });
    expect(parseSalary('0 EUR')).toEqual({ ok: false, error: 'Enter an amount above 0' });
    expect(parseSalary('a lot').ok).toBe(false);
  });

  it('round-trips through formatSalary', () => {
    const salary = { amount: 60000, currency: 'EUR', period: 'year' as const };
    expect(formatSalary(salary)).toBe('60000 EUR/year');
    expect(parseSalary(formatSalary(salary))).toEqual({ ok: true, value: salary });
  });
});

describe('asValidation', () => {
  it('turns a parser into a prompt validator', () => {
    const validate = asValidation(parseCountryCodes);
    expect(validate('GE')).toBe(true);
    expect(validate('Georgia')).toContain('Not valid: GEORGIA');
  });
});
