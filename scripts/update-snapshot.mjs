// Regenerates data/catalog-snapshot.json from the public published catalog.
// Run after `npm run build`: node scripts/update-snapshot.mjs
import { writeFile } from 'node:fs/promises';
import { DEFAULT_CSV_URL, DEFAULT_SHEET_URL, sourcesCsvUrl } from '../dist/config.js';
import { fetchCatalogCsv, parseSourcesCsv } from '../dist/catalog.js';
import { parseCatalogCsv } from '../dist/records.js';

const table = parseCatalogCsv(await fetchCatalogCsv(DEFAULT_CSV_URL));
if (table.issues.length) throw new Error(`Live catalog has invalid rows: ${JSON.stringify(table.issues)}`);
const sources = parseSourcesCsv(await fetchCatalogCsv(sourcesCsvUrl()));
const snapshot = {
  description: 'Snapshot of the public catalog bundled for offline use. The live Google Sheet is authoritative.',
  capturedAt: new Date().toISOString(),
  sourceUrl: DEFAULT_CSV_URL,
  sheetUrl: DEFAULT_SHEET_URL,
  records: table.records,
  sources,
};
await writeFile(new URL('../data/catalog-snapshot.json', import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${table.records.length} records and ${sources.length} sources.`);
