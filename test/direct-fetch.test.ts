import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestBudget } from '../src/http.js';
import { directContent, htmlToText } from '../src/providers/direct.js';
import { assertPublicUrl, checkUrlShape, isPrivateAddress } from '../src/safety.js';
import { ProviderError, UsageError } from '../src/errors.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

type Route = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;

async function serve(route: Route): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  server = createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`);
    route(req, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, hits };
}

// The test server listens on loopback, so tests use a policy in which only the
// exact loopback address 127.0.0.1 counts as "public"; everything else keeps
// the real private-address rules.
const testPolicy = (a: string) => a !== '127.0.0.1' && isPrivateAddress(a);
const budget = () => new RequestBudget(10);

describe('private address detection', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // WHATWG URL normalises ::ffff:127.0.0.1 to this hexadecimal form
    '::ffff:a00:1', // ::ffff:10.0.0.1
    '::ffff:a9fe:a9fe', // ::ffff:169.254.169.254
    '::7f00:1', // deprecated IPv4-compatible loopback
    '64:ff9b::7f00:1', // NAT64 embedding of 127.0.0.1
    '2002:7f00:1::1', // 6to4 embedding of 127.0.0.1
    '2002:c0a8:101::1', // 6to4 embedding of 192.168.1.1
  ])('treats %s as private', (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1'])('treats %s as public', (a) =>
    expect(isPrivateAddress(a)).toBe(false),
  );

  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:10.0.0.1]:8080/x',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.1/', // hex + short form
    'http://017700000001/', // octal
    'http://127.1/',
    'http://[64:ff9b::7f00:1]/',
    'http://localhost:3000/',
    'http://metadata.internal/',
    'http://intranet/',
    'file:///etc/passwd',
    'https://user:pass@example.com/',
  ])('rejects %s before any request', (url) => {
    expect(() => checkUrlShape(url)).toThrow(UsageError);
  });

  it('rejects hostnames that resolve to private addresses, including mapped IPv6', async () => {
    await expect(assertPublicUrl('https://sneaky.example/', async () => ['::ffff:7f00:1'])).rejects.toThrow(UsageError);
    await expect(assertPublicUrl('https://mixed.example/', async () => ['93.184.216.34', '10.0.0.5'])).rejects.toThrow(UsageError);
    await expect(assertPublicUrl('https://ok.example/', async () => ['93.184.216.34'])).resolves.toBeInstanceOf(URL);
  });
});

describe('direct page fetch', () => {
  it('connects to the vetted address from a single lookup (no second DNS resolution)', async () => {
    const { port, hits } = await serve((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Campus Program</title></head><body><p>Apply by October 1, 2026.</p></body></html>');
    });
    const answers = ['127.0.0.1', '10.0.0.9']; // a rebinding resolver: public-looking first, private second
    const calls: string[] = [];
    const resolve = async (host: string) => {
      calls.push(host);
      return [answers[calls.length - 1] ?? '10.0.0.9'];
    };
    const page = await directContent(`http://research.example:${port}/page`, { budget: budget(), resolve, isBlocked: testPolicy });
    expect(page.title).toBe('Campus Program');
    expect(page.text).toContain('Apply by October 1, 2026.');
    expect(calls).toEqual(['research.example']);
    // The request reached the vetted 127.0.0.1 server while keeping the original Host header.
    expect(hits).toEqual([`research.example:${port} /page`]);
  });

  it('refuses when the resolution used for the connection is private, and sends nothing', async () => {
    const { port, hits } = await serve((_q, res) => res.end('should not be reached'));
    const resolve = async () => ['::ffff:7f00:1'];
    await expect(directContent(`http://rebind.example:${port}/`, { budget: budget(), resolve, isBlocked: testPolicy })).rejects.toThrow(/non-public address/);
    expect(hits).toEqual([]);
  });

  it('re-validates every redirect hop, including mapped-IPv6 literals', async () => {
    const { port, hits } = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: 'http://[::ffff:7f00:1]:9/admin' });
        res.end();
      } else res.end('no');
    });
    const resolve = async () => ['127.0.0.1'];
    await expect(directContent(`http://redirect.example:${port}/start`, { budget: budget(), resolve, isBlocked: testPolicy })).rejects.toThrow(UsageError);
    expect(hits).toEqual([`redirect.example:${port} /start`]);
  });

  it('re-validates redirects to hostnames that resolve privately', async () => {
    const { port } = await serve((req, res) => {
      res.writeHead(301, { location: `http://evil.example:${(server!.address() as AddressInfo).port}/x` });
      res.end();
    });
    const resolve = async (host: string) => (host === 'evil.example' ? ['192.168.0.10'] : ['127.0.0.1']);
    await expect(directContent(`http://start.example:${port}/`, { budget: budget(), resolve, isBlocked: testPolicy })).rejects.toThrow(/non-public/);
  });

  it('stops reading an oversized body while streaming (no Content-Length)', async () => {
    let sent = 0;
    const { port } = await serve((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = Buffer.alloc(64 * 1024, 'a');
      const pump = () => {
        while (sent < 50 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      res.on('close', () => (sent = Number.POSITIVE_INFINITY));
      pump();
    });
    const err = await directContent(`http://big.example:${port}/`, { budget: budget(), resolve: async () => ['127.0.0.1'], isBlocked: testPolicy, maxBytes: 200_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String((err as Error).message)).toMatch(/exceeded 200000 bytes/);
  });

  it('rejects a declared Content-Length over the cap without reading it', async () => {
    const { port } = await serve((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(10_000_000) });
      res.end();
    });
    await expect(
      directContent(`http://declared.example:${port}/`, { budget: budget(), resolve: async () => ['127.0.0.1'], isBlocked: testPolicy, maxBytes: 1000 }),
    ).rejects.toThrow(/larger than 1000 bytes/);
  });

  it('bounds decompressed size too (gzip bomb)', async () => {
    const bomb = gzipSync(Buffer.alloc(5_000_000, 'a'));
    const { port } = await serve((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': String(bomb.length) });
      res.end(bomb);
    });
    await expect(
      directContent(`http://gz.example:${port}/`, { budget: budget(), resolve: async () => ['127.0.0.1'], isBlocked: testPolicy, maxBytes: 100_000 }),
    ).rejects.toThrow(/exceeded 100000 bytes/);
  });

  it('uses the real policy by default, so loopback is refused', async () => {
    const { port, hits } = await serve((_q, res) => res.end('x'));
    await expect(directContent(`http://looks-public.example:${port}/`, { budget: budget(), resolve: async () => ['127.0.0.1'] })).rejects.toThrow(UsageError);
    expect(hits).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('drops scripts and styles and decodes entities', () => {
    const r = htmlToText('<title>A &amp; B</title><style>x{}</style><script>alert(1)</script><p>Hello&nbsp;world &#8211; ok</p><li>One</li>');
    expect(r.title).toBe('A & B');
    expect(r.text).toBe('Hello world – ok\n- One');
  });
});
