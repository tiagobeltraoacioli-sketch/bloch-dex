import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Native modal dialog (moved unchanged from components.tsx so that live routes can use it without the sample fixtures). */
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  network,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /**
   * The lamp key of the network the dialog belongs to (styles/tokens.css). The dialog is rendered at the end of
   * the document, outside the shell that carries the key, so a dialog of a live route names it itself.
   */
  network?: string;
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
      data-network={network}
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
