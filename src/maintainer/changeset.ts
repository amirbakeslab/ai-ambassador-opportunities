import { z } from 'zod';
import { TOOL_VERSION } from '../config.js';
import { fieldToText } from '../records.js';
import {
  CandidateSchema,
  FIELD_KEYS,
  formatZodIssues,
  HEADER_BY_KEY,
  ID_PATTERN,
  OpportunitySchema,
  type Candidate,
  type FieldKey,
  type Opportunity,
} from '../schema.js';

/** A reviewed source row destined for the Sources tab. */
const SourceRowSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  url: z.string().url(),
  supports: z.string().max(2000),
  lastChecked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type SourceRow = z.infer<typeof SourceRowSchema>;

const FieldKeySchema = z.enum(FIELD_KEYS as [FieldKey, ...FieldKey[]]);

const ChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), id: z.string().regex(ID_PATTERN), record: OpportunitySchema }),
  z.object({
    action: z.literal('update'),
    id: z.string().regex(ID_PATTERN),
    /** Text form of each changed field: `from` is the reviewed value, `to` the desired value. */
    fields: z.partialRecord(FieldKeySchema, z.object({ from: z.string(), to: z.string() })),
  }),
]);
export type Change = z.infer<typeof ChangeSchema>;

export const ChangesetSchema = z.object({
  schema: z.literal('ai-ambassador-opportunities/changeset@1'),
  createdAt: z.string(),
  toolVersion: z.string(),
  reviewedAgainst: z.object({ kind: z.string(), fetchedAt: z.string(), url: z.string() }),
  changes: z.array(ChangeSchema),
  sources: z.array(SourceRowSchema),
});
export type Changeset = z.infer<typeof ChangesetSchema>;

interface ReviewedCandidate {
  file: string;
  id: string | null;
  ok: boolean;
  problems: string[];
  change?: Change;
  diff: string[];
}

/** Convert a draft (nulls = unknown) to a full record for validation. Unknown text becomes blank. */
function draftToRecord(c: Candidate): { record?: Opportunity; problems: string[] } {
  const r = c.record;
  const problems: string[] = [];
  if (!r.assessment) problems.push('record.assessment must be set by the reviewer (one of the assessment options)');
  if (!r.company) problems.push('record.company is required');
  if (!r.program) problems.push('record.program is required');
  if (!r.id) problems.push('record.id is required (lowercase slug)');
  const draft = Object.fromEntries(
    FIELD_KEYS.map((k) => {
      const v = r[k];
      if (k === 'status') return [k, v ?? 'Needs verification'];
      if (k === 'deadline' || k === 'lastChecked') return [k, v ?? null];
      if (k === 'sourceIds') return [k, v];
      return [k, v ?? ''];
    }),
  );
  const parsed = OpportunitySchema.safeParse(draft);
  if (!parsed.success) problems.push(...formatZodIssues(parsed.error).map((p) => `record.${p}`));
  const known = new Set(c.sources.map((s) => s.id));
  for (const sid of r.sourceIds) if (!known.has(sid)) problems.push(`record.sourceIds references "${sid}" which is not in the candidate's sources`);
  return problems.length || !parsed.success ? { problems } : { record: parsed.data, problems };
}

/**
 * Compare a candidate with the current catalog. New IDs become additions; for
 * existing IDs only fields the candidate actually states (non-null) are
 * proposed, so unknowns never overwrite published values.
 */
export function reviewCandidate(file: string, raw: unknown, current: Map<string, Opportunity>): ReviewedCandidate {
  const parsed = CandidateSchema.safeParse(raw);
  if (!parsed.success) return { file, id: null, ok: false, problems: formatZodIssues(parsed.error), diff: [] };
  const c = parsed.data;
  const id = c.record.id;
  const existing = id ? current.get(id) : undefined;
  if (existing) {
    const fields: Record<string, { from: string; to: string }> = {};
    const diff: string[] = [];
    const merged: Record<string, unknown> = { ...existing };
    for (const k of FIELD_KEYS) {
      let v = c.record[k];
      if (v === null || k === 'id') continue;
      // Source lists are merged so existing citations are never dropped.
      if (k === 'sourceIds') v = [...new Set([...existing.sourceIds, ...c.record.sourceIds])];
      merged[k] = v;
      const from = fieldToText(existing, k);
      const to = Array.isArray(v) ? v.join(', ') : String(v);
      if (from !== to) {
        fields[k] = { from, to };
        diff.push(`  ~ ${HEADER_BY_KEY[k]}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
      }
    }
    const check = OpportunitySchema.safeParse(merged);
    if (!check.success) return { file, id, ok: false, problems: formatZodIssues(check.error), diff };
    if (Object.keys(fields).length === 0) return { file, id, ok: true, problems: [], diff: ['  (no changes; already matches the catalog)'] };
    return { file, id, ok: true, problems: [], change: { action: 'update', id: id!, fields }, diff };
  }
  const { record, problems } = draftToRecord(c);
  if (!record) return { file, id, ok: false, problems, diff: [] };
  const diff = FIELD_KEYS.map((k) => fieldToText(record, k))
    .map((v, i) => [FIELD_KEYS[i]!, v] as const)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `  + ${HEADER_BY_KEY[k]}: ${JSON.stringify(v)}`);
  return { file, id: record.id, ok: true, problems: [], change: { action: 'add', id: record.id, record }, diff };
}

export function sourcesFromCandidates(cands: Candidate[], ids: Set<string>): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  for (const c of cands) {
    for (const s of c.sources) {
      if (!ids.has(s.id)) continue;
      rows.set(s.id, { id: s.id, url: s.url, supports: s.title ? `Page: ${s.title}` : 'Proposed source; describe what it supports', lastChecked: s.retrievedAt.slice(0, 10) });
    }
  }
  return [...rows.values()];
}

export function newChangeset(reviewedAgainst: Changeset['reviewedAgainst'], changes: Change[], sources: SourceRow[], now = new Date()): Changeset {
  return ChangesetSchema.parse({
    schema: 'ai-ambassador-opportunities/changeset@1',
    createdAt: now.toISOString(),
    toolVersion: TOOL_VERSION,
    reviewedAgainst,
    changes,
    sources,
  });
}
