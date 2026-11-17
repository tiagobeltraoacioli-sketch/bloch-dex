// The bridge page's inputs, bundled at build time (never fetched at run time, so a static host cannot swap them):
// the bridges' own interface files as imported by scripts/bridge/import-interfaces.mjs, the coordinator's launch
// decision, the page-side values schema v1 does not carry, and where each file came from.
// The vite alias @postern/bridge-bundle points here; POSTERN_BRIDGE_BUNDLE replaces it with one JSON file of the
// same shape for a loopback rehearsal (a local render build, which shows the "not for publication" banner).
import ethereum from '../../../deployments/bridges/ethereum/bridge.network.json';
import arbitrumOne from '../../../deployments/bridges/arbitrum-one/bridge.network.json';
import opMainnet from '../../../deployments/bridges/op-mainnet/bridge.network.json';
import linea from '../../../deployments/bridges/linea/bridge.network.json';
import base from '../../../deployments/bridges/base/bridge.network.json';
import bnb from '../../../deployments/bridges/bnb/bridge.network.json';
import bitcoin from '../../../deployments/bridges/bitcoin/bridge.network.json';
import solana from '../../../deployments/bridges/solana/bridge.network.json';
import tron from '../../../deployments/bridges/tron/bridge.network.json';
import stellar from '../../../deployments/bridges/stellar/bridge.network.json';
import launch from '../../../deployments/bridges/launch.json';
import page from '../../../deployments/bridges/page.json';
import sources from '../../../deployments/bridges/sources.json';
import tokens from '../../../deployments/bridges/wrapped-tokens.json';

const bundle: {
  rehearsal?: boolean;
  files: unknown[];
  launch: unknown;
  page: unknown;
  sources: unknown;
  tokens: unknown;
} = {
  files: [ethereum, arbitrumOne, opMainnet, linea, base, bnb, bitcoin, solana, tron, stellar],
  launch,
  page,
  sources,
  tokens,
};
export default bundle;
