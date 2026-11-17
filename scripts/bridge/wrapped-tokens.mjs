// The one generated list of wrapped tokens on the Bloch L2 (deployments/bridges/wrapped-tokens.json).
// Pure: the import script writes its result, and a unit test checks that the committed file equals it.
//
// One isolated token per (asset, source network). Two tokens are never merged, and none is shown as the asset
// itself: `bUSDC` is USDC held in the Ethereum vault and nothing else; `bUSDC.arb` is another token with its own
// vault, cap and books.
export const WRAPPED_TOKENS_DOMAIN = 'postern.dex.wrapped-tokens.v1';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SYMBOL = /^[A-Za-z0-9.]{1,11}$/;

export function wrappedTokens(files, launch, page) {
  const tokens = [];
  for (const file of files) {
    const id = file.network.id;
    const decided = launch.networks[id];
    if (!decided) throw new Error(`launch.json has no decision for ${id}`);
    if (decided.state === 'not-offered') continue;
    const offered = decided.state === 'shown' && file.launch?.v1 !== false ? 'shown' : 'not-available-yet';
    const { symbol, name, decimals, token } = file.l2;
    if (!SYMBOL.test(symbol)) throw new Error(`${id}: l2.symbol ${symbol}`);
    if (file.l2.chainId !== launch.l2ChainId) throw new Error(`${id}: l2.chainId`);
    const address = ADDRESS.test(token) ? token.toLowerCase() : null;
    tokens.push({
      symbol,
      name,
      decimals,
      address,
      status: address ? 'deployed' : 'not-deployed',
      offered,
      network: { id, name: file.network.name, kind: file.network.kind },
      asset: {
        symbol: file.asset.symbol,
        name: file.asset.name,
        issuer: file.asset.issuer,
        issuerNative: file.asset.issuerNative,
      },
      exit: page.networks[id]?.router !== undefined ? 'router' : 'token-burn',
      description: `${file.asset.symbol} held in the bridge vault on ${file.network.name}, and no other asset. It is not ${
        file.asset.symbol
      } and not interchangeable with a wrapped token of another network.`,
    });
  }
  const seen = new Set();
  for (const t of tokens) {
    const key = t.symbol.toLowerCase();
    if (seen.has(key)) throw new Error(`two wrapped tokens share the symbol ${t.symbol}`);
    seen.add(key);
    if (t.address) {
      if (seen.has(t.address)) throw new Error(`two wrapped tokens share the address ${t.address}`);
      seen.add(t.address);
    }
  }
  return { domain: WRAPPED_TOKENS_DOMAIN, schemaVersion: 1, l2ChainId: launch.l2ChainId, tokens };
}
