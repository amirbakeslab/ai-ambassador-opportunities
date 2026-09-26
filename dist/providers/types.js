/** Max characters of page text kept as evidence. Bounded to keep model requests and files small. */
export const MAX_EVIDENCE_CHARS = 20_000;
export const MAX_SNIPPET_CHARS = 400;
export function clip(text, max) {
    const t = text.replace(/\s+\n/g, '\n').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
