import type { RequestBudget } from '../http.js';

export interface SearchResult {
  title: string | null;
  url: string;
  publishedDate: string | null;
  snippet: string;
}

export interface PageContent {
  url: string;
  title: string | null;
  text: string;
  fetcher: string;
}

export interface ProviderContext {
  apiKey: string;
  budget: RequestBudget;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface SearchProvider {
  name: string;
  envVar: string;
  search(query: string, limit: number, ctx: ProviderContext): Promise<SearchResult[]>;
  content(url: string, ctx: ProviderContext): Promise<PageContent>;
}

/** Max characters of page text kept as evidence. Bounded to keep model requests and files small. */
export const MAX_EVIDENCE_CHARS = 20_000;
export const MAX_SNIPPET_CHARS = 400;

/** One-line preview text: markdown heading/list markers dropped, whitespace collapsed. */
export function snippetText(text: string, max: number): string {
  const flat = text
    .split('\n')
    .map((l) => l.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/, '').trim())
    .filter((l) => l && l !== '...' && l !== '…')
    .join(' ')
    .replace(/\s+/g, ' ');
  return clip(flat, max);
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
