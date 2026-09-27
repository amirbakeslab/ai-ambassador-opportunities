import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cacheDir, csvUrl, sourcesCsvUrl } from './config.js';
import { parse } from 'csv-parse/sync';
import { CliError } from './errors.js';
import { request } from './http.js';
import { parseCatalogCsv } from './records.js';
import { OpportunitySchema } from './schema.js';
const META = 'catalog.meta.json';
const CSV = 'catalog.csv';
async function readCache(dir, url) {
    try {
        const meta = JSON.parse(await readFile(join(dir, META), 'utf8'));
        if (meta.url !== url)
            return null;
        const text = await readFile(join(dir, CSV), 'utf8');
        if (createHash('sha256').update(text).digest('hex') !== meta.sha256)
            return null;
        return { text, meta };
    }
    catch {
        return null;
    }
}
async function writeCache(dir, text, meta) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `${CSV}.${process.pid}.tmp`);
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, join(dir, CSV));
    const tmpMeta = join(dir, `${META}.${process.pid}.tmp`);
    await writeFile(tmpMeta, JSON.stringify(meta, null, 2), 'utf8');
    await rename(tmpMeta, join(dir, META));
}
export async function fetchCatalogCsv(url, fetchImpl) {
    const res = await request(url, { provider: 'catalog feed', fetchImpl, timeoutMs: 20_000, retries: 1, maxBytes: 5_000_000 });
    if (res.status !== 200)
        throw new CliError(`Catalog feed returned HTTP ${res.status}.`);
    return res.text;
}
const SourceSchema = z.object({ id: z.string(), url: z.string(), supports: z.string() });
export function parseSourcesCsv(text) {
    const [header, ...rows] = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true });
    const col = (name) => (header ?? []).findIndex((h) => h.trim() === name);
    const [id, url, supports] = [col('Source ID'), col('Source URL'), col('What it supports / limitations')];
    if (id < 0 || url < 0)
        throw new CliError('Sources tab is missing the Source ID or Source URL column.');
    return rows
        .map((r) => ({ id: (r[id] ?? '').trim(), url: (r[url] ?? '').trim(), supports: supports >= 0 ? (r[supports] ?? '').trim() : '' }))
        .filter((s) => s.id && /^https?:\/\//.test(s.url));
}
/** Live Sources tab, cached briefly; falls back to the bundled snapshot. */
export async function loadSources(opts = {}) {
    const file = join(cacheDir(), 'sources.json');
    if (!opts.offline) {
        try {
            const entry = JSON.parse(await readFile(file, 'utf8'));
            if (Date.now() - entry.at < 15 * 60_000)
                return { sources: z.array(SourceSchema).parse(entry.sources), live: true };
        }
        catch {
            // no fresh cache
        }
        try {
            const sources = parseSourcesCsv(await fetchCatalogCsv(sourcesCsvUrl(), opts.fetchImpl));
            await mkdir(cacheDir(), { recursive: true, mode: 0o700 })
                .then(() => writeFile(file, JSON.stringify({ at: Date.now(), sources }), 'utf8'))
                .catch(() => undefined);
            return { sources, live: true };
        }
        catch {
            // fall through to snapshot
        }
    }
    return { sources: loadSnapshot().sources, live: false };
}
const SnapshotSchema = z.object({
    description: z.string(),
    capturedAt: z.string(),
    sourceUrl: z.string(),
    sheetUrl: z.string(),
    records: z.array(OpportunitySchema),
    sources: z.array(SourceSchema),
});
let snapshotMemo;
export function loadSnapshot() {
    if (!snapshotMemo) {
        const raw = readFileSync(new URL('../data/catalog-snapshot.json', import.meta.url), 'utf8');
        snapshotMemo = SnapshotSchema.parse(JSON.parse(raw));
    }
    return snapshotMemo;
}
function snapshotTable(snapshot) {
    const rowById = new Map();
    snapshot.records.forEach((r, i) => rowById.set(r.id, i + 2));
    return { records: snapshot.records, rowById, issues: [], columnIndex: {}, header: [] };
}
/**
 * Load the public catalog. Live feed first (unless offline or a fresh cache
 * exists), then the local cache, then the bundled snapshot. The origin always
 * says which one was used and when it was fetched.
 */
export async function loadCatalog(opts = {}) {
    const url = csvUrl();
    const dir = cacheDir();
    const now = opts.now ?? (() => new Date());
    const mode = opts.mode ?? 'auto';
    const cached = await readCache(dir, url);
    if (cached && mode === 'auto') {
        const ageMin = (now().getTime() - Date.parse(cached.meta.fetchedAt)) / 60_000;
        if (ageMin >= 0 && ageMin < (opts.maxAgeMinutes ?? 15)) {
            return { table: parseCatalogCsv(cached.text), origin: { kind: 'cache', url, fetchedAt: cached.meta.fetchedAt } };
        }
    }
    let liveError;
    if (mode !== 'offline') {
        try {
            const text = await fetchCatalogCsv(url, opts.fetchImpl);
            const table = parseCatalogCsv(text);
            const fetchedAt = now().toISOString();
            await writeCache(dir, text, { url, fetchedAt, sha256: createHash('sha256').update(text).digest('hex') }).catch(() => undefined);
            return { table, origin: { kind: 'live', url, fetchedAt } };
        }
        catch (e) {
            if (mode === 'refresh')
                throw e;
            liveError = e;
        }
    }
    const reason = liveError ? `live feed unavailable (${liveError instanceof Error ? liveError.message : String(liveError)})` : 'offline mode';
    if (cached) {
        return { table: parseCatalogCsv(cached.text), origin: { kind: 'cache', url, fetchedAt: cached.meta.fetchedAt, note: reason } };
    }
    const snapshot = loadSnapshot();
    if (liveError && !(liveError instanceof CliError))
        throw liveError;
    return {
        table: snapshotTable(snapshot),
        origin: {
            kind: 'snapshot',
            url: snapshot.sourceUrl,
            fetchedAt: snapshot.capturedAt,
            note: `${reason}; showing the snapshot bundled with this release, which may be out of date`,
        },
    };
}
export function describeOrigin(origin) {
    const label = { live: 'Live published feed', cache: 'Cached copy of published feed', snapshot: 'Bundled snapshot' }[origin.kind];
    return `${label}, fetched ${origin.fetchedAt}${origin.note ? ` — ${origin.note}` : ''}`;
}
export function findRecord(records, id) {
    return records.find((r) => r.id === id.trim().toLowerCase());
}
