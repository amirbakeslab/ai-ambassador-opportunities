import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unit and integration tests must never use a developer's real keys,
// credentials or cache, and never reach real Google/provider endpoints.
for (const name of [
  'EXA_API_KEY',
  'FIRECRAWL_API_KEY',
  'OPENROUTER_API_KEY',
  'AMBASSADOR_GOOGLE_CREDENTIALS',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AMBASSADOR_GOOGLE_ACCESS_TOKEN',
  'AMBASSADOR_SHEET_ID',
  'AMBASSADOR_SHEETS_API_BASE',
  'AMBASSADOR_CSV_URL',
  'AMBASSADOR_SOURCES_CSV_URL',
  'AMBASSADOR_MAX_REQUESTS',
  'AMBASSADOR_BACKUP_DIR',
]) {
  delete process.env[name];
}
process.env.AMBASSADOR_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ambassador-test-cache-'));
