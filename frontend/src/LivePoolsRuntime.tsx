import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import LivePools from './LivePools';
import type { LiveReaderFactory, LiveReaderSession } from './live-runtime';

type RuntimeFactory = Pick<LiveReaderFactory, 'open'>;

/**
 * Standalone read-only composition boundary. A refresh always discards the old
 * provider and adapter before loading and authenticating the manifest again.
 */
export default function LivePoolsRuntime({ factory }: { factory: RuntimeFactory }) {
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; session: LiveReaderSession }
  >({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    let opened: LiveReaderSession | undefined;
    setState({ kind: 'loading' });
    void factory.open(controller.signal).then(
      (session) => {
        if (!current) {
          session.close();
          return;
        }
        opened = session;
        setState({ kind: 'ready', session });
      },
      () => {
        if (current) setState({ kind: 'unavailable' });
      },
    );
    return () => {
      current = false;
      controller.abort();
      opened?.close();
    };
  }, [factory, generation]);

  if (state.kind === 'ready') {
    return (
      <LivePools reader={state.session.reader} onRefresh={() => setGeneration((n) => n + 1)} />
    );
  }

  return (
    <section className="panel pools-panel" aria-labelledby="live-pools-runtime-title">
      <div className="pool-toolbar">
        <div>
          <p className="eyebrow">REVIEWED DEPLOYMENT</p>
          <h2 id="live-pools-runtime-title">Read-only pool snapshot</h2>
        </div>
        <span className="badge">
          <ShieldCheck size={15} /> No transactions
        </span>
      </div>
      {state.kind === 'loading' ? (
        <p className="notice" role="status">
          Loading and authenticating the deployment registry…
        </p>
      ) : (
        <div className="notice" role="alert">
          <p>The reviewed deployment registry or RPC provider is unavailable.</p>
          <p className="microcopy">Preview data was not substituted for this failed live read.</p>
          <button className="button secondary" onClick={() => setGeneration((n) => n + 1)}>
            <RefreshCw size={16} /> Retry deployment read
          </button>
        </div>
      )}
    </section>
  );
}
