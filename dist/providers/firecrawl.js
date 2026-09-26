import { z } from 'zod';
import { ProviderError, QuotaError } from '../errors.js';
import { parseJson, request } from '../http.js';
import { clip, MAX_EVIDENCE_CHARS, MAX_SNIPPET_CHARS } from './types.js';
// https://docs.firecrawl.dev/api-reference/endpoint/search and /scrape (API v2)
const BASE = 'https://api.firecrawl.dev/v2';
const SearchResponse = z.object({
    success: z.boolean(),
    data: z.object({
        web: z.array(z.object({ url: z.string(), title: z.string().nullish(), description: z.string().nullish() })).nullish(),
    }),
    warning: z.string().nullish(),
});
const ScrapeResponse = z.object({
    success: z.boolean(),
    data: z.object({
        markdown: z.string().nullish(),
        metadata: z.object({ title: z.string().nullish(), sourceURL: z.string().nullish(), statusCode: z.number().nullish() }).passthrough().nullish(),
    }),
});
const ErrorEnvelope = z.object({ error: z.string().optional(), code: z.string().optional() });
function check(res) {
    const body = parseJson(res.text);
    if (res.status === 200) {
        if (body === undefined)
            throw new ProviderError('Firecrawl', 'returned a non-JSON response');
        return body;
    }
    const env = ErrorEnvelope.safeParse(body);
    const msg = env.success && env.data.error ? env.data.error : `HTTP ${res.status}`;
    if (res.status === 402)
        throw new QuotaError('Firecrawl', msg);
    if (res.status === 401)
        throw new ProviderError('Firecrawl', 'API key was rejected (401). Check FIRECRAWL_API_KEY.', 401);
    if (res.status === 408)
        throw new ProviderError('Firecrawl', 'request timed out (408)', 408);
    throw new ProviderError('Firecrawl', msg, res.status);
}
function headers(ctx) {
    return { authorization: `Bearer ${ctx.apiKey}` };
}
export const firecrawl = {
    name: 'firecrawl',
    envVar: 'FIRECRAWL_API_KEY',
    async search(query, limit, ctx) {
        const res = await request(`${BASE}/search`, {
            provider: 'Firecrawl',
            headers: headers(ctx),
            body: { query, limit, sources: [{ type: 'web' }] },
            budget: ctx.budget,
            fetchImpl: ctx.fetchImpl,
            sleep: ctx.sleep,
            timeoutMs: 60_000,
        });
        const parsed = SearchResponse.safeParse(check(res));
        if (!parsed.success || !parsed.data.success)
            throw new ProviderError('Firecrawl', 'search response did not match the documented schema');
        return (parsed.data.data.web ?? []).slice(0, limit).map((r) => ({
            title: r.title ?? null,
            url: r.url,
            publishedDate: null,
            snippet: clip(r.description ?? '', MAX_SNIPPET_CHARS),
        }));
    },
    async content(url, ctx) {
        const res = await request(`${BASE}/scrape`, {
            provider: 'Firecrawl',
            headers: headers(ctx),
            body: { url, formats: ['markdown'], onlyMainContent: true },
            budget: ctx.budget,
            fetchImpl: ctx.fetchImpl,
            sleep: ctx.sleep,
            timeoutMs: 90_000,
        });
        const parsed = ScrapeResponse.safeParse(check(res));
        if (!parsed.success || !parsed.data.success)
            throw new ProviderError('Firecrawl', 'scrape response did not match the documented schema');
        const status = parsed.data.data.metadata?.statusCode;
        if (status && status >= 400)
            throw new ProviderError('Firecrawl', `page returned HTTP ${status}`);
        const markdown = parsed.data.data.markdown;
        if (!markdown)
            throw new ProviderError('Firecrawl', 'no page content returned');
        return {
            url: parsed.data.data.metadata?.sourceURL ?? url,
            title: parsed.data.data.metadata?.title ?? null,
            text: clip(markdown, MAX_EVIDENCE_CHARS),
            fetcher: 'firecrawl',
        };
    },
};
