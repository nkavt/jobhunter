/**
 * The tracking sheet Jobhunter creates: a master `Applications` tab, read-only status view tabs
 * built with FILTER formulas, an `Ignored` tab for jobs dropped by the filters, and a hidden
 * `_meta` tab. Pure data + request builders, so it can be tested without Google.
 */

export const SCHEMA_VERSION = 1;

export const STATUSES = [
  'To apply',
  'Applied',
  'Interview',
  'Offer',
  'Declined',
  'Ghosted',
  'Withdrawn',
  'Skipped',
] as const;
export type Status = (typeof STATUSES)[number];

export interface ColumnSpec {
  header: string;
  width: number;
  hidden?: boolean;
  date?: boolean;
  /** Long text: wrap it so the whole note is readable. */
  wrap?: boolean;
}

/** `Applications`: A–J are what the view tabs show; K–N are Jobhunter's own columns. */
export const APPLICATION_COLUMNS = [
  { header: 'Company', width: 180 },
  { header: 'Role', width: 240 },
  { header: 'Applied', width: 100, date: true },
  { header: 'Channel', width: 170 },
  { header: 'Status', width: 110 },
  { header: 'Last update', width: 110, date: true },
  { header: 'Link', width: 220 },
  { header: 'Notes', width: 420, wrap: true },
  { header: 'Note 1', width: 220 },
  { header: 'Note 2', width: 220 },
  { header: 'Key', width: 120, hidden: true },
  { header: 'Source', width: 200, hidden: true },
  { header: 'Found', width: 140, hidden: true, date: true },
  { header: 'Match', width: 70 },
] as const satisfies readonly ColumnSpec[];

export const IGNORED_COLUMNS = [
  { header: 'Restore', width: 100 },
  { header: 'Company', width: 180 },
  { header: 'Role', width: 240 },
  { header: 'Channel', width: 170 },
  { header: 'Reason', width: 320, wrap: true },
  { header: 'Found', width: 110, date: true },
  { header: 'Link', width: 220 },
  { header: 'Key', width: 120, hidden: true },
  { header: 'Source', width: 200, hidden: true },
] as const satisfies readonly ColumnSpec[];

/** Number of `Applications` columns the view tabs mirror (A–J). */
const VIEW_COLUMN_COUNT = 10;
const STATUS_COLUMN = 4; // E (0-based)

export const VIEW_TABS = [
  { title: 'To apply', statuses: ['To apply'], tabColor: '#9972D8' },
  { title: 'Applied', statuses: ['Applied'], tabColor: '#F2BF33' },
  { title: 'Interview & Offer', statuses: ['Interview', 'Offer'], tabColor: '#4C99E5' },
  { title: 'Declined', statuses: ['Declined'], tabColor: '#D84C4C' },
  { title: 'Ghosted', statuses: ['Ghosted'], tabColor: '#597293' },
  { title: 'Skipped', statuses: ['Skipped'], tabColor: '#999999' },
] as const satisfies readonly { title: string; statuses: readonly Status[]; tabColor: string }[];

const IGNORED_TAB_COLOR = '#CCCCCC';

/** Fixed sheet IDs so later code can address tabs without looking them up. */
export const SHEET_IDS = {
  applications: 100,
  views: VIEW_TABS.map((_, index) => 101 + index),
  ignored: 200,
  meta: 900,
} as const;

/** Row colours per status (whole row), matching the familiar job-tracker look. */
const STATUS_STYLES: { statuses: Status[]; background: string; text?: string; bold?: boolean }[] = [
  { statuses: ['To apply'], background: '#EBE1F8' },
  { statuses: ['Applied'], background: '#FFF3CC' },
  { statuses: ['Interview'], background: '#D9EAFF' },
  { statuses: ['Offer'], background: '#D4EFD4', bold: true },
  { statuses: ['Declined'], background: '#F8D9D9' },
  { statuses: ['Ghosted'], background: '#DBE2EF' },
  { statuses: ['Withdrawn', 'Skipped'], background: '#EDEDED', text: '#666666' },
];

const HEADER_BACKGROUND = '#F3F3F3';
const GREY_TEXT = '#666666';

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return {
    red: ((value >> 16) & 255) / 255,
    green: ((value >> 8) & 255) / 255,
    blue: (value & 255) / 255,
  };
}

/** `0` → `A`, `13` → `N`, `26` → `AA`. */
export function columnLetter(index: number): string {
  let letter = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
  }
  return letter;
}

type Request = Record<string, unknown>;

/** Body for `POST /v4/spreadsheets`: title, locale, time zone and empty tabs with fixed IDs. */
export function buildCreateBody(title: string, timeZone: string): Request {
  const tab = (sheetId: number, tabTitle: string, extra: Record<string, unknown> = {}) => ({
    properties: { sheetId, title: tabTitle, ...extra },
  });
  return {
    // en_US keeps formula separators as commas whatever the user's Google locale is.
    properties: { title, locale: 'en_US', timeZone },
    sheets: [
      tab(SHEET_IDS.applications, 'Applications', {
        gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 },
      }),
      ...VIEW_TABS.map((view, index) =>
        tab(SHEET_IDS.views[index] ?? 0, view.title, {
          gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 },
          tabColorStyle: { rgbColor: hexToRgb(view.tabColor) },
        }),
      ),
      tab(SHEET_IDS.ignored, 'Ignored', {
        gridProperties: { frozenRowCount: 1 },
        tabColorStyle: { rgbColor: hexToRgb(IGNORED_TAB_COLOR) },
      }),
      tab(SHEET_IDS.meta, '_meta', { hidden: true }),
    ],
  };
}

const text = (value: string) => ({ userEnteredValue: { stringValue: value } });
const formula = (value: string) => ({ userEnteredValue: { formulaValue: value } });

function writeRow(sheetId: number, row: number, cells: Record<string, unknown>[]): Request {
  return {
    updateCells: {
      start: { sheetId, rowIndex: row, columnIndex: 0 },
      rows: [{ values: cells }],
      fields: 'userEnteredValue',
    },
  };
}

function headerStyle(sheetId: number, columns: number): Request {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: columns,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexToRgb(HEADER_BACKGROUND),
          textFormat: { bold: true },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat)',
    },
  };
}

function columnRequests(sheetId: number, columns: readonly ColumnSpec[], offset = 0): Request[] {
  return columns.flatMap((column, index) => {
    const range = {
      sheetId,
      dimension: 'COLUMNS',
      startIndex: offset + index,
      endIndex: offset + index + 1,
    };
    const requests: Request[] = [
      {
        updateDimensionProperties: {
          range,
          properties: { pixelSize: column.width, hiddenByUser: column.hidden ?? false },
          fields: 'pixelSize,hiddenByUser',
        },
      },
    ];
    const format = cellFormat(column);
    if (format) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            startColumnIndex: offset + index,
            endColumnIndex: offset + index + 1,
          },
          cell: { userEnteredFormat: format.format },
          fields: format.fields,
        },
      });
    }
    return requests;
  });
}

function cellFormat(
  column: ColumnSpec,
): { format: Record<string, unknown>; fields: string } | undefined {
  const format = {
    ...(column.date ? { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } : {}),
    ...(column.wrap ? { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } : {}),
  };
  const fields = Object.keys(format).map((key) => `userEnteredFormat.${key}`);
  return fields.length > 0 ? { format, fields: fields.join(',') } : undefined;
}

function statusDropdown(
  sheetId: number,
  column: number,
  values: readonly string[],
  rows: { start: number; end?: number } = { start: 1 },
): Request {
  return {
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: rows.start,
        ...(rows.end === undefined ? {} : { endRowIndex: rows.end }),
        startColumnIndex: column,
        endColumnIndex: column + 1,
      },
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: values.map((value) => ({ userEnteredValue: value })),
        },
        strict: true,
        showCustomUi: true,
      },
    },
  };
}

/** One conditional-format rule per status style, colouring whole rows by the status column. */
function statusColours(sheetId: number, statusColumn: number, columns: number): Request[] {
  const letter = columnLetter(statusColumn);
  return STATUS_STYLES.map((style, index) => {
    const checks = style.statuses.map((status) => `$${letter}2="${status}"`);
    // Colour rules only accept a few text properties; an empty textFormat is rejected outright.
    const textFormat = {
      ...(style.text ? { foregroundColor: hexToRgb(style.text) } : {}),
      ...(style.bold ? { bold: true } : {}),
    };
    return {
      addConditionalFormatRule: {
        index,
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns }],
          booleanRule: {
            condition: {
              type: 'CUSTOM_FORMULA',
              values: [
                {
                  userEnteredValue:
                    checks.length > 1 ? `=OR(${checks.join(',')})` : `=${checks[0] ?? ''}`,
                },
              ],
            },
            format: {
              backgroundColor: hexToRgb(style.background),
              ...(Object.keys(textFormat).length > 0 ? { textFormat } : {}),
            },
          },
        },
      },
    };
  });
}

/** `FILTER` formula for a view tab, sorted by company; shows a hint while it's empty. */
export function viewFormula(statuses: readonly Status[]): string {
  const lastColumn = columnLetter(VIEW_COLUMN_COUNT - 1);
  const status = columnLetter(STATUS_COLUMN);
  // Whole columns + ROW()>1 instead of A2:J: a range starting at row 2 would move down whenever
  // rows are inserted above it, and the view would miss them.
  const condition = statuses
    .map((value) => `(Applications!${status}:${status}="${value}")`)
    .join('+');
  return `=IFERROR(SORT(FILTER(Applications!A:${lastColumn}, ROW(Applications!A:A)>1, ${condition}), 1, TRUE), "Nothing here yet")`;
}

export interface MetaInfo {
  createdAt: string;
}

const RESTORE_VALUES = ['To apply'];

/**
 * Formatting for freshly written data rows `start`–`end` (0-based, end exclusive), found by the
 * tab's actual header. Rows appended under the header copy its look (bold, grey) and miss the
 * dropdowns, so this resets them to the data-row look.
 */
export function dataRowRequests(
  tab: 'applications' | 'ignored',
  header: readonly string[],
  start: number,
  end: number,
): Request[] {
  const sheetId = tab === 'applications' ? SHEET_IDS.applications : SHEET_IDS.ignored;
  const specs: readonly ColumnSpec[] =
    tab === 'applications' ? APPLICATION_COLUMNS : IGNORED_COLUMNS;
  const rows = { sheetId, startRowIndex: start, endRowIndex: end };
  const requests: Request[] = [
    {
      repeatCell: {
        range: { ...rows, startColumnIndex: 0, endColumnIndex: header.length },
        cell: {
          userEnteredFormat:
            tab === 'ignored' ? { textFormat: { foregroundColor: hexToRgb(GREY_TEXT) } } : {},
        },
        fields: 'userEnteredFormat',
      },
    },
  ];
  header.forEach((name, index) => {
    const spec = specs.find((column) => column.header === name);
    const format = spec && cellFormat(spec);
    if (format) {
      requests.push({
        repeatCell: {
          range: { ...rows, startColumnIndex: index, endColumnIndex: index + 1 },
          cell: { userEnteredFormat: format.format },
          fields: format.fields,
        },
      });
    }
  });
  const dropdown = tab === 'applications' ? header.indexOf('Status') : header.indexOf('Restore');
  if (dropdown >= 0) {
    const values = tab === 'applications' ? STATUSES : RESTORE_VALUES;
    requests.push(statusDropdown(sheetId, dropdown, values, { start, end }));
  }
  return requests;
}

/** All `batchUpdate` requests that turn the empty tabs into the tracking sheet. */
export function buildLayoutRequests(meta: MetaInfo): Request[] {
  const apps = SHEET_IDS.applications;
  const viewHeaderFormula = `={Applications!A1:${columnLetter(VIEW_COLUMN_COUNT - 1)}1}`;

  return [
    // Applications
    writeRow(
      apps,
      0,
      APPLICATION_COLUMNS.map((column) => text(column.header)),
    ),
    headerStyle(apps, APPLICATION_COLUMNS.length),
    ...columnRequests(apps, APPLICATION_COLUMNS),
    statusDropdown(apps, STATUS_COLUMN, STATUSES),
    ...statusColours(apps, STATUS_COLUMN, VIEW_COLUMN_COUNT),

    // View tabs: A = Change status, B… = Applications A–J
    ...VIEW_TABS.flatMap((view, index) => {
      const sheetId = SHEET_IDS.views[index] ?? 0;
      return [
        writeRow(sheetId, 0, [text('Change status'), formula(viewHeaderFormula)]),
        writeRow(sheetId, 1, [text(''), formula(viewFormula(view.statuses))]),
        headerStyle(sheetId, VIEW_COLUMN_COUNT + 1),
        ...columnRequests(sheetId, [{ header: 'Change status', width: 130 }]),
        ...columnRequests(sheetId, APPLICATION_COLUMNS.slice(0, VIEW_COLUMN_COUNT), 1),
        statusDropdown(sheetId, 0, STATUSES),
        ...statusColours(sheetId, STATUS_COLUMN + 1, VIEW_COLUMN_COUNT + 1),
      ];
    }),

    // Ignored
    writeRow(
      SHEET_IDS.ignored,
      0,
      IGNORED_COLUMNS.map((column) => text(column.header)),
    ),
    headerStyle(SHEET_IDS.ignored, IGNORED_COLUMNS.length),
    ...columnRequests(SHEET_IDS.ignored, IGNORED_COLUMNS),
    statusDropdown(SHEET_IDS.ignored, 0, RESTORE_VALUES),
    {
      repeatCell: {
        range: { sheetId: SHEET_IDS.ignored, startRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: hexToRgb(GREY_TEXT) } } },
        fields: 'userEnteredFormat.textFormat.foregroundColor',
      },
    },

    // _meta: lets later versions find columns by header and migrate the layout
    ...[
      ['schemaVersion', String(SCHEMA_VERSION)],
      ['createdBy', 'jobhunter'],
      ['createdAt', meta.createdAt],
      ['applicationsColumns', JSON.stringify(APPLICATION_COLUMNS.map((column) => column.header))],
      ['ignoredColumns', JSON.stringify(IGNORED_COLUMNS.map((column) => column.header))],
    ].map(([key = '', value = ''], row) => writeRow(SHEET_IDS.meta, row, [text(key), text(value)])),
  ];
}
