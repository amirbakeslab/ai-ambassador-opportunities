const DAY_MS = 86_400_000;
// Google Sheets serial day 0 is 1899-12-30 (UTC, no time zone).
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
function iso(y, m, d) {
    const t = Date.UTC(y, m - 1, d);
    const date = new Date(t);
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
        return null;
    return date.toISOString().slice(0, 10);
}
export class DateParseError extends Error {
}
/**
 * Normalise a date cell to YYYY-MM-DD. Accepts ISO dates, the US M/D/YYYY
 * rendering used by the published CSV, and Sheets serial numbers. Blank means
 * unknown and returns null. Anything else throws, so bad data is reported
 * instead of silently becoming "no deadline".
 */
export function parseDateCell(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'number')
        return serialToIso(value);
    const s = String(value).trim();
    if (s === '')
        return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
        const r = iso(Number(m[1]), Number(m[2]), Number(m[3]));
        if (r)
            return r;
    }
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) {
        const r = iso(Number(m[3]), Number(m[1]), Number(m[2]));
        if (r)
            return r;
    }
    throw new DateParseError(`unrecognised date "${s}" (expected YYYY-MM-DD or M/D/YYYY)`);
}
export function serialToIso(serial) {
    if (!Number.isFinite(serial))
        throw new DateParseError(`invalid date serial ${serial}`);
    return new Date(SHEETS_EPOCH_MS + Math.floor(serial) * DAY_MS).toISOString().slice(0, 10);
}
export function isoToSerial(isoDate) {
    const t = Date.parse(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(t))
        throw new DateParseError(`invalid ISO date ${isoDate}`);
    return Math.round((t - SHEETS_EPOCH_MS) / DAY_MS);
}
export function todayIso(now = new Date()) {
    return now.toISOString().slice(0, 10);
}
