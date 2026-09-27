import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  engines: { node: string };
};

describe('package layout for GitHub installs', () => {
  it('has no script that makes npm "prepare" a Git dependency', () => {
    // npm (pacote) runs an inner install for Git deps that define any of these.
    // That inner install breaks `npm install -g` upgrades, so the repo ships dist/ instead.
    for (const name of ['build', 'prepare', 'prepack', 'preinstall', 'install', 'postinstall']) {
      expect(pkg.scripts, name).not.toHaveProperty(name);
    }
  });

  it('ships the committed CLI entry point and data', () => {
    expect(pkg.bin.ambassador).toBe('dist/bin.js');
    expect(() => readFileSync(new URL(`../${pkg.bin.ambassador}`, import.meta.url))).not.toThrow();
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'data/catalog-snapshot.json']));
    expect(pkg.engines.node).toBe('>=22');
  });
});
