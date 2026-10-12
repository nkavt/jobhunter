import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/jobs/index.js';
import {
  buildWorkbook,
  dateValue,
  trackerDataFrom,
  type TrackerData,
} from '../../src/sheet/workbook.js';
import {
  createLocalSheet,
  findOpenLock,
  inspectLocalSheet,
  LocalSheetTracker,
  TrackerError,
} from '../../src/tracker/index.js';
import { readWorkbook, writeWorkbook } from '../../src/xlsx/index.js';
import { readZip } from '../../src/xlsx/zip.js';
import { useTempHome } from '../helpers/temp-home.js';

const now = new Date('2026-10-12T09:30:00Z');

const job = (id: string, company: string, title = 'Frontend Engineer'): Job => ({
  source: 'board-a',
  sourceId: id,
  url: `https://board-a.example/jobs/${id}`,
  title,
  company,
  location: { worldwide: true, regions: [] },
  workMode: 'remote',
  description: '',
  tags: [],
});

const values = async (path: string) => readWorkbook(await readFile(path));
const tab = async (path: string, name: string) =>
  (await values(path)).find((sheet) => sheet.name === name)?.rows ?? [];

describe('local tracking sheet', () => {
  const home = useTempHome();
  const sheetPath = () => join(home(), 'jobhunter.xlsx');

  it('creates the same tabs as the Google Sheet, with a hidden _meta tab', async () => {
    await createLocalSheet(sheetPath(), now);

    const sheets = await values(sheetPath());
    expect(sheets.map((sheet) => [sheet.name, sheet.hidden])).toEqual([
      ['Applications', false],
      ['To apply', false],
      ['Applied', false],
      ['Interview & Offer', false],
      ['Declined', false],
      ['Ghosted', false],
      ['Skipped', false],
      ['Ignored', false],
      ['_meta', true],
    ]);
    expect(sheets[0]?.rows[0]).toEqual([
      'Company',
      'Role',
      'Applied',
      'Channel',
      'Status',
      'Last update',
      'Link',
      'Notes',
      'Note 1',
      'Note 2',
      'Key',
      'Source',
      'Found',
      'Match',
    ]);
    expect(sheets[1]?.rows).toEqual([
      [
        'Company',
        'Role',
        'Applied',
        'Channel',
        'Status',
        'Last update',
        'Link',
        'Notes',
        'Note 1',
        'Note 2',
      ],
      ['Nothing here yet'],
    ]);
    expect(await inspectLocalSheet(sheetPath())).toBe('jobhunter');
  });

  it('adds jobs, fills the view tabs and knows them on the next run', async () => {
    await createLocalSheet(sheetPath(), now);
    const tracker = new LocalSheetTracker(sheetPath());

    await tracker.addIgnored([
      {
        job: job('s1', 'Sales Co', 'Sales Engineer'),
        channel: 'Board A',
        reason: "title doesn't match",
        foundAt: now,
      },
    ]);
    await tracker.addApplications([
      {
        job: job('a1', 'Zeta'),
        channel: 'Board A',
        status: 'To apply',
        note: 'Great fit.',
        score: 88,
        foundAt: now,
      },
      {
        job: job('a2', 'Acme'),
        channel: 'Board A',
        status: 'To apply',
        note: 'Good fit.',
        score: 75,
        foundAt: now,
      },
      {
        job: job('a3', 'Mid'),
        channel: 'Board A',
        status: 'Skipped',
        note: 'Go only.',
        score: 30,
        foundAt: now,
      },
    ]);

    const applications = await tab(sheetPath(), 'Applications');
    expect(applications.slice(1).map((row) => [row[0], row[4], row[13]])).toEqual([
      ['Zeta', 'To apply', 88],
      ['Acme', 'To apply', 75],
      ['Mid', 'Skipped', 30],
    ]);
    // Dates are real dates, so spreadsheet apps sort and filter them as dates.
    expect(applications[1]?.[5]).toBe(dateValue('2026-10-12'));
    // View tabs are sorted by company.
    expect((await tab(sheetPath(), 'To apply')).slice(1).map((row) => row[0])).toEqual([
      'Acme',
      'Zeta',
    ]);
    expect((await tab(sheetPath(), 'Skipped')).slice(1).map((row) => row[0])).toEqual(['Mid']);
    expect((await tab(sheetPath(), 'Ignored'))[1]?.slice(0, 5)).toEqual([
      '',
      'Sales Co',
      'Sales Engineer',
      'Board A',
      "title doesn't match",
    ]);

    const known = await new LocalSheetTracker(sheetPath()).knownJobs();
    expect(known).toContain('url:https://board-a.example/jobs/a1');
    expect(known).toContain('url:https://board-a.example/jobs/s1');
    expect(known.size).toBe(8);
  });

  it("keeps the user's edits: changed statuses, notes, added columns, rows added by hand", async () => {
    await createLocalSheet(sheetPath(), now);
    await new LocalSheetTracker(sheetPath()).addApplications([
      {
        job: job('a1', 'Acme'),
        channel: 'Board A',
        status: 'To apply',
        note: 'Fit.',
        foundAt: now,
      },
    ]);

    // The user edits the file in their spreadsheet app and saves it.
    const data = trackerDataFrom(await values(sheetPath())) as TrackerData;
    data.applications.header.push('Salary');
    data.applications.rows[0]?.splice(4, 1, 'Applied');
    data.applications.rows[0]?.splice(8, 1, 'Recruiter: Sam');
    data.applications.rows[0]?.push('120k');
    data.applications.rows.push([
      'Hand Co',
      'Designer',
      '',
      '',
      'Interview',
      '',
      'https://hand.example',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    await writeFile(sheetPath(), writeWorkbook(buildWorkbook(data)));

    const tracker = new LocalSheetTracker(sheetPath());
    await tracker.addApplications([
      {
        job: job('a2', 'Beta'),
        channel: 'Board A',
        status: 'To apply',
        note: 'New.',
        foundAt: now,
      },
    ]);

    const rows = await tab(sheetPath(), 'Applications');
    expect(rows[0]?.at(-1)).toBe('Salary');
    expect(rows.slice(1).map((row) => [row[0], row[4], row[8] ?? '', row[14] ?? ''])).toEqual([
      ['Acme', 'Applied', 'Recruiter: Sam', '120k'],
      ['Hand Co', 'Interview', '', ''],
      ['Beta', 'To apply', '', ''],
    ]);
    expect((await tab(sheetPath(), 'Applied')).slice(1).map((row) => row[0])).toEqual(['Acme']);
    expect(await tracker.knownJobs()).toContain('url:https://hand.example');
  });

  it('keeps a copy of the previous version', async () => {
    await createLocalSheet(sheetPath(), now);
    const backupFile = join(home(), 'backups', 'default.xlsx');
    const before = await readFile(sheetPath());

    await new LocalSheetTracker(sheetPath(), { backupFile }).addApplications([
      { job: job('a1', 'Acme'), channel: 'Board A', status: 'To apply', note: '', foundAt: now },
    ]);

    expect(await readFile(backupFile)).toEqual(before);
  });

  it('writes the formats: dropdowns, colours, links, wrapped notes, locked view tabs', async () => {
    await createLocalSheet(sheetPath(), now);
    await new LocalSheetTracker(sheetPath()).addApplications([
      {
        job: job('a1', 'Acme'),
        channel: 'Board A',
        status: 'To apply',
        note: 'Fit.',
        foundAt: now,
      },
    ]);
    const files = readZip(await readFile(sheetPath()));
    const applications = files.get('xl/worksheets/sheet1.xml')?.toString() ?? '';
    const toApply = files.get('xl/worksheets/sheet2.xml')?.toString() ?? '';
    const ignored = files.get('xl/worksheets/sheet8.xml')?.toString() ?? '';

    expect(applications).toContain(
      'sqref="E2:E1002"><formula1>&quot;To apply,Applied,Interview,Offer,Declined,Ghosted,Withdrawn,Skipped&quot;',
    );
    expect(applications).toContain('<conditionalFormatting sqref="A2:N1002">');
    expect(applications).toContain('$E2=&quot;To apply&quot;');
    expect(applications).toContain('OR($E2=&quot;Withdrawn&quot;,$E2=&quot;Skipped&quot;)');
    expect(applications).toContain('<autoFilter ref="A1:N2"/>');
    expect(applications).toContain('<hyperlink ref="G2"');
    expect(applications).not.toContain('sheetProtection');
    expect(toApply).toContain('<sheetProtection');
    // Live views: the same FILTER as the Google Sheet, as an Excel dynamic array formula.
    expect(toApply).toContain(
      't="str" cm="1"><f t="array" ref="A2:J202">IFERROR(INDEX(_xlfn._xlws.SORT(_xlfn._xlws.FILTER(Applications!A2:J202,(Applications!E2:E202=&quot;To apply&quot;)),1,1),_xlfn.SEQUENCE(201),_xlfn.SEQUENCE(1,10)),IF(_xlfn.SEQUENCE(201)+_xlfn.SEQUENCE(1,10)=2,&quot;Nothing here yet&quot;,&quot;&quot;))</f><v>Acme</v></c>',
    );
    expect(files.get('xl/worksheets/sheet4.xml')?.toString()).toContain(
      '(Applications!E2:E202=&quot;Interview&quot;)+(Applications!E2:E202=&quot;Offer&quot;)',
    );
    expect(files.get('xl/metadata.xml')?.toString()).toContain('fDynamic="1"');
    // Formula results don't resize rows, so view rows have room for wrapped notes.
    expect(toApply).toContain('<row r="2" ht="40" customHeight="1">');
    expect(toApply).toContain('<row r="202" ht="40" customHeight="1"></row>');
    expect(applications).not.toContain('customHeight="1">');
    expect(files.get('[Content_Types].xml')?.toString()).toContain('/xl/metadata.xml');
    expect(toApply).toContain('<tabColor rgb="FF9972D8"/>');
    expect(ignored).toContain('sqref="A2:A1001"><formula1>&quot;To apply&quot;');
    const styles = files.get('xl/styles.xml')?.toString() ?? '';
    expect(styles).toContain('<alignment wrapText="1" vertical="top"/>');
    expect(styles).toContain('formatCode="yyyy-mm-dd"');
  });

  it('explains a missing file, a file from elsewhere, and a damaged file', async () => {
    const missing = new LocalSheetTracker(join(home(), 'gone.xlsx'));
    await expect(missing.knownJobs()).rejects.toThrow(
      new TrackerError(
        `Can't find your tracking sheet at ${join(home(), 'gone.xlsx')}. Run \`jobhunter init\` to choose it again.`,
      ),
    );

    const other = join(home(), 'budget.xlsx');
    await writeFile(other, writeWorkbook({ sheets: [{ name: 'Budget', rows: [[{ value: 1 }]] }] }));
    expect(await inspectLocalSheet(other)).toBe('other');
    await expect(new LocalSheetTracker(other).knownJobs()).rejects.toThrow(
      "isn't a Jobhunter tracking sheet",
    );

    const damaged = join(home(), 'damaged.xlsx');
    await writeFile(damaged, 'not a spreadsheet');
    expect(await inspectLocalSheet(damaged)).toBe('other');
    await expect(new LocalSheetTracker(damaged).knownJobs()).rejects.toThrow("can't be read");

    expect(await inspectLocalSheet(join(home(), 'new.xlsx'))).toBe('missing');
  });

  it('explains a renamed column', async () => {
    await createLocalSheet(sheetPath(), now);
    const data = trackerDataFrom(await values(sheetPath())) as TrackerData;
    data.applications.header[10] = 'ID';
    await writeFile(sheetPath(), writeWorkbook(buildWorkbook(data)));

    await expect(new LocalSheetTracker(sheetPath()).knownJobs()).rejects.toThrow(
      'The "Applications" tab of your tracking sheet is missing the column(s) "Key"',
    );
  });
});

describe('open sheet detection', () => {
  const home = useTempHome();
  const sheetPath = () => join(home(), 'jobhunter.xlsx');

  it('finds nothing when no app has the file open', async () => {
    expect(await findOpenLock(sheetPath())).toBeUndefined();
  });

  it("reads LibreOffice's lock file, with who opened it", async () => {
    await writeFile(
      join(home(), '.~lock.jobhunter.xlsx#'),
      `Alex Example,${hostname()},alex,12.10.2026 14:03,file:///home/alex/.config/libreoffice/4;`,
    );
    expect(await findOpenLock(sheetPath())).toMatchObject({
      app: 'LibreOffice',
      by: 'Alex Example',
      stale: false,
    });
  });

  it('names the other computer when the folder is shared', async () => {
    await writeFile(
      join(home(), '.~lock.jobhunter.xlsx#'),
      'Sam,sams-desktop,sam,12.10.2026 14:03,;',
    );
    expect(await findOpenLock(sheetPath())).toMatchObject({ by: 'Sam on sams-desktop' });
  });

  it("finds Excel and ONLYOFFICE's owner files, including Excel's shortened name", async () => {
    await writeFile(
      join(home(), '~$jobhunter.xlsx'),
      Buffer.concat([Buffer.from([4]), Buffer.from('Alex')]),
    );
    expect(await findOpenLock(sheetPath())).toMatchObject({
      app: 'Excel or ONLYOFFICE',
      by: 'Alex',
    });

    const other = join(home(), 'tracker');
    await mkdir(other);
    await writeFile(join(other, '~$bhunter.xlsx'), 'binary junk');
    expect(await findOpenLock(join(other, 'jobhunter.xlsx'))).toMatchObject({ app: 'Excel' });
  });

  it('marks a lock from before the computer started as left over', async () => {
    const lock = join(home(), '.~lock.jobhunter.xlsx#');
    await writeFile(lock, `Alex,${hostname()},alex,01.01.2020 10:00,;`);
    const old = new Date('2020-01-01T10:00:00Z');
    await utimes(lock, old, old);
    expect(await findOpenLock(sheetPath())).toMatchObject({ stale: true });
  });
});
