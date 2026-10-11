import { htmlToText, parseLocation, parseSalaryText } from '../jobs/index.js';
import type { Transform } from './schema.js';

const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** ISO timestamps without an offset are treated as UTC; RFC 822 dates (RSS) work too. */
function toIsoDate(value: unknown): string | undefined {
  if (typeof value === 'number') return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString();
  if (typeof value !== 'string') return undefined;
  const text = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value.trim()) ? `${value.trim()}Z` : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Apply one transform; returning `undefined` means "no usable value". */
export function applyTransform(value: unknown, transform: Transform): unknown {
  if (isBlank(value)) return undefined;

  if (transform.startsWith('before:') || transform.startsWith('after:')) {
    const [kind, ...rest] = transform.split(':');
    const separator = rest.join(':');
    const text = String(value);
    const at = text.indexOf(separator);
    if (kind === 'before') return at === -1 ? undefined : text.slice(0, at).trim() || undefined;
    return at === -1 ? text.trim() : text.slice(at + separator.length).trim() || undefined;
  }

  switch (transform) {
    case 'string':
      return String(value);
    case 'text':
      return String(value).trim();
    case 'lowercase':
      return String(value).toLowerCase();
    case 'number': {
      const number = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
      return Number.isFinite(number) ? number : undefined;
    }
    case 'positive': {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : undefined;
    }
    case 'html':
      return htmlToText(String(value));
    case 'date':
      return toIsoDate(value);
    case 'location':
      return parseLocation(String(value));
    case 'salaryText':
      return parseSalaryText(String(value));
    case 'periodFromAmount': {
      // For sources that give amounts without a period: guess it from the size.
      // Under 1,000 is hourly, under 20,000 monthly, anything larger yearly.
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount <= 0) return undefined;
      return amount < 1_000 ? 'hour' : amount < 20_000 ? 'month' : 'year';
    }
    case 'list': {
      const items = Array.isArray(value) ? value : String(value).split(',');
      return items.map((item) => String(item).trim()).filter(Boolean);
    }
    default:
      return value;
  }
}
