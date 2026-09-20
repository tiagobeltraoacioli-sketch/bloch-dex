export const DEX_STAGING_CHAIN_ID = 84001;
export const DEX_STAGING_CAIP_CHAIN = `eip155:${DEX_STAGING_CHAIN_ID}` as const;
export const DEX_STAGING_CHAIN_HEX = `0x${DEX_STAGING_CHAIN_ID.toString(16)}` as const;
