import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { ProviderError, UsageError } from '../errors.js';
import { USER_AGENT } from '../http.js';
import { checkUrlShape, isPrivateAddress } from '../safety.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { clip, MAX_EVIDENCE_CHARS } from './types.js';
const MAX_REDIRECTS = 5;
/** Upper bound on decoded page bytes read from an untrusted site. */
const MAX_PAGE_BYTES = 3_000_000;
const TIMEOUT_MS = 20_000;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}
/** Rough HTML to text for evidence. Scripts, styles and markup are dropped; nothing is executed. */
export function htmlToText(html) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const body = html
        .replace(/<(script|style|noscript|svg|template|title|head)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<[^>]+>/g, ' ');
    const text = decodeEntities(body)
        .split('\n')
        .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
    return { title: titleMatch?.[1] ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null : null, text };
}
const defaultResolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
/**
 * A lookup function for http(s).request that resolves once, rejects the
 * connection if any answer is non-public, and hands the socket the vetted
 * address. The connection therefore uses exactly the address that was
 * checked, so a second DNS answer (rebinding) cannot redirect it. TLS still
 * verifies the certificate against the URL hostname.
 */
function pinnedLookup(resolve, isBlocked) {
    return ((hostname, options, callback) => {
        resolve(hostname).then((addresses) => {
            if (addresses.length === 0)
                return callback(Object.assign(new Error(`no addresses for ${hostname}`), { code: 'ENOTFOUND' }));
            const bad = addresses.find(isBlocked);
            if (bad)
                return callback(Object.assign(new Error(`${hostname} resolves to non-public address ${bad}`), { code: 'EPRIVATE' }));
            const address = addresses[0];
            const family = isIP(address);
            if (options?.all)
                callback(null, [{ address, family }]);
            else
                callback(null, address, family);
        }, (err) => callback(err));
    });
}
function decoder(encoding) {
    switch ((encoding ?? '').trim().toLowerCase()) {
        case 'gzip':
        case 'x-gzip':
            return createGunzip();
        case 'deflate':
            return createInflate();
        case 'br':
            return createBrotliDecompress();
        default:
            return null;
    }
}
/** One GET with a pinned, validated address and a streaming byte cap (applied after decompression). */
function pinnedGet(url, lookup, maxBytes, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
            method: 'GET',
            lookup,
            headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'accept-encoding': 'gzip, deflate, br' },
            timeout: timeoutMs,
        }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
                res.resume();
                return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
            }
            const declared = Number(res.headers['content-length']);
            if (Number.isFinite(declared) && declared > maxBytes) {
                req.destroy();
                return reject(new ProviderError('page fetch', `page is larger than ${maxBytes} bytes (Content-Length ${declared}); not used as evidence`));
            }
            const decode = decoder(res.headers['content-encoding']);
            const stream = decode ? res.pipe(decode) : res;
            const chunks = [];
            let size = 0;
            stream.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    req.destroy();
                    stream.destroy();
                    reject(new ProviderError('page fetch', `page exceeded ${maxBytes} bytes while downloading; stopped reading`));
                    return;
                }
                chunks.push(chunk);
            });
            stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
            stream.on('error', (e) => reject(new ProviderError('page fetch', `could not read page body: ${e.message}`)));
        });
        req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
        req.on('error', (e) => {
            if (e.code === 'EPRIVATE')
                reject(new UsageError(`Refusing to research ${url.hostname}: ${e.message}.`));
            else
                reject(new ProviderError('page fetch', `${url.hostname}: ${e.message}`));
        });
        req.end();
    });
}
/**
 * Keyless page fetch. Every hop (including redirects) is validated, the
 * socket is pinned to the validated address, and the body is capped while
 * streaming.
 */
export async function directContent(url, opts) {
    const resolve = opts.resolve ?? defaultResolver;
    const isBlocked = opts.isBlocked ?? isPrivateAddress;
    const maxBytes = opts.maxBytes ?? MAX_PAGE_BYTES;
    const lookup = pinnedLookup(resolve, isBlocked);
    let current = checkUrlShape(url, isBlocked);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (hop > 0)
            checkUrlShape(current.toString(), isBlocked);
        opts.budget.take();
        const res = await pinnedGet(current, lookup, maxBytes, TIMEOUT_MS);
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.location;
            if (!loc)
                throw new ProviderError('page fetch', `redirect without location from ${current}`);
            current = new URL(loc, current);
            continue;
        }
        if (res.status !== 200)
            throw new ProviderError('page fetch', `HTTP ${res.status} from ${current}`);
        const type = String(res.headers['content-type'] ?? '');
        if (!/html|text\/plain|xml/i.test(type))
            throw new ProviderError('page fetch', `unsupported content type "${type}"; try --provider exa or firecrawl`);
        const raw = res.body.toString('utf8');
        const { title, text } = /html|xml/i.test(type) ? htmlToText(raw) : { title: null, text: raw };
        if (!text.trim())
            throw new ProviderError('page fetch', 'page has no readable text (it may need JavaScript); try --provider exa or firecrawl');
        return { url: current.toString(), title, text: clip(text, MAX_EVIDENCE_CHARS), fetcher: 'direct' };
    }
    throw new ProviderError('page fetch', `more than ${MAX_REDIRECTS} redirects`);
}
