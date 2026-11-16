import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * A button with a floating panel: a popover on wide screens, a bottom sheet
 * on phones (styles/shell.css). Escape and an outside press close it and
 * return focus to the button.
 */
export function Popover({
  label,
  panelLabel,
  className = '',
  buttonClassName = '',
  align = 'end',
  children,
  buttonProps,
}: {
  /** Content of the trigger button. */
  label: ReactNode;
  /** Accessible name of the panel. */
  panelLabel: string;
  className?: string;
  buttonClassName?: string;
  align?: 'start' | 'end';
  children: (close: () => void) => ReactNode;
  buttonProps?: { [name: `data-${string}`]: string | undefined };
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);
  return (
    <div className={`popover ${className}`} ref={root} data-open={open || undefined}>
      <button
        ref={button}
        type="button"
        className={buttonClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        {...buttonProps}
      >
        {label}
      </button>
      {open && (
        <>
          <div className="popover-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            id={panelId}
            className={`popover-panel popover-${align}`}
            role="dialog"
            aria-label={panelLabel}
          >
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}
