import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isoToSerial, parseDateCell } from '../dates.js';
import { CliError, ConflictError } from '../errors.js';
import { fieldToText, parseGrid, type Cell, type ParsedTable } from '../records.js';
import { cleanText } from '../safety.js';
import { COLUMNS, DATE_FIELDS, FIELD_KEYS, HEADER_BY_KEY, OpportunitySchema, formatZodIssues, type FieldKey, type Opportunity } from '../schema.js';
import type { Change, Changeset, SourceRow } from './changeset.js';
import { ProtectedRangeError, type BlockedRange, type CellData, type ExtendedValue, type SheetRequest, type SheetsClient, type TabInfo } from './sheets-client.js';

export const SOURCES_TAB = 'Sources';
export const SOURCE_HEADERS = ['Source ID', 'Source URL', 'What it supports / limitations', 'Last checked'] as const;

export interface SourcesState {
  info: TabInfo;
  grid: Cell[][];
  byId: Map<string, { row: number; url: string }>;
  columnIndex: number[];
}

export interface SheetState {
  opportunities: { info: TabInfo; grid: Cell[][]; formulas: Cell[][]; table: ParsedTable };
  sources: SourcesState | null;
  fingerprint: string;
  readAt: string;
}

function fingerprint(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Cells whose FORMULA rendering is a formula. The catalog should contain none. */
export function formulaCells(values: Cell[][], formulas: Cell[][]): string[] {
  const found: string[] = [];
  formulas.forEach((row, r) =>
    row.forEach((f, c) => {
      if (typeof f === 'string' && f.startsWith('=') && values[r]?.[c] !== f) found.push(`R${r + 1}C${c + 1}`);
    }),
  );
  return found;
}

function parseSources(info: TabInfo, grid: Cell[][]): SourcesState {
  const header = (grid[0] ?? []).map((c) => String(c ?? '').trim());
  const columnIndex = SOURCE_HEADERS.map((h) => header.indexOf(h));
  if (columnIndex.some((i) => i === -1)) throw new CliError(`${SOURCES_TAB} tab is missing expected headers: ${SOURCE_HEADERS.join(', ')}`);
  const byId = new Map<string, { row: number; url: string }>();
  grid.slice(1).forEach((row, i) => {
    const id = String(row[columnIndex[0]!] ?? '').trim();
    if (id) byId.set(id, { row: i + 2, url: String(row[columnIndex[1]!] ?? '').trim() });
  });
  return { info, grid, byId, columnIndex };
}

/** Three API reads: tab metadata, literal values of both tabs, and formulas of the catalog tab. */
export async function readSheetState(client: SheetsClient, tab: string): Promise<SheetState> {
  const infos = await client.tabs([tab, SOURCES_TAB]);
  const info = infos.get(tab);
  if (!info) throw new CliError(`Tab "${tab}" was not found in spreadsheet ${client.spreadsheetId}.`);
  const sourcesInfo = infos.get(SOURCES_TAB) ?? null;
  const [values, [formulas]] = await Promise.all([
    client.valuesBatch(sourcesInfo ? [tab, SOURCES_TAB] : [tab], 'UNFORMATTED_VALUE'),
    client.valuesBatch([tab], 'FORMULA'),
  ]);
  const grid = values[0]!;
  const table = parseGrid(grid);
  const sources = sourcesInfo ? parseSources(sourcesInfo, values[1]!) : null;
  return {
    opportunities: { info, grid, formulas: formulas!, table },
    sources,
    fingerprint: fingerprint([grid, formulas, sources?.grid ?? null]),
    readAt: new Date().toISOString(),
  };
}

// ---------- planning ----------

export interface CellWrite {
  id: string;
  field: FieldKey;
  /** 0-based grid row and column. */
  rowIndex: number;
  columnIndex: number;
  from: string;
  to: string;
}

export interface Plan {
  writes: CellWrite[];
  appends: Opportunity[];
  sourceAppends: SourceRow[];
  noops: string[];
  conflicts: string[];
  notes: string[];
}

function textOf(table: ParsedTable, id: string, field: FieldKey): string | undefined {
  const rec = table.records.find((r) => r.id === id);
  return rec ? fieldToText(rec, field) : undefined;
}

/** Normalise user-facing text for a field so equal values compare equal. */
export function normalizeFieldText(field: FieldKey, value: string): string {
  const v = cleanText(value).trim();
  if (field === 'sourceIds') return v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).join(', ');
  if ((DATE_FIELDS as readonly string[]).includes(field)) return parseDateCell(v) ?? '';
  return v;
}

/** Validate the record that would result from applying field updates. */
function resultingRecord(current: Opportunity, fields: Record<string, { to: string }>): { record?: Opportunity; problems: string[] } {
  const draft: Record<string, unknown> = { ...current };
  for (const [k, { to }] of Object.entries(fields)) {
    const key = k as FieldKey;
    const t = normalizeFieldText(key, to);
    if ((DATE_FIELDS as readonly string[]).includes(key)) draft[key] = t || null;
    else if (key === 'sourceIds') draft[key] = t ? t.split(', ') : [];
    else draft[key] = t;
  }
  const parsed = OpportunitySchema.safeParse(draft);
  return parsed.success ? { record: parsed.data, problems: [] } : { problems: formatZodIssues(parsed.error) };
}

/**
 * Compare reviewed changes with the Sheet as it is now. A field is written only
 * when the Sheet still holds the reviewed `from` value; if it already holds `to`
 * it is a no-op (idempotent); anything else is a conflict (someone edited it).
 */
export function planChangeset(changeset: Changeset, state: Pick<SheetState, 'opportunities' | 'sources'>): Plan {
  const { table } = state.opportunities;
  const plan: Plan = { writes: [], appends: [], sourceAppends: [], noops: [], conflicts: [], notes: [] };
  for (const issue of table.issues) {
    plan.notes.push(`Row ${issue.row}${issue.id ? ` (${issue.id})` : ''} is invalid in the Sheet and was left untouched: ${issue.problems.join('; ')}`);
  }
  const seen = new Set<string>();
  for (const change of changeset.changes) {
    if (seen.has(change.id)) {
      plan.conflicts.push(`${change.id}: appears more than once in the changeset`);
      continue;
    }
    seen.add(change.id);
    planOne(change, table, plan);
  }
  planSources(changeset, state.sources, plan);
  return plan;
}

function planOne(change: Change, table: ParsedTable, plan: Plan): void {
  const invalidRow = table.issues.find((i) => i.id === change.id);
  if (invalidRow) {
    plan.conflicts.push(`${change.id}: the Sheet row ${invalidRow.row} for this ID is invalid (${invalidRow.problems.join('; ')}); fix it by hand first`);
    return;
  }
  const row = table.rowById.get(change.id);
  if (change.action === 'add') {
    if (row === undefined) {
      plan.appends.push(change.record);
      return;
    }
    const differing = FIELD_KEYS.filter((k) => textOf(table, change.id, k) !== fieldToText(change.record, k));
    if (differing.length === 0) plan.noops.push(`${change.id}: already present with identical values`);
    else plan.conflicts.push(`${change.id}: ID already exists with different values (${differing.map((k) => HEADER_BY_KEY[k]).join(', ')}); review it as an update`);
    return;
  }
  if (row === undefined) {
    plan.conflicts.push(`${change.id}: ID not found in the Sheet (was it renamed or removed?)`);
    return;
  }
  const current = table.records.find((r) => r.id === change.id)!;
  const pending: Record<string, { to: string }> = {};
  let conflicted = false;
  for (const [k, { from, to }] of Object.entries(change.fields)) {
    const field = k as FieldKey;
    if (field === 'id') {
      plan.conflicts.push(`${change.id}: stable IDs cannot be changed by sync`);
      conflicted = true;
      continue;
    }
    const now = fieldToText(current, field);
    let want: string;
    let base: string;
    try {
      want = normalizeFieldText(field, to);
      base = normalizeFieldText(field, from);
    } catch (e) {
      conflicted = true;
      plan.conflicts.push(`${change.id}.${HEADER_BY_KEY[field]}: invalid value (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (now === want) {
      plan.noops.push(`${change.id}.${field}: already ${JSON.stringify(want)}`);
    } else if (now === base) {
      pending[field] = { to: want };
      plan.writes.push({ id: change.id, field, rowIndex: row - 1, columnIndex: table.columnIndex[field], from: now, to: want });
    } else {
      conflicted = true;
      plan.conflicts.push(`${change.id}.${HEADER_BY_KEY[field]}: Sheet has ${JSON.stringify(now)} but review expected ${JSON.stringify(from)} (manual edit or stale review)`);
    }
  }
  if (!conflicted && Object.keys(pending).length) {
    const { problems } = resultingRecord(current, pending);
    if (problems.length) plan.conflicts.push(`${change.id}: result would be invalid: ${problems.join('; ')}`);
  }
}

function planSources(changeset: Changeset, sources: SourcesState | null, plan: Plan): void {
  if (changeset.sources.length === 0) return;
  if (!sources) {
    plan.notes.push(`No "${SOURCES_TAB}" tab found; ${changeset.sources.length} source row(s) were not written.`);
    return;
  }
  for (const s of changeset.sources) {
    const existing = sources.byId.get(s.id);
    if (!existing) plan.sourceAppends.push(s);
    else if (existing.url === s.url) plan.noops.push(`source ${s.id}: already present`);
    else plan.conflicts.push(`source ${s.id}: exists with a different URL (${existing.url})`);
  }
}

// ---------- requests ----------

/** Typed literal cell value. stringValue is never parsed as a formula; dates are serial numbers. */
export function cellFor(field: FieldKey, text: string): CellData {
  if (text === '') return {};
  if ((DATE_FIELDS as readonly string[]).includes(field)) return { userEnteredValue: { numberValue: isoToSerial(text) } };
  return { userEnteredValue: { stringValue: text } };
}

function rowCells(record: Opportunity, width: number, columnIndex: Record<FieldKey, number>): CellData[] {
  const cells: CellData[] = Array.from({ length: width }, () => ({}));
  for (const c of COLUMNS) cells[columnIndex[c.key]] = cellFor(c.key, fieldToText(record, c.key));
  return cells;
}

export function buildRequests(plan: Plan, state: Pick<SheetState, 'opportunities' | 'sources'>): SheetRequest[] {
  const { info, table } = state.opportunities;
  const requests: SheetRequest[] = plan.writes.map((w) => ({
    updateCells: {
      start: { sheetId: info.sheetId, rowIndex: w.rowIndex, columnIndex: w.columnIndex },
      rows: [{ values: [cellFor(w.field, w.to)] }],
      fields: 'userEnteredValue',
    },
  }));
  if (plan.appends.length) {
    const width = table.header.length;
    requests.push({
      appendCells: {
        // Google requires sheetId even when tableId is set ("No grid with id: 0" otherwise).
        sheetId: info.sheetId,
        ...(info.tableId ? { tableId: info.tableId } : {}),
        rows: plan.appends.map((r) => ({ values: rowCells(r, width, table.columnIndex) })),
        fields: 'userEnteredValue',
      },
    });
  }
  if (plan.sourceAppends.length && state.sources) {
    const s = state.sources;
    const width = Math.max(...s.columnIndex) + 1;
    requests.push({
      appendCells: {
        sheetId: s.info.sheetId,
        ...(s.info.tableId ? { tableId: s.info.tableId } : {}),
        rows: plan.sourceAppends.map((src) => {
          const cells: CellData[] = Array.from({ length: width }, () => ({}));
          const vals: ExtendedValue[] = [
            { stringValue: src.id },
            { stringValue: src.url },
            { stringValue: cleanText(src.supports) },
            { numberValue: isoToSerial(src.lastChecked) },
          ];
          vals.forEach((v, i) => (cells[s.columnIndex[i]!] = { userEnteredValue: v }));
          return { values: cells };
        }),
        fields: 'userEnteredValue',
      },
    });
  }
  return requests;
}

// ---------- protection preflight ----------

function inRange(r: BlockedRange, row: number, col: number): boolean {
  return (r.startRow ?? 0) <= row && (r.endRow === undefined || row < r.endRow) && (r.startCol ?? 0) <= col && (r.endCol === undefined || col < r.endCol);
}

/**
 * Cells the plan would write that sit in protected ranges this principal
 * cannot edit, using the Sheet's own requestingUserCanEdit metadata. Checked
 * before any backup or write so the answer is precise and nothing is attempted.
 */
export function protectedWrites(plan: Plan, state: Pick<SheetState, 'opportunities' | 'sources'>): string[] {
  const out: string[] = [];
  const opp = state.opportunities;
  const describe = (tab: string, row: number, col: number, label: string, r: BlockedRange) =>
    `${tab}!R${row + 1}C${col + 1} (${label}) is in protected range ${r.id ?? '(unnamed)'}`;
  for (const w of plan.writes) {
    const r = opp.info.blocked.find((b) => inRange(b, w.rowIndex, w.columnIndex));
    if (r) out.push(describe(opp.info.title, w.rowIndex, w.columnIndex, `${w.id} ${HEADER_BY_KEY[w.field]}`, r));
  }
  plan.appends.forEach((rec, i) => {
    const row = opp.grid.length + i;
    for (const c of COLUMNS) {
      if (fieldToText(rec, c.key) === '') continue;
      const col = opp.table.columnIndex[c.key];
      const r = opp.info.blocked.find((b) => inRange(b, row, col));
      if (r) out.push(describe(opp.info.title, row, col, `new ${rec.id} ${c.header}`, r));
    }
  });
  if (state.sources) {
    const s = state.sources;
    plan.sourceAppends.forEach((src, i) => {
      const row = s.grid.length + i;
      s.columnIndex.forEach((col, k) => {
        const r = s.info.blocked.find((b) => inRange(b, row, col));
        if (r) out.push(describe(s.info.title, row, col, `new source ${src.id} ${SOURCE_HEADERS[k]}`, r));
      });
    });
  }
  return out;
}

// ---------- readback ----------

export function verifyReadback(plan: Plan, after: Pick<SheetState, 'opportunities' | 'sources'>): string[] {
  const problems: string[] = [];
  const t = after.opportunities.table;
  for (const w of plan.writes) {
    const now = textOf(t, w.id, w.field);
    if (now !== w.to) problems.push(`${w.id}.${w.field}: expected ${JSON.stringify(w.to)} after write, found ${JSON.stringify(now)}`);
  }
  for (const r of plan.appends) {
    const count = t.records.filter((x) => x.id === r.id).length + t.issues.filter((i) => i.id === r.id).length;
    if (count !== 1) problems.push(`${r.id}: expected exactly one row after append, found ${count}`);
    else for (const k of FIELD_KEYS) if (textOf(t, r.id, k) !== fieldToText(r, k)) problems.push(`${r.id}.${k}: appended value did not read back identically`);
  }
  for (const s of plan.sourceAppends) if (!after.sources?.byId.has(s.id)) problems.push(`source ${s.id}: not found after append`);
  return problems;
}

// ---------- backups ----------

export const BackupSchema = z.object({
  schema: z.literal('ai-ambassador-opportunities/backup@1'),
  createdAt: z.string(),
  spreadsheetId: z.string(),
  origin: z.enum(['sheets-api', 'published-csv']),
  tab: z.string(),
  opportunities: z.object({ values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))), formulaCells: z.array(z.string()) }),
  sources: z.object({ values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))) }).nullable(),
  sha256: z.string(),
});
export type Backup = z.infer<typeof BackupSchema>;

function normalizeGrid(grid: Cell[][]): (string | number | boolean | null)[][] {
  return grid.map((row) => row.map((c) => (c === undefined ? null : c)));
}

export function makeBackup(input: { spreadsheetId: string; tab: string; origin: Backup['origin']; grid: Cell[][]; formulas?: Cell[][]; sources?: Cell[][] | null; now?: Date }): Backup {
  const opportunities = { values: normalizeGrid(input.grid), formulaCells: input.formulas ? formulaCells(input.grid, input.formulas) : [] };
  const sources = input.sources ? { values: normalizeGrid(input.sources) } : null;
  return {
    schema: 'ai-ambassador-opportunities/backup@1',
    createdAt: (input.now ?? new Date()).toISOString(),
    spreadsheetId: input.spreadsheetId,
    origin: input.origin,
    tab: input.tab,
    opportunities,
    sources,
    sha256: fingerprint([opportunities, sources]),
  };
}

export function verifyBackup(b: Backup): void {
  if (fingerprint([b.opportunities, b.sources]) !== b.sha256) throw new CliError('Backup checksum mismatch; the file was modified or truncated.');
}

export async function writeBackup(dir: string, backup: Backup): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `backup-${backup.spreadsheetId.slice(0, 12)}-${backup.createdAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(backup, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return file;
}

/**
 * Turn a backup into a changeset relative to the current Sheet: differing
 * fields become updates (from = current value), missing IDs become additions.
 * Records that exist only in the current Sheet are reported, never deleted.
 */
export function restoreChangeset(backup: Backup, current: ParsedTable, sources: SourcesState | null): { changeset: Changeset; extraIds: string[]; problems: string[] } {
  verifyBackup(backup);
  if (backup.opportunities.formulaCells.length) {
    throw new CliError(`Backup contains formula cells (${backup.opportunities.formulaCells.join(', ')}); restore only writes literal values. Restore those cells by hand.`);
  }
  const saved = parseGrid(backup.opportunities.values);
  const problems = saved.issues.map((i) => `backup row ${i.row}: ${i.problems.join('; ')}`);
  const changes: Change[] = [];
  for (const rec of saved.records) {
    const cur = current.records.find((r) => r.id === rec.id);
    if (!cur) {
      changes.push({ action: 'add', id: rec.id, record: rec });
      continue;
    }
    const fields: Record<string, { from: string; to: string }> = {};
    for (const k of FIELD_KEYS) {
      const from = fieldToText(cur, k);
      const to = fieldToText(rec, k);
      if (from !== to) fields[k] = { from, to };
    }
    if (Object.keys(fields).length) changes.push({ action: 'update', id: rec.id, fields });
  }
  const savedIds = new Set(saved.records.map((r) => r.id));
  const extraIds = current.records.map((r) => r.id).filter((id) => !savedIds.has(id));
  const sourceRows: SourceRow[] = [];
  if (backup.sources && sources) {
    const s = parseSources(sources.info, backup.sources.values);
    for (const [id, { row, url }] of s.byId) {
      if (sources.byId.has(id)) continue;
      const r = backup.sources.values[row - 1] ?? [];
      const supports = String(r[s.columnIndex[2]!] ?? '');
      let lastChecked: string | null = null;
      try {
        lastChecked = parseDateCell(r[s.columnIndex[3]!]);
      } catch {
        lastChecked = null;
      }
      sourceRows.push({ id, url, supports, lastChecked: lastChecked ?? backup.createdAt.slice(0, 10) });
    }
  }
  return {
    changeset: {
      schema: 'ai-ambassador-opportunities/changeset@1',
      createdAt: new Date().toISOString(),
      toolVersion: 'restore',
      reviewedAgainst: { kind: 'restore', fetchedAt: backup.createdAt, url: backup.spreadsheetId },
      changes,
      sources: sourceRows,
    },
    extraIds,
    problems,
  };
}

// ---------- apply ----------

export interface ApplyResult {
  plan: Plan;
  backupFile: string | null;
  written: number;
  readbackProblems: string[];
}

/**
 * Apply a changeset. Steps: read, plan (reject conflicts), back up, re-read and
 * compare fingerprints, one atomic batchUpdate, read back and verify.
 * The read-compare-write sequence is NOT a transaction: an edit landing between
 * the final re-read and the write is not detected. Coordinate direct edits
 * during sync and use one designated sync writer.
 */
export async function applyChangeset(
  client: SheetsClient,
  tab: string,
  changeset: Changeset,
  opts: { backupDir: string; log?: (line: string) => void },
): Promise<ApplyResult> {
  const log = opts.log ?? (() => undefined);
  const state = await readSheetState(client, tab);
  const plan = planChangeset(changeset, state);
  if (plan.conflicts.length) {
    throw new ConflictError(`Sync stopped; nothing was written. Conflicts:\n  - ${plan.conflicts.join('\n  - ')}\nRe-run review against the current Sheet.`);
  }
  if (plan.writes.length + plan.appends.length + plan.sourceAppends.length === 0) {
    return { plan, backupFile: null, written: 0, readbackProblems: [] };
  }
  const blockedCells = protectedWrites(plan, state);
  if (blockedCells.length) {
    throw new ProtectedRangeError(client.principal, `${blockedCells.slice(0, 5).join('; ')}${blockedCells.length > 5 ? `; and ${blockedCells.length - 5} more` : ''}`);
  }
  const backup = makeBackup({
    spreadsheetId: client.spreadsheetId,
    tab,
    origin: 'sheets-api',
    grid: state.opportunities.grid,
    formulas: state.opportunities.formulas,
    sources: state.sources?.grid ?? null,
  });
  const backupFile = await writeBackup(opts.backupDir, backup);
  log(`Backup written: ${backupFile}`);
  const again = await readSheetState(client, tab);
  if (again.fingerprint !== state.fingerprint) {
    throw new ConflictError('The Sheet changed while sync was preparing; nothing was written. Re-run sync --dry-run.');
  }
  const requests = buildRequests(plan, state);
  await client.batchUpdate(requests);
  const after = await readSheetState(client, tab);
  const readbackProblems = verifyReadback(plan, after);
  return { plan, backupFile, written: requests.length, readbackProblems };
}
