// Rules of the shared shell that a screenshot would catch too late: which site a header rule belongs to
// (review R412-4), and where a header popover's sheet is placed at phone width (agent 410, R410-O3). jsdom lays
// nothing out, so these read the stylesheets and the rendered attribute; the real placement is asserted in a
// browser by frontend/integration/browser/multichain-walletconnect.mjs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Shell } from '../shell/Shell';

// Read from disk: under vitest a stylesheet import, `?raw` included, is an empty string. The tests run from
// frontend/ (vitest's root).
const STYLES = join(process.cwd(), 'src/styles');
const SHEETS: Record<string, string> = Object.fromEntries(
  readdirSync(STYLES)
    .filter((name) => name.endsWith('.css'))
    .map((name) => [`../styles/${name}`, readFileSync(join(STYLES, name), 'utf8')]),
);
const gate = SHEETS['../styles/gate.css'];
const postern = SHEETS['../styles/postern.css'];

/** The body of the first top-level `@media (max-width: 640px)` block that holds `needle`. */
function phoneBlock(css: string, needle: string): string {
  let from = 0;
  for (;;) {
    const at = css.indexOf('@media (max-width: 640px) {', from);
    if (at < 0) throw new Error(`no phone block holds ${needle}`);
    let depth = 0;
    let end = at;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = css.slice(at, end);
    if (body.includes(needle)) return body;
    from = end;
  }
}
const rule = (block: string, selector: string) => {
  const at = block.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return block.slice(at, block.indexOf('}', at));
};

describe('the header rule for five or more navigation links (R412-4)', () => {
  it('belongs to the multichain shell only: every selector of it starts at the marked shell', () => {
    expect(Object.keys(SHEETS)).toContain('../styles/gate.css');
    expect(gate.length).toBeGreaterThan(10_000);
    const selectors = gate
      .split('\n')
      .filter(
        (line) => line.includes(':has(.main-nav a:nth-child(5))') && line.trim().endsWith('{'),
      );
    expect(selectors).toHaveLength(5);
    for (const selector of selectors)
      expect(selector.trim()).toMatch(
        /^\.app-shell\[data-site='multichain'\] \.topbar-inner:has\(\.main-nav a:nth-child\(5\)\)/,
      );
    // And nothing else in the shared stylesheets counts navigation links without naming a site.
    for (const css of Object.values(SHEETS))
      for (const line of css.split('\n'))
        if (line.includes(':has(.main-nav')) expect(line).toContain("[data-site='multichain']");
  });
  it('the shell carries the mark only when a site sets it', () => {
    const frame = (site?: 'multichain') =>
      render(
        <Shell
          network="mainnet"
          brandLabel="home"
          navLabel="nav"
          nav={null}
          actions={null}
          footer={null}
          site={site}
        >
          page
        </Shell>,
      ).container.querySelector('.app-shell')!;
    expect(frame().hasAttribute('data-site')).toBe(false);
    expect(frame('multichain').getAttribute('data-site')).toBe('multichain');
  });
});

describe('a popover at phone width (R410-O3)', () => {
  const block = phoneBlock(postern, '.popover-panel {');
  it('is a sheet placed from the top edge and moved up by its own height, never from "bottom: 0"', () => {
    const panel = rule(block, '.popover-panel');
    expect(panel).toMatch(/position: fixed;/);
    expect(panel).toMatch(/top: 100vh;\s+top: 100dvh;/);
    expect(panel).toMatch(/bottom: auto;/);
    expect(panel).toMatch(/transform: translateY\(-100%\);/);
    expect(panel).not.toMatch(/bottom: 0/);
    expect(panel).not.toMatch(/top: auto/);
    // Its entrance must end where the rule puts it (the default entrance ends at "no transform").
    expect(panel).toMatch(/animation-name: postern-sheet-rise;/);
    expect(postern).toMatch(
      /@keyframes postern-sheet-rise \{\s+from \{\s+opacity: 0;\s+transform: translateY\(calc\(-100% \+ 8px\)\);\s+\}\s+to \{\s+opacity: 1;\s+transform: translateY\(-100%\);/,
    );
  });
  it('its scrim is one screen tall from the same edge, not "inset: 0" of whatever contains it', () => {
    const scrim = rule(block, '.popover-scrim');
    expect(scrim).toMatch(/top: 0;/);
    expect(scrim).toMatch(/height: 100vh;\s+height: 100dvh;/);
    expect(scrim).toMatch(/bottom: auto;/);
    expect(scrim).not.toMatch(/inset: 0/);
  });
  it('the header note of a page without a connect step is not a sheet: it sits under the header', () => {
    const note = rule(
      phoneBlock(postern, '.wallet-unavailable {'),
      '.wallet-connect-entry .wallet-unavailable',
    );
    expect(note).toMatch(/position: absolute;/);
    expect(note).toMatch(/transform: none;/);
  });
});
