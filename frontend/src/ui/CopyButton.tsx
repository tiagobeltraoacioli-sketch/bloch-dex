import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from './toast';

/** Copies a value the page already shows (an address or a hash). Icon only; the name says what it copies. */
export function CopyButton({ value, what }: { value: string; what: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast(`Copied ${what}`);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('Copying is not available in this browser');
    }
  }
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={copied ? `Copied ${what}` : `Copy ${what}`}
      title={`Copy ${what}`}
      data-copied={copied || undefined}
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}
