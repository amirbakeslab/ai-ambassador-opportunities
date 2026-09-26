import { createHash } from 'node:crypto';
import { TOOL_NAME, TOOL_VERSION } from './config.js';
import { todayIso } from './dates.js';
import { FORMATTABLE_FIELDS } from './formatters/openrouter.js';
import { cleanText } from './safety.js';
import { CandidateSchema } from './schema.js';
export function slugify(text, max = 60) {
    return text
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max)
        .replace(/-+$/g, '');
}
function sourceIdFor(url) {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').split('.').slice(0, -1).join('-');
    const path = u.pathname.split('/').filter(Boolean).slice(0, 2).join('-');
    return slugify(`${host}-${path}`) || 'source';
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** True if an ISO date appears in the evidence in a common written form. */
export function dateInEvidence(iso, evidence) {
    const [y, m, d] = iso.split('-').map(Number);
    const text = evidence.toLowerCase();
    const month = MONTHS[m - 1] ?? '';
    const forms = [
        iso,
        `${m}/${d}/${y}`,
        `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`,
        `${d}/${m}/${y}`,
        `${month} ${d}, ${y}`,
        `${month} ${d} ${y}`,
        `${d} ${month} ${y}`,
        `${month.slice(0, 3)} ${d}, ${y}`,
        `${month.slice(0, 3)}. ${d}, ${y}`,
        `${d} ${month.slice(0, 3)} ${y}`,
    ];
    return forms.some((f) => text.includes(f));
}
const STOP = new Set(['with', 'from', 'that', 'this', 'will', 'your', 'have', 'their', 'they', 'more', 'about', 'into', 'also', 'such', 'other', 'than', 'each', 'must', 'been', 'only', 'which', 'when', 'what', 'where']);
function words(text) {
    return (text.toLowerCase().match(/[a-z0-9$€£%]+(?:[-'][a-z0-9]+)*/g) ?? []).filter((w) => w.length >= 4 && !STOP.has(w));
}
/** Share of a value's content words that also occur in the evidence (0..1). */
export function groundingScore(value, evidence) {
    const vw = words(value);
    if (vw.length === 0)
        return 1;
    const ev = new Set(words(evidence));
    const stem = (w) => w.replace(/(ies|es|s|ing|ed)$/, '');
    const evStems = new Set([...ev].map(stem));
    const hits = vw.filter((w) => ev.has(w) || evStems.has(stem(w))).length;
    return hits / vw.length;
}
export const GROUNDING_THRESHOLD = 0.6;
/**
 * Keep only formatter values that are traceable to the evidence. Unsupported
 * values revert to null (unknown) with a warning; nothing is invented.
 */
export function applyFormatterOutput(record, output, evidence) {
    const filled = [];
    const warnings = [];
    for (const field of FORMATTABLE_FIELDS) {
        const raw = output[field];
        if (raw === null || raw.trim() === '')
            continue;
        const value = cleanText(raw).trim();
        if (field === 'deadline') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
                warnings.push(`formatter deadline "${value}" is not YYYY-MM-DD; left unknown`);
                continue;
            }
            if (!dateInEvidence(value, evidence)) {
                warnings.push(`formatter deadline ${value} does not appear in the page text; left unknown`);
                continue;
            }
            record.deadline = value;
            filled.push(field);
            continue;
        }
        const score = groundingScore(value, evidence);
        if (score < GROUNDING_THRESHOLD) {
            warnings.push(`formatter ${field} is not supported by the page text (grounding ${score.toFixed(2)}); left unknown`);
            continue;
        }
        record[field] = value;
        filled.push(field);
    }
    return { filled, warnings };
}
export function buildCandidate(input) {
    const now = input.now ?? new Date();
    const evidence = cleanText(input.page.text);
    const title = input.page.title ? cleanText(input.page.title).trim() : null;
    const sourceId = sourceIdFor(input.page.url);
    const record = {
        id: title ? slugify(title) || null : null,
        company: null,
        program: null,
        category: null,
        description: null,
        url: input.requestedUrl,
        status: null,
        deadline: null,
        deadlineNotes: null,
        programDates: null,
        workload: null,
        ambassadorBenefits: null,
        communityBenefits: null,
        expectations: null,
        eligibility: null,
        geography: null,
        localApplicability: null,
        restrictions: null,
        assessment: null,
        assessmentReason: null,
        sourceIds: [sourceId],
        lastChecked: todayIso(now),
    };
    const warnings = [
        'Status and assessment are unset until a maintainer reviews the sources; new entries default to "Needs verification".',
    ];
    let formatter = null;
    if (input.format) {
        const f = input.format;
        let filled = [];
        const errors = [...f.errors];
        if (f.output) {
            const applied = applyFormatterOutput(record, f.output, evidence);
            filled = applied.filled;
            warnings.push(...applied.warnings);
        }
        else {
            warnings.push(`formatter output failed validation; fields left unknown (${errors.join('; ')})`);
        }
        formatter = { model: f.model, ok: errors.length === 0, filledFields: filled, errors, raw: f.raw };
        if (record.company && record.program) {
            const company = slugify(record.company);
            const program = slugify(record.program);
            record.id = (program.startsWith(`${company}-`) || program === company ? program : slugify(`${record.company} ${record.program}`)) || record.id;
        }
    }
    const candidate = {
        schema: 'ai-ambassador-opportunities/candidate@1',
        createdAt: now.toISOString(),
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        reviewState: formatter && !formatter.ok ? 'needs-review' : 'draft',
        record,
        sources: [
            {
                id: sourceId,
                url: input.page.url,
                title,
                retrievedAt: now.toISOString(),
                fetcher: input.page.fetcher,
                excerpt: evidence.slice(0, 600),
            },
        ],
        evidence: { sha256: createHash('sha256').update(evidence).digest('hex'), chars: evidence.length, text: evidence },
        formatter,
        warnings,
    };
    return CandidateSchema.parse(candidate);
}
