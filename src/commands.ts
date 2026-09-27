import { cacheDir, csvUrl, DEFAULT_SHEET_URL, env, ENV, maxRequests, TOOL_VERSION } from './config.js';
import { describeOrigin, findRecord, loadCatalog, loadSnapshot, loadSources, type LoadedCatalog, type SourceRecord } from './catalog.js';
import { CliError, MissingKeyError, UsageError } from './errors.js';
import { checkModel, formatEvidence, FORMATTERS, resolveFormatter, type FormatResult } from './formatters/openrouter.js';
import { RequestBudget } from './http.js';
import { ensureWritable, writeNewFile, type CommandSpec, type Io, type Values } from './io.js';
import { buildCandidate, slugify } from './propose.js';
import { cached, getProvider, providerKey } from './providers/index.js';
import { directContent } from './providers/direct.js';
import type { PageContent } from './providers/types.js';
import { maintainerOptions } from './maintainer/options.js';
import { recordsToCsv } from './records.js';
import { renderList, renderRecord } from './render.js';
import { assertPublicUrl, presence, terminalSafe } from './safety.js';
import { ASSESSMENTS, OPEN_STATUSES, STATUSES, type Opportunity } from './schema.js';

const catalogOptions = {
  offline: { type: 'boolean' },
  refresh: { type: 'boolean' },
} as const;

const filterOptions = {
  status: { type: 'string' },
  open: { type: 'boolean' },
  assessment: { type: 'string' },
  company: { type: 'string' },
  category: { type: 'string' },
  text: { type: 'string' },
} as const;

function str(v: Values[string]): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function matchEnum<T extends string>(input: string, options: readonly T[], label: string): T[] {
  return input.split(',').map((part) => {
    const hit = options.find((o) => norm(o) === norm(part));
    if (!hit) throw new UsageError(`Unknown ${label} "${part.trim()}". Options: ${options.join(', ')}.`);
    return hit;
  });
}

export function filterRecords(records: Opportunity[], v: Values): Opportunity[] {
  let out = records;
  const status = str(v.status);
  if (status) {
    const wanted = new Set(matchEnum(status, STATUSES, 'status'));
    out = out.filter((r) => wanted.has(r.status));
  }
  if (v.open) out = out.filter((r) => OPEN_STATUSES.includes(r.status));
  const assessment = str(v.assessment);
  if (assessment) {
    const wanted = new Set(matchEnum(assessment, ASSESSMENTS, 'assessment'));
    out = out.filter((r) => wanted.has(r.assessment));
  }
  const company = str(v.company);
  if (company) out = out.filter((r) => norm(r.company).includes(norm(company)));
  const category = str(v.category);
  if (category) out = out.filter((r) => norm(r.category).includes(norm(category)));
  const text = str(v.text);
  if (text) {
    const terms = norm(text).split(' ').filter(Boolean);
    out = out.filter((r) => {
      const hay = norm(Object.values(r).flat().join(' '));
      return terms.every((t) => hay.includes(t));
    });
  }
  return out;
}

function urlKey(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/$/, '')}`;
  } catch {
    return u;
  }
}

/** Whether a URL is already a catalog record's application URL, or a source cited by records. */
export function catalogMatches(url: string, records: Opportunity[], sources: SourceRecord[]): { catalogId: string | null; citedBy: string[] } {
  const key = urlKey(url);
  const catalogId = records.find((r) => urlKey(r.url) === key)?.id ?? null;
  const sourceIds = new Set(sources.filter((s) => urlKey(s.url) === key).map((s) => s.id));
  const citedBy = records.filter((r) => r.id !== catalogId && r.sourceIds.some((id) => sourceIds.has(id))).map((r) => r.id);
  return { catalogId, citedBy };
}

async function catalogFor(v: Values): Promise<LoadedCatalog> {
  if (v.offline && v.refresh) throw new UsageError('--offline and --refresh cannot be combined.');
  return loadCatalog({ mode: v.offline ? 'offline' : v.refresh ? 'refresh' : 'auto' });
}

function reportIssues(cat: LoadedCatalog, io: Io): void {
  for (const i of cat.table.issues) io.err(`Warning: catalog row ${i.row}${i.id ? ` (${i.id})` : ''} skipped: ${i.problems.join('; ')}`);
}

const list: CommandSpec = {
  options: { ...catalogOptions, ...filterOptions, json: { type: 'boolean' } },
  async run(_p, v, io) {
    const cat = await catalogFor(v);
    const records = filterRecords(cat.table.records, v);
    if (v.json) {
      io.out(JSON.stringify({ origin: cat.origin, count: records.length, records }, null, 2));
      return;
    }
    reportIssues(cat, io);
    io.out(renderList(records));
    io.out(`\n${records.length} of ${cat.table.records.length} opportunities. ${describeOrigin(cat.origin)}.`);
    io.out(`Blank deadline = no verified exact deadline. Check each official page before applying.`);
  },
};

const show: CommandSpec = {
  options: { ...catalogOptions, json: { type: 'boolean' } },
  async run(p, v, io) {
    const id = p[0];
    if (!id) throw new UsageError('Usage: ambassador show <id>');
    const cat = await catalogFor(v);
    const rec = findRecord(cat.table.records, id);
    if (!rec) {
      const close = cat.table.records.filter((r) => r.id.includes(norm(id).split(' ')[0] ?? '')).map((r) => r.id);
      throw new UsageError(`No opportunity with ID "${id}".${close.length ? ` Did you mean: ${close.slice(0, 5).join(', ')}?` : ' Run "ambassador list" to see IDs.'}`);
    }
    if (v.json) {
      io.out(JSON.stringify({ origin: cat.origin, record: rec }, null, 2));
      return;
    }
    io.out(renderRecord(rec, await loadSources({ offline: Boolean(v.offline) })));
    io.out(`\n${describeOrigin(cat.origin)}.`);
  },
};

const exportCmd: CommandSpec = {
  options: { ...catalogOptions, ...filterOptions, format: { type: 'string', default: 'csv' }, output: { type: 'string', short: 'o' }, force: { type: 'boolean' } },
  async run(_p, v, io) {
    const format = str(v.format) ?? 'csv';
    if (format !== 'csv' && format !== 'json') throw new UsageError('--format must be csv or json.');
    const cat = await catalogFor(v);
    const records = filterRecords(cat.table.records, v);
    const body =
      format === 'csv'
        ? recordsToCsv(records)
        : `${JSON.stringify({ exportedAt: new Date().toISOString(), origin: cat.origin, catalog: DEFAULT_SHEET_URL, records }, null, 2)}\n`;
    const output = str(v.output);
    if (output) {
      await writeNewFile(output, body, Boolean(v.force));
      io.err(`Wrote ${records.length} records to ${output}. ${describeOrigin(cat.origin)}.`);
    } else {
      io.out(body.trimEnd());
      io.err(`${records.length} records. ${describeOrigin(cat.origin)}.`);
    }
  },
};

const search: CommandSpec = {
  options: {
    provider: { type: 'string' },
    limit: { type: 'string', default: '8' },
    json: { type: 'boolean' },
    'no-cache': { type: 'boolean' },
    'max-requests': { type: 'string' },
  },
  async run(p, v, io) {
    const query = p.join(' ').trim();
    if (!query) throw new UsageError('Usage: ambassador search "<query>" [--provider exa|firecrawl]');
    if (query.length > 400) throw new UsageError('Query is too long (400 characters max).');
    const limit = Number(str(v.limit));
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new UsageError('--limit must be an integer from 1 to 20.');
    const provider = getProvider(str(v.provider));
    const apiKey = providerKey(provider);
    const budget = new RequestBudget(maxRequests(str(v['max-requests'])));
    const { value: results, hit } = await cached('search', [provider.name, query, limit], !v['no-cache'], () => provider.search(query, limit, { apiKey, budget }));
    let known: Opportunity[] = [];
    let sources: SourceRecord[] = [];
    try {
      known = (await loadCatalog({ mode: 'auto' })).table.records;
      sources = (await loadSources()).sources;
    } catch {
      // Matching against the catalog is a convenience; search results stand on their own.
    }
    const annotated = results.map((r) => ({ ...r, ...catalogMatches(r.url, known, sources) }));
    if (v.json) {
      io.out(JSON.stringify({ provider: provider.name, query, cached: hit, results: annotated }, null, 2));
      return;
    }
    if (results.length === 0) io.out('No results.');
    annotated.forEach((r, i) => {
      const note = r.catalogId ? `  [already in catalog: ${r.catalogId}]` : r.citedBy.length ? `  [already cited by: ${r.citedBy.join(', ')}]` : '';
      io.out(`${i + 1}. ${terminalSafe(r.title ?? '(untitled)')}${note}`);
      io.out(`   ${terminalSafe(r.url)}${r.publishedDate ? `  (published ${r.publishedDate.slice(0, 10)})` : ''}`);
      if (r.snippet) io.out(`   ${terminalSafe(r.snippet)}`);
    });
    io.out(`\n${provider.name}${hit ? ' (cached result, under 24h old)' : `, ${budget.count} request(s)`}. Results are leads, not verified openings.`);
    io.out('Turn one into a local candidate: ambassador propose <url> --output candidate.json');
  },
};

const propose: CommandSpec = {
  options: {
    provider: { type: 'string' },
    'format-with': { type: 'string' },
    output: { type: 'string', short: 'o' },
    force: { type: 'boolean' },
    'no-cache': { type: 'boolean' },
    'max-requests': { type: 'string' },
  },
  async run(p, v, io) {
    const raw = p[0];
    if (!raw || p.length > 1) throw new UsageError('Usage: ambassador propose <url> [--output candidate.json]');
    const url = (await assertPublicUrl(raw)).toString();
    const budget = new RequestBudget(maxRequests(str(v['max-requests'])));
    const providerName = str(v.provider) ?? (env(ENV.exaKey) ? 'exa' : 'direct');
    const noCache = Boolean(v['no-cache']);
    const force = Boolean(v.force);
    const explicitOutput = str(v.output);
    // Check everything that can fail cheaply before spending provider credits.
    if (explicitOutput) await ensureWritable(explicitOutput, force);
    const provider = providerName === 'direct' ? null : getProvider(providerName);
    const apiKey = provider ? providerKey(provider) : null;
    const choice = str(v['format-with']);
    let formatter: { model: string; key: string; structuredOutputs: boolean } | null = null;
    if (choice) {
      const model = resolveFormatter(choice);
      const key = env(ENV.openrouterKey);
      if (!key) throw new MissingKeyError(ENV.openrouterKey, 'Formatting is optional; omit --format-with to use the no-model workflow.');
      const availability = await checkModel(model, { budget });
      if (!availability.available || !availability.free) {
        throw new UsageError(`Formatter ${model} is unavailable: ${availability.reason}. Re-run without --format-with; no other model is substituted.`);
      }
      formatter = { model, key, structuredOutputs: availability.structuredOutputs };
    }

    const page: PageContent = provider
      ? (await cached('content', [provider.name, url], !noCache, () => provider.content(url, { apiKey: apiKey!, budget }))).value
      : (await cached('content', ['direct', url], !noCache, () => directContent(url, { budget }))).value;
    io.err(`Fetched ${page.text.length} characters of evidence via ${page.fetcher}.`);

    let format: FormatResult | undefined;
    let formatFailure: string | null = null;
    if (formatter) {
      try {
        format = await formatEvidence(
          { model: formatter.model, url: page.url, title: page.title, text: page.text, apiKey: formatter.key, structuredOutputs: formatter.structuredOutputs },
          { budget },
        );
      } catch (e) {
        // Keep the evidence: a rate-limited, exhausted or failing model must not cost the candidate.
        if (!(e instanceof CliError)) throw e;
        formatFailure = e.message;
        format = { model: formatter.model, output: null, raw: null, errors: [e.message] };
      }
    }
    const candidate = buildCandidate({ requestedUrl: url, page, format });
    const output = explicitOutput ?? `candidate-${candidate.record.id ?? slugify(new URL(url).hostname)}.json`;
    await writeNewFile(output, `${JSON.stringify(candidate, null, 2)}\n`, force);
    const filled = candidate.formatter?.filledFields ?? [];
    io.out(`Wrote ${output} (${candidate.reviewState}).`);
    if (formatFailure) io.out(`Formatting failed, so the candidate was saved without model output: ${formatFailure}`);
    else if (candidate.formatter) io.out(`Formatter ${candidate.formatter.model}: ${filled.length} field(s) filled from the page${candidate.formatter.ok ? '' : ', output failed validation'}.`);
    for (const w of candidate.warnings) io.out(`  note: ${w}`);
    io.out('Unknown values stay null. Edit the file to add facts you verified, then submit it through a GitHub issue or pull request.');
    io.out('Nothing was sent anywhere on your behalf.');
    return formatFailure ? 1 : 0;
  },
};

const doctor: CommandSpec = {
  options: { offline: { type: 'boolean' }, json: { type: 'boolean' } },
  async run(_p, v, io) {
    const checks: { name: string; ok: boolean | null; detail: string }[] = [];
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    checks.push({ name: 'Node.js', ok: nodeMajor >= 22, detail: `v${process.versions.node} (needs 22+)` });
    checks.push({ name: 'CLI version', ok: true, detail: TOOL_VERSION });
    try {
      const cat = await loadCatalog({ mode: v.offline ? 'offline' : 'refresh' });
      checks.push({
        name: 'Catalog',
        ok: cat.origin.kind === 'live' ? cat.table.issues.length === 0 : null,
        detail: `${cat.table.records.length} valid records, ${cat.table.issues.length} invalid row(s), ${cat.table.header.length || 22} columns. ${describeOrigin(cat.origin)}`,
      });
    } catch (e) {
      checks.push({ name: 'Catalog', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
    checks.push({ name: 'Catalog feed URL', ok: true, detail: csvUrl() });
    checks.push({ name: 'Cache directory', ok: true, detail: cacheDir() });
    const snap = loadSnapshot();
    checks.push({ name: 'Bundled snapshot', ok: true, detail: `${snap.records.length} records captured ${snap.capturedAt}` });
    checks.push({ name: 'EXA_API_KEY (search default)', ok: null, detail: presence(env(ENV.exaKey)) });
    checks.push({ name: 'FIRECRAWL_API_KEY (optional)', ok: null, detail: presence(env(ENV.firecrawlKey)) });
    checks.push({ name: 'OPENROUTER_API_KEY (optional formatting)', ok: null, detail: presence(env(ENV.openrouterKey)) });
    if (!v.offline) {
      const budget = new RequestBudget(Object.keys(FORMATTERS).length + 1);
      for (const id of Object.values(FORMATTERS)) {
        try {
          const a = await checkModel(id, { budget });
          checks.push({
            name: `Formatter ${id}`,
            ok: a.available && a.free,
            detail: a.available ? `${a.free ? 'listed, free' : a.reason}; ${a.structuredOutputs ? 'enforced JSON schema' : 'JSON by instruction only, validated locally'}` : (a.reason ?? 'unavailable'),
          });
        } catch (e) {
          checks.push({ name: `Formatter ${id}`, ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    const { describeMaintainerCredentials } = await import('./maintainer/google-auth.js');
    const creds = await describeMaintainerCredentials();
    checks.push({ name: 'Maintainer Google credentials', ok: creds.warnings.length ? false : null, detail: [creds.detail, ...creds.warnings].join('; ') });
    if (v.json) {
      io.out(JSON.stringify({ checks }, null, 2));
    } else {
      for (const c of checks) io.out(`${c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : 'info'}  ${c.name}: ${c.detail}`);
      io.out('\nKey values are never printed. Browsing needs no keys; search/propose use your own.');
    }
    return checks.some((c) => c.ok === false) ? 1 : 0;
  },
};

function lazy(name: 'review' | 'sync' | 'backup' | 'restore'): CommandSpec {
  return {
    options: {},
    async run(p, v, io) {
      const mod = await import('./maintainer/commands.js');
      return mod.maintainerCommands[name].run(p, v, io);
    },
  };
}

export const commands: Record<string, CommandSpec> = {
  list,
  show,
  export: exportCmd,
  search,
  propose,
  doctor,
  review: { ...lazy('review'), options: maintainerOptions.review },
  sync: { ...lazy('sync'), options: maintainerOptions.sync },
  backup: { ...lazy('backup'), options: maintainerOptions.backup },
  restore: { ...lazy('restore'), options: maintainerOptions.restore },
};
