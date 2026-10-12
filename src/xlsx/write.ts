import type { Cell, CellStyle, ColourRule, Sheet, Workbook } from './model.js';
import { writeZip, type ZipEntry } from './zip.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const CONTENT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
/** The longest text a cell can hold in Excel. */
const MAX_TEXT = 32767;
const DATE_FORMAT_ID = 164;
/** Marks formulas as dynamic arrays, so Excel spills them instead of showing `@`. */
const METADATA_XML =
  `<metadata xmlns="${NS}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">` +
  '<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>' +
  '<futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>' +
  '<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata>' +
  '</metadata>';

/** `0` → `A`, `13` → `N`, `26` → `AA`. */
export function columnLetter(index: number): string {
  let letter = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
  }
  return letter;
}

/** `(0, 0)` → `A1`. */
export const cellRef = (row: number, column: number): string =>
  `${columnLetter(column)}${String(row + 1)}`;

/** Drops characters XML can't hold (control characters from feeds), then escapes. */
export function escapeXml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;
const isWebLink = (value: string) => /^https?:\/\/\S+$/i.test(value);

/** Fonts, fills and cell formats, added as cells use them. Index 0 is always the plain look. */
class Styles {
  private readonly fonts = ['<font><sz val="10"/><name val="Arial"/></font>'];
  private readonly fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  private readonly formats = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  private readonly differential: string[] = [];
  private readonly byKey = new Map<string, number>([['{}', 0]]);

  cell(style: CellStyle | undefined): number {
    const key = JSON.stringify(style ?? {});
    const known = this.byKey.get(key);
    if (known !== undefined) return known;

    const font = this.font(style ?? {});
    const fill = style?.fill ? this.fill(style.fill) : 0;
    const attributes = [
      `numFmtId="${String(style?.date ? DATE_FORMAT_ID : 0)}"`,
      `fontId="${String(font)}"`,
      `fillId="${String(fill)}"`,
      'borderId="0"',
      'xfId="0"',
      ...(style?.date ? ['applyNumberFormat="1"'] : []),
      ...(font ? ['applyFont="1"'] : []),
      ...(fill ? ['applyFill="1"'] : []),
      ...(style?.wrap ? ['applyAlignment="1"'] : []),
    ];
    const alignment = style?.wrap ? '<alignment wrapText="1" vertical="top"/>' : '';
    this.formats.push(
      alignment ? `<xf ${attributes.join(' ')}>${alignment}</xf>` : `<xf ${attributes.join(' ')}/>`,
    );
    const index = this.formats.length - 1;
    this.byKey.set(key, index);
    return index;
  }

  /** A format for colour rules, which only override what they set. */
  rule(style: ColourRule['style']): number {
    const font =
      style.bold || style.color
        ? `<font>${style.bold ? '<b/>' : ''}${style.color ? `<color rgb="${argb(style.color)}"/>` : ''}</font>`
        : '';
    // Apps disagree on which colour a rule's solid fill uses, so set both.
    const fill = style.fill
      ? `<fill><patternFill patternType="solid"><fgColor rgb="${argb(style.fill)}"/><bgColor rgb="${argb(style.fill)}"/></patternFill></fill>`
      : '';
    this.differential.push(`<dxf>${font}${fill}</dxf>`);
    return this.differential.length - 1;
  }

  private font(style: CellStyle): number {
    if (!style.bold && !style.color && !style.link) return 0;
    const color = style.link ? '#1155CC' : style.color;
    this.fonts.push(
      `<font>${style.bold ? '<b/>' : ''}${style.link ? '<u/>' : ''}<sz val="10"/>${color ? `<color rgb="${argb(color)}"/>` : ''}<name val="Arial"/></font>`,
    );
    return this.fonts.length - 1;
  }

  private fill(color: string): number {
    this.fills.push(
      `<fill><patternFill patternType="solid"><fgColor rgb="${argb(color)}"/><bgColor indexed="64"/></patternFill></fill>`,
    );
    return this.fills.length - 1;
  }

  xml(): string {
    const list = (tag: string, items: string[]) =>
      `<${tag} count="${String(items.length)}">${items.join('')}</${tag}>`;
    return (
      `${XML_HEAD}<styleSheet xmlns="${NS}">` +
      `<numFmts count="1"><numFmt numFmtId="${String(DATE_FORMAT_ID)}" formatCode="yyyy-mm-dd"/></numFmts>` +
      list('fonts', this.fonts) +
      list('fills', this.fills) +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      list('cellXfs', this.formats) +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      list('dxfs', this.differential) +
      '</styleSheet>'
    );
  }
}

class SharedStrings {
  private readonly items: string[] = [];
  private readonly index = new Map<string, number>();

  add(text: string): number {
    const value = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
    const known = this.index.get(value);
    if (known !== undefined) return known;
    this.items.push(value);
    this.index.set(value, this.items.length - 1);
    return this.items.length - 1;
  }

  xml(): string {
    const items = this.items.map((text) => {
      const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
      return `<si><t${space}>${escapeXml(text)}</t></si>`;
    });
    return `${XML_HEAD}<sst xmlns="${NS}" count="${String(items.length)}" uniqueCount="${String(items.length)}">${items.join('')}</sst>`;
  }
}

/** Turn the workbook into the bytes of an .xlsx file. */
export function writeWorkbook(workbook: Workbook): Buffer {
  const styles = new Styles();
  const strings = new SharedStrings();
  const entries: ZipEntry[] = [];
  const sheetRels: string[] = [];
  const definedNames: string[] = [];

  workbook.sheets.forEach((sheet, index) => {
    const { xml, links } = sheetXml(sheet, styles, strings, index === 0);
    const file = `sheet${String(index + 1)}.xml`;
    entries.push({ name: `xl/worksheets/${file}`, data: Buffer.from(xml) });
    if (links.length > 0) {
      entries.push({
        name: `xl/worksheets/_rels/${file}.rels`,
        data: Buffer.from(
          relationships(
            links.map((target, i) => ({
              id: `rId${String(i + 1)}`,
              type: `${REL_NS}/hyperlink`,
              target,
              external: true,
            })),
          ),
        ),
      });
    }
    sheetRels.push(
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(index + 1)}"${sheet.hidden ? ' state="hidden"' : ''} r:id="rId${String(index + 1)}"/>`,
    );
    if (sheet.autoFilter) {
      const [from = 'A1', to = from] = sheet.autoFilter.split(':');
      const absolute = (ref: string) => ref.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2');
      definedNames.push(
        `<definedName name="_xlnm._FilterDatabase" localSheetId="${String(index)}" hidden="1">'${escapeXml(sheet.name.replace(/'/g, "''"))}'!${absolute(from)}:${absolute(to)}</definedName>`,
      );
    }
  });

  const count = workbook.sheets.length;
  const dynamic = workbook.sheets.some((sheet) =>
    sheet.rows.some((row) => row.some((cell) => cell?.formula)),
  );
  const workbookXml =
    `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${REL_NS}">` +
    '<bookViews><workbookView activeTab="0"/></bookViews>' +
    `<sheets>${sheetRels.join('')}</sheets>` +
    (definedNames.length > 0 ? `<definedNames>${definedNames.join('')}</definedNames>` : '') +
    '</workbook>';
  const workbookRels = relationships([
    ...workbook.sheets.map((_, i) => ({
      id: `rId${String(i + 1)}`,
      type: `${REL_NS}/worksheet`,
      target: `worksheets/sheet${String(i + 1)}.xml`,
    })),
    { id: `rId${String(count + 1)}`, type: `${REL_NS}/styles`, target: 'styles.xml' },
    { id: `rId${String(count + 2)}`, type: `${REL_NS}/sharedStrings`, target: 'sharedStrings.xml' },
    ...(dynamic
      ? [{ id: `rId${String(count + 3)}`, type: `${REL_NS}/sheetMetadata`, target: 'metadata.xml' }]
      : []),
  ]);
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${CONTENT}.sheet.main+xml"/>` +
    workbook.sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${String(i + 1)}.xml" ContentType="${CONTENT}.worksheet+xml"/>`,
      )
      .join('') +
    `<Override PartName="/xl/styles.xml" ContentType="${CONTENT}.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${CONTENT}.sharedStrings+xml"/>` +
    (dynamic
      ? `<Override PartName="/xl/metadata.xml" ContentType="${CONTENT}.sheetMetadata+xml"/>`
      : '') +
    '</Types>';

  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        relationships([
          { id: 'rId1', type: `${REL_NS}/officeDocument`, target: 'xl/workbook.xml' },
        ]),
      ),
    },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels) },
    ...entries,
    // Written last: cells register their styles and strings while their sheets are built.
    { name: 'xl/styles.xml', data: Buffer.from(styles.xml()) },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(strings.xml()) },
    ...(dynamic ? [{ name: 'xl/metadata.xml', data: Buffer.from(XML_HEAD + METADATA_XML) }] : []),
  ]);
}

function relationships(
  items: { id: string; type: string; target: string; external?: boolean }[],
): string {
  const rels = items.map(
    (item) =>
      `<Relationship Id="${item.id}" Type="${item.type}" Target="${escapeXml(item.target)}"${item.external ? ' TargetMode="External"' : ''}/>`,
  );
  return `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">${rels.join('')}</Relationships>`;
}

function sheetXml(
  sheet: Sheet,
  styles: Styles,
  strings: SharedStrings,
  selected: boolean,
): { xml: string; links: string[] } {
  const links: string[] = [];
  const hyperlinks: string[] = [];
  const width = Math.max(1, sheet.columns?.length ?? 0, ...sheet.rows.map((row) => row.length));

  const rows = sheet.rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      if (!cell) return '';
      const ref = cellRef(r, c);
      if (cell.link && isWebLink(cell.link)) {
        links.push(cell.link);
        hyperlinks.push(`<hyperlink ref="${ref}" r:id="rId${String(links.length)}"/>`);
      }
      return cellXml(ref, cell, styles, strings);
    });
    return `<row r="${String(r + 1)}">${cells.join('')}</row>`;
  });

  const frozenRows = sheet.frozen?.rows ?? 0;
  const frozenColumns = sheet.frozen?.columns ?? 0;
  let pane = '';
  if (frozenRows || frozenColumns) {
    const active =
      frozenRows && frozenColumns ? 'bottomRight' : frozenRows ? 'bottomLeft' : 'topRight';
    pane =
      `<pane${frozenColumns ? ` xSplit="${String(frozenColumns)}"` : ''}${frozenRows ? ` ySplit="${String(frozenRows)}"` : ''}` +
      ` topLeftCell="${cellRef(frozenRows, frozenColumns)}" activePane="${active}" state="frozen"/>` +
      `<selection pane="${active}"/>`;
  }

  const columns = sheet.columns?.length
    ? `<cols>${sheet.columns
        .map(
          (column, i) =>
            `<col min="${String(i + 1)}" max="${String(i + 1)}" width="${(column.width / 7).toFixed(2)}"${column.style ? ` style="${String(styles.cell(column.style))}"` : ''} customWidth="1"${column.hidden ? ' hidden="1"' : ''}/>`,
        )
        .join('')}</cols>`
    : '';

  const rules = (sheet.colourRules ?? []).map(
    (rule, i) =>
      `<conditionalFormatting sqref="${rule.range}"><cfRule type="expression" dxfId="${String(styles.rule(rule.style))}" priority="${String(i + 1)}"><formula>${escapeXml(rule.formula)}</formula></cfRule></conditionalFormatting>`,
  );
  const dropdowns = (sheet.dropdowns ?? []).map(
    (dropdown) =>
      `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${dropdown.range}"><formula1>${escapeXml(`"${dropdown.values.join(',')}"`)}</formula1></dataValidation>`,
  );

  const xml =
    `${XML_HEAD}<worksheet xmlns="${NS}" xmlns:r="${REL_NS}">` +
    (sheet.tabColor ? `<sheetPr><tabColor rgb="${argb(sheet.tabColor)}"/></sheetPr>` : '') +
    `<dimension ref="A1:${cellRef(Math.max(sheet.rows.length - 1, 0), width - 1)}"/>` +
    `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    columns +
    `<sheetData>${rows.join('')}</sheetData>` +
    (sheet.locked
      ? '<sheetProtection sheet="1" objects="1" scenarios="1" formatColumns="0" formatRows="0"/>'
      : '') +
    (sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : '') +
    rules.join('') +
    (dropdowns.length
      ? `<dataValidations count="${String(dropdowns.length)}">${dropdowns.join('')}</dataValidations>`
      : '') +
    (hyperlinks.length ? `<hyperlinks>${hyperlinks.join('')}</hyperlinks>` : '') +
    '</worksheet>';
  return { xml, links };
}

function cellXml(ref: string, cell: Cell, styles: Styles, strings: SharedStrings): string {
  const style = styles.cell(cell.style);
  const s = style ? ` s="${String(style)}"` : '';
  if (cell.formula) {
    const f = `<f t="array" ref="${cell.formula.spill}">${escapeXml(cell.formula.text)}</f>`;
    const number = typeof cell.value === 'number' && Number.isFinite(cell.value);
    const type = number ? '' : ' t="str"';
    return `<c r="${ref}"${s}${type} cm="1">${f}<v>${escapeXml(String(cell.value))}</v></c>`;
  }
  if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
    return `<c r="${ref}"${s}><v>${String(cell.value)}</v></c>`;
  }
  const text = String(cell.value);
  if (text === '') return s ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}"${s} t="s"><v>${String(strings.add(text))}</v></c>`;
}
