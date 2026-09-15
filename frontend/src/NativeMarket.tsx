import { useEffect, useRef, useState } from 'react';
import { Detail } from './components';
import { nativeProvider, reportedNativeAccount, type NativeProvider } from './nativeWallet';

export default function NativeMarket() {
  const [address, setAddress] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const busy = useRef(false);
  const connected = useRef<NativeProvider | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    // This provider has no account-change subscription. Hide cached identity
    // when leaving the page and require an explicit refresh on return.
    const hide = () => {
      if (document.visibilityState === 'hidden') clearLocal();
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      generation.current++;
      clearTimeout(timeout.current);
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);
  function clearLocal() {
    generation.current++;
    busy.current = false;
    clearTimeout(timeout.current);
    setPending(false);
    setAddress(null);
  }
  async function requestAccount(refresh = false) {
    if (busy.current) return;
    const provider = refresh ? connected.current : nativeProvider();
    if (!provider) {
      setMessage(
        'Postern Wallet was not detected. Open this page in a browser with the native Postern extension enabled. MetaMask connects to EVM networks, not this L1 account.',
      );
      return;
    }
    const attempt = ++generation.current;
    busy.current = true;
    setPending(true);
    setAddress(null);
    setMessage('');
    timeout.current = setTimeout(() => {
      if (generation.current !== attempt) return;
      clearLocal();
      setMessage(
        'The wallet has not responded. Check any open wallet approval before trying again.',
      );
    }, 30_000);
    try {
      if (!refresh) {
        const grant = await provider.request('bloch_connect');
        if (
          !grant ||
          typeof grant !== 'object' ||
          !('connected' in grant) ||
          grant.connected !== true
        ) {
          throw new Error('Native connection was not granted');
        }
      }
      if (generation.current !== attempt) return;
      const account = reportedNativeAccount(await provider.request('bloch_getAccount'));
      if (generation.current !== attempt) return;
      connected.current = provider;
      setAddress(account);
    } catch {
      if (generation.current === attempt)
        setMessage(
          'Account access was not completed. Unlock Postern Wallet and approve the connection, then try again.',
        );
    } finally {
      if (generation.current === attempt) {
        clearTimeout(timeout.current);
        busy.current = false;
        setPending(false);
      }
    }
  }
  async function disconnect() {
    const provider = connected.current;
    connected.current = null;
    clearLocal();
    setMessage('');
    const attempt = generation.current;
    try {
      await provider?.request('bloch_disconnect');
    } catch {
      if (generation.current === attempt)
        setMessage(
          'The address was cleared here. Remove this site in Postern Wallet to revoke its permission.',
        );
    }
  }
  return (
    <div className="develop-page">
      <section className="develop-intro">
        <span className="badge">Bloch L1 · Integration in progress</span>
        <h1>Native BLCH / USDT</h1>
        <p>
          Connect your native Postern Wallet to view its selected L1 account. Deposits, pool launch
          and trading are not enabled on this page.
        </p>
      </section>
      <section className="develop-status" aria-labelledby="native-wallet-heading">
        <h2 id="native-wallet-heading">Postern Wallet · Bloch L1</h2>
        <p>
          Account access only. This flow does not request a signature, token approval or transfer.
        </p>
        {address && (
          <>
            <Detail label="Wallet-reported account">
              <code className="native-account">{address}</code>
            </Detail>
            <Detail label="Address network">
              {address.startsWith('bloch1q') ? 'Bloch mainnet address' : 'Bloch testnet address'}
            </Detail>
            <p className="microcopy">
              This identifies the wallet account. It does not verify a DEX deployment or provide a
              USDT deposit destination.
            </p>
          </>
        )}
        <div className="button-group">
          <button
            className="button primary"
            disabled={pending}
            onClick={() => void requestAccount(!!address)}
          >
            {pending
              ? 'Waiting for Postern Wallet…'
              : address
                ? 'Refresh L1 account'
                : 'Connect Postern Wallet'}
          </button>
          {address && (
            <button className="button secondary" onClick={() => void disconnect()}>
              Disconnect L1 wallet
            </button>
          )}
          {pending && (
            <button
              className="button secondary"
              onClick={() => {
                clearLocal();
                setMessage('Request dismissed here. Check Postern Wallet for any open approval.');
              }}
            >
              Dismiss request
            </button>
          )}
        </div>
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        <p className="microcopy">
          On iPhone Safari, native L1 connection still needs a compatible mobile wallet integration.
          The MetaMask mobile link is for the separate EVM wallet flow.
        </p>
      </section>
      <section className="develop-status">
        <h2>Before deposits and pool launch</h2>
        <p>
          The local executor has passed an import, liquidity, trade and redemption rehearsal. Live
          L1 execution, native DEX signing and the external USDT bridge still need to be connected
          and verified.
        </p>
        <a href="#/develop">View integration status</a>
      </section>
    </div>
  );
}
