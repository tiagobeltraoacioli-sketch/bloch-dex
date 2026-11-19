#!/usr/bin/env node
// Renders multichain-public/social-preview.png from multichain-public/social-preview.svg, and writes
// multichain-public/social-preview.json (the SHA-256 of the source and of the image, and what rendered it):
//
//   node scripts/render-social-preview.mjs [--port 48090]
//
// The image is a build input, committed with its source: a build never renders it (no browser at build time),
// and scripts/multichain-finish.mjs refuses an image whose source changed since it was rendered. The renderer is
// the installed Chrome or Chromium, headless, through integration/browser/cdp.mjs; the two typefaces are the
// locked @fontsource-variable files, given to the page as data: URLs. Set CHROME_EXE to choose the browser.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage } from '../integration/browser/cdp.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const dir = join(here, 'multichain-public');
const at = process.argv.indexOf('--port');
const port = at >= 0 ? Number(process.argv[at + 1]) : 48090;
const chrome =
  process.env.CHROME_EXE ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);
if (!chrome) {
  console.error('no browser found; set CHROME_EXE to a Chrome or Chromium binary');
  process.exit(2);
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const svg = readFileSync(join(dir, 'social-preview.svg'), 'utf8');
const size = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
if (!size) throw new Error('the source has no viewBox');
const [width, height] = [Number(size[1]), Number(size[2])];
const font = (pkg, file) =>
  `data:font/woff2;base64,${readFileSync(join(here, 'node_modules/@fontsource-variable', pkg, 'files', file)).toString('base64')}`;
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: 'Fraunces Variable'; font-weight: 100 900; src: url(${font('fraunces', 'fraunces-latin-opsz-normal.woff2')}) format('woff2-variations'); }
@font-face { font-family: 'Inter Variable'; font-weight: 100 900; src: url(${font('inter', 'inter-latin-wght-normal.woff2')}) format('woff2-variations'); }
html, body { margin: 0; background: #0b0e0f; } svg { display: block; }
</style>${svg}`;

const browser = await launch(chrome, port);
try {
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const page = await openPage(browser, browserContextId, {
    initScript: '',
    url: 'about:blank',
    onBinding: () => {},
  });
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const { frameTree } = await page.cdp('Page.getFrameTree');
  await page.cdp('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  const fonts = await page.evaluate(
    `document.fonts.ready.then(() => Promise.all([document.fonts.load("450 52px 'Fraunces Variable'"), document.fonts.load("400 23px 'Inter Variable'")])).then((loaded) => loaded.map((l) => l.length))`,
  );
  if (fonts.some((n) => n < 1))
    throw new Error('a typeface did not load: the image would use a fallback');
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const { data } = await page.cdp('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  const png = Buffer.from(data, 'base64');
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height)
    throw new Error('the rendered image has another size than the source');
  writeFileSync(join(dir, 'social-preview.png'), png);
  writeFileSync(
    join(dir, 'social-preview.json'),
    `${JSON.stringify(
      {
        note: 'Written by scripts/render-social-preview.mjs. The image is the rendering of the source with these hashes.',
        source: { file: 'social-preview.svg', sha256: sha256(svg) },
        image: { file: 'social-preview.png', sha256: sha256(png), width, height },
        renderer: browser.product,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`social-preview.png: ${width} x ${height}, ${png.length} bytes, ${browser.product}`);
} finally {
  await browser.close();
}
