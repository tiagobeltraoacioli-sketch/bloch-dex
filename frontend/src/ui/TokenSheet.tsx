import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Modal } from './Modal';
import { TokenMark } from '../marks/TokenMark';

export type TokenChoice = { key: string; label: string; detail?: string };

/**
 * Token chooser of the live swap card: a chip that opens a sheet with the
 * tokens of the verified deployment. It owns no value: choosing calls
 * `onChoose` with the option's key, the same value the form's select passes.
 */
export function TokenSheet({
  caption,
  value,
  options,
  onChoose,
}: {
  /** "You pay" or "You receive". */
  caption: string;
  value: string;
  options: TokenChoice[];
  onChoose: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === value);
  return (
    <>
      <button
        type="button"
        className="token-chip"
        aria-haspopup="dialog"
        aria-label={`${caption}: ${current?.label ?? 'no token'}. Choose a token`}
        data-testid={`token-chip-${caption === 'You pay' ? 'pay' : 'receive'}`}
        onClick={() => setOpen(true)}
      >
        <TokenMark symbol={current?.label ?? '?'} size={28} />
        <span>{current?.label ?? 'Choose'}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <Modal title={`${caption}: choose a token`} onClose={() => setOpen(false)}>
          <ul className="token-sheet-list">
            {options.map((o) => (
              <li key={o.key}>
                <button
                  type="button"
                  className="token-sheet-row"
                  aria-pressed={o.key === value}
                  aria-label={`Choose ${o.label}`}
                  onClick={() => {
                    setOpen(false);
                    if (o.key !== value) onChoose(o.key);
                  }}
                >
                  <TokenMark symbol={o.label} size={36} />
                  <span className="token-sheet-name">{o.label}</span>
                  {o.detail && <span className="token-sheet-detail numeric">{o.detail}</span>}
                  {o.key === value && <Check size={16} aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
          <p className="microcopy">Only the tokens of the verified deployment record are listed.</p>
        </Modal>
      )}
    </>
  );
}
