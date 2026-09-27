import { z } from 'zod';
import { env, ENV } from '../config.js';
import { CliError } from '../errors.js';
import { parseJson, request } from '../http.js';
// Google Sheets API v4 REST: spreadsheets.get, spreadsheets.values.get, spreadsheets.batchUpdate
const DEFAULT_BASE = 'https://sheets.googleapis.com/v4';
export function sheetsApiBase() {
    const override = env(ENV.sheetsApiBase);
    if (!override)
        return DEFAULT_BASE;
    const u = new URL(override);
    // Overrides exist for the local integration-test server only.
    if (!(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) && u.protocol !== 'https:') {
        throw new CliError(`${ENV.sheetsApiBase} must be https or a loopback test server.`);
    }
    return override.replace(/\/$/, '');
}
export function a1Tab(tab) {
    return `'${tab.replace(/'/g, "''")}'`;
}
/**
 * A write touched a protected range the principal may not edit. Because
 * batchUpdate is all-or-nothing, nothing from that batch was written.
 */
export class ProtectedRangeError extends CliError {
    constructor(principal, detail) {
        super(`Google Sheets refused the write because it touches a protected range (${detail}). Nothing was written. ` +
            `Existing-record updates only write changed cells, so this usually means a new record needed the protected Opportunity ID column or a header. ` +
            `Ask the spreadsheet owner to allow ${principal} on that protected range, or have the owner add the row by hand.`);
        this.name = 'ProtectedRangeError';
    }
}
const GridRangeSchema = z.object({
    startRowIndex: z.number().optional(),
    endRowIndex: z.number().optional(),
    startColumnIndex: z.number().optional(),
    endColumnIndex: z.number().optional(),
});
const SpreadsheetInfo = z.object({
    sheets: z.array(z.object({
        properties: z.object({ sheetId: z.number(), title: z.string() }),
        tables: z.array(z.object({ tableId: z.string(), name: z.string().optional() })).optional(),
        protectedRanges: z
            .array(z.object({
            protectedRangeId: z.number().optional(),
            range: GridRangeSchema.optional(),
            warningOnly: z.boolean().optional(),
            requestingUserCanEdit: z.boolean().optional(),
        }))
            .optional(),
    })),
});
const ValuesResponse = z.object({ values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).optional() });
export class SheetsClient {
    spreadsheetId;
    auth;
    fetchImpl;
    base;
    constructor(spreadsheetId, auth, fetchImpl) {
        this.spreadsheetId = spreadsheetId;
        this.auth = auth;
        this.fetchImpl = fetchImpl;
        this.base = sheetsApiBase();
    }
    get principal() {
        return this.auth.principal;
    }
    async call(path, init = {}) {
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
    check(res) {
        const body = parseJson(res.text);
        if (res.status === 200)
            return body;
        const msg = z.object({ error: z.object({ message: z.string(), status: z.string().optional() }) }).safeParse(body);
        const detail = msg.success ? msg.data.error.message : `HTTP ${res.status}`;
        if (/protected cell|protected range|protected object/i.test(detail))
            throw new ProtectedRangeError(this.auth.principal, detail);
        if (res.status === 401)
            throw new CliError(`Google Sheets rejected the credentials (401): ${detail}`);
        if (res.status === 403) {
            throw new CliError(`Google Sheets denied access (403): ${detail}. Share the spreadsheet with ${this.auth.principal} as Editor, or use an account that already has edit access.`);
        }
        if (res.status === 404)
            throw new CliError(`Spreadsheet or tab not found (404): ${detail}`);
        throw new CliError(`Google Sheets error (HTTP ${res.status}): ${detail}`);
    }
    /** Metadata for the named tabs in one spreadsheets.get call; missing tabs map to null. */
    async tabs(titles) {
        const fields = 'sheets(properties(sheetId,title),tables(tableId,name),protectedRanges(protectedRangeId,range,warningOnly,requestingUserCanEdit))';
        const body = await this.call(`?fields=${encodeURIComponent(fields)}`);
        const parsed = SpreadsheetInfo.safeParse(body);
        if (!parsed.success)
            throw new CliError('Unexpected spreadsheet metadata from Google Sheets.');
        const out = new Map();
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
    async tabInfo(title) {
        return (await this.tabs([title])).get(title) ?? null;
    }
    /**
     * Raw grids for several tabs in one values.batchGet call. UNFORMATTED_VALUE
     * returns literal values and date serials; FORMULA reveals formulas.
     */
    async valuesBatch(tabs, render) {
        const params = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: render, dateTimeRenderOption: 'SERIAL_NUMBER' });
        for (const tab of tabs)
            params.append('ranges', `${a1Tab(tab)}!A1:ZZ`);
        const body = await this.call(`/values:batchGet?${params.toString()}`);
        const parsed = z.object({ valueRanges: z.array(ValuesResponse).optional() }).safeParse(body);
        if (!parsed.success || (parsed.data.valueRanges ?? []).length !== tabs.length)
            throw new CliError('Unexpected values response from Google Sheets.');
        return parsed.data.valueRanges.map((r) => r.values ?? []);
    }
    async values(tab, render) {
        return (await this.valuesBatch([tab], render))[0];
    }
    /** One spreadsheets.batchUpdate call. Google applies all requests or none of them. */
    async batchUpdate(requests) {
        if (requests.length === 0)
            return;
        await this.call(':batchUpdate', { body: { requests, includeSpreadsheetInResponse: false }, write: true });
    }
}
