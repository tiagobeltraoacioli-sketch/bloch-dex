import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Shows the essential rows of its content and, on request, all of them. The
 * content is always rendered; the stylesheet hides rows that are not marked
 * `.glance` while it is collapsed.
 */
export function Expander({
  className = '',
  more,
  less,
  children,
  defaultExpanded = false,
  onToggle,
}: {
  className?: string;
  more: string;
  less: string;
  children: ReactNode;
  defaultExpanded?: boolean;
  /** Told the new state when the user toggles it. */
  onToggle?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className={`expander ${className}`} data-expanded={expanded || undefined}>
      {children}
      <button
        type="button"
        className="expander-toggle"
        aria-expanded={expanded}
        onClick={() => {
          onToggle?.(!expanded);
          setExpanded(!expanded);
        }}
      >
        {expanded ? less : more}
        <ChevronDown size={16} aria-hidden="true" className="disclosure-chevron" />
      </button>
    </div>
  );
}
