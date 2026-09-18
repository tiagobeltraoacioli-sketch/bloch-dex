import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLiveReadGate } from '../live-gate';
import App from '../App';

vi.mock('../LivePoolsRuntime', () => ({
  default: () => <div data-testid="live-runtime">Authenticated live runtime</div>,
}));

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: 'read-only',
    registryUrl: '/deployment/artifact.json',
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

afterEach(() => document.getElementById('postern-live-read-config')?.remove());

describe('live read host gate', () => {
  it('accepts only an explicit bounded read-only configuration', () => {
    const isolated = document.implementation.createHTMLDocument();
    inject(configuration(), isolated);
    expect(readLiveReadGate(isolated, 'https://dex.invalid')).toMatchObject({ available: true });
  });

  it.each([
    ['disabled', { enabled: false }],
    ['write mode', { mode: 'live' }],
    ['cross-origin registry', { registryUrl: 'https://attacker.invalid/registry.json' }],
    ['registry query', { registryUrl: '/registry.json?deployment=other' }],
    ['insecure RPC', { allowedRpcOrigins: ['http://rpc.invalid'] }],
    ['duplicate RPC origin', { allowedRpcOrigins: ['https://rpc.invalid', 'https://rpc.invalid'] }],
    ['unbounded timeout', { timeoutMs: 30_001 }],
    ['unknown capability', { transactionEnabled: true }],
  ])('rejects %s', (_label, override) => {
    const isolated = document.implementation.createHTMLDocument();
    inject(configuration(override), isolated);
    expect(readLiveReadGate(isolated, 'https://dex.invalid')).toEqual({
      available: false,
      reason: 'invalid',
    });
  });

  it('keeps the default preview unchanged when the host gate is absent', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Every trade, in view.' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Live read' })).toBeNull();
    expect(screen.queryByTestId('live-runtime')).toBeNull();
  });

  it('mounts the isolated runtime on its explicit route only when every gate is present', () => {
    inject(configuration());
    history.replaceState(null, '', '/#/live-pools');
    render(<App />);
    expect(screen.getByTestId('live-runtime')).toBeTruthy();
    expect(screen.getByText('Read only · No wallet')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /connect|swap|liquidity|approve|deposit/i }),
    ).toBeNull();
    expect(screen.queryByText(/sample data/i)).toBeNull();
  });

  it('fails closed on the live route when configuration is missing or invalid', () => {
    history.replaceState(null, '', '/#/live-pools');
    const view = render(<App />);
    expect(screen.getByRole('alert').textContent).toContain('did not provide');
    expect(screen.getByText(/fixtures were not substituted/)).toBeTruthy();
    expect(screen.queryByTestId('live-runtime')).toBeNull();

    view.unmount();
    inject(configuration({ enabled: false }));
    render(<App />);
    expect(screen.getByRole('alert').textContent).toContain('did not pass validation');
    expect(screen.queryByTestId('live-runtime')).toBeNull();
  });
});
