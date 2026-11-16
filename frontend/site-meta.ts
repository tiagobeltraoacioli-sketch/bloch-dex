// Social-preview tags of index.html. The absolute URLs they need come from configuration
// (POSTERN_SITE_URL, the https origin and path the build is published at), never from an assumed
// domain: without it the tags that need an absolute URL are left out.
import type { HtmlTagDescriptor, Plugin } from 'vite';

export function socialTags(siteUrl: string | undefined): HtmlTagDescriptor[] {
  if (!siteUrl) return [];
  let base: URL;
  try {
    base = new URL(siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`);
  } catch {
    throw new Error('POSTERN_SITE_URL is not a URL');
  }
  if (base.protocol !== 'https:' || base.search || base.hash || base.username || base.password)
    throw new Error('POSTERN_SITE_URL must be a plain https URL');
  const meta = (property: string, content: string): HtmlTagDescriptor => ({
    tag: 'meta',
    attrs: { property, content },
    injectTo: 'head',
  });
  return [
    meta('og:url', base.href),
    meta('og:image', new URL('social-preview.png', base).href),
    meta('og:image:width', '1200'),
    meta('og:image:height', '630'),
    {
      tag: 'meta',
      attrs: { name: 'twitter:card', content: 'summary_large_image' },
      injectTo: 'head',
    },
  ];
}

export function siteMeta(siteUrl: string | undefined): Plugin {
  return { name: 'postern-site-meta', transformIndexHtml: () => socialTags(siteUrl) };
}
