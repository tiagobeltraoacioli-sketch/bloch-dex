import { useId, useLayoutEffect, useRef } from 'react';

/**
 * The gate: a segmental arch of dressed voussoirs over the swap card, with the lamp on its keystone. Decorative
 * (aria-hidden): the state it shows is always also written on the card. Geometry in design units of a 480-wide
 * gate; the drawing scales with the card. Colours and light come from the tokens and from `data-lamp` on the
 * card (styles/gate.css).
 */
const CX = 240;
const CY = 348;
const RO = 348; // extrados
const RI = 320; // intrados
const KEY = 3.7; // half-angle of the keystone, degrees
const END = 43.6; // the extrados meets the springing line here
const FOOT = 45.95; // the intrados meets the jamb here
const SIDE = 7; // voussoirs on each side of the keystone
const TOP = 84; // room above the crown for the lamp
export const ARCH_BOX = { width: 480, top: TOP, height: TOP + 131, crown: 96 };

const n = (v: number) => Math.round(v * 100) / 100;
const pt = (r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${n(CX + r * Math.sin(a))} ${n(CY - r * Math.cos(a))}`;
};
/** A stone between two radial joints (a1 < a2, degrees from the crown). */
const stone = (a1: number, a2: number, ro = RO, ri = RI) =>
  `M${pt(ro, a1)}A${ro} ${ro} 0 0 1 ${pt(ro, a2)}L${pt(ri, a2)}A${ri} ${ri} 0 0 0 ${pt(ri, a1)}Z`;

const step = (END - KEY) / SIDE;
const TONES = [1, 3, 2, 1, 2, 3, 1];
const STONE_CLASS = ['gate-stone-1', 'gate-stone-2', 'gate-stone-3'];
const VOUSSOIRS: { d: string; tone: number }[] = [];
for (let i = 0; i < SIDE - 1; i++) {
  const a1 = KEY + i * step;
  VOUSSOIRS.push({ d: stone(a1, a1 + step), tone: TONES[i] });
  VOUSSOIRS.push({ d: stone(-a1 - step, -a1), tone: TONES[(i + 3) % TONES.length] });
}
// The springers: the last stone of each side stands on the jamb.
const last = KEY + (SIDE - 1) * step;
const SPRINGERS = [
  `M${pt(RO, last)}A${RO} ${RO} 0 0 1 480 96L480 131L470 131L${pt(RI, FOOT)}A${RI} ${RI} 0 0 0 ${pt(RI, last)}Z`,
  `M${pt(RO, -last)}A${RO} ${RO} 0 0 0 0 96L0 131L10 131L${pt(RI, -FOOT)}A${RI} ${RI} 0 0 1 ${pt(RI, -last)}Z`,
];
const KEYSTONE = stone(-KEY, KEY, RO + 7, RI - 5);
const RING = `M0 96A${RO} ${RO} 0 0 1 480 96L480 131L470 131L${pt(RI, FOOT)}A${RI} ${RI} 0 0 0 ${pt(RI, -FOOT)}L10 131L0 131Z`;
const OPENING = `M${pt(RI, -FOOT)}A${RI} ${RI} 0 0 1 ${pt(RI, FOOT)}L470 132L10 132Z`;
const INTRADOS = `M${pt(RI, -FOOT)}A${RI} ${RI} 0 0 1 ${pt(RI, FOOT)}`;
const EXTRADOS = `M0 96A${RO} ${RO} 0 0 1 480 96`;

export function GateArch({ anchor = false }: { anchor?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const flame = useRef<SVGEllipseElement>(null);
  // Tells the shell where the lamp is, so the light on the wall falls from it (styles/gate.css). Decoration only.
  useLayoutEffect(() => {
    const el = flame.current;
    const shell = el?.closest<HTMLElement>('.app-shell');
    if (!anchor || !el || !shell) return;
    const place = () => {
      const a = el.getBoundingClientRect();
      const b = shell.getBoundingClientRect();
      if (a.width === 0 && a.height === 0) return;
      shell.style.setProperty('--lamp-x', `${Math.round(a.left + a.width / 2 - b.left)}px`);
      shell.style.setProperty('--lamp-y', `${Math.round(a.top + a.height / 2 - b.top)}px`);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(shell);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      shell.style.removeProperty('--lamp-x');
      shell.style.removeProperty('--lamp-y');
    };
  }, [anchor]);
  return (
    <svg
      className="gate-arch"
      viewBox={`0 ${-TOP} 480 ${TOP + 131}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={`${id}fall`} gradientUnits="userSpaceOnUse" cx="240" cy="-18" r="300">
          <stop offset="0" className="lamp-stop" stopOpacity="0.7" />
          <stop offset="0.35" className="lamp-stop" stopOpacity="0.22" />
          <stop offset="1" className="lamp-stop" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}recess`} gradientUnits="userSpaceOnUse" cx={CX} cy={CY} r={RI}>
          <stop offset="0.9" className="recess-stop" stopOpacity="0" />
          <stop offset="1" className="recess-stop" />
        </radialGradient>
        <radialGradient
          id={`${id}wash`}
          gradientUnits="userSpaceOnUse"
          cx="240"
          cy="28"
          r="103"
          gradientTransform="translate(240 28) scale(2.3 1) translate(-240 -28)"
        >
          <stop offset="0" className="lamp-stop" stopOpacity="0.2" />
          <stop offset="1" className="lamp-stop" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}glass`} cx="0.5" cy="0.62" r="0.7">
          <stop offset="0" className="glass-core" />
          <stop offset="1" className="glass-edge" />
        </radialGradient>
        <radialGradient id={`${id}shade`} gradientUnits="userSpaceOnUse" cx={CX} cy={CY} r={RO + 7}>
          <stop offset={n((RI - 5) / (RO + 7))} className="shade-lo" />
          <stop offset="1" className="shade-hi" />
        </radialGradient>
        <clipPath id={`${id}open`}>
          <path d={OPENING} />
        </clipPath>
      </defs>
      {/* The opening under the arch, its shade and the lamp's wash on it. */}
      <path className="gate-opening" d={OPENING} />
      <g clipPath={`url(#${id}open)`}>
        <path className="gate-wash" d={OPENING} fill={`url(#${id}wash)`} />
        <path d={OPENING} fill={`url(#${id}recess)`} />
      </g>
      {/* The ring of stones. */}
      {VOUSSOIRS.map((v, i) => (
        <path key={i} className={`gate-stone ${STONE_CLASS[v.tone - 1]}`} d={v.d} />
      ))}
      <path className="gate-stone gate-stone-2" d={SPRINGERS[0]} />
      <path className="gate-stone gate-stone-2" d={SPRINGERS[1]} />
      <path className="gate-shade" d={RING} fill={`url(#${id}shade)`} />
      <path className="gate-fall" d={RING} fill={`url(#${id}fall)`} />
      <path className="gate-stone gate-stone-3 gate-keystone" d={KEYSTONE} />
      <path className="gate-shade" d={KEYSTONE} fill={`url(#${id}shade)`} />
      <path className="gate-fall" d={KEYSTONE} fill={`url(#${id}fall)`} />
      <path className="gate-edge" d={EXTRADOS} />
      <path className="gate-rim" d={EXTRADOS} stroke={`url(#${id}fall)`} />
      <path className="gate-soffit" d={INTRADOS} />
      {/* The lamp on the keystone. */}
      <g className="gate-lamp" transform="translate(240 -7) scale(1.3) translate(-240 7)">
        <circle className="lamp-bloom" cx="240" cy="-21" r="26" />
        <circle className="lamp-ring" cx="240" cy="-21" r="24" />
        <path className="lamp-iron" d="M232.5 -7h15l-2.2 -4.6h-10.6Z" />
        <circle className="lamp-glass" cx="240" cy="-21" r="9.6" fill={`url(#${id}glass)`} />
        <ellipse ref={flame} className="lamp-flame" cx="240" cy="-20" rx="2.5" ry="4.6" />
        <path
          className="lamp-bars"
          d="M240 -11.4v-19.2M235.6 -12.5a22 22 0 0 1 0 -17M244.4 -12.5a22 22 0 0 0 0 -17M230.6 -21h18.8"
        />
        <path className="lamp-iron" d="M229.6 -28.6c2.4 -7 18.4 -7 20.8 0Z" />
        <circle className="lamp-iron" cx="240" cy="-36.4" r="1.7" />
      </g>
    </svg>
  );
}
