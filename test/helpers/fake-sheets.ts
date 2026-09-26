import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-memory stand-in for the parts of the Google Sheets API v4 REST surface
 * this CLI uses: spreadsheets.get (sheet/table metadata), values.get with
 * UNFORMATTED_VALUE / FORMULA rendering, and an all-or-nothing
 * spreadsheets.batchUpdate supporting updateCells and appendCells. It also
 * models protected ranges so rejected writes can be tested.
 */

export type StoredCell = { string: string } | { number: number } | { formula: string; result: string | number } | null;

export interface FakeSheet {
  sheetId: number;
  title: string;
  tableId?: string;
  cells: StoredCell[][];
}

export interface Protection {
  sheetId: number;
  /** 0-based inclusive rows; endRow undefined = to the end. */
  startRow: number;
  endRow?: number;
  startCol: number;
  endCol: number;
  /** Tokens allowed to edit. */
  editors: string[];
}

export interface FakeSheetsOptions {
  spreadsheetId: string;
  sheets: FakeSheet[];
  tokens: string[];
  protections?: Protection[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export class FakeSheets {
  readonly requests: RecordedRequest[] = [];
  private server!: Server;
  baseUrl = '';
  /** Called after each values.get; lets a test simulate a concurrent human edit. */
  afterRead?: (count: number) => void;
  private reads = 0;

  constructor(readonly opts: FakeSheetsOptions) {}

  sheet(title: string): FakeSheet {
    const s = this.opts.sheets.find((x) => x.title === title);
    if (!s) throw new Error(`no sheet ${title}`);
    return s;
  }

  /** Set a cell as a human would in the UI (text). */
  edit(title: string, row: number, col: number, value: StoredCell): void {
    const s = this.sheet(title);
    while (s.cells.length <= row) s.cells.push([]);
    s.cells[row]![col] = value;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req)
        .then(({ status, body }) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        })
        .catch((e: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 500, message: String(e) } }));
        });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v4`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get writeRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'POST');
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, body });
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^Bearer /, '');
    if (!this.opts.tokens.includes(token)) return err(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED');
    const prefix = `/v4/spreadsheets/${this.opts.spreadsheetId}`;
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith(prefix)) return err(404, 'Requested entity was not found.', 'NOT_FOUND');
    const rest = path.slice(prefix.length);
    if (req.method === 'GET' && rest === '') {
      return {
        status: 200,
        body: {
          sheets: this.opts.sheets.map((s) => {
            const prs = (this.opts.protections ?? [])
              .filter((p) => p.sheetId === s.sheetId)
              .map((p, i) => ({
                protectedRangeId: 1000 + i,
                range: { sheetId: s.sheetId, startRowIndex: p.startRow, ...(p.endRow !== undefined ? { endRowIndex: p.endRow + 1 } : {}), startColumnIndex: p.startCol, endColumnIndex: p.endCol + 1 },
                // Like Google, requestingUserCanEdit is omitted when false.
                ...(p.editors.includes(token) ? { requestingUserCanEdit: true } : {}),
              }));
            return {
              properties: { sheetId: s.sheetId, title: s.title },
              ...(s.tableId ? { tables: [{ tableId: s.tableId, name: `${s.title}Table` }] } : {}),
              ...(prs.length ? { protectedRanges: prs } : {}),
            };
          }),
        },
      };
    }
    if (req.method === 'GET' && (rest.startsWith('/values/') || rest === '/values:batchGet')) {
      const ranges = rest === '/values:batchGet' ? url.searchParams.getAll('ranges') : [rest.slice('/values/'.length)];
      const render = url.searchParams.get('valueRenderOption');
      const valueRanges = [];
      for (const range of ranges) {
        const m = /^'((?:[^']|'')+)'!/.exec(range);
        const title = m ? m[1]!.replace(/''/g, "'") : range.split('!')[0]!;
        const sheet = this.opts.sheets.find((s) => s.title === title);
        if (!sheet) return err(400, `Unable to parse range: ${range}`, 'INVALID_ARGUMENT');
        const values = trimGrid(sheet.cells.map((row) => row.map((c) => renderCell(c, render === 'FORMULA'))));
        valueRanges.push({ range, majorDimension: 'ROWS', ...(values.length ? { values } : {}) });
      }
      this.reads += 1;
      this.afterRead?.(this.reads);
      return { status: 200, body: rest === '/values:batchGet' ? { spreadsheetId: this.opts.spreadsheetId, valueRanges } : valueRanges[0] };
    }
    if (req.method === 'POST' && rest === ':batchUpdate') return this.batchUpdate(token, body as { requests: Record<string, any>[] });
    return err(404, 'Not found', 'NOT_FOUND');
  }

  private batchUpdate(token: string, body: { requests: Record<string, any>[] }): { status: number; body: unknown } {
    // Validate every request first: Google applies all or none.
    const ops: (() => void)[] = [];
    for (const r of body.requests) {
      if (r.updateCells) {
        const { start, rows, fields } = r.updateCells;
        if (fields !== 'userEnteredValue') return err(400, 'unsupported fields', 'INVALID_ARGUMENT');
        const sheet = this.opts.sheets.find((s) => s.sheetId === start.sheetId);
        if (!sheet) return err(400, `No grid with id: ${start.sheetId}`, 'INVALID_ARGUMENT');
        const writes: [number, number, StoredCell][] = [];
        rows.forEach((row: { values: any[] }, ri: number) =>
          row.values.forEach((cell: any, ci: number) => writes.push([start.rowIndex + ri, start.columnIndex + ci, toStored(cell)])),
        );
        const denied = writes.find(([row, col]) => this.isProtected(sheet.sheetId, row, col, token));
        if (denied) return err(400, 'You are trying to edit a protected cell or object. Please contact the spreadsheet owner to remove protection if you need to edit.', 'INVALID_ARGUMENT');
        ops.push(() => writes.forEach(([row, col, v]) => this.set(sheet, row, col, v)));
      } else if (r.appendCells) {
        const a = r.appendCells;
        // Like the real API, sheetId is required (it defaults to 0) even when tableId is set.
        const bySheet = this.opts.sheets.find((s) => s.sheetId === (a.sheetId ?? 0));
        if (!bySheet) return err(400, `Invalid requests[0].appendCells: No grid with id: ${a.sheetId ?? 0}`, 'INVALID_ARGUMENT');
        const sheet = a.tableId ? this.opts.sheets.find((s) => s.tableId === a.tableId) : bySheet;
        if (!sheet) return err(400, 'No grid or table with that id', 'INVALID_ARGUMENT');
        const first = lastUsedRow(sheet.cells) + 1;
        const writes: [number, number, StoredCell][] = [];
        a.rows.forEach((row: { values: any[] }, ri: number) => row.values.forEach((cell: any, ci: number) => writes.push([first + ri, ci, toStored(cell)])));
        const denied = writes.find(([row, col, v]) => v !== null && this.isProtected(sheet.sheetId, row, col, token));
        if (denied) return err(400, 'You are trying to edit a protected cell or object. Please contact the spreadsheet owner to remove protection if you need to edit.', 'INVALID_ARGUMENT');
        ops.push(() => writes.forEach(([row, col, v]) => this.set(sheet, row, col, v)));
      } else {
        return err(400, 'unsupported request', 'INVALID_ARGUMENT');
      }
    }
    ops.forEach((op) => op());
    return { status: 200, body: { spreadsheetId: this.opts.spreadsheetId, replies: body.requests.map(() => ({})) } };
  }

  private isProtected(sheetId: number, row: number, col: number, token: string): boolean {
    return (this.opts.protections ?? []).some(
      (p) => p.sheetId === sheetId && row >= p.startRow && (p.endRow === undefined || row <= p.endRow) && col >= p.startCol && col <= p.endCol && !p.editors.includes(token),
    );
  }

  private set(sheet: FakeSheet, row: number, col: number, v: StoredCell): void {
    while (sheet.cells.length <= row) sheet.cells.push([]);
    sheet.cells[row]![col] = v;
  }
}

function err(status: number, message: string, code: string) {
  return { status, body: { error: { code: status, message, status: code } } };
}

function toStored(cell: any): StoredCell {
  const v = cell?.userEnteredValue;
  if (!v) return null;
  if ('stringValue' in v) return { string: v.stringValue };
  if ('numberValue' in v) return { number: v.numberValue };
  if ('formulaValue' in v) return { formula: v.formulaValue, result: 0 };
  if ('boolValue' in v) return { string: String(v.boolValue).toUpperCase() };
  return null;
}

function renderCell(c: StoredCell | undefined, formula: boolean): string | number {
  if (!c) return '';
  if ('string' in c) return c.string;
  if ('number' in c) return c.number;
  return formula ? c.formula : c.result;
}

function lastUsedRow(cells: StoredCell[][]): number {
  for (let r = cells.length - 1; r >= 0; r -= 1) if (cells[r]!.some((c) => c !== null && c !== undefined)) return r;
  return -1;
}

/** Google omits trailing empty cells and rows. */
function trimGrid(grid: (string | number)[][]): (string | number)[][] {
  const rows = grid.map((row) => {
    const out = [...row];
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  });
  while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
  return rows;
}

/** Build stored cells from the public CSV fixture, converting M/D/YYYY dates to serials like the real Sheet. */
export function cellsFromCsvGrid(grid: string[][], dateColumns: number[]): StoredCell[][] {
  const epoch = Date.UTC(1899, 11, 30);
  return grid.map((row, r) =>
    row.map((v, c) => {
      if (v === '') return null;
      if (r > 0 && dateColumns.includes(c)) {
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
        if (m) {
          const [y, mo, d] = v.includes('/') ? [Number(m[3]), Number(m[1]), Number(m[2])] : [Number(m[1]), Number(m[2]), Number(m[3])];
          return { number: Math.round((Date.UTC(y, mo - 1, d) - epoch) / 86_400_000) };
        }
      }
      return { string: v };
    }),
  );
}
