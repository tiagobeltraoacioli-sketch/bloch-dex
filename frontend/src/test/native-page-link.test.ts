import { afterEach, expect, it } from 'vitest';
import { installNativePageLink } from '../native-page-link';
let dispose = () => {};
afterEach(() => {
  dispose();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});
it('requires the exact server marker and leaves unrelated links unchanged', () => {
  document.body.innerHTML = '<nav aria-label="Main navigation"><a href="#/native">L1</a></nav>';
  dispose = installNativePageLink();
  expect(document.querySelector('a')?.getAttribute('href')).toBe('#/native');
  document.head.innerHTML = '<meta name="postern-native-page" content="https://attacker.test">';
  dispose();
  dispose = installNativePageLink();
  expect(document.querySelector('a')?.getAttribute('href')).toBe('#/native');
});
it('updates the native menu after React mounts and disconnects cleanly', async () => {
  document.head.innerHTML = '<meta name="postern-native-page" content="/l1/">';
  dispose = installNativePageLink();
  document.body.innerHTML =
    '<nav aria-label="Main navigation"><a href="#/native">L1</a><a href="#/onchain">EVM</a></nav><a href="#/native">Other</a>';
  await Promise.resolve();
  expect([...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
    '/l1/',
    '#/onchain',
    '#/native',
  ]);
  dispose();
  document.body.innerHTML = '<nav aria-label="Main navigation"><a href="#/native">L1</a></nav>';
  await Promise.resolve();
  expect(document.querySelector('a')?.getAttribute('href')).toBe('#/native');
});
