import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cacheDir, env } from '../config.js';
import { MissingKeyError, UsageError } from '../errors.js';
import { exa } from './exa.js';
import { firecrawl } from './firecrawl.js';
const PROVIDERS = { exa, firecrawl };
const DEFAULT_PROVIDER = 'exa';
export function getProvider(name) {
    const p = PROVIDERS[(name ?? DEFAULT_PROVIDER).toLowerCase()];
    if (!p)
        throw new UsageError(`Unknown provider "${name}". Choose one of: ${Object.keys(PROVIDERS).join(', ')}.`);
    return p;
}
export function providerKey(p) {
    const key = env(p.envVar);
    if (!key)
        throw new MissingKeyError(p.envVar, `The ${p.name} provider uses your own ${p.name} API key.`);
    return key;
}
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Small on-disk cache for repeated provider requests, keyed by a hash of the request (never the key). */
export async function cached(namespace, parts, enabled, produce) {
    const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
    const file = join(cacheDir(), 'requests', namespace, `${hash}.json`);
    if (enabled) {
        try {
            const entry = JSON.parse(await readFile(file, 'utf8'));
            if (Date.now() - entry.at < CACHE_TTL_MS)
                return { value: entry.value, hit: true };
        }
        catch {
            // miss
        }
    }
    const value = await produce();
    await mkdir(join(cacheDir(), 'requests', namespace), { recursive: true, mode: 0o700 })
        .then(() => writeFile(file, JSON.stringify({ at: Date.now(), value }), 'utf8'))
        .catch(() => undefined);
    return { value, hit: false };
}
