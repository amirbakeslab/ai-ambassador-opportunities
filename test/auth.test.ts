import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeMaintainerCredentials, loadMaintainerAuth, SHEETS_SCOPE } from '../src/maintainer/google-auth.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  delete process.env.AMBASSADOR_GOOGLE_CREDENTIALS;
  delete process.env.AMBASSADOR_GOOGLE_ACCESS_TOKEN;
});

function keyFile(tokenUri: string, mode = 0o600): string {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'ambassador-sa-'));
  const file = join(dir, 'sa.json');
  writeFileSync(
    file,
    JSON.stringify({ type: 'service_account', client_email: 'sync@test-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: tokenUri }),
  );
  chmodSync(file, mode);
  (keyFile as unknown as { pub: typeof publicKey }).pub = publicKey;
  return file;
}

describe('maintainer credentials', () => {
  it('signs an RS256 JWT for the Sheets scope and exchanges it for a token', async () => {
    let seen: Record<string, unknown> | undefined;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const assertion = new URLSearchParams(body).get('assertion')!;
        const [h, c, sig] = assertion.split('.');
        const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify((keyFile as unknown as { pub: import('node:crypto').KeyObject }).pub, Buffer.from(sig!, 'base64url'));
        seen = { grant: new URLSearchParams(body).get('grant_type'), ok, header: JSON.parse(Buffer.from(h!, 'base64url').toString()), claims: JSON.parse(Buffer.from(c!, 'base64url').toString()) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const uri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    process.env.AMBASSADOR_GOOGLE_CREDENTIALS = keyFile(uri);
    const auth = await loadMaintainerAuth();
    expect(auth.principal).toBe('sync@test-project.iam.gserviceaccount.com');
    expect(await auth.getToken()).toBe('ya29.test');
    expect(await auth.getToken()).toBe('ya29.test');
    expect(seen).toMatchObject({ grant: 'urn:ietf:params:oauth:grant-type:jwt-bearer', ok: true, header: { alg: 'RS256' }, claims: { scope: SHEETS_SCOPE, aud: uri } });
  });

  it('reports token exchange failures without echoing secrets', async () => {
    server = createServer((_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    process.env.AMBASSADOR_GOOGLE_CREDENTIALS = keyFile(`http://127.0.0.1:${(server.address() as AddressInfo).port}/token`);
    const err = await (await loadMaintainerAuth()).getToken().catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 400, invalid_grant/);
    expect(String(err)).not.toMatch(/PRIVATE KEY/);
  });

  it('refuses non-HTTPS token endpoints, wrong key types and missing configuration', async () => {
    process.env.AMBASSADOR_GOOGLE_CREDENTIALS = keyFile('http://evil.example/token');
    await expect(loadMaintainerAuth()).rejects.toThrow(/HTTPS/);
    const dir = mkdtempSync(join(tmpdir(), 'ambassador-sa-'));
    writeFileSync(join(dir, 'user.json'), JSON.stringify({ type: 'authorized_user', client_id: 'x' }));
    process.env.AMBASSADOR_GOOGLE_CREDENTIALS = join(dir, 'user.json');
    await expect(loadMaintainerAuth()).rejects.toThrow(/service-account key/);
    delete process.env.AMBASSADOR_GOOGLE_CREDENTIALS;
    await expect(loadMaintainerAuth()).rejects.toThrow(/Student commands never need this/);
  });

  it('warns about group/world-readable key files and accepts short-lived tokens', async () => {
    process.env.AMBASSADOR_GOOGLE_CREDENTIALS = keyFile('https://oauth2.googleapis.com/token', 0o644);
    const d = await describeMaintainerCredentials();
    expect(d.configured).toBe(true);
    expect(d.warnings.join()).toMatch(/chmod 600/);
    process.env.AMBASSADOR_GOOGLE_ACCESS_TOKEN = 'short-lived';
    const auth = await loadMaintainerAuth();
    expect(await auth.getToken()).toBe('short-lived');
  });
});
