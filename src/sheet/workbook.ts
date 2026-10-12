/**
 * The tracking sheet as a local .xlsx file: the same tabs, columns and colours as the Google
 * Sheet. View tabs are plain rows rebuilt on every write instead of FILTER formulas, so they look
 * right in every spreadsheet app (older LibreOffice versions and Numbers have no FILTER).
 */
import {
  cellRef,
  columnLetter,
  type Cell,
  type CellStyle,
  type CellValue,
  type Sheet,
  type SheetValues,
  type Workbook,
} from '../xlsx/index.js';
import {
  APPLICATION_COLUMNS,
  GREY_TEXT,
  HEADER_BACKGROUND,
  IGNORED_COLUMNS,
  IGNORED_TAB_COLOR,
  RESTORE_VALUES,
  SCHEMA_VERSION,
  STATUS_STYLES,
  STATUSES,
  VIEW_COLUMN_COUNT,
  VIEW_TABS,
  type ColumnSpec,
} from './layout.js';

export const TAB_NAMES = { applications: 'Applications', ignored: 'Ignored', meta: '_meta' };

/** One tab's values: its header row, then the data rows. */
export interface TabData {
  header: string[];
  rows: CellValue[][];
}

export interface TrackerData {
  applications: TabData;
  ignored: TabData;
  createdAt: string;
}

/** Dropdowns and colours reach this far past the last row, for rows added by hand. */
const SPARE_ROWS = 1000;
const HEADER_STYLE: CellStyle = { bold: true, fill: HEADER_BACKGROUND };
const DEFAULT_WIDTH = 120;
const EMPTY_VIEW = 'Nothing here yet';

export function emptyTrackerData(createdAt: string): TrackerData {
  return {
    applications: { header: APPLICATION_COLUMNS.map((column) => column.header), rows: [] },
    ignored: { header: IGNORED_COLUMNS.map((column) => column.header), rows: [] },
    createdAt,
  };
}

/**
 * The tracker tabs of a workbook Jobhunter created, or `undefined` when it isn't one
 * (recognised by its hidden `_meta` tab).
 */
export function trackerDataFrom(sheets: SheetValues[]): TrackerData | undefined {
  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet]));
  const meta = new Map(
    (byName.get(TAB_NAMES.meta)?.rows ?? []).map(([key, value]) => [
      String(key ?? ''),
      String(value ?? ''),
    ]),
  );
  if (meta.get('createdBy') !== 'jobhunter') return undefined;
  return {
    applications: tabData(byName.get(TAB_NAMES.applications)),
    ignored: tabData(byName.get(TAB_NAMES.ignored)),
    createdAt: meta.get('createdAt') ?? '',
  };
}

function tabData(sheet: SheetValues | undefined): TabData {
  const [header = [], ...rows] = sheet?.rows ?? [];
  const names = header.map((value) => String(value).trim());
  return {
    header: names,
    // Rows cleared by hand are dropped.
    rows: rows
      .filter((row) => row.some((value) => value !== ''))
      .map((row) => names.map((_, i) => row[i] ?? '')),
  };
}

export function buildWorkbook(data: TrackerData): Workbook {
  return {
    sheets: [
      applicationsSheet(data.applications),
      ...VIEW_TABS.map((view) => viewSheet(data.applications, view)),
      ignoredSheet(data.ignored),
      metaSheet(data.createdAt),
    ],
  };
}

function applicationsSheet(tab: TabData): Sheet {
  const status = tab.header.indexOf('Status');
  const extent = tab.rows.length + 1 + SPARE_ROWS;
  return {
    name: TAB_NAMES.applications,
    rows: [
      headerRow(tab.header),
      ...tab.rows.map((row) => dataRow(tab.header, row, APPLICATION_COLUMNS)),
    ],
    columns: columnsFor(tab.header, APPLICATION_COLUMNS),
    frozen: { rows: 1, columns: 1 },
    autoFilter: filterRange(tab),
    colourRules: status >= 0 ? statusColours(status, tab.header.length, extent) : [],
    dropdowns: status >= 0 ? [{ range: columnRange(status, extent), values: STATUSES }] : [],
  };
}

function viewSheet(applications: TabData, view: (typeof VIEW_TABS)[number]): Sheet {
  const header = APPLICATION_COLUMNS.slice(0, VIEW_COLUMN_COUNT).map((column) => column.header);
  const status = applications.header.indexOf('Status');
  const company = applications.header.indexOf('Company');
  const statuses: readonly string[] = view.statuses;
  // What the formula returns right now: shown until the app recalculates, and by apps that can't.
  const rows = applications.rows
    .filter((row) => statuses.includes(String(row[status] ?? '')))
    .sort((a, b) => String(a[company] ?? '').localeCompare(String(b[company] ?? '')))
    .map((row) => header.map((name) => row[applications.header.indexOf(name)] ?? ''));
  const lastRow = applications.rows.length + 1 + SPARE_ROWS;
  const formula = {
    text: xlsxViewFormula(statuses, columnLetter(status), lastRow),
    spill: rows.length > 0 ? `A2:${cellRef(rows.length, header.length - 1)}` : 'A2:A2',
  };
  // Formats sit on the columns too, so rows the formula spills into later get them.
  const columns = header.map((name) => {
    const spec: ColumnSpec | undefined = APPLICATION_COLUMNS.find(
      (column) => column.header === name,
    );
    const style: CellStyle = {
      ...(spec?.date ? { date: true } : {}),
      ...(spec?.wrap ? { wrap: true } : {}),
    };
    return {
      width: spec?.width ?? DEFAULT_WIDTH,
      ...(Object.keys(style).length ? { style } : {}),
    };
  });
  const cached: Cell[][] =
    rows.length > 0
      ? rows.map((row) =>
          row.map((raw, i) => {
            const column = columns[i];
            const value = column?.style?.date ? dateValue(raw) : raw;
            return column?.style ? { value, style: column.style } : { value };
          }),
        )
      : [[{ value: EMPTY_VIEW }]];
  const first = cached[0];
  if (first?.[0]) first[0] = { ...first[0], formula };
  return {
    name: view.title,
    rows: [headerRow(header), ...cached],
    columns,
    frozen: { rows: 1, columns: 1 },
    tabColor: view.tabColor,
    colourRules: statusColours(header.indexOf('Status'), header.length, lastRow),
    // The formula fills the tab; typing over it would break the view.
    locked: true,
  };
}

/**
 * The view tab's formula, in Excel's notation: the Applications rows with these statuses, sorted
 * by company, or a hint while there are none. Spreadsheet apps recalculate it as statuses change.
 */
export function xlsxViewFormula(
  statuses: readonly string[],
  statusColumn: string,
  lastRow: number,
): string {
  const last = String(lastRow);
  const data = `Applications!A2:${columnLetter(VIEW_COLUMN_COUNT - 1)}${last}`;
  const condition = statuses
    .map(
      (value) =>
        `(Applications!${statusColumn}2:${statusColumn}${last}="${value.replace(/"/g, '""')}")`,
    )
    .join('+');
  return `IFERROR(_xlfn._xlws.SORT(_xlfn._xlws.FILTER(${data},${condition}),1,1),"${EMPTY_VIEW}")`;
}

function ignoredSheet(tab: TabData): Sheet {
  const restore = tab.header.indexOf('Restore');
  const extent = tab.rows.length + 1 + SPARE_ROWS;
  return {
    name: TAB_NAMES.ignored,
    rows: [
      headerRow(tab.header),
      ...tab.rows.map((row) => dataRow(tab.header, row, IGNORED_COLUMNS, { color: GREY_TEXT })),
    ],
    columns: columnsFor(tab.header, IGNORED_COLUMNS),
    frozen: { rows: 1 },
    tabColor: IGNORED_TAB_COLOR,
    autoFilter: filterRange(tab),
    dropdowns:
      restore >= 0 ? [{ range: columnRange(restore, extent), values: RESTORE_VALUES }] : [],
  };
}

/** Lets later versions find columns by header and migrate the layout. */
function metaSheet(createdAt: string): Sheet {
  return {
    name: TAB_NAMES.meta,
    hidden: true,
    rows: [
      ['schemaVersion', String(SCHEMA_VERSION)],
      ['createdBy', 'jobhunter'],
      ['createdAt', createdAt],
      ['applicationsColumns', JSON.stringify(APPLICATION_COLUMNS.map((column) => column.header))],
      ['ignoredColumns', JSON.stringify(IGNORED_COLUMNS.map((column) => column.header))],
    ].map((row) => row.map((value) => ({ value }))),
  };
}

const headerRow = (header: readonly string[]): Cell[] =>
  header.map((value) => ({ value, style: HEADER_STYLE }));

function dataRow(
  header: readonly string[],
  row: readonly CellValue[],
  specs: readonly ColumnSpec[],
  base: CellStyle = {},
): (Cell | undefined)[] {
  return header.map((name, i) => {
    const spec = specs.find((column) => column.header === name);
    const raw = row[i] ?? '';
    const value = spec?.date ? dateValue(raw) : raw;
    const isLink = name === 'Link' && typeof raw === 'string' && /^https?:\/\//i.test(raw);
    const style: CellStyle = {
      ...base,
      ...(spec?.date && typeof value === 'number' ? { date: true } : {}),
      ...(spec?.wrap ? { wrap: true } : {}),
      ...(isLink ? { link: true } : {}),
    };
    if (value === '' && Object.keys(style).length === 0) return undefined;
    return {
      value,
      ...(Object.keys(style).length > 0 ? { style } : {}),
      ...(isLink ? { link: raw } : {}),
    };
  });
}

/** `2026-10-11` or an ISO timestamp → a spreadsheet date number, so apps sort and filter it as a date. */
export function dateValue(value: CellValue): CellValue {
  if (typeof value !== 'string') return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!match) return value;
  const [, y, m, d, hh = '0', mm = '0', ss = '0'] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  if (Number.isNaN(ms)) return value;
  // Day 25569 is 1970-01-01 in the spreadsheet date system.
  return Math.round((ms / 86_400_000 + 25569) * 1e6) / 1e6;
}

function columnsFor(header: readonly string[], specs: readonly ColumnSpec[]) {
  return header.map((name) => {
    const spec = specs.find((column) => column.header === name);
    return { width: spec?.width ?? DEFAULT_WIDTH, ...(spec?.hidden ? { hidden: true } : {}) };
  });
}

const filterRange = (tab: TabData) =>
  `A1:${cellRef(Math.max(tab.rows.length, 1), Math.max(tab.header.length - 1, 0))}`;

const columnRange = (column: number, lastRow: number) =>
  `${columnLetter(column)}2:${columnLetter(column)}${String(lastRow)}`;

function statusColours(statusColumn: number, columns: number, lastRow: number) {
  if (statusColumn < 0) return [];
  const status = columnLetter(statusColumn);
  const range = `A2:${columnLetter(Math.max(columns - 1, 0))}${String(Math.max(lastRow, 2))}`;
  return STATUS_STYLES.map((style) => {
    const checks = style.statuses.map((value) => `$${status}2="${value}"`);
    return {
      range,
      formula: checks.length > 1 ? `OR(${checks.join(',')})` : (checks[0] ?? ''),
      style: {
        fill: style.background,
        ...(style.text ? { color: style.text } : {}),
        ...(style.bold ? { bold: true } : {}),
      },
    };
  });
}
