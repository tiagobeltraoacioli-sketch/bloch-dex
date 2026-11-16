import { describe, expect, it } from 'vitest';
import { quoteRate } from '../ui/rate';

// A live route may never show a sample figure. The sample fixtures live in data.ts and are drawn by the preview
// screens; this walks the static imports of every live-route entry and fails when one of them can reach those
// modules. (A render check would only cover the states a test happens to reach.)
const SOURCES = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const FIXTURE_MODULES = [
  'data.ts',
  'components.tsx',
  'Chart.tsx',
  'Trade.tsx',
  'Pools.tsx',
  'Portfolio.tsx',
  'LiquidityDialog.tsx',
];
const LIVE_ENTRIES = [
  'MainnetLive.tsx',
  'Devnet4Live.tsx',
  'LivePools.tsx',
  'LivePoolsRuntime.tsx',
  'shell/Shell.tsx',
  'shell/NetworkSwitcher.tsx',
  'shell/WalletStatus.tsx',
];

const join = (dir: string, spec: string) => {
  const parts = dir ? dir.split('/') : [];
  for (const part of spec.split('/')) {
    if (part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
};
const has = (file: string) => `../${file}` in SOURCES;

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    for (const match of SOURCES[`../${file}`].matchAll(
      /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g,
    )) {
      const base = join(dir, match[1]);
      const target = [base, `${base}.ts`, `${base}.tsx`].find((c) => /\.tsx?$/.test(c) && has(c));
      if (target) queue.push(target);
    }
  }
  return [...seen];
}

describe('live routes and the sample fixtures', () => {
  it.each(LIVE_ENTRIES)('%s cannot reach a module that holds or draws sample data', (entry) => {
    const files = reachable(entry);
    expect(files.length).toBeGreaterThan(1);
    for (const fixture of FIXTURE_MODULES) expect(files).not.toContain(fixture);
  });

  it('the walk itself sees the fixtures from the preview screens', () => {
    expect(reachable('Trade.tsx')).toContain('data.ts');
    expect(reachable('App.tsx')).toContain('data.ts');
  });
});

describe('rate line of a quote', () => {
  it('is the output per whole input token, rounded down, from the quote figures only', () => {
    expect(quoteRate(10n ** 16n, 18, 863_627n)).toBe(86_362_700n);
    expect(quoteRate(10_000_000n, 6, 112_897_529_116_768_234n)).toBe(11_289_752_911_676_823n);
    expect(quoteRate(3n, 0, 10n)).toBe(3n);
    expect(quoteRate(0n, 18, 5n)).toBeNull();
  });
});
