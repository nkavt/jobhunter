/**
 * A spreadsheet as plain data: what the writer turns into an .xlsx file. Only the features
 * that LibreOffice, ONLYOFFICE and Excel all understand the same way.
 */

export type CellValue = string | number;

export interface CellStyle {
  bold?: boolean;
  /** Text colour, `#RRGGBB`. */
  color?: string;
  /** Background colour, `#RRGGBB`. */
  fill?: string;
  /** Show numbers as `yyyy-mm-dd`. */
  date?: boolean;
  /** Wrap long text and align it to the top of the cell. */
  wrap?: boolean;
  /** Align to the top of the cell (implied by `wrap`). */
  top?: boolean;
  /** Blue and underlined, for links. */
  link?: boolean;
}

export interface Cell {
  /** For a formula cell: its last result, shown by apps that don't recalculate. */
  value: CellValue;
  style?: CellStyle;
  /** An http(s) URL the cell links to. */
  link?: string;
  /**
   * A formula whose result spills over a range (FILTER, SORT…), written as Excel's dynamic array
   * formula. Use Excel's names for newer functions (`_xlfn._xlws.FILTER`). The cells of `spill`
   * after this one hold the last results.
   */
  formula?: { text: string; spill: string };
}

export interface Column {
  /** Width in pixels, as Google Sheets measures it. */
  width: number;
  hidden?: boolean;
  /** Look of empty cells in the column, e.g. cells a formula spills into later. */
  style?: CellStyle;
}

/** Colours whole rows when `formula` (written for the range's first row) is true. */
export interface ColourRule {
  /** e.g. `A2:N5000`. */
  range: string;
  formula: string;
  style: Pick<CellStyle, 'bold' | 'color' | 'fill'>;
}

/** A dropdown with a fixed list of values. */
export interface Dropdown {
  range: string;
  values: readonly string[];
}

export interface Sheet {
  name: string;
  /** Rows of cells; `undefined` leaves a cell empty. */
  rows: (Cell | undefined)[][];
  columns?: Column[];
  frozen?: { rows?: number; columns?: number };
  tabColor?: string;
  hidden?: boolean;
  /** Filter buttons on the header, e.g. `A1:N40`. */
  autoFilter?: string;
  colourRules?: ColourRule[];
  dropdowns?: Dropdown[];
  /** Cells can't be edited (no password): for tabs that are regenerated on every run. */
  locked?: boolean;
  /**
   * A fixed height in points for rows `from`–`to` (0-based, end exclusive). Apps only fit a row's
   * height to its text when it's typed in, not when a formula's result changes.
   */
  rowHeight?: { height: number; from: number; to: number };
}

export interface Workbook {
  sheets: Sheet[];
}
