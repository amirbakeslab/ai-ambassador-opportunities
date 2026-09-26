import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { buildCandidate } from '../src/propose.js';
import { reviewCandidate } from '../src/maintainer/changeset.js';
import { parseCatalogCsv } from '../src/records.js';
import type { FakeSheets } from './helpers/fake-sheets.js';
import { CATALOG_CSV, MAINTAINER_TOKEN, OWNER_TOKEN, SOURCES_CSV, SPREADSHEET_ID, startFakeSheets } from './helpers/fixtures.js';

let feed: Server;
let feedHits = 0;

beforeAll(async () => {
  feed = createServer((req, res) => {
    feedHits += 1;
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.end(req.url?.includes('sources') ? SOURCES_CSV : CATALOG_CSV);
  });
  await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r));
  const port = (feed.address() as AddressInfo).port;
  process.env.AMBASSADOR_CSV_URL = `http://127.0.0.1:${port}/catalog.csv`;
  process.env.AMBASSADOR_SOURCES_CSV_URL = `http://127.0.0.1:${port}/sources.csv`;
});
afterAll(async () => {
  await new Promise<void>((r) => feed.close(() => r()));
});

let fake: FakeSheets | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
  delete process.env.AMBASSADOR_GOOGLE_ACCESS_TOKEN;
  delete process.env.AMBASSADOR_SHEETS_API_BASE;
  process.env.AMBASSADOR_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ambassador-cli-cache-'));
});

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('student commands', () => {
  it('prints help and version, and rejects unknown commands and flags', async () => {
    expect((await run('--help')).out).toMatch(/ambassador list/);
    expect((await run('--version')).out).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await run('frobnicate')).code).toBe(2);
    const bad = await run('list', '--colour');
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/Unknown option/);
  });

  it('lists and filters the catalog with its origin and timestamp', async () => {
    const all = await run('list');
    expect(all.code).toBe(0);
    expect(all.out).toMatch(/13 of 13 opportunities\. Live published feed, fetched \d{4}-/);
    const rolling = await run('list', '--status', 'rolling', '--json');
    const parsed = JSON.parse(rolling.out) as { count: number; origin: { kind: string } };
    expect(parsed.count).toBe(3);
    expect(parsed.origin.kind).toBe('cache');
    const open = JSON.parse((await run('list', '--open', '--assessment', 'worth considering', '--json')).out) as { records: { id: string }[] };
    expect(open.records.map((r) => r.id)).toEqual(['cursor-ambassadors', 'microsoft-student-ambassadors']);
    expect((await run('list', '--status', 'soonish')).code).toBe(2);
  });

  it('shows a record with its sources, and suggests IDs for typos', async () => {
    const r = await run('show', 'anthropic-campus-2026');
    expect(r.out).toMatch(/Claude Campus Program — Anthropic/);
    expect(r.out).toMatch(/\[anthropic\] https:\/\/claude\.com\/programs\/campus/);
    const miss = await run('show', 'anthropic');
    expect(miss.code).toBe(2);
    expect(miss.err).toMatch(/Did you mean: anthropic-campus-2026/);
  });

  it('exports CSV and JSON, refusing to overwrite without --force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ambassador-export-'));
    const file = join(dir, 'out.csv');
    expect((await run('export', '--output', file)).code).toBe(0);
    expect(parseCatalogCsv(readFileSync(file, 'utf8')).records).toHaveLength(13);
    expect((await run('export', '--output', file)).code).toBe(2);
    expect((await run('export', '--output', file, '--force', '--format', 'json', '--status', 'closed')).code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).records).toHaveLength(1);
  });

  it('works offline from the cache after one live read', async () => {
    await run('list');
    const before = feedHits;
    const off = await run('list', '--offline');
    expect(off.out).toMatch(/Cached copy of published feed/);
    expect(feedHits).toBe(before);
  });

  it('search and formatting explain missing keys; propose refuses private URLs', async () => {
    const s = await run('search', 'AI student ambassador');
    expect(s.code).toBe(1);
    expect(s.err).toMatch(/EXA_API_KEY is not set/);
    expect((await run('search', '--provider', 'firecrawl', 'x')).err).toMatch(/FIRECRAWL_API_KEY is not set/);
    const p = await run('propose', 'http://[::ffff:127.0.0.1]:8080/');
    expect(p.code).toBe(2);
    expect(p.err).toMatch(/private address/);
    expect((await run('propose', 'http://169.254.169.254/latest/meta-data')).code).toBe(2);
  });

  it('doctor reports key presence without values', async () => {
    process.env.EXA_API_KEY = 'secret-value-should-not-print';
    const d = await run('doctor', '--offline');
    delete process.env.EXA_API_KEY;
    expect(d.out).toMatch(/EXA_API_KEY \(search default\): set/);
    expect(d.out).not.toMatch(/secret-value/);
  });
});

describe('maintainer workflow end to end (review -> sync dry-run -> apply -> idempotent)', () => {
  it('turns a reviewed candidate into precise Sheet changes', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    process.env.AMBASSADOR_GOOGLE_ACCESS_TOKEN = MAINTAINER_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), 'ambassador-flow-'));
    const page = { url: 'https://cursor.com/ambassadors', title: 'Cursor Ambassadors', text: 'Cursor Ambassadors. Plan on about 2 hours per week.', fetcher: 'direct' };
    const cand = buildCandidate({ requestedUrl: 'https://anysphere.typeform.com/to/YreXrWZd', page });
    cand.record.id = 'cursor-ambassadors';
    cand.record.workload = 'About 2 hours per week.';
    cand.sources[0]!.id = 'cursor';
    cand.record.sourceIds = ['cursor'];
    const candFile = join(dir, 'candidate.json');
    writeFileSync(candFile, JSON.stringify(cand));
    const changes = join(dir, 'changes.json');

    const review = await run('review', candFile, '--output', changes, '--sheet-id', SPREADSHEET_ID);
    expect(review.code).toBe(0);
    expect(review.out).toMatch(/UPDATE cursor-ambassadors/);
    expect(review.out).toMatch(/~ Time commitment: "Regular involvement; hours not published\." -> "About 2 hours per week\."/);
    expect(review.out).toMatch(/~ Last checked/);
    expect(review.out).not.toMatch(/Application status/);

    const dry = await run('sync', '--dry-run', '--changes', changes, '--sheet-id', SPREADSHEET_ID);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/nothing written/);
    expect(fake.writeRequests).toHaveLength(0);

    const noTarget = await run('sync', '--apply', '--changes', changes);
    expect(noTarget.code).toBe(2);
    expect(noTarget.err).toMatch(/explicit target/);

    const backups = join(dir, 'backups');
    const apply = await run('sync', '--apply', '--changes', changes, '--sheet-id', SPREADSHEET_ID, '--backup-dir', backups);
    expect(apply.code).toBe(0);
    expect(apply.out).toMatch(/Readback verified/);
    expect(existsSync(backups)).toBe(true);
    const again = await run('sync', '--apply', '--changes', changes, '--sheet-id', SPREADSHEET_ID, '--backup-dir', backups);
    expect(again.out).toMatch(/Already up to date/);
    expect(fake.writeRequests).toHaveLength(1);
  });

  it('dry-run reports additions blocked by a protected ID column before anything is attempted', async () => {
    const s = await startFakeSheets([{ sheetId: 1872724035, startRow: 1, startCol: 21, endCol: 21, editors: [OWNER_TOKEN] }]);
    fake = s.fake;
    process.env.AMBASSADOR_GOOGLE_ACCESS_TOKEN = MAINTAINER_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), 'ambassador-blocked-'));
    const page = { url: 'https://example.com/new-program', title: 'New Program', text: 'New Program by Example.', fetcher: 'direct' };
    const cand = buildCandidate({ requestedUrl: page.url, page });
    Object.assign(cand.record, { id: 'example-new-program', company: 'Example', program: 'New Program', assessment: 'Needs clarification' });
    const candFile = join(dir, 'candidate.json');
    writeFileSync(candFile, JSON.stringify(cand));
    const changes = join(dir, 'changes.json');
    expect((await run('review', candFile, '--output', changes, '--sheet-id', SPREADSHEET_ID)).code).toBe(0);
    const dry = await run('sync', '--dry-run', '--changes', changes, '--sheet-id', SPREADSHEET_ID);
    expect(dry.code).toBe(3);
    expect(dry.out).toMatch(/BLOCKED Opportunities!R15C22 \(new example-new-program Opportunity ID\) is in protected range/);
    const apply = await run('sync', '--apply', '--changes', changes, '--sheet-id', SPREADSHEET_ID, '--backup-dir', join(dir, 'b'));
    expect(apply.code).toBe(1);
    expect(apply.err).toMatch(/protected range/);
    expect(fake.writeRequests).toHaveLength(0);
    expect(existsSync(join(dir, 'b'))).toBe(false);
  });

  it('rejects candidates that are missing reviewer decisions or cite unknown sources', () => {
    const page = { url: 'https://example.com/p', title: 'New Program', text: 'text', fetcher: 'direct' };
    const cand = buildCandidate({ requestedUrl: page.url, page });
    const current = new Map(parseCatalogCsv(CATALOG_CSV).records.map((r) => [r.id, r]));
    const r = reviewCandidate('c.json', cand, current);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/assessment must be set/);
    expect(r.problems.join()).toMatch(/company is required/);
    cand.record.company = 'Example';
    cand.record.program = 'New Program';
    cand.record.assessment = 'Needs clarification';
    cand.record.sourceIds = ['not-a-listed-source'];
    expect(reviewCandidate('c.json', cand, current).problems.join()).toMatch(/not in the candidate's sources/);
    expect(reviewCandidate('c.json', { hello: 1 }, current).ok).toBe(false);
  });

  it('restore dry-run lists changes and never deletes', async () => {
    const s = await startFakeSheets();
    fake = s.fake;
    process.env.AMBASSADOR_GOOGLE_ACCESS_TOKEN = MAINTAINER_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), 'ambassador-restore-'));
    const b = await run('backup', '--sheet-id', SPREADSHEET_ID, '--output-dir', dir);
    expect(b.code).toBe(0);
    const file = /written to (.+\.json)/.exec(b.out)![1]!;
    fake.edit('Opportunities', 1, 2, { string: 'Closed' });
    const r = await run('restore', file, '--dry-run', '--sheet-id', SPREADSHEET_ID);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Application status: "Closed" -> "Rolling"/);
    const wrong = await run('restore', file, '--apply', '--sheet-id', 'another-spreadsheet-id-123456');
    expect(wrong.code).toBe(2);
    expect(wrong.err).toMatch(/Refusing to restore across spreadsheets/);
    const ok = await run('restore', file, '--apply', '--sheet-id', SPREADSHEET_ID, '--backup-dir', dir);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Readback verified/);
  });
});
