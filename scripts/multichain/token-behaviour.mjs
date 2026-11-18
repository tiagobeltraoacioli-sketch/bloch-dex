// What a listed token does besides moving balances, read from the chain (docs/MULTICHAIN-DEPLOY.md section 2.6,
// "What a token can do to a pool"). Read-only helpers shared by gate.mjs, first-deposit.mjs and verify-chain.mjs.
//
// The pair and the router assume that a transfer of N units moves N units. Tether's contract on Ethereum can be
// switched, by its owner, to keep a fee on every transfer (`basisPointsRate`, `maximumFee`, both zero today), to
// stop every transfer (`paused`) and to forward every call to another contract (`deprecated`). None of that
// changes the contract's code, so the pinned code hash does not see it: the values are READ, at the pinned block,
// from the endpoints that must agree, and anything but "off" is refused:
//   - every listed token is asked for the fee getters. One that answers must declare them in its `behaviour`
//     block (deployments/<chain>/chain.json) and they must read zero; one that declares them must answer.
//   - the switches a token declares must read false.
//   - before a deposit, the declared blocklist getter must read false for the addresses the deposit touches.
// A getter the contract does not have reverts (or, at a contract with a fallback such as WETH9, returns nothing):
// that is "absent". An answer that cannot be read (too few endpoints answered) is not "absent": the check fails.
import { createRequire } from "node:module";
import { FEE_PARAMETER_GETTERS } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { toFunctionSelector, encodeFunctionData, parseAbi } = requireFromFrontend("viem");

const WORD = /^0x[0-9a-f]{64}$/i;
const isRevert = (error) => /execution reverted|revert/i.test(String(error?.message ?? error));
const selector = (name) => toFunctionSelector(`${name}()`);
const BLOCKLIST_ABI = parseAbi(["function isBlackListed(address) view returns (bool)", "function isBlocked(address) view returns (bool)", "function isBlacklisted(address) view returns (bool)"]);

/**
 * One getter without arguments. `ethCall(to, data)` resolves to the returned bytes and rejects with the node's
 * error. Returns { present: true, value } for exactly one word, { present: false } for a revert or no data, and
 * { present: null, problem } when the answer is neither (unreadable, or of another shape).
 */
export async function readGetter(ethCall, address, name) {
  try {
    const data = await ethCall(address, selector(name));
    if (data === "0x") return { present: false };
    if (!WORD.test(String(data))) return { present: null, problem: `${name}() answered ${String(data).length > 20 ? `${String(data).slice(0, 20)}…` : data}, not one word` };
    return { present: true, value: BigInt(data) };
  } catch (error) {
    if (isRevert(error)) return { present: false };
    return { present: null, problem: `${name}() could not be read: ${String(error?.message ?? error).replace(/^multichain: /, "").slice(0, 160)}` };
  }
}

/**
 * The transfer-fee and switch state of one listed token against its configuration. Never throws.
 * Returns { ok, problems: [string], read: { getter: "absent" | decimal string | "unreadable" } }.
 */
export async function tokenBehaviourState(ethCall, token) {
  const problems = [];
  const read = {};
  const declaredFee = token.behaviour?.transferFee?.parameters ?? [];
  for (const name of FEE_PARAMETER_GETTERS) {
    const r = await readGetter(ethCall, token.address, name);
    read[name] = r.present === true ? r.value.toString() : r.present === false ? "absent" : "unreadable";
    if (r.present === null) problems.push(r.problem);
    else if (r.present && !declaredFee.includes(name)) problems.push(`the contract answers ${name}() (${r.value}), a transfer-fee parameter its configuration does not declare (behaviour.transferFee): establish what the token does before it is listed`);
    else if (!r.present && declaredFee.includes(name)) problems.push(`the configuration declares the fee parameter ${name}() and the contract does not answer it: this is not the token that was reviewed`);
    else if (r.present && r.value !== 0n) problems.push(`${name}() is ${r.value}, not zero: the issuer has switched on a fee on every transfer. The pair and the router do not support such a token; deposit nothing and list nothing while it is on`);
  }
  for (const name of token.behaviour?.switches ?? []) {
    const r = await readGetter(ethCall, token.address, name);
    read[name] = r.present === true ? r.value.toString() : r.present === false ? "absent" : "unreadable";
    if (r.present === null) problems.push(r.problem);
    else if (!r.present) problems.push(`the configuration declares the switch ${name}() and the contract does not answer it: this is not the token that was reviewed`);
    else if (r.value !== 0n) problems.push(`${name}() is true: ${name === "paused" ? "the issuer has stopped every transfer of this token" : "the issuer has replaced this contract: every call is forwarded to another one, which was not reviewed"}`);
  }
  return { ok: problems.length === 0, problems, read };
}

/**
 * The issuer's blocklist, for the addresses a deposit touches. Returns { ok, problems, read }; a token without a
 * declared blocklist getter reads nothing and is ok.
 */
export async function blocklistState(ethCall, token, addresses) {
  const getter = token.behaviour?.blocklist ?? null;
  const problems = [];
  const read = {};
  if (!getter) return { ok: true, problems, read };
  for (const [label, address] of Object.entries(addresses)) {
    try {
      const data = await ethCall(token.address, encodeFunctionData({ abi: BLOCKLIST_ABI, functionName: getter, args: [address] }));
      if (!WORD.test(String(data))) problems.push(`${getter}(${label}) did not answer one word`);
      else {
        read[label] = BigInt(data) !== 0n;
        if (read[label]) problems.push(`${label} ${address} is on the issuer's blocklist of ${token.symbol} (${getter}): it cannot send this token, and a pool at a blocked address cannot pay it out`);
      }
    } catch (error) {
      problems.push(`${getter}(${label}) could not be read: ${String(error?.message ?? error).replace(/^multichain: /, "").slice(0, 160)}`);
    }
  }
  return { ok: problems.length === 0, problems, read };
}

/**
 * The approval transactions for `amount` to `spender`, given the allowance that stands now. Pure.
 * A token whose approve reverts on a non-zero to non-zero change (`approveZeroFirst`) is first set to zero; when its
 * allowance already is the amount, nothing is sent. Every other token gets the one approve it always got.
 * Returns [{ step, amount }], step "approve-zero" | "approve".
 */
export function approvalSteps({ zeroFirst, allowance, amount }) {
  if (!zeroFirst) return [{ step: "approve", amount }];
  if (allowance === amount) return [];
  if (allowance === 0n) return [{ step: "approve", amount }];
  return [{ step: "approve-zero", amount: 0n }, { step: "approve", amount }];
}
