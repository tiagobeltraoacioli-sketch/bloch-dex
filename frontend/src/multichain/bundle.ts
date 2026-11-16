// The per-chain files of the multichain site, bundled at build time (never fetched at run time). The vite alias
// @postern/multichain-bundle points here; POSTERN_MULTICHAIN_BUNDLE replaces it with one JSON file of the same
// shape for a local rehearsal against loopback forks (vite.multichain.config.ts).
import opNetwork from '../../../deployments/op-mainnet/frontend.network.json';
import opRecord from '../../../deployments/op-mainnet/frontend.record.json';
import baseNetwork from '../../../deployments/base/frontend.network.json';
import baseRecord from '../../../deployments/base/frontend.record.json';
import arbitrumNetwork from '../../../deployments/arbitrum-one/frontend.network.json';
import arbitrumRecord from '../../../deployments/arbitrum-one/frontend.record.json';
import lineaNetwork from '../../../deployments/linea/frontend.network.json';
import lineaRecord from '../../../deployments/linea/frontend.record.json';
import bnbNetwork from '../../../deployments/bnb-smart-chain/frontend.network.json';
import bnbRecord from '../../../deployments/bnb-smart-chain/frontend.record.json';
import ethereumNetwork from '../../../deployments/ethereum/frontend.network.json';
import ethereumRecord from '../../../deployments/ethereum/frontend.record.json';

const bundle: { network: unknown; record: unknown }[] = [
  { network: ethereumNetwork, record: ethereumRecord },
  { network: baseNetwork, record: baseRecord },
  { network: arbitrumNetwork, record: arbitrumRecord },
  { network: opNetwork, record: opRecord },
  { network: lineaNetwork, record: lineaRecord },
  { network: bnbNetwork, record: bnbRecord },
];
export default bundle;
