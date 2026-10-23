import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  htmlToText,
  JobSchema,
  jobKey,
  normalizeUrl,
  parseLocation,
  parseSalaryText,
} from '../../src/jobs/index.js';

describe('htmlToText', () => {
  it('keeps paragraphs and list items readable', () => {
    const html =
      '<p dir="ltr" style="line-height: 1.38">We are <strong>hiring</strong>&nbsp;now.</p><ul><li>React &amp; TypeScript</li><li>5+ years</li></ul><p>Apply&hellip;</p>';
    expect(htmlToText(html)).toBe('We are hiring now.\n- React & TypeScript\n- 5+ years\n\nApply…');
  });

  it('keeps bullets with their text when list items wrap a paragraph (as Remotive does)', () => {
    const html =
      '<p>You are a fit if:</p><ul><li><p>Software Engineers.</p></li><li><p>Full-Stack Developers.</p></li></ul><p>Apply now.</p>';
    expect(htmlToText(html)).toBe(
      'You are a fit if:\n- Software Engineers.\n- Full-Stack Developers.\n\nApply now.',
    );
  });

  it('drops scripts and styles, handles <br> and numeric entities', () => {
    expect(
      htmlToText('<style>p{}</style>Line one<br/>Line&#160;two &#x2014; done<script>x()</script>'),
    ).toBe('Line one\nLine two — done');
  });

  it('decodes unknown entities as-is', () => {
    expect(decodeEntities('a &unknown; b &lt;c&gt;')).toBe('a &unknown; b <c>');
  });
});

describe('normalizeUrl', () => {
  it('ignores host case, query, fragment and trailing slash', () => {
    expect(normalizeUrl('https://RemoteOK.com/remote-jobs/abc-123/?ref=feed#apply')).toBe(
      'https://remoteok.com/remote-jobs/abc-123',
    );
    expect(normalizeUrl('not a url ')).toBe('not a url');
  });

  it("keeps Greenhouse's job id, so jobs on a company's own careers page stay apart", () => {
    const stripe = (id: string, extra = '') =>
      normalizeUrl(`https://stripe.com/jobs/search?${extra}gh_jid=${id}`);
    expect(stripe('8172510')).toBe('https://stripe.com/jobs/search?gh_jid=8172510');
    expect(stripe('8172510')).not.toBe(stripe('8172487'));
    // Other parameters still don't matter.
    expect(stripe('8172510', 'gh_src=abc&utm_source=x&')).toBe(stripe('8172510'));
  });
});

describe('jobKey', () => {
  it('is short, stable and depends on source + id', () => {
    const key = jobKey({ source: 'remotive', sourceId: '2086540' });
    expect(key).toMatch(/^[a-f0-9]{16}$/);
    expect(jobKey({ source: 'remotive', sourceId: '2086540' })).toBe(key);
    expect(jobKey({ source: 'remoteok', sourceId: '2086540' })).not.toBe(key);
  });
});

describe('parseLocation (real values from the boards)', () => {
  it.each(['Worldwide', 'Anywhere in the World', 'anywhere'])('"%s" is worldwide', (text) => {
    expect(parseLocation(text)).toEqual({ text, worldwide: true, regions: [] });
  });

  it('splits region lists and drops "Only"', () => {
    expect(parseLocation('USA, Canada, Argentina, Mexico, Peru').regions).toEqual([
      'USA',
      'Canada',
      'Argentina',
      'Mexico',
      'Peru',
    ]);
    expect(parseLocation('North America Only')).toEqual({
      text: 'North America Only',
      regions: ['North America'],
    });
  });

  it('treats empty as unknown', () => {
    expect(parseLocation('')).toEqual({ regions: [] });
    expect(parseLocation(undefined)).toEqual({ regions: [] });
  });
});

describe('parseSalaryText (real values from Remotive)', () => {
  it.each([
    ['$80k - $150k', { min: 80000, max: 150000, currency: 'USD', period: 'year' }],
    ['OTE $25k - $35k', { min: 25000, max: 35000, currency: 'USD', period: 'year' }],
    ['$45-$120/Hour', { min: 45, max: 120, currency: 'USD', period: 'hour' }],
    ['$50-$75 /hour', { min: 50, max: 75, currency: 'USD', period: 'hour' }],
    ['€50,000 – €60,000 per year', { min: 50000, max: 60000, currency: 'EUR', period: 'year' }],
    ['USD 100k', { min: 100000, currency: 'USD', period: 'year' }],
    ['4000 GEL monthly', { min: 4000, currency: 'GEL', period: 'month' }],
  ])('%s', (text, expected) => {
    expect(parseSalaryText(text)).toEqual({ ...expected, text });
  });

  it('keeps the text when there is no amount, and ignores empty input', () => {
    expect(parseSalaryText('Competitive')).toEqual({ text: 'Competitive' });
    expect(parseSalaryText('  ')).toBeUndefined();
    expect(parseSalaryText(undefined)).toBeUndefined();
  });
});

describe('JobSchema', () => {
  const job = {
    source: 'remotive',
    sourceId: '2086540',
    url: 'https://remotive.com/remote-jobs/software-dev/senior-engineer-2086540',
    title: 'Senior Engineer',
    company: 'Acme',
    location: { text: 'Worldwide', worldwide: true, regions: [] },
    workMode: 'remote',
    employmentType: 'full_time',
    salary: { min: 80000, max: 150000, currency: 'USD', period: 'year', text: '$80k - $150k' },
    postedAt: '2026-10-08T21:47:32Z',
    description: 'We are hiring.',
    tags: ['react'],
  };

  it('accepts a complete job and a minimal one', () => {
    expect(JobSchema.parse(job)).toEqual(job);
    expect(
      JobSchema.safeParse({
        source: 'x',
        sourceId: '1',
        url: 'https://x.com/1',
        title: 'T',
        company: 'C',
        location: { regions: [] },
        description: '',
        tags: [],
      }).success,
    ).toBe(true);
  });

  it('accepts timestamps with an offset', () => {
    expect(JobSchema.safeParse({ ...job, postedAt: '2026-10-10T08:00:08+00:00' }).success).toBe(
      true,
    );
  });

  it('rejects jobs without a title, company or valid URL', () => {
    for (const patch of [{ title: '' }, { company: '' }, { url: 'nope' }]) {
      expect(JobSchema.safeParse({ ...job, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
});
