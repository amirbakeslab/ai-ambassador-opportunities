import { describe, expect, it } from 'vitest';
import { MissingKeyError, NetworkError, ProviderError, QuotaError, RateLimitError, RequestCapError } from '../src/errors.js';
import { parseRetryAfter, request, RequestBudget } from '../src/http.js';
import { exa } from '../src/providers/exa.js';
import { firecrawl } from '../src/providers/firecrawl.js';
import { getProvider, providerKey } from '../src/providers/index.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (Response | Error)[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noSleep = async () => undefined;
const ctx = (fetchImpl: typeof fetch, cap = 5) => ({ apiKey: 'test-key', budget: new RequestBudget(cap), fetchImpl, sleep: noSleep });

describe('http client', () => {
  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const slept: number[] = [];
    const { fetchImpl, calls } = fakeFetch([json(429, {}, { 'retry-after': '2' }), json(200, { ok: true })]);
    const res = await request('https://x.example', { provider: 'X', fetchImpl, sleep: async (ms) => void slept.push(ms) });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
  });

  it('fails fast with RateLimitError when Retry-After is too long or retries run out', async () => {
    await expect(request('https://x.example', { provider: 'X', fetchImpl: fakeFetch([json(429, {}, { 'retry-after': '3600' })]).fetchImpl, sleep: noSleep })).rejects.toThrow(
      RateLimitError,
    );
    const many = fakeFetch([json(429, {}), json(429, {}), json(429, {})]);
    await expect(request('https://x.example', { provider: 'X', fetchImpl: many.fetchImpl, sleep: noSleep })).rejects.toThrow(RateLimitError);
    expect(many.calls).toHaveLength(3);
  });

  it('wraps network failures after bounded retries', async () => {
    const f = fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);
    await expect(request('https://x.example', { provider: 'X', fetchImpl: f.fetchImpl, retries: 1, sleep: noSleep })).rejects.toThrow(NetworkError);
  });

  it('enforces the per-command request cap, including retries', async () => {
    const budget = new RequestBudget(1);
    const f = fakeFetch([json(503, {}), json(200, {})]);
    await expect(request('https://x.example', { provider: 'X', fetchImpl: f.fetchImpl, budget, sleep: noSleep })).rejects.toThrow(RequestCapError);
  });

  it('bounds response bodies while streaming', async () => {
    const big = new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(64 * 1024)) }), { status: 200 });
    await expect(request('https://x.example', { provider: 'X', fetchImpl: fakeFetch([big]).fetchImpl, maxBytes: 100_000 })).rejects.toThrow(/exceeded 100000 bytes/);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThanOrEqual(8);
  });
});

describe('provider selection and keys', () => {
  it('defaults to Exa and rejects unknown providers', () => {
    expect(getProvider(undefined).name).toBe('exa');
    expect(getProvider('Firecrawl').name).toBe('firecrawl');
    expect(() => getProvider('bing')).toThrow(/Unknown provider/);
  });
  it('explains missing keys without needing them for browsing', () => {
    expect(() => providerKey(exa)).toThrow(MissingKeyError);
    expect(() => providerKey(firecrawl)).toThrow(/FIRECRAWL_API_KEY is not set/);
  });
});

describe('Exa', () => {
  it('sends the documented search request and maps results', async () => {
    const { fetchImpl, calls } = fakeFetch([
      json(200, { requestId: 'r', results: [{ url: 'https://a.example/p', title: 'A', publishedDate: '2026-09-01T00:00:00Z', highlights: ['Apply now', 'Stipend'] }] }),
    ]);
    const results = await exa.search('student ambassador', 3, ctx(fetchImpl));
    expect(calls[0]!.url).toBe('https://api.exa.ai/search');
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: 'student ambassador', numResults: 3, type: 'auto', contents: { highlights: true } });
    expect(results).toEqual([{ title: 'A', url: 'https://a.example/p', publishedDate: '2026-09-01T00:00:00Z', snippet: 'Apply now … Stipend' }]);
  });

  it('maps out-of-credit and budget errors to QuotaError without retrying', async () => {
    const f = fakeFetch([json(402, { requestId: 'r', error: 'No more credits', tag: 'NO_MORE_CREDITS' })]);
    await expect(exa.search('q', 3, ctx(f.fetchImpl))).rejects.toThrow(QuotaError);
    expect(f.calls).toHaveLength(1);
    await expect(exa.search('q', 3, ctx(fakeFetch([json(400, { requestId: 'r', error: 'budget', tag: 'API_KEY_BUDGET_EXCEEDED' })]).fetchImpl))).rejects.toThrow(QuotaError);
  });

  it('reports bad keys, malformed JSON and schema drift clearly', async () => {
    await expect(exa.search('q', 3, ctx(fakeFetch([json(401, { requestId: 'r', error: 'Invalid API key', tag: 'INVALID_API_KEY' })]).fetchImpl))).rejects.toThrow(/rejected/);
    await expect(exa.search('q', 3, ctx(fakeFetch([new Response('<html>oops</html>', { status: 200 })]).fetchImpl))).rejects.toThrow(/non-JSON/);
    await expect(exa.search('q', 3, ctx(fakeFetch([json(200, { results: [{ title: 'no url' }] })]).fetchImpl))).rejects.toThrow(ProviderError);
  });

  it('surfaces per-URL content failures', async () => {
    const f = fakeFetch([json(200, { results: [], statuses: [{ id: 'https://a.example', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } }] })]);
    await expect(exa.content('https://a.example', ctx(f.fetchImpl))).rejects.toThrow(/CRAWL_NOT_FOUND, HTTP 404/);
    const ok = fakeFetch([json(200, { results: [{ url: 'https://a.example', title: 'T', text: 'Body text' }], statuses: [{ id: 'https://a.example', status: 'success' }] })]);
    const page = await exa.content('https://a.example', ctx(ok.fetchImpl));
    expect(page).toEqual({ url: 'https://a.example', title: 'T', text: 'Body text', fetcher: 'exa' });
    expect(JSON.parse(String(ok.calls[0]!.init.body))).toEqual({ urls: ['https://a.example'], text: { maxCharacters: 20000 } });
  });
});

describe('Firecrawl', () => {
  it('uses v2 search with bearer auth and maps web results', async () => {
    const { fetchImpl, calls } = fakeFetch([json(200, { success: true, data: { web: [{ url: 'https://b.example', title: 'B', description: 'desc' }] }, creditsUsed: 2 })]);
    const results = await firecrawl.search('campus', 2, ctx(fetchImpl));
    expect(calls[0]!.url).toBe('https://api.firecrawl.dev/v2/search');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(results[0]).toEqual({ title: 'B', url: 'https://b.example', publishedDate: null, snippet: 'desc' });
  });

  it('maps 402 to QuotaError and success:false or missing data to ProviderError', async () => {
    await expect(firecrawl.search('q', 2, ctx(fakeFetch([json(402, { success: false, error: 'Insufficient credits' })]).fetchImpl))).rejects.toThrow(QuotaError);
    await expect(firecrawl.search('q', 2, ctx(fakeFetch([json(200, { success: false, data: {} })]).fetchImpl))).rejects.toThrow(ProviderError);
    await expect(firecrawl.content('https://b.example', ctx(fakeFetch([json(200, { success: true, data: { metadata: { statusCode: 404 } } })]).fetchImpl))).rejects.toThrow(/HTTP 404/);
  });

  it('scrapes markdown for evidence', async () => {
    const f = fakeFetch([json(200, { success: true, data: { markdown: '# Program\nDetails', metadata: { title: 'Program', sourceURL: 'https://b.example/p', statusCode: 200 } } })]);
    const page = await firecrawl.content('https://b.example/p', ctx(f.fetchImpl));
    expect(page).toEqual({ url: 'https://b.example/p', title: 'Program', text: '# Program\nDetails', fetcher: 'firecrawl' });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ url: 'https://b.example/p', formats: ['markdown'], onlyMainContent: true });
  });
});
