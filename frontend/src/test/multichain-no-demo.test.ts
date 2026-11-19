// Round 20 (agent 411): the multichain site's screens are the preview's layout over the chain, never over the
// preview's data. No module of the sample-data preview is reachable from the multichain entry, so none of its
// figures or symbols can be in that bundle (scripts/check-production-bundle.mjs --multichain looks for their
// literals in the built files as well).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(__dirname, '..');
const PREVIEW_ONLY = [
  'data.ts',
  'model.ts',
  'App.tsx',
  'Trade.tsx',
  'Pools.tsx',
  'Portfolio.tsx',
  'LiquidityDialog.tsx',
  'Chart.tsx',
  'components.tsx',
  'LivePools.tsx',
];

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    // Every import that brings code or values (a type-only import is erased by the compiler).
    for (const m of text.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?from\s+)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    )) {
      const base = join(dirname(file), (m[1] ?? m[2])!);
      const found = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
        (p) => existsSync(p) && /\.(ts|tsx|css|json)$/.test(p),
      );
      if (found && /\.tsx?$/.test(found)) queue.push(found);
    }
  }
  return seen;
}

describe('the multichain site and the sample-data preview', () => {
  it('no module of the preview is reachable from the multichain entry', () => {
    const files = reachable(join(src, 'multichain-main.tsx'));
    // The walk really followed the site: its route, the new screens and their logic are in it.
    for (const expected of [
      'MultichainApp.tsx',
      'MainnetLive.tsx',
      'live/LiveScreens.tsx',
      'live/LiveLiquidityDialog.tsx',
      'mainnet/liquidity.ts',
      'mainnet/pendingswap.ts',
    ])
      expect(files.has(join(src, expected)), expected).toBe(true);
    expect(PREVIEW_ONLY.filter((name) => files.has(join(src, name)))).toEqual([]);
  });

  it('the walk would see such an import: the Bloch L2 site does reach the preview', () => {
    const files = reachable(join(src, 'main.tsx'));
    expect(files.has(join(src, 'data.ts'))).toBe(true);
    expect(files.has(join(src, 'Trade.tsx'))).toBe(true);
  });
});
