// The bridge route's presentational pieces. Each takes plain data (a route, a quote, a status) and decides
// nothing; the page (BridgePage.tsx) owns every read and every wallet request. Styles: styles/bridge.css, tokens only.
import type { ReactNode } from 'react';
import { CircleCheck, Clock, Hourglass, Info, OctagonAlert, ShieldAlert, TriangleAlert } from 'lucide-react';
import { CopyButton } from '../ui/CopyButton';
import { formatAmount } from '../amm';
import type { RouteEntry, RouteStatus, Route, WrappedToken } from './config';
import type { LimitLine, Quote, Risk, Waits } from './quote';
import type { Status, StatusAction } from './status';

// ── marks ────────────────────────────────────────────────────────────────────
// One place for every asset and network mark of the route. Today a letter in the shared tile (the site bundles no
// third-party logo); the design pass replaces the body of these two components with its mark component.
const NETWORK_GLYPH: Record<string, string> = {
  'bloch-l2': 'B',
  ethereum: 'E',
  'arbitrum-one': 'A',
  'op-mainnet': 'OP',
  linea: 'L',
  base: 'Ba',
  bitcoin: '₿',
  solana: 'S',
  tron: 'T',
  stellar: 'X',
};
export function NetworkMark({ id, name }: { id: string; name: string }) {
  return (
    <span className="network-tile" data-network={id} aria-hidden="true" title={name}>
      {NETWORK_GLYPH[id] ?? name.slice(0, 2)}
    </span>
  );
}
/** An asset with the badge of the network it lives on: `bUSDC.arb` is drawn as USDC with the Bloch L2 badge and the source's letter. */
export function AssetMark({ symbol, networkId, networkName }: { symbol: string; networkId: string; networkName: string }) {
  return (
    <span className="bridge-asset-mark" aria-hidden="true">
      <span className="token-glyph">{symbol.replace(/^b(?=[A-Z])/, '').slice(0, 1)}</span>
      <span className="bridge-asset-badge" data-network={networkId} title={networkName}>
        {NETWORK_GLYPH[networkId] ?? networkName.slice(0, 1)}
      </span>
    </span>
  );
}

// ── panels ───────────────────────────────────────────────────────────────────
const TONE_ICON = { info: Info, warn: TriangleAlert, danger: OctagonAlert, ok: CircleCheck, wait: Clock, action: ShieldAlert } as const;

/** A titled block with a tone rail. Required text lives in these; none of them collapses. */
export function Panel({
  tone,
  title,
  children,
  label,
  role,
  testId,
}: {
  tone: keyof typeof TONE_ICON;
  title: string;
  children: ReactNode;
  label?: string;
  role?: 'status' | 'alert';
  testId?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div className="bridge-panel" data-tone={tone} role={role} aria-label={label ?? title} data-testid={testId}>
      <p className="bridge-panel-title">
        <Icon size={16} aria-hidden="true" /> {title}
      </p>
      <div className="bridge-panel-body">{children}</div>
    </div>
  );
}

export const statusWord = (status: RouteStatus): string =>
  status.state === 'live' ? 'Live' : status.state === 'not-live' ? 'Not live' : status.state === 'not-available-yet' ? 'Not available yet' : 'Unreadable';

export function NetworkPicker({ entries, value, onChoose }: { entries: RouteEntry[]; value: string; onChoose: (id: string) => void }) {
  return (
    <div className="bridge-networks" role="radiogroup" aria-label="Source network">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="radio"
          aria-checked={entry.id === value}
          className="bridge-network"
          data-state={entry.status.state}
          onClick={() => onChoose(entry.id)}
        >
          <NetworkMark id={entry.id} name={entry.name} />
          <span className="bridge-network-name">{entry.name}</span>
          <span className="bridge-network-asset">{entry.route ? entry.route.asset.symbol : ''}</span>
          <span className="bridge-network-state" data-state={entry.status.state}>
            {statusWord(entry.status)}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Why nothing can be sent on this route, on the page, never behind a click. */
export function RouteState({ entry, l2Reasons }: { entry: RouteEntry; l2Reasons: string[] }) {
  const { status } = entry;
  if (status.state === 'unreadable')
    return (
      <Panel tone="danger" title={`The bridge file of ${entry.name} cannot be read`} role="alert" testId="route-state">
        <p>
          This page understands only a complete file of the format it was reviewed against, and shows nothing it cannot
          check: {status.reason}. No amount, address or transaction is shown for {entry.name}.
        </p>
      </Panel>
    );
  if (status.state === 'not-available-yet')
    return (
      <Panel tone="warn" title={`${entry.name}: not available yet`} role="status" testId="route-state">
        <p>{status.reason}</p>
        <p>Nothing can be deposited or withdrawn on this network from this page, and no address is shown for it.</p>
      </Panel>
    );
  const reasons = [...l2Reasons, ...(status.state === 'not-live' ? status.reasons : [])];
  if (reasons.length === 0) return null;
  return (
    <Panel tone="warn" title={`${entry.name}: not live`} role="status" testId="route-state">
      <p>
        This bridge is not deployed. The page builds no transaction, shows no deposit address and asks your wallet
        nothing for it. The figures below are the bridge's published proposal, shown so you can read them before it
        opens.
      </p>
      <ul className="bridge-reasons">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </Panel>
  );
}

export function QuoteBlock({ quote, direction }: { quote: Quote; direction: 'deposit' | 'exit' }) {
  return (
    <div className="bridge-block" aria-label="Amounts and fees" data-testid="bridge-quote">
      <h3>What you pay and receive</h3>
      <dl className="bridge-lines">
        {quote.lines.map((line) => (
          <div key={line.label} className="bridge-line" data-kind={line.kind}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
            {line.note && <p className="bridge-line-note">{line.note}</p>}
          </div>
        ))}
      </dl>
      {quote.problems.map((problem) => (
        <p key={problem} className="form-error" role="alert">
          {problem}
        </p>
      ))}
      {quote.ok && quote.receiveIsMinimum && (
        <p className="microcopy">The amount received is the least you get: it is computed at the fee ceiling you named.</p>
      )}
      {quote.ok && direction === 'deposit' && <p className="microcopy">Fees round down, never up: you are credited exactly the amount shown.</p>}
    </div>
  );
}

export function LimitsBlock({ lines }: { lines: LimitLine[] }) {
  return (
    <div className="bridge-block" aria-label="Limits" data-testid="bridge-limits">
      <h3>Minimums and limits</h3>
      <dl className="bridge-lines">
        {lines.map((line) => (
          <div key={line.label} className="bridge-line">
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      <p className="microcopy">Fixed when the bridge is deployed; no key can change them afterwards.</p>
    </div>
  );
}

export function WaitsBlock({ waits }: { waits: Waits }) {
  return (
    <div className="bridge-block" aria-label="How long it takes" data-testid="bridge-waits">
      <h3>How long it takes</h3>
      <p className="bridge-total">
        <Hourglass size={16} aria-hidden="true" /> Usually <strong>{waits.total}</strong>
        {waits.worst && <> ; in the worst case {waits.worst}</>}
      </p>
      <ol className="bridge-waits">
        {waits.steps.map((step) => (
          <li key={step.label}>
            <span className="bridge-wait-head">
              <span className="bridge-wait-label">{step.label}</span>
              <span className="bridge-wait-time">{step.typical}</span>
            </span>
            <span className="bridge-wait-detail">{step.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function RisksBlock({ risks }: { risks: Risk[] }) {
  return (
    <div className="bridge-risks" aria-label="Risks of this route" data-testid="bridge-risks">
      <h3>Risks of this route</h3>
      {risks.map((risk) => (
        <Panel key={risk.id} tone={risk.tone} title={risk.title}>
          <p>{risk.body}</p>
        </Panel>
      ))}
    </div>
  );
}

// ── status ───────────────────────────────────────────────────────────────────
export function Timeline({ steps, current, tone }: { steps: string[]; current: number; tone: Status['tone'] }) {
  return (
    <ol className="bridge-timeline" aria-label="Progress">
      {steps.map((step, i) => (
        <li key={step} data-step={i < current ? 'done' : i === current ? (tone === 'ok' ? 'done' : 'current') : 'todo'} data-tone={i === current ? tone : undefined}>
          <span className="bridge-timeline-dot" aria-hidden="true" />
          <span className="bridge-timeline-label">{step}</span>
        </li>
      ))}
    </ol>
  );
}

export function StatusCard({
  heading,
  reference,
  status,
  onAction,
  busy,
  children,
}: {
  /** "Exit of 25 bUSDC.sol", "Deposit of 0.5 bBTC". */
  heading: string;
  /** A hash or id the user can copy, with what it is. */
  reference?: { what: string; value: string; href?: string };
  status: Status;
  /** Called for an action the page itself can send; actions without it are shown as instructions. */
  onAction?: (action: StatusAction) => void;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <article className="bridge-status" data-state={status.state} data-tone={status.tone} aria-label={heading}>
      <header className="bridge-status-head">
        <h4>{heading}</h4>
        <span className="state-pill" data-tone={status.tone}>
          {status.tone === 'ok' ? 'done' : status.tone === 'danger' ? 'held' : status.tone === 'action' ? 'your turn' : 'waiting'}
        </span>
      </header>
      <Timeline steps={status.steps} current={status.step} tone={status.tone} />
      <p className="bridge-status-title" role="status">
        {status.title}
      </p>
      <p className="bridge-status-body">{status.body}</p>
      {status.actions.length > 0 && (
        <div className="bridge-status-actions" aria-label="What you can do">
          {status.actions.map((action) => (
            <div key={action.id} className="bridge-status-action">
              {onAction && (action.id === 'execute-credit' || action.id === 'drain-credits' || action.id === 'claim-direct-burn') ? (
                <button type="button" className="button secondary" disabled={busy} onClick={() => onAction(action)}>
                  {action.label}
                </button>
              ) : (
                <strong>{action.label}</strong>
              )}
              <span className="microcopy">{action.detail}</span>
            </div>
          ))}
        </div>
      )}
      {status.actions.length === 0 && status.tone !== 'ok' && <p className="microcopy bridge-status-nothing">Nothing for you to do in this state.</p>}
      {reference && (
        <p className="hashline">
          <span className="muted">{reference.what}</span> <code>{reference.value}</code>
          <CopyButton value={reference.value} what={reference.what} />
        </p>
      )}
      {children}
    </article>
  );
}

// ── tokens ───────────────────────────────────────────────────────────────────
/** Every wrapped token, each as its own asset: name, network, and what it is not. */
export function WrappedTokenList({ tokens, compact }: { tokens: WrappedToken[]; compact?: boolean }) {
  return (
    <div className="bridge-tokens" aria-label="Wrapped tokens on the Bloch L2" data-testid="wrapped-tokens">
      {!compact && (
        <>
          <h2>Wrapped tokens on the Bloch L2</h2>
          <p className="microcopy">
            One token per asset and network, each backed by its own vault with its own cap. They are different tokens:
            none of them is the asset itself, and none can be exchanged for another except by trading in a pool.
          </p>
        </>
      )}
      <ul className="bridge-token-list">
        {tokens.map((token) => (
          <li key={token.symbol} className="bridge-token" data-offered={token.offered}>
            <AssetMark symbol={token.asset.symbol} networkId={token.network.id} networkName={token.network.name} />
            <span className="bridge-token-names">
              <strong>{token.symbol}</strong>
              <span className="muted">{token.name}</span>
            </span>
            <span className="bridge-token-what">
              {token.asset.symbol} from {token.network.name}
              {token.offered === 'not-available-yet' && <span className="chip">Not available yet</span>}
            </span>
            <span className="bridge-token-address">
              {token.address ? (
                <>
                  <code>{token.address}</code>
                  <CopyButton value={token.address} what={`${token.symbol} address`} />
                </>
              ) : (
                <span className="muted">Not deployed</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A value the user must copy exactly (an address, a payload, a message), in a mono block with its own copy button. */
export function Exact({ label, value, what }: { label: string; value: string; what?: string }) {
  return (
    <div className="bridge-exact">
      <span className="bridge-exact-label">{label}</span>
      <code>{value}</code>
      <CopyButton value={value} what={what ?? label} />
    </div>
  );
}

export function RouteFacts({ route }: { route: Route }) {
  const unit = route.asset.unitsPerCustodyUnit;
  return (
    <div className="bridge-block" aria-label="Route details" data-testid="bridge-facts">
      <h3>Route details</h3>
      <dl className="bridge-lines">
        <div className="bridge-line">
          <dt>Asset on {route.name}</dt>
          <dd>
            {route.asset.name} ({route.asset.symbol}), issuer: {route.asset.issuer.split(' (')[0]}
          </dd>
          <p className="bridge-line-note bridge-break">{route.asset.id}</p>
        </div>
        <div className="bridge-line">
          <dt>Token on the Bloch L2</dt>
          <dd>
            {route.l2.name} ({route.l2.symbol}), {route.l2.decimals} decimals
          </dd>
          {unit > 1n && (
            <p className="bridge-line-note">
              One unit of {route.l2.symbol} is {formatAmount(unit, route.asset.decimals)} {route.asset.symbol}; finer amounts cannot be bridged.
            </p>
          )}
        </div>
        <div className="bridge-line">
          <dt>Custody</dt>
          <dd>
            {route.committee.threshold} signatures of the committee; guardians can only pause
          </dd>
        </div>
        <div className="bridge-line">
          <dt>Bridge fees go to</dt>
          <dd className="bridge-break">{route.fee.recipient}</dd>
        </div>
        <div className="bridge-line">
          <dt>Network fees</dt>
          <dd className="bridge-prose">{route.fee.networkFee}</dd>
        </div>
        {route.source && (
          <div className="bridge-line">
            <dt>Read from the bridge's file at</dt>
            <dd>
              <code>{route.source.commit.slice(0, 12)}</code>
              {route.source.derived && ' (derived from the launch configuration)'}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
