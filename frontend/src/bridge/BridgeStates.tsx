// A gallery of every named state of a deposit and of an exit, for review and screenshots (#/bridge-states, local
// render builds only). Each card is the REAL status function applied to a fixed observation; nothing here reads a
// chain, and the page says so at its top.
import { formatAmount } from '../amm';
import { Panel, StatusCard } from './BridgeParts';
import type { BridgeConfig, Route } from './config';
import { STATE_FIXTURES } from './state-fixtures';

export function BridgeStates({ config }: { config: BridgeConfig }) {
  const routes = new Map(config.entries.filter((e) => e.route).map((e) => [e.id, e.route as Route]));
  return (
    <section className="page bridge-page" aria-labelledby="bridge-states-title">
      <div className="bridge-heading">
        <span className="badge">Review build · fixed observations</span>
        <h1 id="bridge-states-title">Bridge states</h1>
      </div>
      <Panel tone="warn" title="Not live data">
        <p>Every card below is a status computed from a fixed, invented observation, to show each state the bridge page can name. No chain was read.</p>
      </Panel>
      <div className="bridge-activity">
        {STATE_FIXTURES.map((fixture) => {
          const route = routes.get(fixture.route);
          if (!route) return null;
          const status = fixture.status(route);
          return (
            <StatusCard
              key={fixture.id}
              heading={`${fixture.heading(route)} · ${route.name}`}
              reference={{ what: 'State', value: status.state }}
              status={status}
              onAction={() => {}}
            >
              <p className="microcopy">
                {fixture.id}: {formatAmount(fixture.amount, route.l2.decimals)} {route.l2.symbol}
              </p>
            </StatusCard>
          );
        })}
      </div>
    </section>
  );
}
