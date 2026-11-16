import { useEffect, useSyncExternalStore } from 'react';
import { Check } from 'lucide-react';

/** Short confirmations of interface actions (a copied address). Never used for transaction outcomes. */
type Toast = { id: number; text: string };
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, ms = 2200) {
  const id = nextId++;
  toasts = [...toasts.slice(-2), { id, text }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, ms);
}

export function Toaster() {
  const list = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
  useEffect(
    () => () => {
      toasts = [];
    },
    [],
  );
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {list.map((t) => (
        <div className="toast" key={t.id}>
          <Check size={16} aria-hidden="true" />
          {t.text}
        </div>
      ))}
    </div>
  );
}
