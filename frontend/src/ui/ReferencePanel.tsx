import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * The reference layer of a live route (pools, network, deployment record,
 * bridges). Docked, it is part of the page. Otherwise it is a side panel (a
 * sheet on phones) opened from the trust strip. Its children are rendered in
 * every mode, in the same place of the tree, so nothing inside remounts.
 */
export function ReferencePanel({
  docked,
  open,
  onClose,
  title,
  children,
}: {
  docked: boolean;
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const floating = !docked;
  useEffect(() => {
    if (!floating || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose();
      if (event.key !== 'Tab' || !panel.current) return;
      // Keep Tab inside the open panel: the page behind it is under the scrim.
      const stops = [
        ...panel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.closest('[inert]'));
      if (stops.length === 0) return event.preventDefault();
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!panel.current.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floating, open]);
  return (
    <>
      {floating && open && <div className="reference-scrim" aria-hidden="true" onClick={onClose} />}
      <aside
        ref={panel}
        className="reference"
        data-mode={docked ? 'docked' : 'panel'}
        data-open={floating && open ? true : undefined}
        aria-label={title}
        role={floating ? 'dialog' : undefined}
        aria-modal={floating && open ? true : undefined}
        tabIndex={-1}
        inert={floating && !open}
      >
        {floating && (
          <div className="reference-head">
            <h2>{title}</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close details"
              onClick={onClose}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
        )}
        {children}
      </aside>
    </>
  );
}
