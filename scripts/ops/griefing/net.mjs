// Test harness for the griefing scenes. Private and loopback only, with throwaway keys
// generated at run time. Two backends:
//   private-l2  bloch-l2-settled-rpc plus bloch-l2-produce-dev. Blocks are built when the
//               scene says so, by the real selector, so ordering is the L2's own.
//               Finality is synthetic: there is no L1, no proof and no settlement.
//   anvil       for slot counts through anvil_dumpState, where ordering is not the point.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const req = createRequire(join(ROOT, "frontend/package.json"));
export const viem = req("viem");
export const accounts = req("viem/accounts");
const { encodeFunctionData, decodeFunctionResult, parseAbi, keccak256, encodeDeployData, serializeTransaction, getContractAddress } = viem;

export const gwei = (x) => BigInt(Math.round(x * 1e9));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function reserveCaps() view returns (uint112,uint112)",
  "function token0() view returns (address)",
  "function kLast() view returns (uint256)",
  "function skim(address)",
  "function sync()",
  "function mint(address) returns (uint256)",
  "function burn(address) returns (uint256,uint256)",
  "function createPair(address,address) returns (address)",
  "function getPair(address,address) view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function INIT_CODE_PAIR_HASH() view returns (bytes32)",
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
  "function addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)",
  "function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function swapExactBLCHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
  "function swapExactTokensForBLCH(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function mintDigest(bytes32,uint64,uint64,address) view returns (bytes32)",
  "function mint(bytes32,uint64,uint64,address,bytes)",
  "function burn(uint64,address) returns (bytes32)",
  "function position(address,address) view returns ((uint256 liquidity,uint256 pendingProtocolLiquidity,uint256 dilutedSupply,uint256 reserveShare0,uint256 reserveShare1))",
  "function fillApprove(address,uint256)",
  "function fillTransfer(address,uint256)",
]);
export const data = (functionName, args = []) => encodeFunctionData({ abi: ABI, functionName, args });

export function artifact(name, dir = "out") {
  const j = JSON.parse(readFileSync(join(ROOT, dir, `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export class Actor {
  constructor(net, name) {
    this.net = net;
    this.name = name;
    this.key = accounts.generatePrivateKey();
    this.account = accounts.privateKeyToAccount(this.key);
    this.address = this.account.address.toLowerCase();
    this.nonce = 0n;
    this.paid = 0n; // Fees of every receipt collected for this actor.
  }
  async send(to, callData, { tip = 1, maxFee = 100, gas = 400_000n, value = 0n } = {}) {
    const tx = { type: "eip1559", chainId: this.net.chainId, nonce: Number(this.nonce), gas: BigInt(gas), maxFeePerGas: gwei(maxFee), maxPriorityFeePerGas: gwei(tip), value, data: callData };
    if (to) tx.to = to;
    const raw = await this.account.signTransaction(tx);
    const hash = await this.net.rpc("eth_sendRawTransaction", [raw]);
    const sent = { hash, nonce: this.nonce, tip, actor: this };
    this.nonce += 1n;
    return sent;
  }
}

export class Net {
  constructor(mode, work, port) {
    Object.assign(this, { mode, work, port, url: `http://127.0.0.1:${port}`, chainId: 700770, children: [], id: 0, anchorN: 2 });
    mkdirSync(work, { recursive: true });
  }
  actor(name) {
    return new Actor(this, name);
  }
  async rpc(method, params = []) {
    const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }), signal: AbortSignal.timeout(120_000) });
    const body = await r.json();
    if (body.error) {
      const e = new Error(`${method}: ${body.error.message}`);
      e.rpc = body.error;
      throw e;
    }
    return body.result;
  }
  async read(to, functionName, args = [], block = "latest") {
    const out = await this.rpc("eth_call", [{ to, data: data(functionName, args) }, block]);
    return decodeFunctionResult({ abi: ABI, functionName, data: out });
  }
  /// Revert reason of a call, or null when it would pass.
  async why(from, to, callData, value = 0n) {
    try {
      await this.rpc("eth_call", [{ from, to, data: callData, value: `0x${value.toString(16)}` }, "latest"]);
      return null;
    } catch (e) {
      const d = e.rpc?.data;
      if (typeof d === "string" && d.startsWith("0x08c379a0")) return viem.decodeErrorResult({ abi: parseAbi(["error Error(string)"]), data: d }).args[0];
      return e.rpc?.message ?? e.message;
    }
  }
  async start(funded, env) {
    if (this.mode === "anvil") {
      this.children.push(spawn(env.ANVIL ?? "anvil", ["--chain-id", String(this.chainId), "--port", String(this.port), "--host", "127.0.0.1", "--silent", "--code-size-limit", "60000", "--gas-limit", "60000000"], { stdio: "ignore" }));
      await this.waitUp();
      for (const a of funded) await this.rpc("anvil_setBalance", [a.address, "0x56bc75e2d63100000"]);
      return;
    }
    this.produce = env.PRODUCE_DEV;
    this.settled = env.SETTLED_RPC;
    const pins = JSON.parse(readFileSync(join(ROOT, "deployments/mainnet/700770/pins.json"), "utf8"));
    this.pins = pins;
    const l2 = join(this.work, "l2");
    this.l2 = l2;
    execFileSync(join(ROOT, "scripts/staging/private-l2.sh"), ["init", l2, funded.map((a) => a.address).join(","), "1000000000000"], { env: { ...process.env, ...env, }, stdio: "pipe" });
    this.netArgs = ["--rules", "mainnet", "--domain", pins.l2.rulesDomain, "--genesis-time", String(pins.l2.genesisTime)];
    const log = join(this.work, "rpc.log");
    writeFileSync(log, "");
    this.children.push(spawn(env.SETTLED_RPC, ["--data-dir", join(l2, "canonical"), "--view-dir", join(l2, "rpc-view"), "--finality-status", join(l2, "status.json"), "--network", pins.l1.networkPin, "--port", String(this.port), "--poll-ms", "300", ...this.netArgs, "--txpool", join(l2, "txpool")], { stdio: "ignore" }));
    await this.waitUp();
  }
  async waitUp() {
    for (let i = 0; i < 200; i++) {
      try {
        await this.rpc("eth_chainId");
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error("the node did not start");
  }
  stop() {
    for (const c of this.children) c.kill("SIGTERM");
  }
  /// Build one block from everything pending. Returns its number.
  async mine() {
    if (this.mode === "anvil") {
      await this.rpc("evm_mine");
      return BigInt(await this.rpc("eth_blockNumber"));
    }
    const { pins, l2 } = this;
    const head = JSON.parse(execFileSync(this.produce, ["head", "--target", join(l2, "canonical"), ...this.netArgs]).toString()).hash;
    const slotMs = pins.l1.slotSeconds * 1000;
    const slot = Math.floor(((Date.now() / 1000 - pins.l1.genesisTime) * 1000) / slotMs);
    const anchor = (this.anchorN++).toString(16).padStart(64, "0");
    const out = JSON.parse(execFileSync(this.produce, ["extend", "--target", join(l2, "canonical"), "--parent", head, "--anchor", anchor, "--anchor-slot", String(slot), "--timestamp-rule", `1:${pins.l1.genesisTime}:${slotMs}`, "--txs", join(l2, "txpool"), ...this.netArgs], { maxBuffer: 1 << 26 }).toString());
    for (let i = 0; i < 300; i++) {
      if (BigInt(await this.rpc("eth_blockNumber")) >= BigInt(out.number)) break;
      await sleep(100);
    }
    this.lastBlock = out;
    return BigInt(out.number);
  }
  /// Mine until these transactions have receipts. Each receipt is charged to its actor.
  async settle(sent) {
    const list = Array.isArray(sent) ? sent : [sent];
    const pending = new Map(list.map((s) => [s.hash, s]));
    const out = [];
    for (let round = 0; pending.size && round < 8; round++) {
      await this.mine();
      for (const [hash, s] of [...pending]) {
        const r = await this.rpc("eth_getTransactionReceipt", [hash]);
        if (!r) continue;
        pending.delete(hash);
        const fee = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? 0);
        s.actor.paid += fee;
        out.push({ who: s.actor.name, hash, status: r.status === "0x1", block: Number(r.blockNumber), index: Number(r.transactionIndex), gas: Number(r.gasUsed), fee, tip: s.tip, contract: r.contractAddress, logs: r.logs });
      }
    }
    if (pending.size) throw new Error(`no receipt for ${[...pending.values()].map((s) => s.actor.name)}`);
    return Array.isArray(sent) ? out.sort((a, b) => a.index - b.index) : out[0];
  }
  async must(sent) {
    const r = await this.settle(sent);
    for (const x of Array.isArray(r) ? r : [r]) if (!x.status) throw new Error(`${x.who} reverted in block ${x.block}`);
    return r;
  }
  /// Non-zero storage slots per lower-case address. Anvil only.
  async storage() {
    const hex = await this.rpc("anvil_dumpState");
    const dump = JSON.parse(gunzipSync(Buffer.from(hex.slice(2), "hex")).toString());
    const out = {};
    for (const [addr, acc] of Object.entries(dump.accounts)) {
      const live = Object.entries(acc.storage ?? {}).filter(([, v]) => BigInt(v) !== 0n);
      out[addr.toLowerCase()] = Object.fromEntries(live);
    }
    return out;
  }
}

export const BLCH = 10n ** 18n;
export const USD = 10n ** 6n;
export const DEADLINE = 99_999_999_999n;

export function getOut(x, rIn, rOut) {
  return (x * 997n * rOut) / (rIn * 1000n + x * 997n);
}

/// A deployment made directly from the RC's artifacts and the real bridged token.
export class World {
  constructor(net, roles, busdcArtifact, { capW = 10n * BLCH, capQ = 1000n * USD } = {}) {
    Object.assign(this, { net, ...roles, busdcArtifact, capW, capQ, deposit: 0n });
  }
  async create(actor, name, abiArgs, dir) {
    const a = name === "BridgedStablecoinV2" ? this.busdcArtifact : artifact(name, dir);
    const code = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: abiArgs });
    return (await this.net.must(await actor.send(null, code, { gas: 8_000_000n }))).contract.toLowerCase();
  }
  async deploy() {
    const { deployer: D, signer, safe, depositor } = this;
    this.w = await this.create(D, "WBLCH", []);
    const limits = [100_000_000_000n, 10_000_000_000n, 115740n, 1_000_000_000n, 43200n, 1_000_000n];
    this.q = await this.create(signer, "BridgedStablecoinV2", ["Bridged USDC", "bUSDC", 1n, "0x00000000000000000000000000000000000000aa", `0x${"bb".padStart(64, "0")}`, [signer.address], 1n, limits, [[this.guardian.address], 259200n, 259200n]]);
    this.factory = await this.create(D, "UniswapV2Factory", [safe.address, depositor.address, [this.w, this.q], [this.capW, this.capQ]]);
    this.router = await this.create(D, "BDexRouter", [this.factory, this.w]);
    this.lens = await this.create(D, "BDexLens", [this.factory]);
    await this.net.must(await D.send(this.factory, data("createPair", [this.w, this.q]), { gas: 6_000_000n }));
    this.pair = (await this.net.read(this.factory, "getPair", [this.w, this.q])).toLowerCase();
    this.wFirst = (await this.net.read(this.pair, "token0")).toLowerCase() === this.w;
    return this;
  }
  async mintQ(to, amount) {
    const id = `0x${(++this.deposit).toString(16).padStart(64, "0")}`;
    const digest = await this.net.read(this.q, "mintDigest", [id, this.deposit, amount, to]);
    const s = await accounts.sign({ hash: digest, privateKey: this.signer.key });
    const sig = viem.concat([s.r, s.s, viem.numberToHex(Number(s.v ?? 27n + BigInt(s.yParity)), { size: 1 })]);
    return this.net.must(await this.signer.send(this.q, data("mint", [id, this.deposit, amount, to, sig])));
  }
  /// WBLCH and bUSDC in the wallet, router approved for both.
  async fund(actor, aw, aq) {
    const n = [];
    if (aq > 0n) await this.mintQ(actor.address, aq);
    if (aw > 0n) n.push(await actor.send(this.w, data("deposit"), { value: aw }));
    n.push(await actor.send(this.w, data("approve", [this.router, (1n << 256n) - 1n])));
    n.push(await actor.send(this.q, data("approve", [this.router, (1n << 256n) - 1n])));
    await this.net.must(n);
  }
  async seed(aw, aq) {
    await this.fund(this.depositor, aw, aq);
    await this.net.must(await this.depositor.send(this.router, data("addLiquidity", [this.w, this.q, aw, aq, 0n, 0n, this.depositor.address, DEADLINE]), { gas: 800_000n }));
  }
  async state(block = "latest") {
    const [r0, r1] = await this.net.read(this.pair, "getReserves", [], block);
    const bw = await this.net.read(this.w, "balanceOf", [this.pair], block);
    const bq = await this.net.read(this.q, "balanceOf", [this.pair], block);
    const [rw, rq] = this.wFirst ? [r0, r1] : [r1, r0];
    return { rw, rq, bw, bq, xw: bw - rw, xq: bq - rq };
  }
  /// The kit's own view of the pair.
  pairRef() {
    const [token0, token1] = this.wFirst ? [this.w, this.q] : [this.q, this.w];
    return { address: this.pair, token0, token1 };
  }
  swapData(sellW, amountIn, minOut, to) {
    return data("swapExactTokensForTokens", [amountIn, minOut, sellW ? [this.w, this.q] : [this.q, this.w], to, DEADLINE]);
  }
  /// A schema-2 gate file with what the keeper and monitor read. No Safe: feeTo is a throwaway EOA.
  async gate(path) {
    const hash = async (a) => keccak256(await this.net.rpc("eth_getCode", [a, "latest"]));
    const g = await this.net.rpc("eth_getBlockByNumber", ["0x0", false]);
    const ref = await this.pairRef();
    const gate = {
      schemaVersion: 2,
      chain: { id: this.net.chainId, genesisHash: g.hash },
      deployment: {
        contracts: {
          factory: { address: this.factory, codeHash: await hash(this.factory) },
          router: { address: this.router, codeHash: await hash(this.router) },
          lens: { address: this.lens, codeHash: await hash(this.lens) },
          wrappedNative: { address: this.w, codeHash: await hash(this.w) },
        },
        pairInitCodeHash: await this.net.read(this.factory, "INIT_CODE_PAIR_HASH"),
        feeTo: this.safe.address,
        firstDepositor: this.depositor.address,
        reserveCaps: [{ token: this.w, cap: this.capW.toString() }, { token: this.q, cap: this.capQ.toString() }],
        roles: { blochInc: { address: this.safe.address, codeHash: null, safe: {} } },
        tokens: [{ symbol: "bUSDC", token: this.q, codeHash: await hash(this.q) }],
        pairs: [{ ...ref, codeHash: await hash(this.pair) }],
      },
    };
    writeFileSync(path, JSON.stringify(gate, null, 2));
    return gate;
  }
}

export const fmt = (v, d) => {
  const n = Number(v) / 10 ** d;
  return Number.isFinite(n) ? +n.toFixed(6) : null;
};
export const log = (...a) => console.log(...a);
export const big = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
