// Chain IDs come from one source, deployments/networks.json, shared with the
// deployment tooling (scripts/staging/dex-deploy-config.mjs) and mirrored by
// script/DeployMainnet.s.sol. The preview stays pinned to the devnet4 staging
// network; switching the frontend to the mainnet is a separate reviewed change
// that needs a verified mainnet deployment record.
import networks from '../../deployments/networks.json';

function chainIdOf(name: string): number {
  const entry = [networks.mainnet, ...networks.development].find(
    (network) => network.name === name,
  );
  if (!entry || !Number.isSafeInteger(entry.chainId) || entry.chainId <= 0) {
    throw new Error(`network ${name} is missing from deployments/networks.json`);
  }
  return entry.chainId;
}

export const DEX_MAINNET_CHAIN_ID = chainIdOf('bloch-l2-mainnet');
export const DEX_STAGING_CHAIN_ID = chainIdOf('bloch-l2-devnet4');
export const DEX_STAGING_CAIP_CHAIN = `eip155:${DEX_STAGING_CHAIN_ID}` as const;
export const DEX_STAGING_CHAIN_HEX = `0x${DEX_STAGING_CHAIN_ID.toString(16)}` as const;
