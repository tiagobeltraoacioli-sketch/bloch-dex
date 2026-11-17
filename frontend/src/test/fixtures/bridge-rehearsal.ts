// A rehearsal bundle for tests: the committed files with throwaway addresses filled in (the shape
// scripts/bridge/rehearse-page.mjs writes for the browser harness). Nothing here exists on any network.
import bundle from '@postern/bridge-bundle';
import vectors from './bridge-vectors.json';
import { wrappedTokens } from '../../../../scripts/bridge/wrapped-tokens.mjs';

export const ADDRESSES = {
  tokens: {
    ethereum: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
    bitcoin: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
    solana: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0',
    tron: '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9',
    stellar: '0xdc64a140aa3e981100a9beca4e685f962f0cf6c9',
  } as Record<string, string>,
  routers: {
    bitcoin: '0x5fc8d32690cc91d4c39d9d3abcbd16989f875707',
    solana: '0x0165878a594ca255338adfa4d48449f69242eb8f',
    stellar: '0xa513e6e4b8f2a923d98304ec87f64353c4d5c853',
  } as Record<string, string>,
  custody: {
    ethereum: '0x8a791620dd6260079bf849dc5567adc3f2fdc318',
    bitcoin: 'bc1qgp3c6sv4yqj93qwa7zyflzqrdt796azzmaqmhtyeq9df06rstc7sedd4pa',
    solana: `${vectors.solana.program}/${vectors.solana.vault.address}`,
    tron: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    stellar: 'CAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6IBZ',
  } as Record<string, string>,
};
const ROUTER_HASH = `0x${'ab'.repeat(32)}`;

export function rehearsalBundle(readPorts: Record<string, number> = { ethereum: 44801, bitcoin: 44810, solana: 44811, tron: 44812, stellar: 44813 }): unknown {
  const b = JSON.parse(JSON.stringify(bundle)) as Record<string, any>;
  b.rehearsal = true;
  for (const file of b.files) {
    const id = file.network.id as string;
    if (!ADDRESSES.tokens[id]) continue;
    file.l2.token = ADDRESSES.tokens[id];
    file.custody.address = ADDRESSES.custody[id];
    const page = b.page.networks[id];
    page.read = { urls: [`http://127.0.0.1:${readPorts[id]}`] };
    if (ADDRESSES.routers[id]) {
      page.router = ADDRESSES.routers[id];
      page.routerCodeHash = ROUTER_HASH;
    }
  }
  b.page.networks.bitcoin.script = {
    threshold: vectors.bitcoin.threshold,
    publicKeys: vectors.bitcoin.publicKeys.map((k) => `0x${k}`),
    vaultId: `0x${vectors.bitcoin.vaultId}`,
  };
  b.tokens = wrappedTokens(b.files, b.launch, b.page);
  return b;
}
