import { access, readFile, writeFile } from 'node:fs/promises';
import { UsageError } from './errors.js';
export async function writeNewFile(path, content, force) {
    if (!force) {
        const exists = await access(path).then(() => true, () => false);
        if (exists)
            throw new UsageError(`${path} already exists. Use --force to overwrite.`);
    }
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
