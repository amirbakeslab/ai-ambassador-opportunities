import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { COLUMNS, DATE_FIELDS, FIELD_KEYS, formatZodIssues, OpportunitySchema, type FieldKey, type Opportunity } from './schema.js';
import { DateParseError, parseDateCell } from './dates.js';
import { CliError } from './errors.js';
import { neutralizeFormula } from './safety.js';

export type Cell = string | number | boolean | null | undefined;

interface RowIssue {
  /** 1-based sheet row number (header is row 1). */
  row: number;
  id: string | null;
  problems: string[];
}

export interface ParsedTable {
  records: Opportunity[];
  /** Sheet row number for each valid record id. */
  rowById: Map<string, number>;
  issues: RowIssue[];
  /** Column index for each field key in the source header. */
  columnIndex: Record<FieldKey, number>;
  header: string[];
}

function mapHeader(header: string[]): Record<FieldKey, number> {
  const normalized = header.map((h) => h.trim().replace(/^\uFEFF/, ''));
  const columnIndex = {} as Record<FieldKey, number>;
  const missing: string[] = [];
  for (const c of COLUMNS) {
    const i = normalized.indexOf(c.header);
    if (i === -1) missing.push(c.header);
    else if (normalized.indexOf(c.header, i + 1) !== -1) throw new CliError(`Catalog header "${c.header}" appears more than once.`);
    else columnIndex[c.key] = i;
  }
  if (missing.length) {
    throw new CliError(`Catalog is missing expected column(s): ${missing.join(', ')}. The published format may have changed.`);
  }
  return columnIndex;
}

function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** Convert one raw row into a validated record, or a list of problems. */
function rowToRecord(row: Cell[], columnIndex: Record<FieldKey, number>): { record?: Opportunity; problems: string[]; id: string | null } {
  const problems: string[] = [];
  const draft: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) {
    const raw = row[columnIndex[key]];
    if ((DATE_FIELDS as readonly string[]).includes(key)) {
      try {
        draft[key] = parseDateCell(typeof raw === 'string' ? raw.trim() : raw);
      } catch (e) {
        problems.push(`${key} ${e instanceof DateParseError ? e.message : String(e)}`);
        draft[key] = null;
      }
    } else if (key === 'sourceIds') {
      draft[key] = cellText(raw)
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      draft[key] = cellText(raw);
    }
  }
  const id = typeof draft.id === 'string' && draft.id ? draft.id : null;
  const parsed = OpportunitySchema.safeParse(draft);
  if (!parsed.success) problems.push(...formatZodIssues(parsed.error));
  if (problems.length) return { problems, id };
  return { record: parsed.data, problems, id };
}

/** Parse a header + rows grid (from CSV or the Sheets API) into records, keeping per-row problems. */
export function parseGrid(grid: Cell[][]): ParsedTable {
  const [headerRow, ...rows] = grid;
  if (!headerRow) throw new CliError('Catalog is empty (no header row).');
  const header = headerRow.map(cellText);
  const columnIndex = mapHeader(header);
  const records: Opportunity[] = [];
  const rowById = new Map<string, number>();
  const issues: RowIssue[] = [];
  rows.forEach((row, i) => {
    const rowNumber = i + 2;
    if (row.every((c) => cellText(c) === '')) return;
    const { record, problems, id } = rowToRecord(row, columnIndex);
    if (id && rowById.has(id)) {
      issues.push({ row: rowNumber, id, problems: [`duplicate Opportunity ID (also on row ${rowById.get(id)})`, ...problems] });
      return;
    }
    if (!record) {
      issues.push({ row: rowNumber, id, problems });
      return;
    }
    rowById.set(record.id, rowNumber);
    records.push(record);
  });
  return { records, rowById, issues, columnIndex, header };
}

export function parseCatalogCsv(text: string): ParsedTable {
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new CliError('Catalog feed returned HTML instead of CSV. The Sheet may be unpublished or the URL is wrong.');
  }
  let grid: string[][];
  try {
    grid = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
  } catch (e) {
    throw new CliError(`Catalog CSV could not be parsed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseGrid(grid);
}

/** Plain string value for a field as it appears in exports and diffs. */
export function fieldToText(record: Opportunity, key: FieldKey): string {
  const v = record[key];
  if (Array.isArray(v)) return v.join(', ');
  return v ?? '';
}

export function recordsToCsv(records: Opportunity[]): string {
  const rows = records.map((r) => COLUMNS.map((c) => neutralizeFormula(fieldToText(r, c.key))));
  return stringify([COLUMNS.map((c) => c.header), ...rows]);
}
