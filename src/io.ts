import { access, readFile, writeFile } from 'node:fs/promises';
import type { ParseArgsConfig } from 'node:util';
import { UsageError } from './errors.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export type Values = Record<string, string | boolean | undefined>;
export type Handler = (positionals: string[], values: Values, io: Io) => Promise<number | void>;

export interface CommandSpec {
  options: NonNullable<ParseArgsConfig['options']>;
  run: Handler;
}

export async function writeNewFile(path: string, content: string, force: boolean): Promise<void> {
  if (!force) {
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (exists) throw new UsageError(`${path} already exists. Use --force to overwrite.`);
  }
  await writeFile(path, content, 'utf8');
}

export async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new UsageError(`Cannot read ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${path} is not valid JSON.`);
  }
}
