/**
 * Live Google Sheets integration test. Runs ONLY against a disposable copy of
 * the catalog: set AMBASSADOR_TEST_SHEET_ID to that copy and
 * AMBASSADOR_GOOGLE_CREDENTIALS to a service account with Editor access to it.
 * It refuses to run against the published catalog. The published catalog is
 * only read (never written) to check which protected ranges apply to this
 * principal there.
 *
 * The test restores the copy at the end: changed cells via `restore`, and the
 * rows it appended via a test-only cleanup (the CLI itself never deletes).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { DEFAULT_SHEET_ID } from '../../src/config.js';
import { buildCandidate } from '../../src/propose.js';
import { ConflictError } from '../../src/errors.js';
import { newChangeset } from '../../src/maintainer/changeset.js';
import { loadMaintainerAuth } from '../../src/maintainer/google-auth.js';
import { ProtectedRangeError, SheetsClient } from '../../src/maintainer/sheets-client.js';
import {
  applyChangeset,
  makeBackup,
  planChangeset,
  protectedWrites,
  readSheetState,
  restoreChangeset,
  SOURCES_TAB,
  type SheetState,
} from '../../src/maintainer/sync.js';
import type { Opportunity } from '../../src/schema.js';

const SHEET = process.env.AMBASSADOR_TEST_SHEET_ID;
const enabled = Boolean(SHEET && (process.env.AMBASSADOR_GOOGLE_CREDENTIALS || process.env.AMBASSADOR_GOOGLE_ACCESS_TOKEN));
const TAB = 'Opportunities';
const stamp = new Date().toISOString();
const TEST_ID = `live-test-${Date.now().toString(36)}`;
const TEST_SOURCE = `${TEST_ID}-src`;
const reviewed = { kind: 'sheets-api', fetchedAt: stamp, url: 'live-test' };

let client: SheetsClient;
let initial: SheetState;
let backupDir: string;

function record(): Opportunity {
  return {
    id: TEST_ID,
    company: 'Live Test Co',
    program: 'Disposable integration row',
    category: 'Test',
    description: '@mention and =1+1 must stay literal',
    url: 'https://example.com/live-test',
    status: 'Needs verification',
    deadline: '2026-12-31',
    deadlineNotes: 'Test row; deleted at the end of the run.',
    programDates: '',
    workload: '',
    ambassadorBenefits: '',
    communityBenefits: '',
    expectations: '',
    eligibility: '',
    geography: '',
    localApplicability: '',
    restrictions: '',
    assessment: 'Low value',
    assessmentReason: 'Automated test row.',
    sourceIds: [TEST_SOURCE],
    lastChecked: stamp.slice(0, 10),
  };
}

const get = (s: SheetState, id: string) => s.opportunities.table.records.find((r) => r.id === id);

async function rawBatchUpdate(requests: unknown[]): Promise<Response> {
  const auth = await loadMaintainerAuth();
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET}:batchUpdate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await auth.getToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(60_000),
  });
}

/**
 * Test-only cleanup of rows created by live tests (IDs starting "live-test-").
 * Deleting a row shrinks the protected ID range, which Google treats as editing
 * the protection itself (owner only), so when deletion is refused the row's
 * values are cleared instead. Returns how rows were removed.
 */
async function removeTestRows(tab: string, idColumn: number): Promise<{ deleted: number; cleared: number }> {
  const info = await client.tabInfo(tab);
  if (!info) return { deleted: 0, cleared: 0 };
  const grid = await client.values(tab, 'UNFORMATTED_VALUE');
  const rows = grid.map((r, i) => (String(r[idColumn] ?? '').startsWith('live-test-') ? i : -1)).filter((i) => i > 0).reverse();
  if (!rows.length) return { deleted: 0, cleared: 0 };
  const del = await rawBatchUpdate(rows.map((i) => ({ deleteDimension: { range: { sheetId: info.sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } })));
  if (del.ok) return { deleted: rows.length, cleared: 0 };
  const detail = await del.text();
  if (!/protected/i.test(detail)) throw new Error(`cleanup failed: HTTP ${del.status} ${detail}`);
  const clear = await rawBatchUpdate(rows.map((i) => ({ updateCells: { range: { sheetId: info.sheetId, startRowIndex: i, endRowIndex: i + 1 }, fields: 'userEnteredValue' } })));
  if (!clear.ok) throw new Error(`cleanup failed: HTTP ${clear.status} ${await clear.text()}`);
  console.info(`[test copy] ${tab}: row deletion refused by protection; cleared ${rows.length} test row(s) instead`);
  return { deleted: 0, cleared: rows.length };
}

async function cleanup(): Promise<{ deleted: number; cleared: number }> {
  const idCol = initial?.opportunities.table.columnIndex.id ?? 21;
  const a = await removeTestRows(TAB, idCol);
  const b = await removeTestRows(SOURCES_TAB, 0);
  return { deleted: a.deleted + b.deleted, cleared: a.cleared + b.cleared };
}

describe.runIf(enabled)('live Google Sheets (disposable test copy)', () => {
  beforeAll(async () => {
    if (SHEET === DEFAULT_SHEET_ID) throw new Error('Refusing to run live write tests against the published catalog.');
    client = new SheetsClient(SHEET!, await loadMaintainerAuth());
    await cleanup(); // leftovers from an interrupted earlier run
    initial = await readSheetState(client, TAB);
    backupDir = mkdtempSync(join(tmpdir(), 'ambassador-live-'));
  });

  afterAll(async () => {
    if (client) await cleanup();
  });

  it('reads the copy through the Sheets API with the expected structure', () => {
    expect(initial.opportunities.table.header).toHaveLength(22);
    expect(initial.opportunities.table.issues).toEqual([]);
    expect(initial.opportunities.table.records.length).toBeGreaterThanOrEqual(13);
    expect(initial.opportunities.info.tableId).toBeTruthy();
    expect(initial.sources?.byId.size).toBeGreaterThanOrEqual(16);
  });

  it('reads the published catalog (read-only): IDs are editable by the maintainer, headers stay protected', async () => {
    const live = new SheetsClient(DEFAULT_SHEET_ID, await loadMaintainerAuth());
    const state = await readSheetState(live, TAB);
    expect(state.opportunities.table.records.length).toBeGreaterThanOrEqual(13);
    // The owner granted the maintainer on the stable-ID protection, so a planned add is not blocked.
    const plan = planChangeset(newChangeset(reviewed, [{ action: 'add', id: TEST_ID, record: record() }], []), state);
    const blocked = protectedWrites(plan, state);
    console.info(`[live catalog, read-only] protected cells for a hypothetical add: ${blocked.join(' | ') || 'none'}`);
    expect(blocked).toEqual([]);
    // Header protections remain owner-only, and the preflight still reports them.
    const headerWrite = { ...plan, appends: [], writes: [{ id: '(header)', field: 'company' as const, rowIndex: 0, columnIndex: 0, from: 'Company', to: 'Company' }] };
    const headerBlocked = protectedWrites(headerWrite, state);
    console.info(`[live catalog, read-only] preflight for a header write: ${headerBlocked.join(' | ')}`);
    expect(headerBlocked).toHaveLength(1);
    expect(headerBlocked[0]).toMatch(/Opportunities!R1C1 .* is in protected range 1664011227/);
    expect(state.sources?.info.blocked.some((b) => b.startRow === 0 && b.endRow === 1)).toBe(true);
  });

  it('updates only the changed cell, backs up first and reads back', async () => {
    const target = initial.opportunities.table.records.find((r) => r.id === 'cursor-ambassadors')!;
    const cs = newChangeset(reviewed, [{ action: 'update', id: target.id, fields: { workload: { from: target.workload, to: `Live test ${stamp}` } } }], []);
    const res = await applyChangeset(client, TAB, cs, { backupDir });
    expect(res.readbackProblems).toEqual([]);
    expect(res.backupFile).toBeTruthy();
    expect(res.plan.writes).toHaveLength(1);
    const after = await readSheetState(client, TAB);
    expect(get(after, target.id)!.workload).toBe(`Live test ${stamp}`);
    // Every other cell, including every stable ID, is unchanged.
    const row = initial.opportunities.table.rowById.get(target.id)! - 1;
    const col = initial.opportunities.table.columnIndex.workload;
    initial.opportunities.grid.forEach((r, ri) =>
      r.forEach((v, ci) => {
        if (ri === row && ci === col) return;
        expect(after.opportunities.grid[ri]?.[ci]).toEqual(v);
      }),
    );
  });

  it('is idempotent: re-applying writes nothing', async () => {
    const target = initial.opportunities.table.records.find((r) => r.id === 'cursor-ambassadors')!;
    const cs = newChangeset(reviewed, [{ action: 'update', id: target.id, fields: { workload: { from: target.workload, to: `Live test ${stamp}` } } }], []);
    const res = await applyChangeset(client, TAB, cs, { backupDir });
    expect(res.written).toBe(0);
    expect(res.backupFile).toBeNull();
  });

  it('rejects a stale review (the value changed since it was reviewed) without writing', async () => {
    const target = initial.opportunities.table.records.find((r) => r.id === 'cursor-ambassadors')!;
    const before = await readSheetState(client, TAB);
    const cs = newChangeset(reviewed, [{ action: 'update', id: target.id, fields: { workload: { from: target.workload, to: 'Something else' } } }], []);
    await expect(applyChangeset(client, TAB, cs, { backupDir })).rejects.toThrow(ConflictError);
    expect((await readSheetState(client, TAB)).fingerprint).toBe(before.fingerprint);
  });

  it('stores formula-like text as literal strings (no formula is created)', async () => {
    const target = initial.opportunities.table.records.find((r) => r.id === 'microsoft-student-ambassadors')!;
    const evil = '=HYPERLINK("https://example.com/x","click")';
    const cs = newChangeset(reviewed, [{ action: 'update', id: target.id, fields: { restrictions: { from: target.restrictions, to: evil } } }], []);
    const res = await applyChangeset(client, TAB, cs, { backupDir });
    expect(res.readbackProblems).toEqual([]);
    const after = await readSheetState(client, TAB);
    expect(get(after, target.id)!.restrictions).toBe(evil);
    const b = makeBackup({ spreadsheetId: SHEET!, tab: TAB, origin: 'sheets-api', grid: after.opportunities.grid, formulas: after.opportunities.formulas });
    expect(b.opportunities.formulaCells).toEqual([]);
  });

  it('maps a real protected-header rejection to a clear error', async () => {
    const info = initial.opportunities.info;
    const err = await client
      .batchUpdate([{ updateCells: { start: { sheetId: info.sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { stringValue: 'Company' } }] }], fields: 'userEnteredValue' } }])
      .catch((e: unknown) => e);
    console.info(`[test copy] header write result: ${err instanceof Error ? err.message : 'accepted (no protection for this principal)'}`);
    expect(err).toBeInstanceOf(ProtectedRangeError);
  });

  it('appends a new record and source with readback, and repeating the import does not duplicate', async () => {
    const cs = newChangeset(reviewed, [{ action: 'add', id: TEST_ID, record: record() }], [
      { id: TEST_SOURCE, url: 'https://example.com/live-test', supports: 'Automated test source', lastChecked: stamp.slice(0, 10) },
    ]);
    const res = await applyChangeset(client, TAB, cs, { backupDir });
    expect(res.readbackProblems).toEqual([]);
    const again = await applyChangeset(client, TAB, cs, { backupDir });
    expect(again.written).toBe(0);
    const after = await readSheetState(client, TAB);
    expect(after.opportunities.table.records.filter((r) => r.id === TEST_ID)).toHaveLength(1);
    expect(get(after, TEST_ID)).toEqual(record());
    expect(after.sources?.byId.has(TEST_SOURCE)).toBe(true);
  });

  it('restores the original values from the initial backup and keeps (never deletes) the added row', async () => {
    const backup = makeBackup({ spreadsheetId: SHEET!, tab: TAB, origin: 'sheets-api', grid: initial.opportunities.grid, formulas: initial.opportunities.formulas, sources: initial.sources?.grid });
    const now = await readSheetState(client, TAB);
    const { changeset, extraIds } = restoreChangeset(backup, now.opportunities.table, now.sources);
    expect(extraIds).toEqual([TEST_ID]);
    expect(changeset.changes.map((c) => c.id).sort()).toEqual(['cursor-ambassadors', 'microsoft-student-ambassadors']);
    const res = await applyChangeset(client, TAB, changeset, { backupDir });
    expect(res.readbackProblems).toEqual([]);
    const after = await readSheetState(client, TAB);
    for (const rec of initial.opportunities.table.records) expect(get(after, rec.id)).toEqual(rec);
    expect(get(after, TEST_ID)).toBeDefined();
  });

  it('runs the maintainer CLI end to end: review, sync dry-run/apply, repeat, stale plan, backup, restore', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const cli = async (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    const dir = mkdtempSync(join(tmpdir(), 'ambassador-live-cli-'));
    const cliId = `${TEST_ID}-cli`;
    // An addition, reviewed from a candidate file.
    const add = buildCandidate({ requestedUrl: 'https://example.com/live-cli', page: { url: 'https://example.com/live-cli', title: 'Live CLI test', text: 'Live CLI test page.', fetcher: 'direct' } });
    Object.assign(add.record, { id: cliId, company: 'Live Test Co', program: 'CLI flow row', assessment: 'Low value', assessmentReason: 'Automated test row.' });
    add.sources[0]!.id = `${cliId}-src`;
    add.record.sourceIds = [`${cliId}-src`];
    // An update to an existing record: only the stated field changes.
    const target = initial.opportunities.table.records.find((r) => r.id === 'openai-campus-network')!;
    const upd = buildCandidate({ requestedUrl: target.url, page: { url: target.url, title: null, text: 'x', fetcher: 'direct' } });
    Object.assign(upd.record, { id: target.id, workload: `CLI live test ${stamp}`, lastChecked: null, sourceIds: [] });
    writeFileSync(join(dir, 'add.json'), JSON.stringify(add));
    writeFileSync(join(dir, 'upd.json'), JSON.stringify(upd));
    const changes = join(dir, 'changes.json');

    const review = await cli('review', join(dir, 'add.json'), join(dir, 'upd.json'), '--output', changes, '--sheet-id', SHEET!);
    expect(review.code, review.err).toBe(0);
    expect(review.out).toMatch(new RegExp(`ADD ${cliId}`));
    expect(review.out).toMatch(/UPDATE openai-campus-network[\s\S]*~ Time commitment/);

    const dry = await cli('sync', '--dry-run', '--changes', changes, '--sheet-id', SHEET!);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).not.toMatch(/BLOCKED/);
    expect(dry.out).toMatch(/1 cell update\(s\), 1 new record\(s\), 1 new source\(s\)/);

    const backups = join(dir, 'backups');
    const apply = await cli('sync', '--apply', '--changes', changes, '--sheet-id', SHEET!, '--backup-dir', backups);
    expect(apply.code, apply.err).toBe(0);
    expect(apply.out).toMatch(/Readback verified every written value/);
    const preApplyBackup = /Backup: (\S+\.json)/.exec(apply.out)![1]!;

    const again = await cli('sync', '--apply', '--changes', changes, '--sheet-id', SHEET!, '--backup-dir', backups);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(/Already up to date/);

    // A stale plan: its reviewed value no longer matches the Sheet.
    const stale = JSON.parse(readFileSync(changes, 'utf8'));
    stale.changes = stale.changes.filter((c: { action: string }) => c.action === 'update');
    stale.changes[0].fields.workload.to = 'A different edit';
    stale.sources = [];
    writeFileSync(join(dir, 'stale.json'), JSON.stringify(stale));
    const before = (await readSheetState(client, TAB)).fingerprint;
    const rejected = await cli('sync', '--apply', '--changes', join(dir, 'stale.json'), '--sheet-id', SHEET!, '--backup-dir', backups);
    expect(rejected.code, rejected.err).toBe(3);
    expect(rejected.err).toMatch(/Sync stopped; nothing was written/);
    expect((await readSheetState(client, TAB)).fingerprint).toBe(before);

    const backup = await cli('backup', '--sheet-id', SHEET!, '--output-dir', join(dir, 'manual'));
    expect(backup.code, backup.err).toBe(0);
    expect(backup.out).toMatch(/Backup of \d+ records and \d+ sources/);

    const preview = await cli('restore', preApplyBackup, '--dry-run', '--sheet-id', SHEET!);
    expect(preview.code, preview.err).toBe(0);
    expect(preview.out).toMatch(new RegExp(`kept   ${cliId}`));
    const restored = await cli('restore', preApplyBackup, '--apply', '--sheet-id', SHEET!, '--backup-dir', backups);
    expect(restored.code, restored.err).toBe(0);
    expect(restored.out).toMatch(/Readback verified every written value/);
    const after = await readSheetState(client, TAB);
    expect(get(after, 'openai-campus-network')).toEqual(target);
    expect(get(after, cliId)).toBeDefined();
  });

  it('leaves the copy with the same values as it started after test cleanup', async () => {
    const removed = await cleanup();
    expect(removed.deleted + removed.cleared).toBe(4);
    const final = await readSheetState(client, TAB);
    expect(final.opportunities.grid).toEqual(initial.opportunities.grid);
    expect(final.sources?.grid).toEqual(initial.sources?.grid);
  });
});

describe.runIf(!enabled)('live Google Sheets', () => {
  it.skip('skipped: set AMBASSADOR_TEST_SHEET_ID and maintainer credentials to run', () => undefined);
});
