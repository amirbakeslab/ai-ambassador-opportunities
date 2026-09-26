import { terminalSafe } from './safety.js';
import { COLUMNS, type Opportunity } from './schema.js';
import type { SourceRecord } from './catalog.js';

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

export function renderList(records: Opportunity[], width = process.stdout.isTTY ? process.stdout.columns || 120 : Infinity): string {
  if (records.length === 0) return 'No matching opportunities.';
  const cols = [
    // IDs are never truncated: they are what `show` needs.
    { title: 'ID', get: (r: Opportunity) => r.id, min: Math.max(2, ...records.map((r) => r.id.length)) },
    { title: 'Company', get: (r: Opportunity) => r.company, min: 9 },
    { title: 'Program', get: (r: Opportunity) => r.program, min: 16 },
    { title: 'Status', get: (r: Opportunity) => r.status, min: 12 },
    { title: 'Deadline', get: (r: Opportunity) => r.deadline ?? '—', min: 10 },
    { title: 'Assessment', get: (r: Opportunity) => r.assessment, min: 12 },
  ];
  const natural = cols.map((c) => Math.max(c.title.length, ...records.map((r) => terminalSafe(c.get(r)).length)));
  const gap = 2;
  let widths = natural;
  const total = () => widths.reduce((a, b) => a + b, 0) + gap * (cols.length - 1);
  if (total() > width) {
    widths = natural.map((w, i) => Math.min(w, Math.max(cols[i]!.min, Math.floor((w / natural.reduce((a, b) => a + b, 0)) * (width - gap * cols.length)))));
  }
  const line = (cells: string[]) => cells.map((c, i) => trunc(c, widths[i]!).padEnd(widths[i]!)).join(' '.repeat(gap)).trimEnd();
  return [line(cols.map((c) => c.title)), line(widths.map((w) => '-'.repeat(w))), ...records.map((r) => line(cols.map((c) => terminalSafe(c.get(r)))))].join('\n');
}

export function renderRecord(r: Opportunity, sources: { sources: SourceRecord[]; live: boolean }): string {
  const lines: string[] = [`${terminalSafe(r.program)} — ${terminalSafe(r.company)}`, ''];
  for (const c of COLUMNS) {
    if (c.key === 'program' || c.key === 'company') continue;
    const v = r[c.key];
    const text = Array.isArray(v) ? v.join(', ') : v;
    const shown = text === null || text === '' ? (c.key === 'deadline' ? 'Unknown (blank means no verified exact deadline, not rolling)' : '—') : text;
    lines.push(`${c.header}:`.padEnd(30) + terminalSafe(shown));
  }
  const known = new Map(sources.sources.map((s) => [s.id, s]));
  const refs = r.sourceIds.map((id) => known.get(id)).filter(Boolean);
  if (refs.length) {
    lines.push('', `Sources (${sources.live ? 'live Sources tab' : 'bundled snapshot of the Sources tab; may be out of date'}):`);
    for (const s of refs) lines.push(`  [${s!.id}] ${s!.url}\n      ${terminalSafe(s!.supports)}`);
  }
  const missing = r.sourceIds.filter((id) => !known.has(id));
  if (missing.length) lines.push('', `Source IDs without a matching Sources row: ${missing.join(', ')}`);
  return lines.join('\n');
}
