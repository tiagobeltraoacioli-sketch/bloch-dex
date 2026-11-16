#!/usr/bin/env node
// No dead CSS: node scripts/check-css.mjs
// Fails when a class selector of src/styles/*.css is not referenced by any source file under src/
// (tests excluded), or when a stylesheet uses text-transform (machine-read text must stay as written).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = new URL('../src/', import.meta.url).pathname;
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'test' ? [] : walk(path)) : [path];
  });
const files = walk(src);
const code = files.filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
const words = new Set(code.match(/[A-Za-z][A-Za-z0-9_-]*/g));
// Classes built from a template in the source: `token-${symbol}`, `popover-${align}`.
const TEMPLATED = [/^token-(blch|usdc|weth|ustav)$/, /^popover-(start|end)$/];
let dead = 0;
let classes = 0;
for (const file of files.filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
  if (/text-transform\s*:/.test(css)) {
    dead++;
    console.log(`${file}: text-transform is not allowed`);
  }
  const selectors = css.replace(/\{[^{}]*\}/g, '{}');
  for (const name of new Set([...selectors.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]))) {
    classes++;
    if (!words.has(name) && !TEMPLATED.some((t) => t.test(name))) {
      dead++;
      console.log(`${file.slice(src.length)}: .${name} is used by no source file`);
    }
  }
}
console.log(`${classes} class selectors checked, ${dead} problem(s)`);
process.exit(dead ? 1 : 0);
