// scripts/multichain-finish.mjs, the second step of the multichain build: it must finish the directory it is given.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import bundle from '../multichain/bundle';

// The tests run from frontend/ (vitest's root).
const FRONTEND = process.cwd();
const made: string[] = [];
const built = () => {
  const dir = mkdtempSync(join(tmpdir(), 'postern-multichain-finish-'));
  made.push(dir);
  writeFileSync(join(dir, 'multichain.html'), '<!doctype html><title>built page</title>');
  return dir;
};
const finish = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/multichain-finish.mjs', ...args], {
    cwd: FRONTEND,
    encoding: 'utf8',
  });
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('multichain-finish.mjs', () => {
  it('finishes the directory it is given, without --bundle: index.html and the multichain _headers there', () => {
    const dir = built();
    const standard = join(FRONTEND, 'dist-multichain', '_headers');
    const before = existsSync(standard) ? statSync(standard).mtimeMs : null;
    const run = finish(dir);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${dir}/index.html`);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('built page');
    expect(existsSync(join(dir, 'multichain.html'))).toBe(false);
    const headers = readFileSync(join(dir, '_headers'), 'utf8');
    expect(headers.split('\n')[0]).toMatch(/multichain/);
    expect(headers).toContain('upgrade-insecure-requests');
    // The default directory was not the one written (before agent 410 the given directory was ignored).
    expect(existsSync(standard) ? statSync(standard).mtimeMs : null).toBe(before);
  });

  it('with --bundle FILE the directory may come before or after the flag, and the policy names the bundle’s endpoints', () => {
    const rehearsal = (bundle as { network: { rpc: { urls: string[] } }; record: unknown }[]).map(
      (entry, i) => ({
        ...entry,
        network: {
          ...entry.network,
          rpc: { ...entry.network.rpc, urls: [`http://127.0.0.1:${48090 + i}`] },
        },
      }),
    );
    for (const order of ['before', 'after'] as const) {
      const dir = built();
      const file = join(dir, 'bundle.json');
      writeFileSync(file, JSON.stringify(rehearsal));
      const run =
        order === 'before' ? finish(dir, '--bundle', file) : finish('--bundle', file, dir);
      expect(run.status).toBe(0);
      const headers = readFileSync(join(dir, '_headers'), 'utf8');
      expect(headers).toContain('http://127.0.0.1:48090');
      // A rehearsal is served over plain http.
      expect(headers).not.toContain('upgrade-insecure-requests');
      expect(existsSync(join(dir, 'index.html'))).toBe(true);
    }
  });
});
