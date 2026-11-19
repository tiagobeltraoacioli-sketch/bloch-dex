// scripts/multichain-finish.mjs, the second step of the multichain build: it must finish the directory it is given.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  // What a build copies from public/, shared with the Bloch L2 site.
  for (const file of ['404.html', 'social-preview.png'])
    copyFileSync(join(FRONTEND, 'public', file), join(dir, file));
  writeFileSync(
    join(dir, 'THIRD-PARTY-NOTICES.txt'),
    readFileSync(join(FRONTEND, 'public/THIRD-PARTY-NOTICES.txt'), 'utf8').slice(0, 2000),
  );
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

  // Review R412-7: three files of public/ name the site, and the multichain site is "Bloch DEX".
  it('names the multichain site in the 404 title, the notices and the preview image, in the output only', () => {
    const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const shared = ['404.html', 'social-preview.png', 'THIRD-PARTY-NOTICES.txt'].map((f) =>
      sha(join(FRONTEND, 'public', f)),
    );
    const dir = built();
    expect(readFileSync(join(dir, '404.html'), 'utf8')).toContain(
      '<title>Postern: no gate here</title>',
    );
    expect(finish(dir).status).toBe(0);
    const page = readFileSync(join(dir, '404.html'), 'utf8');
    expect(page).toContain('<title>Bloch DEX: no gate here</title>');
    expect(page).not.toMatch(/Postern:/);
    const notices = readFileSync(join(dir, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    expect(notices.split('\n')[2]).toBe(
      "This page is built from Bloch DEX's own code (MIT License, see the repository's LICENSE) and from the",
    );
    expect(notices).not.toContain('PosternDEX');
    // The image is the one rendered from the committed source, and the record of that rendering holds.
    const record = JSON.parse(
      readFileSync(join(FRONTEND, 'multichain-public/social-preview.json'), 'utf8'),
    );
    expect(sha(join(dir, 'social-preview.png'))).toBe(record.image.sha256);
    expect(sha(join(FRONTEND, 'multichain-public/social-preview.png'))).toBe(record.image.sha256);
    expect(sha(join(FRONTEND, 'multichain-public/social-preview.svg'))).toBe(record.source.sha256);
    const png = readFileSync(join(dir, 'social-preview.png'));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    const source = readFileSync(join(FRONTEND, 'multichain-public/social-preview.svg'), 'utf8');
    expect(source).toContain('>Bloch DEX</text>');
    expect(source).not.toMatch(/Postern(?!\.svg)/i);
    // Running it again changes nothing and does not fail.
    expect(finish(dir).status).toBe(0);
    expect(readFileSync(join(dir, '404.html'), 'utf8')).toBe(page);
    // The Bloch L2 site's own files are as they were.
    expect(
      ['404.html', 'social-preview.png', 'THIRD-PARTY-NOTICES.txt'].map((f) =>
        sha(join(FRONTEND, 'public', f)),
      ),
    ).toEqual(shared);
    expect(readFileSync(join(FRONTEND, 'public/404.html'), 'utf8')).toContain(
      '<title>Postern: no gate here</title>',
    );
  });

  it('refuses to finish when a sentence it must put right is gone, or the image is not its source’s', () => {
    const dir = built();
    writeFileSync(join(dir, '404.html'), '<title>Something else</title>');
    const run = finish(dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('404.html: expected exactly one');
  });

  it('refuses an image whose source changed since it was rendered, and an image that is not the rendered one', () => {
    const art = (change: (dir: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), 'postern-multichain-public-'));
      made.push(dir);
      for (const file of ['social-preview.svg', 'social-preview.png', 'social-preview.json'])
        copyFileSync(join(FRONTEND, 'multichain-public', file), join(dir, file));
      change(dir);
      return dir;
    };
    const run = (dir: string) =>
      spawnSync(process.execPath, ['scripts/multichain-finish.mjs', built()], {
        cwd: FRONTEND,
        encoding: 'utf8',
        env: { ...process.env, POSTERN_MULTICHAIN_PUBLIC: dir },
      });
    // An untouched copy passes: the refusals below are about the change, not the directory.
    expect(run(art(() => {})).status).toBe(0);
    const edited = run(
      art((dir) =>
        writeFileSync(
          join(dir, 'social-preview.svg'),
          readFileSync(join(dir, 'social-preview.svg'), 'utf8').replace(
            'Bloch DEX</text>',
            'Another name</text>',
          ),
        ),
      ),
    );
    expect(edited.status).not.toBe(0);
    expect(edited.stderr).toContain('social-preview.svg changed since the image was rendered');
    const swapped = run(
      art((dir) =>
        copyFileSync(join(FRONTEND, 'public/social-preview.png'), join(dir, 'social-preview.png')),
      ),
    );
    expect(swapped.status).not.toBe(0);
    expect(swapped.stderr).toContain('is not the image scripts/render-social-preview.mjs wrote');
  });
});
