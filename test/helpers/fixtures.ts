import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { cellsFromCsvGrid, FakeSheets, type Protection } from './fake-sheets.js';
import { SheetsClient } from '../../src/maintainer/sheets-client.js';

export const CATALOG_CSV = readFileSync(new URL('../fixtures/catalog.csv', import.meta.url), 'utf8');
export const SOURCES_CSV = readFileSync(new URL('../fixtures/sources.csv', import.meta.url), 'utf8');

export const SPREADSHEET_ID = 'test-spreadsheet-000000000000';
export const MAINTAINER_TOKEN = 'maintainer-token';
export const OWNER_TOKEN = 'owner-token';

export function catalogGrid(): string[][] {
  return parse(CATALOG_CSV, { bom: true }) as string[][];
}

export async function startFakeSheets(protections: Protection[] = []): Promise<{ fake: FakeSheets; client: SheetsClient }> {
  const fake = new FakeSheets({
    spreadsheetId: SPREADSHEET_ID,
    tokens: [MAINTAINER_TOKEN, OWNER_TOKEN],
    protections,
    sheets: [
      { sheetId: 1872724035, title: 'Opportunities', tableId: '1510487007', cells: cellsFromCsvGrid(catalogGrid(), [5, 20]) },
      { sheetId: 1002279870, title: 'Sources', cells: cellsFromCsvGrid(parse(SOURCES_CSV, { bom: true }) as string[][], [3]) },
    ],
  });
  process.env.AMBASSADOR_SHEETS_API_BASE = await fake.start();
  const client = new SheetsClient(SPREADSHEET_ID, { principal: 'test-maintainer', getToken: async () => MAINTAINER_TOKEN, warnings: [] });
  return { fake, client };
}
