import { describe, expect, it } from 'vitest';
import { readWorkbook, writeWorkbook, ZipError } from '../../src/xlsx/index.js';
import { readZip, writeZip } from '../../src/xlsx/zip.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** An .xlsx file written the way other apps do: prefixes, inline and rich text, no cell refs. */
function foreignWorkbook(sheetXml: string, sharedStrings = ''): Buffer {
  return writeZip([
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<x:workbook xmlns:x="${NS}" xmlns:r="${REL}"><x:sheets><x:sheet name="Data" sheetId="1" r:id="rId1"/><x:sheet name="Secret" sheetId="2" state="hidden" r:id="rId2"/></x:sheets></x:workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="worksheet" Target="/xl/worksheets/data.xml"/>' +
          '<Relationship Id="rId2" Type="worksheet" Target="worksheets/missing.xml"/>' +
          '</Relationships>',
      ),
    },
    { name: 'xl/worksheets/data.xml', data: Buffer.from(sheetXml) },
    ...(sharedStrings ? [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStrings) }] : []),
  ]);
}

describe('zip', () => {
  it('round-trips entries with UTF-8 names and binary data', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello '.repeat(1000)) },
      { name: 'ünïcode/b.bin', data: Buffer.from([0, 1, 2, 255]) },
      { name: 'empty', data: Buffer.alloc(0) },
    ];
    const read = readZip(writeZip(entries));
    expect([...read.keys()]).toEqual(['a.txt', 'ünïcode/b.bin', 'empty']);
    expect(read.get('a.txt')?.toString()).toBe('hello '.repeat(1000));
    expect([...(read.get('ünïcode/b.bin') ?? [])]).toEqual([0, 1, 2, 255]);
    expect(read.get('empty')?.length).toBe(0);
  });

  it('rejects files that are not ZIP archives or are damaged', () => {
    expect(() => readZip(Buffer.from('not a zip at all, just some text'))).toThrow(ZipError);
    expect(() => readZip(Buffer.alloc(0))).toThrow(ZipError);
    const archive = writeZip([{ name: 'a.txt', data: Buffer.from('hello world') }]);
    archive.fill(0, 30, 40); // corrupt the compressed data
    expect(() => readZip(archive)).toThrow(ZipError);
  });
});

describe('xlsx', () => {
  it('reads back what it writes, keeping text exactly as given', () => {
    const bytes = writeWorkbook({
      sheets: [
        {
          name: 'Main',
          rows: [
            [{ value: 'Company' }, { value: 'Score' }],
            [{ value: '=HYPERLINK("x")' }, { value: 86 }],
            [{ value: ' padded <&> "quoted" ' }, { value: 0.5 }],
            [undefined, { value: 'Bell\u0007 removed' }],
            [{ value: 'Ünïcødé ✓ 日本' }],
          ],
        },
        { name: "It's hidden", hidden: true, rows: [[{ value: 'k' }, { value: 'v' }]] },
      ],
    });

    expect(readWorkbook(bytes)).toEqual([
      {
        name: 'Main',
        hidden: false,
        rows: [
          ['Company', 'Score'],
          ['=HYPERLINK("x")', 86],
          [' padded <&> "quoted" ', 0.5],
          ['', 'Bell removed'],
          ['Ünïcødé ✓ 日本'],
        ],
      },
      { name: "It's hidden", hidden: true, rows: [['k', 'v']] },
    ]);
  });

  it('writes links, dropdowns, colour rules, filters, frozen panes and locked sheets', () => {
    const bytes = writeWorkbook({
      sheets: [
        {
          name: 'Main',
          rows: [
            [{ value: 'Status' }, { value: 'Link' }],
            [
              { value: 'To apply', style: { bold: true, fill: '#EBE1F8' } },
              { value: 'https://a.example/1', style: { link: true }, link: 'https://a.example/1' },
            ],
            [{ value: 'x' }, { value: 'javascript:alert(1)', link: 'javascript:alert(1)' }],
          ],
          columns: [{ width: 140 }, { width: 70, hidden: true }],
          frozen: { rows: 1, columns: 1 },
          tabColor: '#9972D8',
          autoFilter: 'A1:B3',
          colourRules: [
            { range: 'A2:B100', formula: '$A2="To apply"', style: { fill: '#EBE1F8' } },
          ],
          dropdowns: [{ range: 'A2:A100', values: ['To apply', 'Applied'] }],
          locked: true,
        },
      ],
    });
    const files = readZip(bytes);
    const sheet = files.get('xl/worksheets/sheet1.xml')?.toString() ?? '';
    const rels = files.get('xl/worksheets/_rels/sheet1.xml.rels')?.toString() ?? '';
    const workbook = files.get('xl/workbook.xml')?.toString() ?? '';

    expect(sheet).toContain('<tabColor rgb="FF9972D8"/>');
    expect(sheet).toContain('xSplit="1" ySplit="1" topLeftCell="B2"');
    expect(sheet).toContain('<col min="2" max="2" width="10.00" customWidth="1" hidden="1"/>');
    expect(sheet).toContain('<autoFilter ref="A1:B3"/>');
    expect(sheet).toContain('<formula>$A2=&quot;To apply&quot;</formula>');
    expect(sheet).toContain('sqref="A2:A100"><formula1>&quot;To apply,Applied&quot;</formula1>');
    expect(sheet).toContain('<sheetProtection sheet="1"');
    // Only web links become hyperlinks.
    expect(sheet).toContain('<hyperlink ref="B2" r:id="rId1"/>');
    expect(sheet).not.toContain('ref="B3"');
    expect(rels).toContain('Target="https://a.example/1" TargetMode="External"');
    expect(rels).not.toContain('javascript');
    expect(workbook).toContain(
      `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Main'!$A$1:$B$3</definedName>`,
    );
    // The element order Excel insists on.
    const order = [
      '<sheetPr',
      '<dimension',
      '<sheetViews',
      '<cols',
      '<sheetData',
      '<sheetProtection',
      '<autoFilter',
      '<conditionalFormatting',
      '<dataValidations',
      '<hyperlinks',
    ];
    const positions = order.map((tag) => sheet.indexOf(tag));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions).not.toContain(-1);
  });

  it('reads files from other apps: namespace prefixes, inline and rich text, missing refs', () => {
    const sheet =
      `<x:worksheet xmlns:x="${NS}"><x:sheetData>` +
      '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>inline</x:t></x:is></x:c></x:row>' +
      '<x:row r="3"><x:c t="s"><x:v>1</x:v></x:c><x:c t="b"><x:v>1</x:v></x:c><x:c t="str"><x:v>formula result</x:v></x:c><x:c><x:v>45000.5</x:v></x:c></x:row>' +
      '<x:row r="4"><x:c r="A4"/></x:row>' +
      '<x:row r="5"><x:c r="A5" t="s"><x:v>2</x:v></x:c></x:row>' +
      '</x:sheetData></x:worksheet>';
    const shared =
      `<sst xmlns="${NS}"><si><t xml:space="preserve"> plain </t></si>` +
      '<si><r><t>rich </t></r><r><rPr><b/></rPr><t>text</t></r></si>' +
      '<si><t>line&#10;break &amp; &#x263A; carriage_x000D_return</t></si></sst>';

    expect(readWorkbook(foreignWorkbook(sheet, shared))).toEqual([
      {
        name: 'Data',
        hidden: false,
        rows: [
          [' plain ', '', 'inline'],
          [],
          ['rich text', 'TRUE', 'formula result', 45000.5],
          [],
          ['line\nbreak & ☺ carriage\rreturn'],
        ],
      },
      { name: 'Secret', hidden: true, rows: [] },
    ]);
  });

  it('rejects ZIP files that are not spreadsheets', () => {
    const zip = writeZip([{ name: 'word/document.xml', data: Buffer.from('<w/>') }]);
    expect(() => readWorkbook(zip)).toThrow("isn't an .xlsx spreadsheet");
  });
});
