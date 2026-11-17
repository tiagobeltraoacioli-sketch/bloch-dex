import type { CSSProperties } from 'react';

/**
 * A large figure whose digits arrive one by one. Each character is its own box keyed by place and value, so a
 * digit that changed is drawn again and the stylesheet lets it roll in (not at all under reduced motion). The
 * text content is exactly `text`. `--chars` lets the stylesheet fit a long figure to its line instead of
 * cutting it.
 */
export function Figure({
  text,
  className = '',
  empty = false,
}: {
  text: string;
  className?: string;
  empty?: boolean;
}) {
  return (
    <span
      className={`figure ${className}`}
      data-empty={empty || undefined}
      style={{ '--chars': Math.max(1, text.length) } as CSSProperties}
    >
      {[...text].map((ch, i) => (
        <span
          key={`${i}:${ch}`}
          className="figure-char"
          data-mark={/[0-9]/.test(ch) ? undefined : true}
          style={{ '--i': i } as CSSProperties}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}
