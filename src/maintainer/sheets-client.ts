import { z } from 'zod';
import { env, ENV } from '../config.js';
import { CliError } from '../errors.js';
import { parseJson, request, type HttpResult } from '../http.js';
import type { Cell } from '../records.js';
import type { MaintainerAuth } from './google-auth.js';

// Google Sheets API v4 REST: spreadsheets.get, spreadsheets.values.get, spreadsheets.batchUpdate
const DEFAULT_BASE = 'https://sheets.googleapis.com/v4';

export function sheetsApiBase(): string {
  const override = env(ENV.sheetsApiBase);
  if (!override) return DEFAULT_BASE;
  const u = new URL(override);
  // Overrides exist for the local integration-test server only.
  if (!(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) && u.protocol !== 'https:') {
    throw new CliError(`${ENV.sheetsApiBase} must be https or a loopback test server.`);
  }
  return override.replace(/\/$/, '');
}

export function a1Tab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/**
 * A write touched a protected range the principal may not edit. Because
 * batchUpdate is all-or-nothing, nothing from that batch was written.
 */
export class ProtectedRangeError extends CliError {
  constructor(principal: string, detail: string) {
    super(`Protected cells: ${detail}. Nothing was written. Ask the spreadsheet owner to let ${principal} edit them, or make the change by hand.`);
    this.name = 'ProtectedRangeError';
  }
}

export type ExtendedValue = { stringValue: string } | { numberValue: number };
export interface CellData {
  userEnteredValue?: ExtendedValue;
}
export type SheetRequest =
  | { updateCells: { start: { sheetId: number; rowIndex: number; columnIndex: number }; rows: { values: CellData[] }[]; fields: 'userEnteredValue' } }
  | { appendCells: { sheetId: number; tableId?: string; rows: { values: CellData[] }[]; fields: 'userEnteredValue' } };

const GridRangeSchema = z.object({
  startRowIndex: z.number().optional(),
  endRowIndex: z.number().optional(),
  startColumnIndex: z.number().optional(),
  endColumnIndex: z.number().optional(),
});

const SpreadsheetInfo = z.object({
  sheets: z.array(
    z.object({
      properties: z.object({ sheetId: z.number(), title: z.string() }),
      tables: z.array(z.object({ tableId: z.string(), name: z.string().optional() })).optional(),
      protectedRanges: z
        .array(
          z.object({
            protectedRangeId: z.number().optional(),
            range: GridRangeSchema.optional(),
            warningOnly: z.boolean().optional(),
            requestingUserCanEdit: z.boolean().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

/** A protected area the current principal may not edit (0-based, end-exclusive; undefined = unbounded). */
export interface BlockedRange {
  id: number | null;
  startRow?: number;
  endRow?: number;
  startCol?: number;
  endCol?: number;
}

const ValuesResponse = z.object({ values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).optional() });

export interface TabInfo {
  sheetId: number;
  title: string;
  tableId: string | null;
  /** Protected ranges this principal cannot edit (from requestingUserCanEdit). */
  blocked: BlockedRange[];
}

export class SheetsClient {
  private readonly base: string;
  constructor(
    readonly spreadsheetId: string,
    private readonly auth: MaintainerAuth,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.base = sheetsApiBase();
  }

  get principal(): string {
    return this.auth.principal;
  }

  private async call(path: string, init: { body?: unknown; write?: boolean } = {}): Promise<unknown> {
    const token = await this.auth.getToken();
    const res = await request(`${this.base}/spreadsheets/${encodeURIComponent(this.spreadsheetId)}${path}`, {
      provider: 'Google Sheets',
      headers: { authorization: `Bearer ${token}` },
      body: init.body,
      fetchImpl: this.fetchImpl,
      // Sheets enforces per-minute quotas; backoff (2s, 4s ... 64s) outlasts one quota window.
      // Writes retry only on 429 (the request was rejected, so nothing was applied);
      // a timed-out or 5xx write might have been applied and is never retried.
      retries: 6,
      retryStatuses: init.write ? [429] : undefined,
      retryNetworkErrors: !init.write,
      maxRetryAfterSeconds: 60,
      timeoutMs: 60_000,
    });
    return this.check(res);
  }

  private check(res: HttpResult): unknown {
    const body = parseJson(res.text);
    if (res.status === 200) return body;
    const msg = z.object({ error: z.object({ message: z.string(), status: z.string().optional() }) }).safeParse(body);
    const detail = msg.success ? msg.data.error.message : `HTTP ${res.status}`;
    if (/protected cell|protected range|protected object/i.test(detail)) throw new ProtectedRangeError(this.auth.principal, detail);
    if (res.status === 401) throw new CliError(`Google Sheets rejected the credentials (401): ${detail}`);
    if (res.status === 403) {
      throw new CliError(`Google Sheets denied access (403): ${detail}. Share the spreadsheet with ${this.auth.principal} as Editor, or use an account that already has edit access.`);
    }
    if (res.status === 404) throw new CliError(`Spreadsheet or tab not found (404): ${detail}`);
    throw new CliError(`Google Sheets error (HTTP ${res.status}): ${detail}`);
  }

  /** Metadata for the named tabs in one spreadsheets.get call; missing tabs map to null. */
  async tabs(titles: string[]): Promise<Map<string, TabInfo | null>> {
    const fields = 'sheets(properties(sheetId,title),tables(tableId,name),protectedRanges(protectedRangeId,range,warningOnly,requestingUserCanEdit))';
    const body = await this.call(`?fields=${encodeURIComponent(fields)}`);
    const parsed = SpreadsheetInfo.safeParse(body);
    if (!parsed.success) throw new CliError('Unexpected spreadsheet metadata from Google Sheets.');
    const out = new Map<string, TabInfo | null>();
    for (const title of titles) {
      const sheet = parsed.data.sheets.find((s) => s.properties.title === title);
      if (!sheet) {
        out.set(title, null);
        continue;
      }
      // Google omits requestingUserCanEdit when it is false.
      const blocked = (sheet.protectedRanges ?? [])
        .filter((p) => !p.warningOnly && !p.requestingUserCanEdit)
        .map((p) => ({
          id: p.protectedRangeId ?? null,
          startRow: p.range?.startRowIndex,
          endRow: p.range?.endRowIndex,
          startCol: p.range?.startColumnIndex,
          endCol: p.range?.endColumnIndex,
        }));
      out.set(title, { sheetId: sheet.properties.sheetId, title, tableId: sheet.tables?.[0]?.tableId ?? null, blocked });
    }
    return out;
  }

  /**
   * Raw grids for several tabs in one values.batchGet call. UNFORMATTED_VALUE
   * returns literal values and date serials; FORMULA reveals formulas.
   */
  async valuesBatch(tabs: string[], render: 'UNFORMATTED_VALUE' | 'FORMULA'): Promise<Cell[][][]> {
    const params = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: render, dateTimeRenderOption: 'SERIAL_NUMBER' });
    for (const tab of tabs) params.append('ranges', `${a1Tab(tab)}!A1:ZZ`);
    const body = await this.call(`/values:batchGet?${params.toString()}`);
    const parsed = z.object({ valueRanges: z.array(ValuesResponse).optional() }).safeParse(body);
    if (!parsed.success || (parsed.data.valueRanges ?? []).length !== tabs.length) throw new CliError('Unexpected values response from Google Sheets.');
    return parsed.data.valueRanges!.map((r) => r.values ?? []);
  }

  /** One spreadsheets.batchUpdate call. Google applies all requests or none of them. */
  async batchUpdate(requests: SheetRequest[]): Promise<void> {
    if (requests.length === 0) return;
    await this.call(':batchUpdate', { body: { requests, includeSpreadsheetInResponse: false }, write: true });
  }
}
