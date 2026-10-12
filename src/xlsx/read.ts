import { XMLParser } from 'fast-xml-parser';
import type { CellValue } from './model.js';
import { readZip, ZipError } from './zip.js';

/** A sheet's values; formulas are read as their last calculated result. */
export interface SheetValues {
  name: string;
  hidden: boolean;
  /** Row by row, empty cells as `''`. */
  rows: CellValue[][];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Values stay text until the cell type says otherwise: "007" is a string unless typed as a number.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // Character references like `&#10;` (line breaks in notes).
  htmlEntities: true,
  // Some apps write `x:row` instead of `row`.
  removeNSPrefix: true,
  isArray: (name) => ['sheet', 'Relationship', 'si', 'r', 'row', 'c'].includes(name),
});

type Node = Record<string, unknown>;

const asNode = (value: unknown): Node =>
  value && typeof value === 'object' ? (value as Node) : {};
const asList = (value: unknown): Node[] => (Array.isArray(value) ? value.map(asNode) : []);
const attr = (node: Node, name: string): string | undefined => {
  const value = node[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
};

/** Text of a `<t>` (plain, or with `xml:space` it's an object with `#text`). */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  const inner = asNode(value)['#text'];
  return typeof inner === 'string' || typeof inner === 'number' ? String(inner) : '';
}

/** Excel writes some characters as `_x000D_`; `_x005F_` escapes a literal underscore. */
const unescapeExcel = (value: string): string =>
  value.replace(/_x([0-9A-Fa-f]{4})_/g, (_, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );

/** A shared or inline string: plain `<t>`, or rich text runs `<r><t>…</t></r>`. */
function stringItem(node: Node): string {
  if ('t' in node) return unescapeExcel(text(node.t));
  return unescapeExcel(
    asList(node.r)
      .map((run) => text(run.t))
      .join(''),
  );
}

/** `C12` → column 2. */
function columnIndex(ref: string | undefined): number | undefined {
  const letters = /^([A-Z]+)\d+$/.exec(ref ?? '')?.[1];
  if (!letters) return undefined;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** The file read as text, or `undefined` when it isn't in the archive. */
const part = (files: Map<string, Buffer>, name: string) => files.get(name)?.toString('utf8');

/** Read the values of every sheet in an .xlsx file. */
export function readWorkbook(bytes: Buffer): SheetValues[] {
  const files = readZip(bytes);
  const workbookXml = part(files, 'xl/workbook.xml');
  if (!workbookXml) throw new ZipError("The file isn't an .xlsx spreadsheet (no workbook in it).");

  const workbook = asNode(asNode(parser.parse(workbookXml)).workbook);
  const rels = asList(
    asNode(asNode(parser.parse(part(files, 'xl/_rels/workbook.xml.rels') ?? '')).Relationships)
      .Relationship,
  );
  const targets = new Map(rels.map((rel) => [attr(rel, 'Id'), attr(rel, 'Target') ?? '']));

  const shared = asList(
    asNode(asNode(parser.parse(part(files, 'xl/sharedStrings.xml') ?? '')).sst).si,
  ).map(stringItem);

  return asList(asNode(workbook.sheets).sheet).map((sheet) => {
    const target = targets.get(attr(sheet, 'id')) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = part(files, path);
    return {
      name: attr(sheet, 'name') ?? '',
      hidden: (attr(sheet, 'state') ?? 'visible') !== 'visible',
      rows: xml ? sheetRows(xml, shared) : [],
    };
  });
}

function sheetRows(xml: string, shared: string[]): CellValue[][] {
  const data = asNode(asNode(asNode(parser.parse(xml)).worksheet).sheetData);
  const rows: CellValue[][] = [];
  let nextRow = 0;
  for (const row of asList(data.row)) {
    const number = Number(attr(row, 'r'));
    const rowIndex = Number.isInteger(number) && number > 0 ? number - 1 : nextRow;
    nextRow = rowIndex + 1;
    const values: CellValue[] = [];
    let nextColumn = 0;
    for (const cell of asList(row.c)) {
      const column = columnIndex(attr(cell, 'r')) ?? nextColumn;
      nextColumn = column + 1;
      const value = cellValue(cell, shared);
      if (value === '') continue;
      while (values.length < column) values.push('');
      values[column] = value;
    }
    if (values.length === 0) continue;
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = values;
  }
  return rows;
}

function cellValue(cell: Node, shared: string[]): CellValue {
  const raw = text(cell.v);
  switch (attr(cell, 't')) {
    case 's':
      return shared[Number(raw)] ?? '';
    case 'inlineStr':
      return stringItem(asNode(cell.is));
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'str':
    case 'e':
      return raw;
    default: {
      if (raw === '') return '';
      const number = Number(raw);
      return Number.isFinite(number) ? number : raw;
    }
  }
}
