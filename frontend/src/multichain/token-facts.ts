// What the reviewed token list says about each listed token's contract and issuer (the network file's
// `tokens[].kind`, written by scripts/multichain/frontend-files.mjs from deployments/<chain>/chain.json), for the
// liquidity screens: a liquidity provider holds both tokens of a pool and must see an issuer's powers before
// signing. Display text only; nothing here names a contract the route calls. Read from the same bundle as
// multichain/config.ts, which pins everything else.
import bundle from '@postern/multichain-bundle';

export type TokenFact = { name: string; fact: string };

const clean = (value: unknown): string | null =>
  typeof value === 'string' && value.length >= 4 && value.length <= 400 && !/[<>\n\r]/.test(value)
    ? value
    : null;

/** The first sentence of a `kind`: the statement about the token; later sentences are the list's own notes. */
const firstSentence = (kind: string): string => {
  const cut = kind.indexOf('. ');
  return (cut < 0 ? kind : kind.slice(0, cut)).replace(/\.$/, '');
};

/** Per chain key: the wrapped native token and every listed token, by the name the page shows. */
export function tokenFacts(input: unknown = bundle): Record<string, TokenFact[]> {
  const out: Record<string, TokenFact[]> = {};
  if (!Array.isArray(input)) return out;
  for (const entry of input as { network?: Record<string, unknown> }[]) {
    const n = entry?.network;
    if (!n || typeof n.key !== 'string') continue;
    const tokens = [n.wrappedNative, ...(Array.isArray(n.tokens) ? n.tokens : [])] as Record<
      string,
      unknown
    >[];
    out[n.key] = tokens.flatMap((t) => {
      const name = clean(t?.label) ?? clean(t?.symbol);
      const kind = clean(t?.kind);
      return name && kind ? [{ name, fact: firstSentence(kind) }] : [];
    });
  }
  return out;
}
