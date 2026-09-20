// Selected by bloch-l2-evm revision fb042a5. Registration and production
// genesis remain separate activation gates.
export const DEX_STAGING_CHAIN_ID = 700771;
export const DEX_STAGING_CAIP_CHAIN = `eip155:${DEX_STAGING_CHAIN_ID}` as const;
export const DEX_STAGING_CHAIN_HEX = `0x${DEX_STAGING_CHAIN_ID.toString(16)}` as const;
