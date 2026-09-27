import { access, readFile, writeFile } from 'node:fs/promises';
import { UsageError } from './errors.js';
/** Refuse to overwrite an existing file unless --force was given. */
export async function ensureWritable(path, force) {
    if (force)
        return;
    const exists = await access(path).then(() => true, () => false);
    if (exists)
        throw new UsageError(`${path} already exists. Use --force to overwrite.`);
}
export async function writeNewFile(path, content, force) {
    await ensureWritable(path, force);
    await writeFile(path, content, 'utf8');
}
export async function readJsonFile(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch {
        throw new UsageError(`Cannot read ${path}.`);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new UsageError(`${path} is not valid JSON.`);
    }
}
