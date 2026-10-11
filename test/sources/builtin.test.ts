import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { applyMapping, FeedMappingSchema, parseFeed } from '../../src/mapping/index.js';
import {
  BUILTIN_MAPPINGS,
  BUILTIN_SOURCES,
  fetchSource,
  SourceError,
  USER_AGENT,
} from '../../src/sources/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/feeds/${name}`, import.meta.url), 'utf8');
const source = (id: string) => {
  const found = BUILTIN_SOURCES.find((s) => s.id === id);
  if (!found) throw new Error(id);
  return found;
};
const convert = (id: string, file: string) => {
  const mapping = BUILTIN_MAPPINGS[source(id).mappingKey];
  if (!mapping) throw new Error(id);
  return applyMapping(parseFeed(fixture(file), mapping.format), mapping, id);
};

describe('built-in sources', () => {
  it('are valid mappings, one per source, polite about fetch frequency', () => {
    for (const s of BUILTIN_SOURCES) {
      expect(FeedMappingSchema.safeParse(BUILTIN_MAPPINGS[s.mappingKey]).success, s.id).toBe(true);
      expect(s.minIntervalHours).toBeGreaterThanOrEqual(6);
    }
    expect(BUILTIN_SOURCES.map((s) => s.name)).toEqual([
      'Remotive',
      'Remote OK',
      'We Work Remotely',
    ]);
  });

  it('Remotive: salary text, region lists and employment types', () => {
    const { jobs, errors } = convert('remotive', 'remotive.json');
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      source: 'remotive',
      sourceId: '2091149',
      employmentType: 'contract',
      workMode: 'remote',
      salary: { min: 45, max: 120, currency: 'USD', period: 'hour', text: '$45-$120/Hour' },
      location: { regions: expect.arrayContaining(['USA', 'UK', 'India']) as string[] },
    });
    expect(jobs[0]?.url).toMatch(/^https:\/\/remotive\.com\/remote-jobs\//);
    expect(jobs[1]).toMatchObject({
      location: { worldwide: true },
      salary: { min: 25000, max: 35000, period: 'year' },
    });
    expect(jobs[2]).not.toHaveProperty('salary');
    expect(jobs[0]?.description).not.toMatch(/<\w+/);
    expect(jobs[0]?.postedAt).toMatch(/Z$/);
  });

  it('Remote OK: skips the legal notice, reads hourly vs yearly salaries, treats 0 as unknown', () => {
    const { jobs, errors, skipped } = convert('remoteok', 'remoteok.json');
    expect(errors).toEqual([]);
    expect(skipped).toBe(1);
    expect(jobs.map((j) => j.sourceId)).toEqual(['1137479', '1137475', '1137469']);
    expect(jobs[0]?.salary).toEqual({ min: 40, max: 48, currency: 'USD', period: 'hour' });
    expect(jobs[1]?.salary).toEqual({ min: 80000, max: 200000, currency: 'USD', period: 'year' });
    expect(jobs[2]).not.toHaveProperty('salary');
    expect(jobs[2]?.location).toEqual({ text: 'Neuruppin', regions: ['Neuruppin'] });
  });

  it('We Work Remotely: splits "Company: Title", reads region and type from RSS', () => {
    const { jobs, errors } = convert('weworkremotely', 'weworkremotely.rss');
    expect(errors).toEqual([]);
    expect(jobs.map((j) => [j.company, j.title, j.employmentType])).toEqual([
      ['A.Team', 'Senior Independent AI Engineer / Architect', 'contract'],
      ['Toptal', 'Salesforce Platform Lead for Global Industrial Company', 'full_time'],
      ['Vercel', 'Software Engineer - Data Platform', 'full_time'],
    ]);
    expect(jobs[0]?.location.worldwide).toBe(true);
    expect(jobs[1]?.location.regions).toEqual(['North America']);
    expect(jobs[2]?.sourceId).toBe(
      'https://weworkremotely.com/remote-jobs/vercel-software-engineer-data-platform',
    );
    expect(jobs[2]?.description).toContain('Headquarters:');
    expect(jobs[2]?.postedAt).toMatch(/^2026-10-11T/);
  });
});

describe('fetchSource', () => {
  const server = useMockServer();

  it('downloads the feed with a polite User-Agent and converts it', async () => {
    let userAgent = '';
    server.use(
      http.get('https://remoteok.com/api', ({ request }) => {
        userAgent = request.headers.get('user-agent') ?? '';
        return new HttpResponse(fixture('remoteok.json'), {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const result = await fetchSource(source('remoteok'), BUILTIN_MAPPINGS);
    expect(result.jobs).toHaveLength(3);
    expect(result.source.name).toBe('Remote OK');
    expect(userAgent).toBe(USER_AGENT);
    expect(userAgent).toMatch(
      /^jobhunter\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/nkavt\/jobhunter\)$/,
    );
  });

  it('names the source in errors', async () => {
    server.use(
      http.get('https://remoteok.com/api', () => new HttpResponse('busy', { status: 503 })),
      http.get('https://remotive.com/api/remote-jobs', () => new HttpResponse('<html>oops</html>')),
      http.get('https://weworkremotely.com/remote-jobs.rss', () => HttpResponse.error()),
    );
    await expect(fetchSource(source('remoteok'), BUILTIN_MAPPINGS)).rejects.toThrow(
      'Remote OK answered with HTTP 503.',
    );
    await expect(fetchSource(source('remotive'), BUILTIN_MAPPINGS)).rejects.toThrow(
      "Remotive: The feed isn't valid JSON.",
    );
    const error = await fetchSource(source('weworkremotely'), BUILTIN_MAPPINGS).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).source).toBe('weworkremotely');
    expect((error as Error).message).toBe("Couldn't reach We Work Remotely.");
  });

  it('needs a mapping for the source', async () => {
    await expect(fetchSource(source('remotive'), {})).rejects.toThrow('No mapping for Remotive.');
  });
});
