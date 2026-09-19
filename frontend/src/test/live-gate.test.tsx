import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLiveReadGate } from '../live-gate';
import App from '../App';
import { LIVE_GATE_DOMAIN, LIVE_MANIFEST_DOMAIN } from '../live-auth';
import { createSigningFixture, type SigningFixture } from './live-auth-helpers';

vi.mock('../LivePoolsRuntime', () => ({
  default: () => <div data-testid="live-runtime">Authenticated live runtime</div>,
}));

let signing: SigningFixture;
const NOW = Math.floor(Date.now() / 1_000);

beforeAll(async () => {
  signing = await createSigningFixture();
});

beforeEach(() => vi.stubEnv('VITE_POSTERN_LIVE_READ_PUBLIC_KEY', signing.encodedPublicKey));

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: 'read-only',
    registryUrl: '/deployment/artifact.json',
    manifestSha256: 'a'.repeat(64),
    issuedAt: NOW - 60,
    expiresAt: NOW + 3_600,
    allowedRpcOrigins: ['https://rpc.invalid'],
    timeoutMs: 8_000,
    ...overrides,
  };
}

function inject(value: unknown, target: Document = document): HTMLScriptElement {
  const element = target.createElement('script');
  element.id = 'postern-live-read-config';
  element.type = 'application/json';
  element.textContent = JSON.stringify(value);
  target.body.append(element);
  return element;
}

async function signedConfiguration(
  overrides: Record<string, unknown> = {},
  domain = LIVE_GATE_DOMAIN,
) {
  return signing.sign(configuration(overrides), domain);
}

afterEach(() => {
  document.getElementById('postern-live-read-config')?.remove();
  vi.unstubAllEnvs();
});

describe('live read host gate', () => {
  it('accepts only an explicitly signed bounded read-only configuration', async () => {
    const isolated = document.implementation.createHTMLDocument();
    const signed = (await signedConfiguration()) as { payload: Record<string, unknown> };
    signed.payload = Object.fromEntries(Object.entries(signed.payload).reverse());
    inject(signed, isolated);
    await expect(
      readLiveReadGate(isolated, 'https://dex.invalid', signing.encodedPublicKey),
    ).resolves.toMatchObject({ available: true });
  });

  it.each([
    ['disabled', { enabled: false }],
    ['write mode', { mode: 'live' }],
    ['cross-origin registry', { registryUrl: 'https://attacker.invalid/registry.json' }],
    ['registry query', { registryUrl: '/registry.json?deployment=other' }],
    ['insecure RPC', { allowedRpcOrigins: ['http://rpc.invalid'] }],
    ['duplicate RPC origin', { allowedRpcOrigins: ['https://rpc.invalid', 'https://rpc.invalid'] }],
    ['unbounded timeout', { timeoutMs: 30_001 }],
    ['expired authorization', { issuedAt: 1, expiresAt: 2 }],
    ['excessive validity', { issuedAt: NOW, expiresAt: NOW + 604_801 }],
    ['unknown capability', { transactionEnabled: true }],
  ])('rejects %s', async (_label, override) => {
    const isolated = document.implementation.createHTMLDocument();
    inject(await signedConfiguration(override), isolated);
    await expect(
      readLiveReadGate(isolated, 'https://dex.invalid', signing.encodedPublicKey),
    ).resolves.toEqual({
      available: false,
      reason: 'invalid',
    });
  });

  it('rejects tampering, the wrong pin and cross-domain signature replay', async () => {
    const isolated = document.implementation.createHTMLDocument();
    const signed = (await signedConfiguration()) as {
      payload: Record<string, unknown>;
      signature: Record<string, unknown>;
    };
    signed.payload.timeoutMs = 9_000;
    inject(signed, isolated);
    await expect(
      readLiveReadGate(isolated, 'https://dex.invalid', signing.encodedPublicKey),
    ).resolves.toEqual({ available: false, reason: 'untrusted' });

    const other = await createSigningFixture();
    await expect(
      readLiveReadGate(isolated, 'https://dex.invalid', other.encodedPublicKey),
    ).resolves.toEqual({ available: false, reason: 'untrusted' });

    isolated.getElementById('postern-live-read-config')?.remove();
    inject(await signedConfiguration({}, LIVE_MANIFEST_DOMAIN), isolated);
    await expect(
      readLiveReadGate(isolated, 'https://dex.invalid', signing.encodedPublicKey),
    ).resolves.toEqual({ available: false, reason: 'untrusted' });

    isolated.getElementById('postern-live-read-config')?.remove();
    const extraField = (await signedConfiguration()) as Record<string, unknown>;
    extraField.transactionEnabled = false;
    inject(extraField, isolated);
    await expect(
      readLiveReadGate(isolated, 'https://dex.invalid', signing.encodedPublicKey),
    ).resolves.toEqual({ available: false, reason: 'untrusted' });
  });

  it('keeps the default preview unchanged when the host gate is absent', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Every trade, in view.' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Live read' })).toBeNull();
    expect(screen.queryByTestId('live-runtime')).toBeNull();
  });

  it('mounts the isolated runtime on its explicit route only when every gate is present', async () => {
    inject(await signedConfiguration());
    history.replaceState(null, '', '/#/live-pools');
    render(<App />);
    expect(await screen.findByTestId('live-runtime')).toBeTruthy();
    expect(screen.getByText('Read only · No wallet')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /connect|swap|liquidity|approve|deposit/i }),
    ).toBeNull();
    expect(screen.queryByText(/sample data/i)).toBeNull();
  });

  it('does not trust a host signature when the reviewed build has no public-key pin', async () => {
    vi.stubEnv('VITE_POSTERN_LIVE_READ_PUBLIC_KEY', '');
    inject(await signedConfiguration());
    history.replaceState(null, '', '/#/live-pools');
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('could not be authenticated');
    expect(screen.queryByTestId('live-runtime')).toBeNull();
  });

  it('fails closed on the live route when configuration is missing or invalid', async () => {
    history.replaceState(null, '', '/#/live-pools');
    const view = render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('did not provide');
    expect(screen.getByText(/fixtures were not substituted/)).toBeTruthy();
    expect(screen.queryByTestId('live-runtime')).toBeNull();

    view.unmount();
    inject(await signedConfiguration({ enabled: false }));
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('did not pass validation');
    expect(screen.queryByTestId('live-runtime')).toBeNull();
  });
});
