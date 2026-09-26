import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from '../errors.js';

const STALE_MS = 15 * 60 * 1000;

/**
 * Local lock so two sync/restore runs on this computer cannot overlap. It does
 * not protect against another computer or a person editing the Sheet.
 */
export async function withLocalLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs > STALE_MS) await rm(file, { force: true });
  } catch {
    // no lock
  }
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch {
    const holder = await readFile(file, 'utf8').catch(() => 'unknown');
    throw new CliError(`Another sync or restore is running on this computer (lock ${file}, ${holder.trim()}). Wait for it or remove the lock if it is stale.`);
  }
  try {
    await handle.writeFile(`pid ${process.pid} since ${new Date().toISOString()}\n`);
    await handle.close();
    return await fn();
  } finally {
    await rm(file, { force: true });
  }
}
