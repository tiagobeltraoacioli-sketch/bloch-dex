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
// The preview screens' stylesheet stays in the token system (tokens.css): type sizes, spacing, radii, colours and
// the font come from tokens; no name of the pre-redesign stylesheet.
{
  const file = join(src, 'styles/preview.css');
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const problem = (line, why) => {
    dead++;
    console.log(`styles/preview.css: ${why}: ${line.trim()}`);
  };
  for (const [, prop, value] of css.matchAll(/(?<![\w-])([a-z-]+): ([^;{}]+);/g)) {
    const line = `${prop}: ${value}`;
    if (prop === 'font-size' && !/^var\(--text-[a-z]+\)$/.test(value.trim())) problem(line, 'a type size outside the scale');
    if (/^(gap|row-gap|column-gap|padding|margin)(-(top|right|bottom|left))?$/.test(prop) && /(?<![\w.-])-?(?:[3-9]|\d{2,})px/.test(value)) problem(line, 'spacing outside the 4-point scale');
    if (prop === 'border-radius' && /\dpx/.test(value)) problem(line, 'a radius outside the tokens');
    if (prop === 'font-family' && !/^var\(--font-/.test(value.trim())) problem(line, 'a font outside the tokens');
    if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(value)) problem(line, 'a colour outside the tokens');
    if (/var\(--(muted|subtle|accent|accent-hover|panel|panel-hover|blue|radius)\)/.test(value)) problem(line, 'a name of the pre-redesign stylesheet');
  }
}
console.log(`${classes} class selectors checked, ${dead} problem(s)`);
process.exit(dead ? 1 : 0);
