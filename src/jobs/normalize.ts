import { createHash } from 'node:crypto';
import type { Job } from './job.js';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Job description HTML → readable plain text: paragraphs and list items on their own lines. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    // Block endings: paragraphs, headings and lists leave a blank line; divs and rows a line break.
    .replace(/<\/(p|h[1-6]|ul|ol|table|section|article)>/gi, '\n\n')
    .replace(/<\/(div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return (
    decodeEntities(text)
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      // List items often wrap their text in <p>: keep the bullet with its text, one item per line.
      .replace(/^- *\n+/gm, '- ')
      .replace(/\n{2,}(?=- )/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Query parameters that name the job itself, so they're kept: Greenhouse boards on a company's
 * own site link every job to the same page (`stripe.com/jobs/search?gh_jid=8172510`).
 */
const JOB_PARAMS = ['gh_jid'];

/** For duplicate checks: lowercase host, no fragment, trailing slash or query (but job ids). */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const kept = new URLSearchParams();
    for (const name of JOB_PARAMS) {
      const value = parsed.searchParams.get(name);
      if (value) kept.set(name, value);
    }
    const query = kept.size > 0 ? `?${kept.toString()}` : '';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${query}`;
  } catch {
    return url.trim();
  }
}

/** Stable, short key for a job: the same listing always gets the same key. */
export function jobKey(job: Pick<Job, 'source' | 'sourceId'>): string {
  return createHash('sha1').update(`${job.source}:${job.sourceId}`).digest('hex').slice(0, 16);
}

const WORLDWIDE = /^(worldwide|anywhere|anywhere in the world|global|remote)$/i;

/** "USA, Canada" → regions; "Worldwide" / "Anywhere in the World" → worldwide. */
export function parseLocation(text: string | undefined): Job['location'] {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return { regions: [] };
  if (WORLDWIDE.test(trimmed)) return { text: trimmed, worldwide: true, regions: [] };
  const regions = trimmed
    .split(/[,;/|]/)
    .map((part) => part.replace(/\bonly\b/gi, '').trim())
    .filter(Boolean);
  return { text: trimmed, regions };
}

const CURRENCY_SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

/**
 * Best-effort salary from free text: "$80k - $150k", "$45-$120/Hour", "OTE $25k - $35k",
 * "€50,000 – €60,000 per year", "USD 100k". Returns undefined when no amount is found.
 */
export function parseSalaryText(text: string | undefined): Job['salary'] {
  const original = text?.trim();
  if (!original) return undefined;

  const amounts = [...original.matchAll(/(\d[\d,.]*)\s*(k)?/gi)]
    .map(([, digits = '', thousands]) => Number(digits.replace(/,/g, '')) * (thousands ? 1000 : 1))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  if (amounts.length === 0) return { text: original };

  const symbol = /[$€£]/.exec(original)?.[0];
  const code = /\b(USD|EUR|GBP|CAD|AUD|CHF|GEL|PLN|INR)\b/i.exec(original)?.[1]?.toUpperCase();
  const currency = code ?? (symbol ? CURRENCY_SYMBOLS[symbol] : undefined);
  const period = /\b(hour|hr|hourly)\b/i.test(original)
    ? 'hour'
    : /\b(month|mo|monthly)\b/i.test(original)
      ? 'month'
      : 'year';

  const [min, max] = [Math.min(...amounts), Math.max(...amounts)];
  return {
    min,
    ...(max !== min ? { max } : {}),
    ...(currency ? { currency } : {}),
    period,
    text: original,
  };
}
