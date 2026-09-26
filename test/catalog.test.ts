import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog, loadSnapshot } from '../src/catalog.js';
import { CATALOG_CSV } from './helpers/fixtures.js';

const csv = (text: string, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/csv' } });

function fetchSeq(items: (Response | Error)[]) {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    const next = items.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, count: () => n };
}

beforeEach(() => {
  process.env.AMBASSADOR_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ambassador-cache-'));
});

describe('catalog loading, cache and offline behaviour', () => {
  it('fetches live, caches with an explicit timestamp and reuses a fresh cache', async () => {
    const f = fetchSeq([csv(CATALOG_CSV)]);
    const now = new Date('2026-09-25T20:00:00Z');
    const live = await loadCatalog({ fetchImpl: f.fetchImpl, now: () => now });
    expect(live.origin).toMatchObject({ kind: 'live', fetchedAt: '2026-09-25T20:00:00.000Z' });
    expect(live.table.records).toHaveLength(13);
    const again = await loadCatalog({ fetchImpl: f.fetchImpl, now: () => new Date('2026-09-25T20:05:00Z') });
    expect(again.origin).toMatchObject({ kind: 'cache', fetchedAt: '2026-09-25T20:00:00.000Z' });
    expect(f.count()).toBe(1);
  });

  it('falls back to the cache (with its original timestamp) when the network fails', async () => {
    await loadCatalog({ fetchImpl: fetchSeq([csv(CATALOG_CSV)]).fetchImpl, now: () => new Date('2026-09-25T20:00:00Z') });
    const down = fetchSeq([new TypeError('getaddrinfo ENOTFOUND'), new TypeError('getaddrinfo ENOTFOUND')]);
    const r = await loadCatalog({ fetchImpl: down.fetchImpl, now: () => new Date('2026-09-26T20:00:00Z') });
    expect(r.origin.kind).toBe('cache');
    expect(r.origin.fetchedAt).toBe('2026-09-25T20:00:00.000Z');
    expect(r.origin.note).toMatch(/live feed unavailable/);
  });

  it('does not replace a good cache with a broken feed, and offline mode never fetches', async () => {
    await loadCatalog({ fetchImpl: fetchSeq([csv(CATALOG_CSV)]).fetchImpl, now: () => new Date('2026-09-25T20:00:00Z') });
    const bad = await loadCatalog({ fetchImpl: fetchSeq([csv('<html>Sign in</html>')]).fetchImpl, now: () => new Date('2026-09-26T00:00:00Z') });
    expect(bad.origin.kind).toBe('cache');
    expect(bad.origin.note).toMatch(/HTML instead of CSV/);
    const off = fetchSeq([]);
    const offline = await loadCatalog({ mode: 'offline', fetchImpl: off.fetchImpl });
    expect(offline.origin.kind).toBe('cache');
    expect(off.count()).toBe(0);
  });

  it('uses the bundled snapshot, clearly labelled, when there is no cache', async () => {
    const r = await loadCatalog({ mode: 'offline' });
    expect(r.origin.kind).toBe('snapshot');
    expect(r.origin.note).toMatch(/bundled with this release/);
    expect(r.table.records).toHaveLength(loadSnapshot().records.length);
  });

  it('refresh mode surfaces errors instead of silently using stale data', async () => {
    await expect(loadCatalog({ mode: 'refresh', fetchImpl: fetchSeq([csv('nope', 500)]).fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  it('bundled snapshot contains only validated public catalog records', () => {
    const s = loadSnapshot();
    expect(s.records.length).toBeGreaterThanOrEqual(13);
    expect(new Set(s.records.map((r) => r.id)).size).toBe(s.records.length);
    const sourceIds = new Set(s.sources.map((x) => x.id));
    for (const r of s.records) for (const id of r.sourceIds) expect(sourceIds.has(id)).toBe(true);
  });
});
