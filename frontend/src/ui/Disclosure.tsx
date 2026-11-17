import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * A button that shows or hides a region. The region is always rendered (its
 * fields keep their values and stay reachable by label); closed, it is hidden
 * by the stylesheet and inert.
 */
export function Disclosure({
  className = '',
  summary,
  children,
  defaultOpen = false,
  clip = false,
  onToggle,
}: {
  className?: string;
  /** Content of the toggle button; told whether the region is open. */
  summary: (open: boolean) => ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /**
   * Closed, the region is clipped to no height instead of removed from rendering: its text is still part of the
   * page's text (tools that read the page see it), it is inert and takes no space.
   */
  clip?: boolean;
  /** Told the new state when the user toggles it. */
  onToggle?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div
      className={`disclosure ${clip ? 'disclosure-clip' : ''} ${className}`}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          onToggle?.(!open);
          setOpen(!open);
        }}
      >
        {summary(open)}
        <ChevronDown size={16} aria-hidden="true" className="disclosure-chevron" />
      </button>
      <div id={id} className="disclosure-region" inert={!open}>
        {children}
      </div>
    </div>
  );
}
