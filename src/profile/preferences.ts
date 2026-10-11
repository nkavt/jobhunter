import type { Preferences } from '../config/index.js';
import type { SalaryPeriod } from '../schema/enums.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

/** `"a, b,,a "` → `["a", "b"]` (trimmed, no empties, no duplicates). */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** `"ge, de"` → `["GE", "DE"]`; at least one 2-letter code. */
export function parseCountryCodes(text: string): Parsed<string[]> {
  const codes = parseList(text).map((code) => code.toUpperCase());
  if (codes.length === 0) return fail('Enter at least one country code, e.g. GE');
  const invalid = codes.filter((code) => !/^[A-Z]{2}$/.test(code));
  if (invalid.length > 0) {
    return fail(`Use 2-letter country codes (e.g. GE, DE, US). Not valid: ${invalid.join(', ')}`);
  }
  return ok(codes);
}

export type Timezone = NonNullable<NonNullable<Preferences['remote']>['timezone']>;

/** `"UTC+4 ±3h"`, `"utc-5"`, `"GMT+5:30 +-2"` → `{ base: 'UTC+4', toleranceHours: 3 }`; empty → none. */
export function parseTimezone(text: string): Parsed<Timezone | undefined> {
  if (!text.trim()) return ok(undefined);
  const match =
    /^\s*(?:UTC|GMT)\s*(?:([+-])\s*(\d{1,2})(?::([0-5]\d))?)?\s*(?:(?:±|\+-|\+\/-)\s*(\d{1,2})\s*h?)?\s*$/i.exec(
      text,
    );
  if (!match) return fail('Use a format like UTC+4 or UTC+4 ±3h');
  const [, sign, hours, minutes, tolerance] = match;
  if (hours !== undefined && Number(hours) > 14)
    return fail('UTC offsets go from UTC-12 to UTC+14');
  if (tolerance !== undefined && Number(tolerance) > 12) return fail('Use a range of at most ±12h');
  const offset =
    sign && hours ? `${sign}${String(Number(hours))}${minutes ? `:${minutes}` : ''}` : '';
  return ok({ base: `UTC${offset}`, toleranceHours: tolerance ? Number(tolerance) : 0 });
}

export function formatTimezone(timezone: Timezone): string {
  return timezone.toleranceHours > 0
    ? `${timezone.base} ±${String(timezone.toleranceHours)}h`
    : timezone.base;
}

export type Salary = NonNullable<Preferences['minSalary']>;

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP' };

/**
 * `"60000 EUR"`, `"60k EUR/year"`, `"€5,500/month"`, `"40 USD per hour"` → amount, currency
 * and period (default: year). Empty → none.
 */
export function parseSalary(text: string): Parsed<Salary | undefined> {
  if (!text.trim()) return ok(undefined);
  const match =
    /^\s*([€$£])?\s*(\d[\d,. ]*)\s*(k)?\s*([a-z]{3})?\s*(?:(?:\/|per)\s*(year|yr|month|mo|hour|hr))?\s*$/i.exec(
      text,
    );
  if (!match) return fail('Use a format like 60000 EUR, 60k EUR/year or 5000 USD/month');
  const [, symbol, digits = '', thousands, code, period] = match;

  const currency = code?.toUpperCase() ?? (symbol ? CURRENCY_SYMBOLS[symbol] : undefined);
  if (!currency) return fail('Add a currency, e.g. 60000 EUR');

  const amount = Number(digits.replace(/[,\s]/g, '')) * (thousands ? 1000 : 1);
  if (!Number.isFinite(amount) || amount <= 0) return fail('Enter an amount above 0');

  return ok({ amount, currency, period: normalisePeriod(period) });
}

function normalisePeriod(period: string | undefined): SalaryPeriod {
  switch (period?.toLowerCase()) {
    case 'month':
    case 'mo':
      return 'month';
    case 'hour':
    case 'hr':
      return 'hour';
    default:
      return 'year';
  }
}

export function formatSalary(salary: Salary): string {
  return `${String(salary.amount)} ${salary.currency}/${salary.period}`;
}

/** Turn a `Parsed` into what a prompt's `validate` expects: `true` or the error message. */
export function asValidation<T>(
  parse: (text: string) => Parsed<T>,
): (text: string) => true | string {
  return (text) => {
    const result = parse(text);
    return result.ok ? true : result.error;
  };
}

/** Unwrap a value that already passed validation. */
export function valueOf<T>(result: Parsed<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
