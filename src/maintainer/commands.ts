import { join } from 'node:path';
import { cacheDir, DEFAULT_SHEET_ID, DEFAULT_TAB, env, ENV } from '../config.js';
import { CliError, ConflictError, UsageError } from '../errors.js';
import { readJsonFile, str, writeNewFile, type CommandSpec, type Io, type Values } from '../io.js';
import { CandidateSchema, HEADER_BY_KEY, type Candidate, type Opportunity } from '../schema.js';
import { ChangesetSchema, newChangeset, reviewCandidate, sourcesFromCandidates, type Change, type Changeset } from './changeset.js';
import { loadMaintainerAuth } from './google-auth.js';
import { withLocalLock } from './lock.js';
import { SheetsClient } from './sheets-client.js';
import {
  applyChangeset,
  BackupSchema,
  makeBackup,
  planChangeset,
  protectedWrites,
  readSheetState,
  restoreChangeset,
  writeBackup,
  type ApplyResult,
  type Plan,
  type SheetState,
} from './sync.js';

const STALE_DAYS = 14;

const sheetOptions = {
  'sheet-id': { type: 'string' },
  tab: { type: 'string' },
} as const;

function tabOf(v: Values): string {
  return str(v.tab) ?? DEFAULT_TAB;
}

/** Reads may default to the public catalog; writes need an explicit target. */
function sheetIdForRead(v: Values): string {
  return str(v['sheet-id']) ?? env(ENV.sheetId) ?? DEFAULT_SHEET_ID;
}

function sheetIdForWrite(v: Values): string {
  const id = str(v['sheet-id']) ?? env(ENV.sheetId);
  if (!id) throw new UsageError(`--apply needs an explicit target: pass --sheet-id or set ${ENV.sheetId}. There is no implicit write target.`);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) throw new UsageError('That does not look like a spreadsheet ID (the long ID in the Sheet URL).');
  return id;
}

function backupDir(v: Values): string {
  return str(v['backup-dir']) ?? str(v['output-dir']) ?? env('AMBASSADOR_BACKUP_DIR') ?? 'ambassador-backups';
}

async function client(sheetId: string): Promise<SheetsClient> {
  return new SheetsClient(sheetId, await loadMaintainerAuth());
}

/** Current Sheet contents through the Sheets API (maintainer credentials required). */
async function readSheet(v: Values, sheetId = sheetIdForRead(v)): Promise<SheetState> {
  return readSheetState(await client(sheetId), tabOf(v));
}

function printPlan(plan: Plan, io: Io): void {
  const byId = new Map<string, string[]>();
  for (const w of plan.writes) {
    const lines = byId.get(w.id) ?? [];
    lines.push(`    ${HEADER_BY_KEY[w.field]}: ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}`);
    byId.set(w.id, lines);
  }
  for (const [id, lines] of byId) io.out(`  update ${id}\n${lines.join('\n')}`);
  for (const r of plan.appends) io.out(`  add    ${r.id} (${r.company} — ${r.program}, ${r.status})`);
  for (const s of plan.sourceAppends) io.out(`  add source ${s.id} ${s.url}`);
  for (const n of plan.noops) io.out(`  same   ${n}`);
  for (const n of plan.notes) io.out(`  note   ${n}`);
  for (const c of plan.conflicts) io.out(`  CONFLICT ${c}`);
  io.out(`Summary: ${plan.writes.length} cell update(s), ${plan.appends.length} new record(s), ${plan.sourceAppends.length} new source(s), ${plan.noops.length} unchanged, ${plan.conflicts.length} conflict(s).`);
}

/** Print a plan and any protected cells this principal cannot write; exit 3 if apply would stop. */
function previewPlan(changeset: Changeset, state: SheetState, io: Io): number {
  const plan = planChangeset(changeset, state);
  printPlan(plan, io);
  const blocked = protectedWrites(plan, state);
  for (const b of blocked) io.out(`  BLOCKED ${b}`);
  if (blocked.length) io.out('Apply would stop: the spreadsheet owner must allow edits to those protected cells, or make the change by hand.');
  return plan.conflicts.length || blocked.length ? 3 : 0;
}

const review: CommandSpec = {
  options: { output: { type: 'string', short: 'o' }, force: { type: 'boolean' }, ...sheetOptions },
  async run(p, v, io) {
    if (p.length === 0) throw new UsageError('Usage: ambassador review <candidate.json...> [--output changes.json]');
    const state = await readSheet(v);
    const current = new Map<string, Opportunity>(state.opportunities.table.records.map((r) => [r.id, r]));
    const changes: Change[] = [];
    const candidates: Candidate[] = [];
    let rejected = 0;
    for (const file of p) {
      const raw = await readJsonFile(file);
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        const r = reviewCandidate(file, item, current);
        io.out(`${r.ok ? (r.change ? r.change.action.toUpperCase() : 'SAME') : 'REJECT'} ${r.id ?? '(no id)'}  [${file}]`);
        for (const line of r.diff) io.out(line);
        for (const prob of r.problems) io.out(`  problem: ${prob}`);
        if (!r.ok) rejected += 1;
        else if (r.change) {
          if (changes.some((c) => c.id === r.change!.id)) {
            io.out(`  problem: ${r.change.id} is proposed more than once`);
            rejected += 1;
          } else {
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
    const cs = newChangeset({ kind: 'sheets-api', fetchedAt: state.readAt, url: sheetIdForRead(v) }, changes, sources);
    const output = str(v.output) ?? 'changes.json';
    await writeNewFile(output, `${JSON.stringify(cs, null, 2)}\n`, Boolean(v.force));
    io.out(`\nWrote ${output}: ${changes.length} change(s), ${sources.length} source row(s). Next: ambassador sync --dry-run --changes ${output}`);
  },
};

async function loadChangeset(v: Values): Promise<Changeset> {
  const file = str(v.changes) ?? 'changes.json';
  const parsed = ChangesetSchema.safeParse(await readJsonFile(file));
  if (!parsed.success) throw new UsageError(`${file} is not a valid changeset: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  const ageDays = (Date.now() - Date.parse(parsed.data.createdAt)) / 86_400_000;
  if (ageDays > STALE_DAYS && !v['allow-stale']) {
    throw new ConflictError(`${file} was reviewed ${Math.floor(ageDays)} days ago. Re-run review, or pass --allow-stale after checking it.`);
  }
  return parsed.data;
}

function modeOf(v: Values): 'dry-run' | 'apply' {
  if (v['dry-run'] && v.apply) throw new UsageError('Choose either --dry-run or --apply.');
  return v.apply ? 'apply' : 'dry-run';
}

function reportApply(result: ApplyResult, io: Io): number {
  printPlan(result.plan, io);
  if (!result.backupFile) {
    io.out('Nothing to write: the Sheet already matches.');
    return 0;
  }
  io.out(`Wrote ${result.plan.writes.length} cell(s), ${result.plan.appends.length} record(s) and ${result.plan.sourceAppends.length} source(s). Backup: ${result.backupFile}`);
  if (result.readbackProblems.length) {
    io.err(`Readback found differences:\n  - ${result.readbackProblems.join('\n  - ')}\nInspect the Sheet; restore with: ambassador restore ${result.backupFile} --dry-run`);
    return 1;
  }
  io.out('Read back every written value: all match.');
  return 0;
}

const sync: CommandSpec = {
  options: {
    changes: { type: 'string' },
    'dry-run': { type: 'boolean' },
    apply: { type: 'boolean' },
    'backup-dir': { type: 'string' },
    'allow-stale': { type: 'boolean' },
    ...sheetOptions,
  },
  async run(_p, v, io) {
    const mode = modeOf(v);
    const changeset = await loadChangeset(v);
    if (mode === 'dry-run') {
      if (!v['dry-run']) io.err('No --apply given; showing a dry run.');
      const state = await readSheet(v);
      io.out(`Dry run against spreadsheet ${sheetIdForRead(v)}; nothing written.`);
      return previewPlan(changeset, state, io);
    }
    const id = sheetIdForWrite(v);
    const c = await client(id);
    io.err(`Writing as ${c.principal} to spreadsheet ${id}, tab "${tabOf(v)}".`);
    const result = await withLocalLock(join(cacheDir(), `sync-${id}.lock`), () =>
      applyChangeset(c, tabOf(v), changeset, { backupDir: backupDir(v), log: (l) => io.err(l) }),
    );
    return reportApply(result, io);
  },
};

const backup: CommandSpec = {
  options: { 'backup-dir': { type: 'string' }, 'output-dir': { type: 'string' }, ...sheetOptions },
  async run(_p, v, io) {
    const id = sheetIdForRead(v);
    const state = await readSheet(v, id);
    const b = makeBackup({ spreadsheetId: id, tab: tabOf(v), origin: 'sheets-api', grid: state.opportunities.grid, formulas: state.opportunities.formulas, sources: state.sources?.grid ?? null });
    const file = await writeBackup(backupDir(v), b);
    io.out(`Backup of ${state.opportunities.table.records.length} records${state.sources ? ` and ${state.sources.byId.size} sources` : ''} written to ${file}`);
    if (b.opportunities.formulaCells.length) io.err(`Warning: formula cells found: ${b.opportunities.formulaCells.join(', ')}`);
  },
};

const restore: CommandSpec = {
  options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, 'backup-dir': { type: 'string' }, ...sheetOptions },
  async run(p, v, io) {
    const file = p[0];
    if (!file) throw new UsageError('Usage: ambassador restore <backup.json> --dry-run | --apply --sheet-id ID');
    const parsed = BackupSchema.safeParse(await readJsonFile(file));
    if (!parsed.success) throw new UsageError(`${file} is not a backup file created by this tool.`);
    const b = parsed.data;
    if (modeOf(v) === 'dry-run') {
      const state = await readSheet(v, str(v['sheet-id']) ?? b.spreadsheetId);
      const { changeset, extraIds, problems } = restoreChangeset(b, state.opportunities.table, state.sources);
      io.out(`Restore preview from ${file} (backup taken ${b.createdAt}); nothing written.`);
      const code = previewPlan(changeset, state, io);
      for (const prob of problems) io.out(`  backup problem: ${prob}`);
      if (extraIds.length) io.out(`  kept   ${extraIds.join(', ')} (present now but not in the backup; restore never deletes)`);
      return code;
    }
    const id = sheetIdForWrite(v);
    if (id !== b.spreadsheetId) throw new UsageError(`Backup belongs to spreadsheet ${b.spreadsheetId}, not ${id}. Refusing to restore across spreadsheets.`);
    if (b.tab !== tabOf(v)) throw new UsageError(`Backup is of tab "${b.tab}", not "${tabOf(v)}".`);
    const c = await client(id);
    const result = await withLocalLock(join(cacheDir(), `sync-${id}.lock`), async () => {
      const state = await readSheetState(c, b.tab);
      const { changeset, extraIds, problems } = restoreChangeset(b, state.opportunities.table, state.sources);
      if (problems.length) throw new CliError(`Backup has invalid rows; fix before restoring:\n  - ${problems.join('\n  - ')}`);
      if (extraIds.length) io.out(`Keeping ${extraIds.join(', ')} (not in backup; restore never deletes).`);
      return applyChangeset(c, b.tab, changeset, { backupDir: backupDir(v), log: (l) => io.err(l) });
    });
    return reportApply(result, io);
  },
};

export const maintainerCommands = { review, sync, backup, restore };
