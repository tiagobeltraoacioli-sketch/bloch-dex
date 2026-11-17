import { useEffect, useState } from 'react';

/** The width from which a live route sets the gate and the verification rail side by side (styles/gate.css). */
export const WIDE_QUERY = '(min-width: 1060px)';

/** Layout only: whether the rail is beside the gate. False where the environment cannot say. */
export function useWide(): boolean {
  const can = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [wide, setWide] = useState(() => can && window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    if (!can) return;
    const media = window.matchMedia(WIDE_QUERY);
    const on = () => setWide(media.matches);
    on();
    media.addEventListener?.('change', on);
    return () => media.removeEventListener?.('change', on);
  }, [can]);
  return wide;
}
