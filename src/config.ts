import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { UsageError } from './errors.js';

export const TOOL_NAME = 'ai-ambassador-opportunities';
export const TOOL_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** The public catalog. The Sheet is authoritative; the CSV is its published Opportunities tab. */
export const DEFAULT_SHEET_ID = '1TKibIwQrSLoJOYSswXYuqfRsFrkRyVIsqiw4F6dp-Rc';
export const DEFAULT_SHEET_URL = `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/edit`;
export const DEFAULT_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSPmNeiTw-xmXCIxrNL__gRZnl7wlC8pv94uLYAM7sTiLk4rQ4gPl8nGA_J9WZcy9vwiQsrOKuo4cMo/pub?gid=1872724035&single=true&output=csv';
export const DEFAULT_TAB = 'Opportunities';
export const SOURCES_GID = 1002279870;

/** Anonymous CSV export of the public Sources tab (the Sheet is viewable by anyone with the link). */
export function sourcesCsvUrl(): string {
  return env('AMBASSADOR_SOURCES_CSV_URL') ?? `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/export?format=csv&gid=${SOURCES_GID}`;
}

export const ENV = {
  csvUrl: 'AMBASSADOR_CSV_URL',
  cacheDir: 'AMBASSADOR_CACHE_DIR',
  maxRequests: 'AMBASSADOR_MAX_REQUESTS',
  exaKey: 'EXA_API_KEY',
  firecrawlKey: 'FIRECRAWL_API_KEY',
  openrouterKey: 'OPENROUTER_API_KEY',
  googleCredentials: 'AMBASSADOR_GOOGLE_CREDENTIALS',
  googleAccessToken: 'AMBASSADOR_GOOGLE_ACCESS_TOKEN',
  sheetId: 'AMBASSADOR_SHEET_ID',
  sheetsApiBase: 'AMBASSADOR_SHEETS_API_BASE',
} as const;

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function csvUrl(): string {
  return env(ENV.csvUrl) ?? DEFAULT_CSV_URL;
}

export function cacheDir(): string {
  const explicit = env(ENV.cacheDir);
  if (explicit) return explicit;
  const xdg = env('XDG_CACHE_HOME');
  return join(xdg ?? join(homedir(), '.cache'), TOOL_NAME);
}

export function maxRequests(flag?: string): number {
  const raw = flag ?? env(ENV.maxRequests) ?? '5';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new UsageError(`Request cap must be an integer from 1 to 100 (got "${raw}").`);
  return n;
}
