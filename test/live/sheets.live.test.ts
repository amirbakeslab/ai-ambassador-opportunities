/**
 * Live Google Sheets integration test. Runs ONLY against a disposable copy of
 * the catalog: set AMBASSADOR_TEST_SHEET_ID to that copy and
 * AMBASSADOR_GOOGLE_CREDENTIALS to a service account with Editor access to it.
 * It refuses to run against the published catalog, which it only reads.
 *
 * The copy is restored at the end: changed cells through `restore`, and rows
 * the test appended through a test-only cleanup (the CLI itself never deletes).
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { DEFAULT_SHEET_ID } from '../../src/config.js';
import { newChangeset } from '../../src/maintainer/changeset.js';
import { loadMaintainerAuth } from '../../src/maintainer/google-auth.js';
import { ProtectedRangeError, SheetsClient } from '../../src/maintainer/sheets-client.js';
import { formulaCells, planChangeset, protectedWrites, readSheetState, SOURCES_TAB, type SheetState } from '../../src/maintainer/sync.js';
import { buildCandidate } from '../../src/propose.js';

const SHEET = process.env.AMBASSADOR_TEST_SHEET_ID;
const enabled = Boolean(SHEET && (process.env.AMBASSADOR_GOOGLE_CREDENTIALS || process.env.AMBASSADOR_GOOGLE_ACCESS_TOKEN));
const TAB = 'Opportunities';
const stamp = new Date().toISOString();
const TEST_ID = `live-test-${Date.now().toString(36)}`;
const LITERAL = '=HYPERLINK("https://example.com/x","click") @mention +1';

let client: SheetsClient;
let initial: SheetState;

const get = (s: SheetState, id: string) => s.opportunities.table.records.find((r) => r.id === id);

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

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
 * Test-only removal of rows whose ID starts with "live-test-". Deleting a row
 * shrinks the protected ID range, which Google treats as editing the protection
 * itself (owner only), so when deletion is refused the row is cleared instead.
 */
async function removeTestRows(tab: string, idColumn: number): Promise<number> {
  const info = (await client.tabs([tab])).get(tab);
  if (!info) return 0;
  const [grid] = await client.valuesBatch([tab], 'UNFORMATTED_VALUE');
  const rows = grid!.map((r, i) => (String(r[idColumn] ?? '').startsWith('live-test-') ? i : -1)).filter((i) => i > 0).reverse();
  if (!rows.length) return 0;
  const del = await rawBatchUpdate(rows.map((i) => ({ deleteDimension: { range: { sheetId: info.sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } })));
  if (del.ok) return rows.length;
  const detail = await del.text();
  if (!/protected/i.test(detail)) throw new Error(`cleanup failed: HTTP ${del.status} ${detail}`);
  const clear = await rawBatchUpdate(rows.map((i) => ({ updateCells: { range: { sheetId: info.sheetId, startRowIndex: i, endRowIndex: i + 1 }, fields: 'userEnteredValue' } })));
  if (!clear.ok) throw new Error(`cleanup failed: HTTP ${clear.status} ${await clear.text()}`);
  return rows.length;
}

async function cleanup(): Promise<number> {
  return (await removeTestRows(TAB, initial?.opportunities.table.columnIndex.id ?? 21)) + (await removeTestRows(SOURCES_TAB, 0));
}

describe.runIf(enabled)('live Google Sheets (disposable test copy)', () => {
  beforeAll(async () => {
    if (SHEET === DEFAULT_SHEET_ID) throw new Error('Refusing to run live write tests against the published catalog.');
    client = new SheetsClient(SHEET!, await loadMaintainerAuth());
    await cleanup(); // leftovers from an interrupted earlier run
    initial = await readSheetState(client, TAB);
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
    const state = await readSheetState(new SheetsClient(DEFAULT_SHEET_ID, await loadMaintainerAuth()), TAB);
    expect(state.opportunities.table.records.length).toBeGreaterThanOrEqual(13);
    // A planned addition (never applied here) would not touch any protected cell.
    const record = { ...state.opportunities.table.records[0]!, id: TEST_ID };
    const plan = planChangeset(newChangeset({ kind: 'sheets-api', fetchedAt: stamp, url: 'live' }, [{ action: 'add', id: TEST_ID, record }], []), state);
    expect(protectedWrites(plan, state)).toEqual([]);
    const headerWrite = { ...plan, appends: [], writes: [{ id: '(header)', field: 'company' as const, rowIndex: 0, columnIndex: 0, from: 'Company', to: 'Company' }] };
    const headerBlocked = protectedWrites(headerWrite, state);
    console.info(`[live catalog, read-only] preflight for a header write: ${headerBlocked.join(' | ')}`);
    expect(headerBlocked).toHaveLength(1);
    expect(headerBlocked[0]).toContain('1664011227');
  });

  it('Google itself rejects a write to the protected header row, and the CLI reports it', async () => {
    const info = initial.opportunities.info;
    const err = await client
      .batchUpdate([{ updateCells: { start: { sheetId: info.sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { stringValue: 'Company' } }] }], fields: 'userEnteredValue' } }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtectedRangeError);
  });

  it('round trip through the CLI: review, preview, apply, repeat, stale plan, backup and restore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ambassador-live-cli-'));
    const backups = join(dir, 'backups');
    // An addition whose text looks like a formula, and an update to one existing field.
    const add = buildCandidate({ requestedUrl: 'https://example.com/live-test', page: { url: 'https://example.com/live-test', title: 'Live test', text: 'Live test page.', fetcher: 'direct' } });
    Object.assign(add.record, { id: TEST_ID, company: 'Live Test Co', program: 'Disposable row', description: LITERAL, deadline: '2026-12-31', assessment: 'Low value' });
    add.sources[0]!.id = `${TEST_ID}-src`;
    add.record.sourceIds = [`${TEST_ID}-src`];
    const target = initial.opportunities.table.records.find((r) => r.id === 'openai-campus-network')!;
    const upd = buildCandidate({ requestedUrl: target.url, page: { url: target.url, title: null, text: 'x', fetcher: 'direct' } });
    Object.assign(upd.record, { id: target.id, workload: `Live test ${stamp}`, lastChecked: null, sourceIds: [] });
    writeFileSync(join(dir, 'add.json'), JSON.stringify(add));
    writeFileSync(join(dir, 'upd.json'), JSON.stringify(upd));
    const changes = join(dir, 'changes.json');

    const review = await cli('review', join(dir, 'add.json'), join(dir, 'upd.json'), '--output', changes, '--sheet-id', SHEET!);
    expect(review.code, review.err).toBe(0);
    const reviewed = JSON.parse(readFileSync(changes, 'utf8'));
    expect(reviewed.changes.map((c: { action: string }) => c.action).sort()).toEqual(['add', 'update']);

    const dry = await cli('sync', '--dry-run', '--changes', changes, '--sheet-id', SHEET!);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).not.toContain('BLOCKED');
    expect((await readSheetState(client, TAB)).fingerprint).toBe(initial.fingerprint);

    const apply = await cli('sync', '--apply', '--changes', changes, '--sheet-id', SHEET!, '--backup-dir', backups);
    expect(apply.code, apply.err).toBe(0);
    const preApplyBackup = join(backups, readdirSync(backups)[0]!);
    const after = await readSheetState(client, TAB);
    // Only the one updated cell changed among existing rows; stable IDs are untouched.
    const row = initial.opportunities.table.rowById.get(target.id)! - 1;
    const col = initial.opportunities.table.columnIndex.workload;
    initial.opportunities.grid.forEach((r, ri) =>
      r.forEach((v, ci) => {
        if (ri !== row || ci !== col) expect(after.opportunities.grid[ri]?.[ci]).toEqual(v);
      }),
    );
    expect(get(after, target.id)!.workload).toBe(`Live test ${stamp}`);
    // Formula-looking text was stored as a literal string.
    expect(get(after, TEST_ID)!.description).toBe(LITERAL);
    expect(formulaCells(after.opportunities.grid, after.opportunities.formulas)).toEqual([]);
    expect(after.sources?.byId.has(`${TEST_ID}-src`)).toBe(true);

    const again = await cli('sync', '--apply', '--changes', changes, '--sheet-id', SHEET!, '--backup-dir', backups);
    expect(again.code, again.err).toBe(0);
    expect(readdirSync(backups)).toHaveLength(1);
    expect((await readSheetState(client, TAB)).fingerprint).toBe(after.fingerprint);

    const stale = JSON.parse(readFileSync(changes, 'utf8'));
    stale.changes = stale.changes.filter((c: { action: string }) => c.action === 'update');
    stale.changes[0].fields.workload.to = 'A different edit';
    stale.sources = [];
    writeFileSync(join(dir, 'stale.json'), JSON.stringify(stale));
    const rejected = await cli('sync', '--apply', '--changes', join(dir, 'stale.json'), '--sheet-id', SHEET!, '--backup-dir', backups);
    expect(rejected.code, rejected.err).toBe(3);
    expect((await readSheetState(client, TAB)).fingerprint).toBe(after.fingerprint);

    const manual = await cli('backup', '--sheet-id', SHEET!, '--backup-dir', join(dir, 'manual'));
    expect(manual.code, manual.err).toBe(0);
    const preview = await cli('restore', preApplyBackup, '--dry-run', '--sheet-id', SHEET!);
    expect(preview.code, preview.err).toBe(0);
    expect(preview.out).toContain(TEST_ID); // reported as kept: restore never deletes
    const restored = await cli('restore', preApplyBackup, '--apply', '--sheet-id', SHEET!, '--backup-dir', backups);
    expect(restored.code, restored.err).toBe(0);
    const final = await readSheetState(client, TAB);
    expect(get(final, target.id)).toEqual(target);
    expect(get(final, TEST_ID)).toBeDefined();
  });

  it('cleanup leaves the copy with the same values as it started', async () => {
    expect(await cleanup()).toBe(2);
    const final = await readSheetState(client, TAB);
    expect(final.opportunities.grid).toEqual(initial.opportunities.grid);
    expect(final.sources?.grid).toEqual(initial.sources?.grid);
  });
});

describe.runIf(!enabled)('live Google Sheets', () => {
  it.skip('skipped: set AMBASSADOR_TEST_SHEET_ID and maintainer credentials to run', () => undefined);
});
