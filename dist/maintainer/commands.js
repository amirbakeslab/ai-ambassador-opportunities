import { join } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { cacheDir, csvUrl, DEFAULT_SHEET_ID, DEFAULT_TAB, env, ENV } from '../config.js';
import { describeOrigin, fetchCatalogCsv, loadCatalog } from '../catalog.js';
import { CliError, ConflictError, UsageError } from '../errors.js';
import { readJsonFile, writeNewFile } from '../io.js';
import { parseCatalogCsv } from '../records.js';
import { CandidateSchema, HEADER_BY_KEY } from '../schema.js';
import { ChangesetSchema, newChangeset, reviewCandidate, sourcesFromCandidates } from './changeset.js';
import { describeMaintainerCredentials, loadMaintainerAuth } from './google-auth.js';
import { withLocalLock } from './lock.js';
import { maintainerOptions } from './options.js';
import { SheetsClient } from './sheets-client.js';
import { applyChangeset, BackupSchema, makeBackup, planChangeset, protectedWrites, readSheetState, restoreChangeset, writeBackup, } from './sync.js';
const STALE_DAYS = 14;
function str(v) {
    return typeof v === 'string' ? v : undefined;
}
function tabOf(v) {
    return str(v.tab) ?? DEFAULT_TAB;
}
/** Reads may default to the public catalog; writes need an explicit target. */
function sheetIdForRead(v) {
    return str(v['sheet-id']) ?? env(ENV.sheetId) ?? DEFAULT_SHEET_ID;
}
function sheetIdForWrite(v) {
    const id = str(v['sheet-id']) ?? env(ENV.sheetId);
    if (!id)
        throw new UsageError(`--apply needs an explicit target: pass --sheet-id or set ${ENV.sheetId}. There is no implicit write target.`);
    if (!/^[A-Za-z0-9_-]{20,}$/.test(id))
        throw new UsageError('That does not look like a spreadsheet ID (the long ID in the Sheet URL).');
    return id;
}
function backupDir(v) {
    return str(v['backup-dir']) ?? str(v['output-dir']) ?? env('AMBASSADOR_BACKUP_DIR') ?? 'ambassador-backups';
}
async function client(sheetId) {
    const auth = await loadMaintainerAuth();
    return new SheetsClient(sheetId, auth);
}
/** Current catalog for previews: Sheets API when maintainer credentials exist, else the public CSV. */
async function currentView(v, io) {
    const creds = await describeMaintainerCredentials();
    const against = str(v.against);
    if (against && against !== 'sheet' && against !== 'csv')
        throw new UsageError('--against must be "sheet" or "csv".');
    if (against === 'sheet' || (against !== 'csv' && creds.configured)) {
        const c = await client(sheetIdForRead(v));
        return { kind: 'sheets-api', state: await readSheetState(c, tabOf(v)) };
    }
    const cat = await loadCatalog({ mode: 'refresh' });
    io.err(`Reading the published CSV (no maintainer credentials). It can lag Sheet edits by several minutes. ${describeOrigin(cat.origin)}.`);
    return { kind: 'published-csv', table: cat.table, fetchedAt: cat.origin.fetchedAt };
}
function viewTable(view) {
    return view.kind === 'sheets-api' ? view.state.opportunities.table : view.table;
}
export function printPlan(plan, io) {
    const byId = new Map();
    for (const w of plan.writes) {
        const lines = byId.get(w.id) ?? [];
        lines.push(`    ${HEADER_BY_KEY[w.field]}: ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}`);
        byId.set(w.id, lines);
    }
    for (const [id, lines] of byId)
        io.out(`  update ${id}\n${lines.join('\n')}`);
    for (const r of plan.appends)
        io.out(`  add    ${r.id} (${r.company} — ${r.program}, ${r.status})`);
    for (const s of plan.sourceAppends)
        io.out(`  add source ${s.id} ${s.url}`);
    for (const n of plan.noops)
        io.out(`  same   ${n}`);
    for (const n of plan.notes)
        io.out(`  note   ${n}`);
    for (const c of plan.conflicts)
        io.out(`  CONFLICT ${c}`);
    io.out(`Summary: ${plan.writes.length} cell update(s), ${plan.appends.length} new record(s), ${plan.sourceAppends.length} new source(s), ${plan.noops.length} unchanged, ${plan.conflicts.length} conflict(s).`);
}
/** Print a plan plus any protected cells this principal could not write; exit 3 if apply would stop. */
function previewPlan(changeset, view, io) {
    const plan = view.kind === 'sheets-api'
        ? planChangeset(changeset, view.state)
        : planChangeset(changeset, { opportunities: { table: view.table }, sources: null });
    printPlan(plan, io);
    const blocked = view.kind === 'sheets-api' ? protectedWrites(plan, view.state) : [];
    for (const b of blocked)
        io.out(`  BLOCKED ${b}`);
    if (blocked.length) {
        io.out('Apply would stop: these cells are protected for this principal. The spreadsheet owner must grant access to that protected range or make the change by hand.');
    }
    if (view.kind === 'published-csv')
        io.out('Protected ranges were not checked (no maintainer credentials).');
    return plan.conflicts.length || blocked.length ? 3 : 0;
}
const review = {
    options: maintainerOptions.review,
    async run(p, v, io) {
        if (p.length === 0)
            throw new UsageError('Usage: ambassador review <candidate.json...> [--output changes.json]');
        const view = await currentView(v, io);
        const table = viewTable(view);
        const current = new Map(table.records.map((r) => [r.id, r]));
        const changes = [];
        const candidates = [];
        let rejected = 0;
        for (const file of p) {
            const raw = await readJsonFile(file);
            const items = Array.isArray(raw) ? raw : [raw];
            for (const item of items) {
                const r = reviewCandidate(file, item, current);
                io.out(`${r.ok ? (r.change ? r.change.action.toUpperCase() : 'SAME') : 'REJECT'} ${r.id ?? '(no id)'}  [${file}]`);
                for (const line of r.diff)
                    io.out(line);
                for (const prob of r.problems)
                    io.out(`  problem: ${prob}`);
                if (!r.ok)
                    rejected += 1;
                else if (r.change) {
                    if (changes.some((c) => c.id === r.change.id)) {
                        io.out(`  problem: ${r.change.id} is proposed more than once`);
                        rejected += 1;
                    }
                    else {
                        changes.push(r.change);
                        candidates.push(CandidateSchema.parse(item));
                    }
                }
            }
        }
        if (rejected) {
            io.err(`${rejected} candidate(s) need fixes. No changeset written.`);
            return 2;
        }
        if (changes.length === 0) {
            io.out('Nothing to change.');
            return 0;
        }
        const citedIds = new Set(changes.flatMap((c) => (c.action === 'add' ? c.record.sourceIds : (c.fields.sourceIds?.to.split(', ') ?? []))));
        const sources = sourcesFromCandidates(candidates, citedIds);
        const fetchedAt = view.kind === 'sheets-api' ? view.state.readAt : view.fetchedAt;
        const cs = newChangeset({ kind: view.kind, fetchedAt, url: view.kind === 'sheets-api' ? sheetIdForRead(v) : csvUrl() }, changes, sources);
        const output = str(v.output) ?? 'changes.json';
        await writeNewFile(output, `${JSON.stringify(cs, null, 2)}\n`, Boolean(v.force));
        io.out(`\nWrote ${output}: ${changes.length} change(s), ${sources.length} source row(s). Next: ambassador sync --dry-run --changes ${output}`);
    },
};
async function loadChangeset(v) {
    const file = str(v.changes) ?? 'changes.json';
    const parsed = ChangesetSchema.safeParse(await readJsonFile(file));
    if (!parsed.success)
        throw new UsageError(`${file} is not a valid changeset: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const ageDays = (Date.now() - Date.parse(parsed.data.createdAt)) / 86_400_000;
    if (ageDays > STALE_DAYS && !v['allow-stale']) {
        throw new ConflictError(`${file} was reviewed ${Math.floor(ageDays)} days ago. Re-run review, or pass --allow-stale after checking it.`);
    }
    return parsed.data;
}
function modeOf(v) {
    if (v['dry-run'] && v.apply)
        throw new UsageError('Choose either --dry-run or --apply.');
    return v.apply ? 'apply' : 'dry-run';
}
function reportApply(result, io) {
    printPlan(result.plan, io);
    if (!result.backupFile) {
        io.out('Already up to date; nothing written (repeat runs are idempotent).');
        return 0;
    }
    io.out(`Applied in one batchUpdate (${result.written} request(s)). Backup: ${result.backupFile}`);
    if (result.readbackProblems.length) {
        io.err(`Readback found differences:\n  - ${result.readbackProblems.join('\n  - ')}\nInspect the Sheet; restore with: ambassador restore ${result.backupFile} --dry-run`);
        return 1;
    }
    io.out('Readback verified every written value.');
    return 0;
}
const sync = {
    options: maintainerOptions.sync,
    async run(_p, v, io) {
        const mode = modeOf(v);
        const changeset = await loadChangeset(v);
        if (mode === 'dry-run') {
            if (!v['dry-run'])
                io.err('No --apply given; showing a dry run.');
            const view = await currentView(v, io);
            io.out(`Dry run against ${view.kind === 'sheets-api' ? `spreadsheet ${sheetIdForRead(v)}` : 'the published CSV'}; nothing written.`);
            return previewPlan(changeset, view, io);
        }
        const id = sheetIdForWrite(v);
        const c = await client(id);
        io.err(`Writing as ${(await loadMaintainerAuth()).principal} to spreadsheet ${id}, tab "${tabOf(v)}".`);
        const result = await withLocalLock(join(cacheDir(), `sync-${id}.lock`), () => applyChangeset(c, tabOf(v), changeset, { backupDir: backupDir(v), log: (l) => io.err(l) }));
        return reportApply(result, io);
    },
};
const backup = {
    options: maintainerOptions.backup,
    async run(_p, v, io) {
        const creds = await describeMaintainerCredentials();
        const dir = backupDir(v);
        if (creds.configured && !v['public-csv']) {
            const id = sheetIdForRead(v);
            const state = await readSheetState(await client(id), tabOf(v));
            const b = makeBackup({ spreadsheetId: id, tab: tabOf(v), origin: 'sheets-api', grid: state.opportunities.grid, formulas: state.opportunities.formulas, sources: state.sources?.grid ?? null });
            const file = await writeBackup(dir, b);
            io.out(`Backup of ${state.opportunities.table.records.length} records${state.sources ? ` and ${state.sources.byId.size} sources` : ''} written to ${file}`);
            if (b.opportunities.formulaCells.length)
                io.err(`Warning: formula cells found: ${b.opportunities.formulaCells.join(', ')}`);
            return;
        }
        const text = await fetchCatalogCsv(csvUrl());
        const table = parseCatalogCsv(text);
        const grid = parseCsv(text, { bom: true, relax_column_count: true, skip_empty_lines: true });
        const b = makeBackup({ spreadsheetId: sheetIdForRead(v), tab: tabOf(v), origin: 'published-csv', grid, sources: null });
        const file = await writeBackup(dir, b);
        io.out(`Backup of ${table.records.length} records from the published CSV written to ${file}`);
        io.err('Note: the published CSV omits the Sources tab and formulas and may lag edits. Configure maintainer credentials for a full backup.');
    },
};
const restore = {
    options: maintainerOptions.restore,
    async run(p, v, io) {
        const file = p[0];
        if (!file)
            throw new UsageError('Usage: ambassador restore <backup.json> --dry-run | --apply --sheet-id ID');
        const parsed = BackupSchema.safeParse(await readJsonFile(file));
        if (!parsed.success)
            throw new UsageError(`${file} is not a backup file created by this tool.`);
        const b = parsed.data;
        const mode = modeOf(v);
        if (mode === 'dry-run') {
            const view = await currentView({ ...v, 'sheet-id': str(v['sheet-id']) ?? b.spreadsheetId }, io);
            const sources = view.kind === 'sheets-api' ? view.state.sources : null;
            const { changeset, extraIds, problems } = restoreChangeset(b, viewTable(view), sources);
            io.out(`Restore preview from ${file} (backup taken ${b.createdAt}); nothing written.`);
            const code = previewPlan(changeset, view, io);
            for (const prob of problems)
                io.out(`  backup problem: ${prob}`);
            if (extraIds.length)
                io.out(`  kept   ${extraIds.join(', ')} (present now but not in the backup; restore never deletes)`);
            return code;
        }
        const id = sheetIdForWrite(v);
        if (id !== b.spreadsheetId)
            throw new UsageError(`Backup belongs to spreadsheet ${b.spreadsheetId}, not ${id}. Refusing to restore across spreadsheets.`);
        if (b.tab !== tabOf(v))
            throw new UsageError(`Backup is of tab "${b.tab}", not "${tabOf(v)}".`);
        const c = await client(id);
        const result = await withLocalLock(join(cacheDir(), `sync-${id}.lock`), async () => {
            const state = await readSheetState(c, b.tab);
            const { changeset, extraIds, problems } = restoreChangeset(b, state.opportunities.table, state.sources);
            if (problems.length)
                throw new CliError(`Backup has invalid rows; fix before restoring:\n  - ${problems.join('\n  - ')}`);
            if (extraIds.length)
                io.out(`Keeping ${extraIds.join(', ')} (not in backup; restore never deletes).`);
            return applyChangeset(c, b.tab, changeset, { backupDir: backupDir(v), log: (l) => io.err(l) });
        });
        return reportApply(result, io);
    },
};
export const maintainerCommands = { review, sync, backup, restore };
