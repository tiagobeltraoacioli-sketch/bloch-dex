import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, X } from 'lucide-react';
import { TOKENS } from './data';
import type { Symbol } from './model';

export function TokenIcon({ symbol, small = false }: { symbol: Symbol; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`token-icon token-${symbol.toLowerCase()} ${small ? 'small' : ''}`}
    >
      {TOKENS[symbol].glyph}
    </span>
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

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Capture before React applies autoFocus to any field inside the portal.
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      const previous = returnFocus.current;
      if (previous?.isConnected) previous.focus();
      else document.getElementById('main-content')?.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>,
    document.body,
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
