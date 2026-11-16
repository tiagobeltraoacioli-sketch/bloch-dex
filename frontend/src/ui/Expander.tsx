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
}: {
  className?: string;
  more: string;
  less: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`expander ${className}`} data-expanded={expanded || undefined}>
      {children}
      <button
        type="button"
        className="expander-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? less : more}
        <ChevronDown size={16} aria-hidden="true" className="disclosure-chevron" />
      </button>
    </div>
  );
}
