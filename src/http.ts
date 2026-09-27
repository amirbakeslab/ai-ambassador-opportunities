import { NetworkError, ProviderError, RateLimitError, RequestCapError } from './errors.js';

export const USER_AGENT = 'ai-ambassador-opportunities-cli (+https://github.com/amirbakeslab/ai-ambassador-opportunities)';

/** Counts outbound provider requests for one command so a loop can never run up a bill. */
export class RequestBudget {
  private used = 0;
  constructor(readonly cap: number) {}
  take(): void {
    if (this.used >= this.cap) throw new RequestCapError(this.cap);
    this.used += 1;
  }
  get count(): number {
    return this.used;
  }
}

interface RequestOptions {
  provider: string;
  headers?: Record<string, string>;
  /** JSON-encoded request body. */
  body?: unknown;
  /** Pre-encoded body; set content-type in headers. */
  rawBody?: string;
  timeoutMs?: number;
  /** Retries after 429/5xx/network failures. Bounded; default 2. */
  retries?: number;
  /** Longest Retry-After we are willing to sleep; longer waits fail fast. */
  maxRetryAfterSeconds?: number;
  budget?: RequestBudget;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** HTTP statuses that are retried. Default 429, 502, 503, 504. */
  retryStatuses?: number[];
  /** Retry after connection failures (default true). Disable for non-idempotent writes. */
  retryNetworkErrors?: boolean;
  /** Response bodies larger than this are rejected while streaming. Default 10 MB. */
  maxBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 10_000_000;

/** Read a response body as text, aborting once more than maxBytes have arrived. */
async function readBounded(res: Response, maxBytes: number, provider: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError(provider, `response is larger than ${maxBytes} bytes (Content-Length ${declared})`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (e) {
      throw new ProviderError(provider, `could not read response body: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError(provider, `response exceeded ${maxBytes} bytes; stopped reading`);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

export interface HttpResult {
  status: number;
  text: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(value);
  if (!Number.isNaN(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return null;
}

/**
 * fetch with a timeout, a per-command request budget and bounded retries that
 * honour Retry-After. 402 and other 4xx responses are returned to the caller
 * unretried so provider modules can map quota/auth errors precisely.
 */
export async function request(url: string, opts: RequestOptions): Promise<HttpResult> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 2;
  const maxWait = opts.maxRetryAfterSeconds ?? 30;
  let attempt = 0;
  for (;;) {
    opts.budget?.take();
    let res: Response;
    try {
      const hasJson = opts.body !== undefined;
      res = await f(url, {
        method: hasJson || opts.rawBody !== undefined ? 'POST' : 'GET',
        headers: {
          'user-agent': USER_AGENT,
          ...(hasJson ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: hasJson ? JSON.stringify(opts.body) : opts.rawBody,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (attempt < retries && opts.retryNetworkErrors !== false) {
        attempt += 1;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new NetworkError(`contacting ${opts.provider}`, err);
    }
    const retryable = (opts.retryStatuses ?? [429, 502, 503, 504]).includes(res.status);
    if (retryable) {
      const after = parseRetryAfter(res.headers.get('retry-after'));
      if (attempt < retries && (after === null || after <= maxWait)) {
        attempt += 1;
        await res.body?.cancel().catch(() => undefined);
        await sleep(after !== null ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        throw new RateLimitError(opts.provider, after);
      }
    }
    return { status: res.status, text: await readBounded(res, opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES, opts.provider) };
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
