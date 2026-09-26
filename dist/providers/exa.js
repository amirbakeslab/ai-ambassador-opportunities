import { z } from 'zod';
import { ProviderError, QuotaError } from '../errors.js';
import { parseJson, request } from '../http.js';
import { clip, MAX_EVIDENCE_CHARS, MAX_SNIPPET_CHARS } from './types.js';
// https://exa.ai/docs/reference/search and /reference/get-contents (OpenAPI "Exa Public API" 2.0.0)
const BASE = 'https://api.exa.ai';
const ResultSchema = z.object({
    url: z.string(),
    title: z.string().nullish(),
    publishedDate: z.string().nullish(),
    text: z.string().nullish(),
    highlights: z.array(z.string()).nullish(),
});
const SearchResponse = z.object({ results: z.array(ResultSchema) });
const ContentsResponse = z.object({
    results: z.array(ResultSchema),
    statuses: z
        .array(z.object({ id: z.string(), status: z.string(), error: z.object({ tag: z.string().nullish(), httpStatusCode: z.number().nullish() }).nullish() }))
        .nullish(),
});
const ErrorEnvelope = z.object({ error: z.string().optional(), tag: z.string().optional() });
const QUOTA_TAGS = new Set(['NO_MORE_CREDITS', 'API_KEY_BUDGET_EXCEEDED', 'TEAM_BUDGET_EXCEEDED']);
function check(res) {
    const body = parseJson(res.text);
    if (res.status === 200) {
        if (body === undefined)
            throw new ProviderError('Exa', 'returned a non-JSON response');
        return body;
    }
    const env = ErrorEnvelope.safeParse(body);
    const tag = env.success ? env.data.tag : undefined;
    const msg = env.success && env.data.error ? env.data.error : `HTTP ${res.status}`;
    if (res.status === 402 || (tag && QUOTA_TAGS.has(tag)))
        throw new QuotaError('Exa', tag ?? msg);
    if (res.status === 401 || tag === 'INVALID_API_KEY')
        throw new ProviderError('Exa', 'API key was rejected (401). Check EXA_API_KEY.', 401);
    throw new ProviderError('Exa', `${msg}${tag ? ` [${tag}]` : ''}`, res.status);
}
function headers(ctx) {
    return { 'x-api-key': ctx.apiKey };
}
export const exa = {
    name: 'exa',
    envVar: 'EXA_API_KEY',
    async search(query, limit, ctx) {
        const res = await request(`${BASE}/search`, {
            provider: 'Exa',
            headers: headers(ctx),
            body: { query, numResults: limit, type: 'auto', contents: { highlights: true } },
            budget: ctx.budget,
            fetchImpl: ctx.fetchImpl,
            sleep: ctx.sleep,
        });
        const parsed = SearchResponse.safeParse(check(res));
        if (!parsed.success)
            throw new ProviderError('Exa', 'search response did not match the documented schema');
        return parsed.data.results.slice(0, limit).map((r) => ({
            title: r.title ?? null,
            url: r.url,
            publishedDate: r.publishedDate ?? null,
            snippet: clip((r.highlights ?? []).join(' … ') || r.text || '', MAX_SNIPPET_CHARS),
        }));
    },
    async content(url, ctx) {
        const res = await request(`${BASE}/contents`, {
            provider: 'Exa',
            headers: headers(ctx),
            body: { urls: [url], text: { maxCharacters: MAX_EVIDENCE_CHARS } },
            budget: ctx.budget,
            fetchImpl: ctx.fetchImpl,
            sleep: ctx.sleep,
        });
        const parsed = ContentsResponse.safeParse(check(res));
        if (!parsed.success)
            throw new ProviderError('Exa', 'contents response did not match the documented schema');
        const status = parsed.data.statuses?.[0];
        if (status && status.status !== 'success') {
            throw new ProviderError('Exa', `could not retrieve page (${status.error?.tag ?? 'error'}${status.error?.httpStatusCode ? `, HTTP ${status.error.httpStatusCode}` : ''})`);
        }
        const first = parsed.data.results[0];
        if (!first?.text)
            throw new ProviderError('Exa', 'no page text returned');
        return { url: first.url || url, title: first.title ?? null, text: clip(first.text, MAX_EVIDENCE_CHARS), fetcher: 'exa' };
    },
};
