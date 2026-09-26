import { z } from 'zod';
export const STATUSES = [
    'Rolling',
    'Registration available',
    'Interest form available',
    'Future interest only',
    'Closed',
    'Historical',
    'Needs verification',
    'Invitation only',
];
export const ASSESSMENTS = [
    'Worth considering',
    'Needs clarification',
    'Low value',
    'Not a student role',
];
/** Statuses that describe a currently usable intake path. */
export const OPEN_STATUSES = ['Rolling', 'Registration available', 'Interest form available'];
/**
 * Column contract of the published Opportunities tab. Order matches the live
 * Sheet, but readers map columns by header name so reordering is tolerated.
 */
export const COLUMNS = [
    { key: 'company', header: 'Company' },
    { key: 'program', header: 'Program' },
    { key: 'status', header: 'Application status' },
    { key: 'assessment', header: 'Assessment' },
    { key: 'url', header: 'Application / program URL' },
    { key: 'deadline', header: 'Deadline' },
    { key: 'ambassadorBenefits', header: 'Ambassador benefits' },
    { key: 'communityBenefits', header: 'Benefits for students / club' },
    { key: 'expectations', header: 'Expectations' },
    { key: 'workload', header: 'Time commitment' },
    { key: 'programDates', header: 'Program dates / duration' },
    { key: 'eligibility', header: 'Eligibility' },
    { key: 'localApplicability', header: 'Pitt applicability' },
    { key: 'restrictions', header: 'Restrictions / exclusivity' },
    { key: 'assessmentReason', header: 'Assessment reason' },
    { key: 'deadlineNotes', header: 'Deadline / intake notes' },
    { key: 'description', header: 'Description' },
    { key: 'category', header: 'Category' },
    { key: 'geography', header: 'Geography' },
    { key: 'sourceIds', header: 'Source IDs' },
    { key: 'lastChecked', header: 'Last checked' },
    { key: 'id', header: 'Opportunity ID' },
];
export const FIELD_KEYS = COLUMNS.map((c) => c.key);
export const DATE_FIELDS = ['deadline', 'lastChecked'];
export const HEADER_BY_KEY = Object.fromEntries(COLUMNS.map((c) => [c.key, c.header]));
/** Largest string Google Sheets accepts in one cell. */
export const MAX_CELL_CHARS = 50_000;
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = z
    .string()
    .max(MAX_CELL_CHARS)
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), 'contains control characters');
const isoDate = z
    .string()
    .regex(ISO_DATE, 'must be YYYY-MM-DD')
    .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'not a real date');
const httpUrl = z
    .string()
    .max(2048)
    .refine((s) => {
    try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:';
    }
    catch {
        return false;
    }
}, 'must be an http(s) URL');
/** A published catalog record. Empty text means "not stated"; null deadline means unknown, never rolling. */
export const OpportunitySchema = z.object({
    id: z.string().regex(ID_PATTERN, 'must be a lowercase slug such as "acme-campus-ambassadors"'),
    company: text.min(1, 'is required'),
    program: text.min(1, 'is required'),
    category: text,
    description: text,
    url: httpUrl,
    status: z.enum(STATUSES),
    deadline: isoDate.nullable(),
    deadlineNotes: text,
    programDates: text,
    workload: text,
    ambassadorBenefits: text,
    communityBenefits: text,
    expectations: text,
    eligibility: text,
    geography: text,
    localApplicability: text,
    restrictions: text,
    assessment: z.enum(ASSESSMENTS),
    assessmentReason: text,
    sourceIds: z.array(z.string().regex(ID_PATTERN, 'source IDs must be lowercase slugs')),
    lastChecked: isoDate.nullable(),
});
/** Draft record produced by `propose`. Unknown values stay null rather than being guessed. */
export const DraftRecordSchema = z.object({
    id: z.string().regex(ID_PATTERN).nullable(),
    company: text.nullable(),
    program: text.nullable(),
    category: text.nullable(),
    description: text.nullable(),
    url: httpUrl,
    status: z.enum(STATUSES).nullable(),
    deadline: isoDate.nullable(),
    deadlineNotes: text.nullable(),
    programDates: text.nullable(),
    workload: text.nullable(),
    ambassadorBenefits: text.nullable(),
    communityBenefits: text.nullable(),
    expectations: text.nullable(),
    eligibility: text.nullable(),
    geography: text.nullable(),
    localApplicability: text.nullable(),
    restrictions: text.nullable(),
    assessment: z.enum(ASSESSMENTS).nullable(),
    assessmentReason: text.nullable(),
    sourceIds: z.array(z.string().regex(ID_PATTERN)),
    lastChecked: isoDate.nullable(),
});
export const SourceRefSchema = z.object({
    id: z.string().regex(ID_PATTERN),
    url: httpUrl,
    title: z.string().nullable(),
    retrievedAt: z.string(),
    fetcher: z.string(),
    excerpt: z.string(),
});
export const CandidateSchema = z.object({
    schema: z.literal('ai-ambassador-opportunities/candidate@1'),
    createdAt: z.string(),
    tool: z.object({ name: z.string(), version: z.string() }),
    reviewState: z.enum(['draft', 'needs-review']),
    record: DraftRecordSchema,
    sources: z.array(SourceRefSchema),
    evidence: z.object({ sha256: z.string(), chars: z.number(), text: z.string() }),
    formatter: z
        .object({
        model: z.string(),
        ok: z.boolean(),
        filledFields: z.array(z.string()),
        errors: z.array(z.string()),
        raw: z.string().nullable(),
    })
        .nullable(),
    warnings: z.array(z.string()),
});
export function formatZodIssues(error) {
    return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'} ${i.message}`);
}
