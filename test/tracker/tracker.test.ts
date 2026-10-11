import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { jobKey, type Job } from '../../src/jobs/index.js';
import { APPLICATION_COLUMNS, IGNORED_COLUMNS } from '../../src/sheet/layout.js';
import {
  applicationCells,
  ignoredCells,
  isKnown,
  SheetTracker,
  toRow,
  TrackerError,
  type Cell,
} from '../../src/tracker/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';
import { saveGoogleSession } from '../helpers/google-session.js';
import { useTempHome } from '../helpers/temp-home.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const client = { clientId: 'c', clientSecret: 's' };
const foundAt = new Date('2026-10-11T15:30:00.000Z');

const job: Job = {
  source: 'remotive',
  sourceId: '2086540',
  url: 'https://remotive.com/remote-jobs/software-dev/senior-engineer-2086540',
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: { worldwide: true, regions: [] },
  description: 'Hiring.',
  tags: [],
};

const APP_HEADER = APPLICATION_COLUMNS.map((c) => c.header);
const IGNORED_HEADER = IGNORED_COLUMNS.map((c) => c.header);

describe('rows', () => {
  it('fills Applications by header and leaves user columns empty', () => {
    const row = toRow(
      APP_HEADER,
      applicationCells({
        job,
        channel: 'Remotive',
        status: 'To apply',
        note: 'Strong React match.',
        score: 82,
        foundAt,
      }),
    );
    expect(Object.fromEntries(APP_HEADER.map((h, i) => [h, row[i]]))).toEqual({
      Company: 'Acme',
      Role: 'Senior Frontend Engineer',
      Applied: '',
      Channel: 'Remotive',
      Status: 'To apply',
      'Last update': '2026-10-11',
      Link: job.url,
      Notes: 'Strong React match.',
      'Note 1': '',
      'Note 2': '',
      Key: jobKey(job),
      Source: 'remotive',
      Found: '2026-10-11T15:30:00.000Z',
      Match: 82,
    });
  });

  it('fills Ignored with the reason, and follows the actual column order', () => {
    const reordered = ['Link', 'Reason', 'Company', 'Something else'];
    expect(
      toRow(
        reordered,
        ignoredCells({ job, channel: 'Remote OK', reason: 'employment type: part_time', foundAt }),
      ),
    ).toEqual([job.url, 'employment type: part_time', 'Acme', '']);
  });

  it('knows a job by its key or its link', () => {
    expect(isKnown(new Set([`key:${jobKey(job)}`]), job)).toBe(true);
    expect(
      isKnown(
        new Set(['url:https://remotive.com/remote-jobs/software-dev/senior-engineer-2086540']),
        job,
      ),
    ).toBe(true);
    expect(isKnown(new Set(['key:other']), job)).toBe(false);
  });
});

describe('SheetTracker', () => {
  useTempHome();
  const server = useMockServer();

  function sheet(applications: Cell[][], ignored: Cell[][]) {
    const appends: { url: URL; body: { values: (string | number)[][] } }[] = [];
    server.use(
      http.get(`${SHEETS}/sheet-1/values:batchGet`, () =>
        HttpResponse.json({
          valueRanges: [
            { range: "'Applications'!A1:Z1000", values: applications },
            { range: "'Ignored'!A1:Z1000", values: ignored },
          ],
        }),
      ),
      http.post(`${SHEETS}/sheet-1/values/:range`, async ({ request }) => {
        appends.push({
          url: new URL(request.url),
          body: (await request.json()) as { values: (string | number)[][] },
        });
        return HttpResponse.json({ updates: {} });
      }),
    );
    return appends;
  }

  it('collects keys and links from both tabs, including hand-added rows without a key', async () => {
    await saveGoogleSession();
    const withKey = toRow(APP_HEADER, { Company: 'A', Key: 'abc123', Link: 'https://x.com/1' });
    const handAdded = toRow(APP_HEADER, { Company: 'B', Link: 'https://Y.com/2/?ref=x' });
    const ignoredRow = toRow(IGNORED_HEADER, { Key: 'def456', Link: 'https://z.com/3' });
    sheet([APP_HEADER, withKey, handAdded], [IGNORED_HEADER, ignoredRow]);

    const known = await new SheetTracker(client, 'sheet-1').knownJobs();

    expect([...known].sort()).toEqual([
      'key:abc123',
      'key:def456',
      'url:https://x.com/1',
      'url:https://y.com/2',
      'url:https://z.com/3',
    ]);
  });

  it('appends rows as RAW values, in header order, one request per tab', async () => {
    await saveGoogleSession();
    const appends = sheet([APP_HEADER], [IGNORED_HEADER]);
    const tracker = new SheetTracker(client, 'sheet-1');

    await tracker.addApplications([
      { job, channel: 'Remotive', status: 'To apply', note: 'Good fit', score: 80, foundAt },
      {
        job: { ...job, sourceId: '2', title: '=HYPERLINK("http://evil")' },
        channel: 'Remotive',
        status: 'Skipped',
        note: 'No',
        score: 10,
        foundAt,
      },
    ]);
    await tracker.addIgnored([
      { job, channel: 'Remote OK', reason: 'posted 45 days ago', foundAt },
    ]);

    expect(appends).toHaveLength(2);
    expect(decodeURIComponent(appends[0]?.url.pathname ?? '')).toMatch(
      /values\/Applications!A1:append$/,
    );
    expect(Object.fromEntries(appends[0]?.url.searchParams ?? [])).toEqual({
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
    });
    expect(appends[0]?.body.values).toHaveLength(2);
    // A formula-looking title is stored as plain text, not run.
    expect(appends[0]?.body.values[1]?.[APP_HEADER.indexOf('Role')]).toBe(
      '=HYPERLINK("http://evil")',
    );
    expect(decodeURIComponent(appends[1]?.url.pathname ?? '')).toMatch(
      /values\/Ignored!A1:append$/,
    );
    expect(appends[1]?.body.values[0]?.[IGNORED_HEADER.indexOf('Reason')]).toBe(
      'posted 45 days ago',
    );
  });

  it('sends nothing when there is nothing to add', async () => {
    await saveGoogleSession();
    const appends = sheet([APP_HEADER], [IGNORED_HEADER]);
    const tracker = new SheetTracker(client, 'sheet-1');
    await tracker.addApplications([]);
    await tracker.addIgnored([]);
    expect(appends).toHaveLength(0);
  });

  it('explains a missing column instead of writing to the wrong place', async () => {
    await saveGoogleSession();
    sheet([APP_HEADER.map((h) => (h === 'Key' ? 'Id' : h))], [IGNORED_HEADER]);
    const error = await new SheetTracker(client, 'sheet-1').knownJobs().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as Error).message).toContain(
      'The "Applications" tab of your tracking sheet is missing the column(s) "Key"',
    );
  });
});
