import { createSign } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { env, ENV } from '../config.js';
import { CliError } from '../errors.js';
import { parseJson, request } from '../http.js';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const ServiceAccountSchema = z.object({
  type: z.literal('service_account'),
  client_email: z.string().email(),
  private_key: z.string().includes('PRIVATE KEY'),
  token_uri: z.string().url(),
});

export interface MaintainerAuth {
  /** Human-readable principal (service account email or "access token"); never the secret. */
  principal: string;
  getToken(): Promise<string>;
}

function credentialsPath(): string | undefined {
  return env(ENV.googleCredentials) ?? env('GOOGLE_APPLICATION_CREDENTIALS');
}

/** Describe configured maintainer credentials without reading secret values into output. */
export async function describeMaintainerCredentials(): Promise<{ configured: boolean; detail: string; warnings: string[] }> {
  if (env(ENV.googleAccessToken)) return { configured: true, detail: `${ENV.googleAccessToken} is set`, warnings: [] };
  const path = credentialsPath();
  if (!path) return { configured: false, detail: `neither ${ENV.googleCredentials} nor ${ENV.googleAccessToken} is set`, warnings: [] };
  try {
    const s = await stat(path);
    const warnings = (s.mode & 0o077) !== 0 ? [`credential file is readable by other users; run: chmod 600 "${path}"`] : [];
    return { configured: true, detail: 'service-account credential file is present', warnings };
  } catch {
    return { configured: false, detail: 'credential file path is set but the file is not readable', warnings: [] };
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(sa: { client_email: string; private_key: string; token_uri: string }, scope: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(sa.private_key))}`;
}

function allowedTokenUri(uri: string): boolean {
  const u = new URL(uri);
  if (u.protocol === 'https:') return true;
  // Only the local test server may use plain HTTP.
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}

/**
 * Maintainer credentials, loaded only by maintainer commands. Either a
 * short-lived OAuth access token (for example from `gcloud auth
 * print-access-token` for an editor account) or a service-account JSON key
 * file shared as Editor on the catalog.
 */
export async function loadMaintainerAuth(opts: { fetchImpl?: typeof fetch } = {}): Promise<MaintainerAuth> {
  const token = env(ENV.googleAccessToken);
  if (token) return { principal: 'access token from environment', getToken: async () => token };
  const path = credentialsPath();
  if (!path) {
    throw new CliError(
      `Maintainer credentials are not configured. Set ${ENV.googleCredentials} to a service-account key file that has Editor access to the catalog, or ${ENV.googleAccessToken} to a short-lived OAuth token. Student commands never need this.`,
    );
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new CliError('Could not read the maintainer credential file. Check the path and permissions.');
  }
  const sa = ServiceAccountSchema.safeParse(parseJson(raw));
  if (!sa.success) throw new CliError('Maintainer credential file is not a Google service-account key (type "service_account").');
  if (!allowedTokenUri(sa.data.token_uri)) throw new CliError('Service-account token_uri must use HTTPS.');
  let cached: { token: string; expires: number } | undefined;
  return {
    principal: sa.data.client_email,
    async getToken() {
      const now = Math.floor(Date.now() / 1000);
      if (cached && cached.expires - 60 > now) return cached.token;
      const assertion = signJwt(sa.data, SHEETS_SCOPE, now);
      const res = await request(sa.data.token_uri, {
        provider: 'Google OAuth',
        fetchImpl: opts.fetchImpl,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        rawBody: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        retries: 1,
      });
      const body = z.object({ access_token: z.string(), expires_in: z.number().optional() }).safeParse(parseJson(res.text));
      if (res.status !== 200 || !body.success) {
        const detail = z.object({ error: z.string() }).safeParse(parseJson(res.text));
        throw new CliError(`Google token exchange failed (HTTP ${res.status}${detail.success ? `, ${detail.data.error}` : ''}). Check that the service-account key is current.`);
      }
      cached = { token: body.data.access_token, expires: now + (body.data.expires_in ?? 3600) };
      return cached.token;
    },
  };
}
