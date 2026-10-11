import { describe, expect, it } from 'vitest';
import {
  APPLICATION_COLUMNS,
  buildCreateBody,
  buildLayoutRequests,
  columnLetter,
  hexToRgb,
  IGNORED_COLUMNS,
  SHEET_IDS,
  STATUSES,
  VIEW_TABS,
  viewFormula,
} from '../../src/sheet/layout.js';

type Req = Record<string, Record<string, unknown>>;
const requests = buildLayoutRequests({ createdAt: '2026-10-11T12:00:00.000Z' }) as Req[];
const ofType = (type: string) =>
  requests
    .filter((request) => type in request)
    .map((request) => request[type] as Record<string, unknown>);
const sheetOf = (range: unknown) => (range as { sheetId: number }).sheetId;

describe('sheet layout helpers', () => {
  it('converts hex colours and column numbers', () => {
    expect(hexToRgb('#FF8000')).toEqual({ red: 1, green: 128 / 255, blue: 0 });
    expect(
      ['A', 'E', 'N', 'Z', 'AA', 'AB'].map((_, i) => columnLetter([0, 4, 13, 25, 26, 27][i] ?? 0)),
    ).toEqual(['A', 'E', 'N', 'Z', 'AA', 'AB']);
  });

  it('builds the FILTER formula for one or several statuses', () => {
    expect(viewFormula(['To apply'])).toBe(
      '=IFERROR(SORT(FILTER(Applications!A2:J, (Applications!E2:E="To apply")), 1, TRUE), "Nothing here yet")',
    );
    expect(viewFormula(['Interview', 'Offer'])).toContain(
      '(Applications!E2:E="Interview")+(Applications!E2:E="Offer")',
    );
  });
});

describe('creating the spreadsheet', () => {
  it('uses en_US formulas, the given time zone, and all tabs with fixed IDs', () => {
    const body = buildCreateBody('Jobhunter', 'Asia/Tbilisi') as {
      properties: Record<string, string>;
      sheets: { properties: { sheetId: number; title: string; hidden?: boolean } }[];
    };
    expect(body.properties).toEqual({
      title: 'Jobhunter',
      locale: 'en_US',
      timeZone: 'Asia/Tbilisi',
    });
    expect(body.sheets.map((s) => s.properties.title)).toEqual([
      'Applications',
      ...VIEW_TABS.map((view) => view.title),
      'Ignored',
      '_meta',
    ]);
    expect(body.sheets.map((s) => s.properties.sheetId)).toEqual([
      100, 101, 102, 103, 104, 105, 106, 200, 900,
    ]);
    expect(body.sheets.at(-1)?.properties.hidden).toBe(true);
  });

  it('colours the status tabs and Ignored, but not Applications', () => {
    const body = buildCreateBody('Jobhunter', 'UTC') as {
      sheets: { properties: { title: string; tabColorStyle?: { rgbColor: unknown } } }[];
    };
    const colours = Object.fromEntries(
      body.sheets.map((s) => [s.properties.title, s.properties.tabColorStyle?.rgbColor]),
    );
    expect(colours.Applications).toBeUndefined();
    expect(colours['To apply']).toEqual(hexToRgb('#9972D8'));
    expect(colours['Interview & Offer']).toEqual(hexToRgb('#4C99E5'));
    expect(colours.Ignored).toEqual(hexToRgb('#CCCCCC'));
    expect(colours._meta).toBeUndefined();
  });
});

describe('layout requests', () => {
  it('writes the Applications and Ignored headers', () => {
    const headers = (sheetId: number) =>
      ofType('updateCells')
        .filter(
          (u) => sheetOf(u.start) === sheetId && (u.start as { rowIndex: number }).rowIndex === 0,
        )
        .flatMap(
          (u) =>
            (u.rows as { values: { userEnteredValue: Record<string, string> }[] }[])[0]?.values ??
            [],
        )
        .map((cell) => cell.userEnteredValue.stringValue ?? cell.userEnteredValue.formulaValue);

    expect(headers(SHEET_IDS.applications)).toEqual([
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
    expect(headers(SHEET_IDS.ignored)).toEqual(IGNORED_COLUMNS.map((c) => c.header));
    expect(headers(SHEET_IDS.views[0] ?? 0)).toEqual(['Change status', '={Applications!A1:J1}']);
  });

  it('hides Key, Source and Found but keeps Match visible', () => {
    const hidden = ofType('updateDimensionProperties')
      .filter(
        (u) =>
          sheetOf(u.range) === SHEET_IDS.applications &&
          (u.properties as { hiddenByUser: boolean }).hiddenByUser,
      )
      .map((u) => APPLICATION_COLUMNS[(u.range as { startIndex: number }).startIndex]?.header);
    expect(hidden).toEqual(['Key', 'Source', 'Found']);
  });

  it('puts a strict status dropdown on Applications!E and every view tab column A', () => {
    const dropdowns = ofType('setDataValidation');
    const apps = dropdowns.find((d) => sheetOf(d.range) === SHEET_IDS.applications);
    expect(apps).toMatchObject({
      range: { startColumnIndex: 4, endColumnIndex: 5 },
      rule: { strict: true },
    });
    expect(
      (
        apps?.rule as { condition: { values: { userEnteredValue: string }[] } }
      ).condition.values.map((v) => v.userEnteredValue),
    ).toEqual([...STATUSES]);
    for (const sheetId of SHEET_IDS.views) {
      expect(dropdowns.find((d) => sheetOf(d.range) === sheetId)).toMatchObject({
        range: { startColumnIndex: 0 },
      });
    }
    expect(dropdowns.find((d) => sheetOf(d.range) === SHEET_IDS.ignored)).toMatchObject({
      rule: { condition: { values: [{ userEnteredValue: 'To apply' }] } },
    });
  });

  it('colours rows by status: column E on Applications, F on view tabs', () => {
    const rules = ofType('addConditionalFormatRule').map(
      (r) =>
        r.rule as {
          ranges: unknown[];
          booleanRule: { condition: { values: { userEnteredValue: string }[] } };
        },
    );
    const formulasFor = (sheetId: number) =>
      rules
        .filter((r) => sheetOf(r.ranges[0]) === sheetId)
        .map((r) => r.booleanRule.condition.values[0]?.userEnteredValue);

    expect(formulasFor(SHEET_IDS.applications)).toEqual([
      '=$E2="To apply"',
      '=$E2="Applied"',
      '=$E2="Interview"',
      '=$E2="Offer"',
      '=$E2="Declined"',
      '=$E2="Ghosted"',
      '=OR($E2="Withdrawn",$E2="Skipped")',
    ]);
    expect(formulasFor(SHEET_IDS.views[2] ?? 0)[0]).toBe('=$F2="To apply"');
  });

  it('only sends text properties colour rules accept, and never an empty textFormat', () => {
    const formats = ofType('addConditionalFormatRule').map(
      (r) =>
        (r.rule as { booleanRule: { format: Record<string, Record<string, unknown> | undefined> } })
          .booleanRule.format,
    );
    for (const format of formats) {
      expect(
        Object.keys(format).every((key) => ['backgroundColor', 'textFormat'].includes(key)),
      ).toBe(true);
      if (format.textFormat) {
        expect(Object.keys(format.textFormat).length).toBeGreaterThan(0);
        expect(
          Object.keys(format.textFormat).every((key) =>
            ['bold', 'italic', 'strikethrough', 'foregroundColor'].includes(key),
          ),
        ).toBe(true);
      }
    }
    expect(formats[0]).not.toHaveProperty('textFormat');
    expect(formats[3]?.textFormat).toEqual({ bold: true });
  });

  it('fills each view tab with its FILTER formula', () => {
    const formulas = ofType('updateCells')
      .filter(
        (u) =>
          (SHEET_IDS.views as readonly number[]).includes(sheetOf(u.start)) &&
          (u.start as { rowIndex: number }).rowIndex === 1,
      )
      .map(
        (u) =>
          (u.rows as { values: { userEnteredValue: { formulaValue?: string } }[] }[])[0]?.values[1]
            ?.userEnteredValue.formulaValue,
      );
    expect(formulas).toEqual(VIEW_TABS.map((view) => viewFormula(view.statuses)));
  });

  it('records the schema version and column maps in _meta', () => {
    const meta = ofType('updateCells')
      .filter((u) => sheetOf(u.start) === SHEET_IDS.meta)
      .map((u) =>
        (u.rows as { values: { userEnteredValue: { stringValue: string } }[] }[])[0]?.values.map(
          (v) => v.userEnteredValue.stringValue,
        ),
      );
    expect(meta).toEqual([
      ['schemaVersion', '1'],
      ['createdBy', 'jobhunter'],
      ['createdAt', '2026-10-11T12:00:00.000Z'],
      ['applicationsColumns', JSON.stringify(APPLICATION_COLUMNS.map((c) => c.header))],
      ['ignoredColumns', JSON.stringify(IGNORED_COLUMNS.map((c) => c.header))],
    ]);
  });
});
