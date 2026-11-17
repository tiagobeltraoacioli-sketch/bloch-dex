import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { TokenMark } from './marks/TokenMark';
import type { Symbol } from './model';

export { Modal } from './ui/Modal';

export function TokenIcon({ symbol, small = false }: { symbol: Symbol; small?: boolean }) {
  return (
    <TokenMark
      symbol={symbol}
      size={0}
      className={`token-icon token-${symbol.toLowerCase()} ${small ? 'small' : ''}`}
    />
  );
}

export function PairIcons({ a, b }: { a: Symbol; b: Symbol }) {
  return (
    <span className="pair-icons">
      <TokenIcon symbol={a} />
      <TokenIcon symbol={b} />
    </span>
  );
}

export function Stat({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {children}
    </div>
  );
}

export function Detail({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="detail">
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function ExternalLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a className="text-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={16} />
    </a>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        P
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
