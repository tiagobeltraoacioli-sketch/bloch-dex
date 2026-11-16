import { describe, expect, it } from 'vitest';
import { socialTags } from '../../site-meta';
import indexHtml from '../../index.html?raw';

describe('social preview tags', () => {
  it('index.html carries no absolute URL of its own', () => {
    expect(indexHtml).not.toMatch(/https?:\/\//);
  });
  it('adds nothing without a configured site URL', () => {
    expect(socialTags(undefined)).toEqual([]);
    expect(socialTags('')).toEqual([]);
  });
  it('builds the absolute URLs from the configured site URL only', () => {
    const attrs = socialTags('https://dex.example/app').map((t) => t.attrs);
    expect(attrs).toContainEqual({ property: 'og:url', content: 'https://dex.example/app/' });
    expect(attrs).toContainEqual({
      property: 'og:image',
      content: 'https://dex.example/app/social-preview.png',
    });
  });
  it('refuses a URL that is not plain https', () => {
    for (const bad of [
      'http://dex.example',
      'https://u:p@dex.example',
      'https://dex.example/?a=1',
      'dex.example',
    ])
      expect(() => socialTags(bad)).toThrow();
  });
});
