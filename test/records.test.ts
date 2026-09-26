import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { describe, expect, it } from 'vitest';
import { isoToSerial, parseDateCell, serialToIso } from '../src/dates.js';
import { parseCatalogCsv, recordsToCsv } from '../src/records.js';
import { neutralizeFormula, terminalSafe } from '../src/safety.js';
import { CATALOG_CSV } from './helpers/fixtures.js';

function mutate(fn: (grid: string[][]) => void): string {
  const grid = parse(CATALOG_CSV, { bom: true }) as string[][];
  fn(grid);
  return stringify(grid);
}

describe('dates', () => {
  it('accepts ISO, the published M/D/YYYY form and serials; blank is unknown', () => {
    expect(parseDateCell('2026-09-12')).toBe('2026-09-12');
    expect(parseDateCell('9/12/2026')).toBe('2026-09-12');
    expect(parseDateCell(46277)).toBe('2026-09-12');
    expect(parseDateCell('')).toBeNull();
    expect(parseDateCell(null)).toBeNull();
    expect(isoToSerial('2026-09-12')).toBe(46277);
    expect(serialToIso(isoToSerial('2024-02-29'))).toBe('2024-02-29');
  });
  it('rejects impossible or ambiguous text instead of treating it as no deadline', () => {
    expect(() => parseDateCell('2026-02-30')).toThrow();
    expect(() => parseDateCell('13/40/2026')).toThrow();
    expect(() => parseDateCell('rolling')).toThrow();
    expect(() => parseDateCell('Sept 12')).toThrow();
  });
});

describe('catalog CSV parsing', () => {
  it('parses the published feed: 13 records, 22 columns, no issues', () => {
    const t = parseCatalogCsv(CATALOG_CSV);
    expect(t.header).toHaveLength(22);
    expect(t.records).toHaveLength(13);
    expect(t.issues).toEqual([]);
    const anthropic = t.records.find((r) => r.id === 'anthropic-campus-2026')!;
    expect(anthropic.deadline).toBe('2026-09-12');
    expect(t.records.find((r) => r.id === 'microsoft-copilot-fall-2026')!.sourceIds).toEqual(['copilot', 'copilot-application']);
    expect(t.records.every((r) => r.lastChecked === '2026-09-25')).toBe(true);
  });

  it('maps columns by header name, so reordering is tolerated', () => {
    const csv = mutate((g) => g.forEach((row) => row.reverse()));
    const t = parseCatalogCsv(csv);
    expect(t.records).toHaveLength(13);
    expect(t.records[0]!.company).toBe('Cursor');
  });

  it('fails clearly when an expected column disappears', () => {
    const csv = mutate((g) => g.forEach((row) => row.splice(21, 1)));
    expect(() => parseCatalogCsv(csv)).toThrow(/missing expected column\(s\): Opportunity ID/);
  });

  it('reports bad rows (status, date, URL, duplicate ID) and keeps good ones', () => {
    const csv = mutate((g) => {
      g[1]![2] = 'Open now!!';
      g[2]![5] = 'soon';
      g[3]![4] = 'javascript:alert(1)';
      g[4]![21] = g[5]![21]!;
    });
    const t = parseCatalogCsv(csv);
    expect(t.records).toHaveLength(9);
    expect(t.issues.map((i) => i.row)).toEqual([2, 3, 4, 6]);
    expect(t.issues[0]!.problems.join()).toMatch(/status/);
    expect(t.issues[1]!.problems.join()).toMatch(/deadline unrecognised date "soon"/);
    expect(t.issues[3]!.problems.join()).toMatch(/duplicate Opportunity ID/);
  });

  it('handles quoted commas, embedded newlines, a BOM and short rows', () => {
    const csv = '﻿' + mutate((g) => {
      g[1]![16] = 'Line one, with comma\nLine "two"';
      g[2] = g[2]!.slice(0, 22);
    });
    const t = parseCatalogCsv(csv);
    expect(t.records.find((r) => r.id === 'cursor-ambassadors')!.description).toBe('Line one, with comma\nLine "two"');
  });

  it('rejects an HTML error page and malformed CSV with useful messages', () => {
    expect(() => parseCatalogCsv('<!DOCTYPE html><html>Sign in</html>')).toThrow(/returned HTML/);
    expect(() => parseCatalogCsv('Company,"Program\n')).toThrow(/could not be parsed/);
    expect(() => parseCatalogCsv('')).toThrow(/empty/);
  });
});

describe('export safety', () => {
  it('neutralises formula-leading cells in CSV exports', () => {
    expect(neutralizeFormula('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(neutralizeFormula('+1')).toBe("'+1");
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeFormula('-2+3')).toBe("'-2+3");
    expect(neutralizeFormula('Plain text')).toBe('Plain text');
    const t = parseCatalogCsv(mutate((g) => (g[1]![16] = '=cmd|" /C calc"!A0')));
    const out = recordsToCsv(t.records);
    expect(out).toContain(`"'=cmd|"" /C calc""!A0"`);
    const reparsed = parse(out) as string[][];
    expect(reparsed).toHaveLength(14);
    expect(reparsed[0]).toHaveLength(22);
  });

  it('strips terminal escape sequences from untrusted text', () => {
    expect(terminalSafe('ok\u001b[31mred\u001b[0m\u0007')).toBe('okred');
  });
});
