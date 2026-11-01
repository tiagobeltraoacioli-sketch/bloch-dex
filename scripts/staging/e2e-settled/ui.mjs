// Drives the production frontend build in a real headless Chromium against the private
// stack with real settled finality, at phone or desktop width. Reads go to the production
// gateway. The injected EIP-6963 test wallet signs in Node with a throwaway key (through
// exposeFunction, so the page's CSP stays exactly as built) and publishes through the
// gateway. No real wallet extension is involved.
//
//   node ui.mjs <scene> <desktop|phone> [args]      evidence: $OUT/<scene>-<device>*.png, .json
//
// Env: BROWSER_EXE PLAYWRIGHT_DIR OUT GW LIVE COMMITTED USER_ADDR USER_KEY
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const { chromium } = createRequire(`${process.env.PLAYWRIGHT_DIR}/`)("playwright-core");
const { BROWSER_EXE, OUT, GW, LIVE, COMMITTED, USER_ADDR, USER_KEY } = process.env;
const [scene, device, ...args] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const result = { scene, device, start: new Date().toISOString(), checks: [], notes: {} };
const name = `${scene}-${device}`;
const check = (ok, what) => {
  result.checks.push({ ok: !!ok, what });
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
const browser = await chromium.launch({ executablePath: BROWSER_EXE, headless: true });
const context = await browser.newContext(
  device === "phone"
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 } },
);
const cast = (...a) => execFileSync("cast", a, { encoding: "utf8" }).trim();
await context.exposeFunction("__e2eWallet", async (method, params) => {
  if (method === "eth_sendTransaction") {
    const tx = params[0];
    const nonce = cast("nonce", tx.from, "--block", "pending", "--rpc-url", GW);
    const raw = cast("mktx", "--chain", "700770", "--nonce", nonce, "--gas-limit", String(BigInt(tx.gas ?? "0x7a120")),
      "--gas-price", "5000000000", "--priority-gas-price", "1000000000", "--value", String(BigInt(tx.value ?? "0x0")),
      "--private-key", USER_KEY, tx.to, tx.data ?? "0x");
    const r = await fetch(GW, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }) });
    const body = await r.json();
    if (body.error) return { error: { code: body.error.code, message: body.error.message } };
    return { result: body.result };
  }
  const r = await fetch(GW, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await r.json();
  return body.error ? { error: body.error } : { result: body.result };
});

const log = { console: [], bodies: [], failed: [] };
async function open(url, wallet) {
  const page = await context.newPage();
  page.on("console", (m) => log.console.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.console.push(`pageerror: ${e.message}`));
  page.on("request", (r) => {
    if (r.url().startsWith(GW) && r.method() === "POST") {
      try { log.bodies.push(JSON.parse(r.postData() ?? "{}")); } catch { /* not JSON */ }
    }
  });
  page.on("requestfailed", (r) => log.failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.url().startsWith(GW) && r.status() >= 400) log.failed.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  if (wallet)
    await page.addInitScript((account) => {
      let chainId = "0x1", added = false;
      window.__wallet = [];
      const provider = {
        async request({ method, params }) {
          window.__wallet.push(method);
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "eth_chainId") return chainId;
          if (method === "wallet_switchEthereumChain") {
            if (!added) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
            chainId = params[0].chainId; return null;
          }
          if (method === "wallet_addEthereumChain") { added = true; chainId = params[0].chainId; return null; }
          const r = await window.__e2eWallet(method, params ?? []);
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
          return r.result;
        },
        on() {}, removeListener() {},
      };
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info: { uuid: "6f1c2c55-4b8e-4c55-9a51-0d6c3b1e7a10", name: "E2E test wallet", icon: "", rdns: "invalid.e2e-test" }, provider }),
      }));
      window.addEventListener("eip6963:requestProvider", announce);
    }, USER_ADDR);
  await page.goto(url);
  return page;
}
const shots = [];
async function shot(page, label) {
  const file = `${name}-${label}.png`;
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  shots.push(file);
  const box = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  check(box.scroll <= box.inner, `${label}: no horizontal page scroll (${box.scroll} <= ${box.inner})`);
}
const connect = async (page) => {
  await page.getByRole("button", { name: /Connect E2E test wallet/ }).click();
  await page.getByLabel("Finalized balances").waitFor({ timeout: 60000 });
};
const liveReady = (page) => page.getByRole("table").first().waitFor({ timeout: 90000 });
const quoteForm = async (page, amount, pay = "bUSDC", get = "BLCH") => {
  await page.getByLabel("You pay").selectOption({ label: pay });
  await page.getByLabel("You receive").selectOption({ label: get });
  await page.getByLabel("Amount").fill(amount);
  await page.getByRole("button", { name: "Get quote" }).click();
};
const rpcNow = async (method, params) => (await (await fetch(GW, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const heads = async () => {
  const [l, f] = await Promise.all([rpcNow("eth_getBlockByNumber", ["latest", false]), rpcNow("eth_getBlockByNumber", ["finalized", false])]);
  return { latest: Number(l.number), finalized: Number(f.number), finalizedAgeSeconds: Math.floor(Date.now() / 1000) - Number(f.timestamp) };
};
const text = (page) => page.locator("main").innerText();
const waitMined = (page, re) => page.getByText(re).first().waitFor({ timeout: 4 * 3600 * 1000 });

const scenes = {
  async notlive() {
    const page = await open(`${COMMITTED}/#/mainnet`, false);
    await page.getByText("Not yet live", { exact: true }).waitFor();
    await page.waitForTimeout(1500);
    await shot(page, "not-live");
    const t = await text(page);
    check(log.bodies.length === 0, "committed build: 0 RPC requests");
    check(/WBLCH\/bUSDC/.test(t) && !/wGSMH/.test(t), "committed build: planned pools are WBLCH/bUSDC only");
    check((await page.evaluate(() => window.__csp)).length === 0, "committed build: no CSP violation");
  },
  // Pools, balances, cap explanation, and which block every read used.
  async live() {
    const page = await open(`${LIVE}/#/mainnet`, true);
    await liveReady(page);
    await shot(page, "live");
    await connect(page);
    result.notes.heads = await heads();
    result.notes.pools = await page.getByRole("table").first().innerText();
    result.notes.balances = await page.getByLabel("Finalized balances").innerText();
    const finalizedShown = Number(result.notes.balances.match(/finalized block (\d+)/)[1]);
    check(finalizedShown <= result.notes.heads.finalized && finalizedShown >= result.notes.heads.finalized - 1, `balances are at the finalized block (${finalizedShown}, chain ${JSON.stringify(result.notes.heads)})`);
    await quoteForm(page, "900");
    await page.getByLabel("Why this swap would revert").waitFor({ timeout: 60000 });
    result.notes.overCap = await page.getByLabel("Why this swap would revert").innerText();
    check(/RESERVE_CAP/.test(result.notes.overCap), "over-cap amount is explained with BDEX: RESERVE_CAP");
    await shot(page, "over-cap");
    const reads = log.bodies.filter((b) => ["eth_call", "eth_getBalance", "eth_getCode"].includes(b.method));
    const atLatest = reads.filter((b) => !b.params?.[1]?.blockHash);
    result.notes.reads = { total: reads.length, atBlockHash: reads.length - atLatest.length, notAtHash: atLatest.map((b) => b.params?.[1]) };
    const sel = cast("sig", "bestExactInput(uint256,address[][],uint256)");
    check(atLatest.every((b) => b.method === "eth_call" && b.params[0]?.data?.startsWith(sel)), "cap, reserve, balance and allowance reads are at the finalized hash; the only latest read is the lens quote");
    check((await page.evaluate(() => window.__csp)).length === 0, "no CSP violation with the cross-origin gateway");
  },
  // The pool moved after the finalized block: warning, Swap disabled, reconfirm, swap mined.
  async stale() {
    const amount = args[0] ?? "2";
    const page = await open(`${LIVE}/#/mainnet`, true);
    await liveReady(page);
    await connect(page);
    result.notes.heads = await heads();
    await quoteForm(page, amount);
    await page.getByLabel("Quote", { exact: true }).waitFor({ timeout: 60000 });
    await page.getByLabel("Stale quote").waitFor({ timeout: 30000 });
    result.notes.warning = await page.getByLabel("Stale quote").innerText();
    result.notes.finalizedQuote = await page.getByLabel("Quote", { exact: true }).innerText();
    check(/worse than this quote/.test(result.notes.warning), "stale quote warning shown");
    check(await page.getByRole("button", { name: "Swap", exact: true }).isDisabled(), "Swap disabled before reconfirmation");
    await shot(page, "stale-warning");
    const approve = page.getByRole("button", { name: new RegExp(`Approve ${amount} bUSDC`) });
    if (await approve.count()) {
      await approve.click();
      await waitMined(page, new RegExp(`Approve ${amount} bUSDC: (mined|failed)`));
      result.notes.approve = await page.getByLabel("Transactions").innerText();
      await shot(page, "approved");
    }
    await page.getByRole("button", { name: /Reconfirm at the latest price/ }).click();
    result.notes.reconfirmedQuote = await page.getByLabel("Quote", { exact: true }).innerText();
    check(/Latest block \d+, not finalized/.test(result.notes.reconfirmedQuote), "reconfirmed quote is labelled latest");
    await shot(page, "reconfirmed");
    await page.getByRole("button", { name: "Swap", exact: true }).click();
    await waitMined(page, new RegExp(`Swap ${amount} bUSDC for BLCH: (mined|failed)`));
    result.notes.steps = await page.getByLabel("Transactions").innerText();
    check(/: mined/.test(result.notes.steps), "the reconfirmed swap was mined");
    await shot(page, "swapped");
    // onMined refreshes the panel, and with real finality the finalized hash has moved by now.
    await page.waitForTimeout(20000);
    const stillShown = await page.getByLabel("Transactions").count();
    check(stillShown > 0, "the transaction result stays on screen after the post-swap refresh");
    await shot(page, "swapped-after-refresh");
    result.notes.heads2 = await heads();
    check((await page.evaluate(() => window.__csp)).length === 0, "no CSP violation");
  },
  // After a finalized donation: hint, blocked route, one click skim, hint gone after finality.
  async excess() {
    const page = await open(`${LIVE}/#/mainnet`, true);
    await liveReady(page);
    await connect(page);
    const hint = page.getByLabel("Pending excess");
    await hint.waitFor({ timeout: 60000 });
    result.notes.hint = await hint.innerText();
    check(/revert until someone calls skim/.test(result.notes.hint), "the UI shows the blocking excess and the skim hint");
    await quoteForm(page, "1");
    await page.getByLabel("Why this swap would revert").waitFor({ timeout: 60000 });
    result.notes.blocked = await page.getByLabel("Why this swap would revert").innerText();
    check(/above its reserves/.test(result.notes.blocked), "the blocked route names the excess");
    await shot(page, "pending-excess");
    await page.getByRole("button", { name: "Skim to my wallet" }).click();
    await page.getByText(/Skim (mined|reverted) in block/).waitFor({ timeout: 4 * 3600 * 1000 });
    result.notes.skim = await hint.innerText().catch(() => "hint gone");
    check(/Skim mined/.test(result.notes.skim), "skim mined");
    await shot(page, "skim-mined");
  },
  async excessgone() {
    const page = await open(`${LIVE}/#/mainnet`, true);
    await liveReady(page);
    await page.waitForTimeout(3000);
    check((await page.getByLabel("Pending excess").count()) === 0, "after skim and finality the hint is gone");
    await shot(page, "after-skim");
  },
  // State capture for stalls and backend failures: load, connect, quote, screenshot, record the words.
  async observe() {
    const label = args[0] ?? "observe";
    const page = await open(`${LIVE}/#/mainnet`, true);
    const failed = page.getByRole("alert");
    await Promise.race([liveReady(page), failed.first().waitFor({ timeout: 90000 })]).catch(() => {});
    await page.waitForTimeout(2000);
    result.notes.heads = await heads().catch((e) => String(e));
    result.notes.main = (await text(page)).slice(0, 2500);
    result.notes.alerts = await failed.allInnerTexts();
    await shot(page, `${label}-load`);
    if (await page.getByRole("button", { name: /Connect E2E test wallet/ }).count()) {
      await connect(page).catch((e) => { result.notes.connectError = String(e).slice(0, 200); });
      await quoteForm(page, "1").catch(() => {});
      await page.waitForTimeout(8000);
      result.notes.afterQuote = (await page.locator(".devnet4-swap").innerText().catch(() => "")).slice(0, 1800);
      await shot(page, `${label}-quote`);
    }
    result.notes.failed = log.failed.slice(0, 20);
  },
  // A swap whose receipt polls hit a backend failure while it is pending. Args: seconds to watch.
  // The caller breaks the RPC while this runs, when the marker file appears.
  async pendingfailure() {
    const page = await open(`${LIVE}/#/mainnet`, true);
    await liveReady(page);
    await connect(page);
    await quoteForm(page, args[0] ?? "0.5", args[1] ?? "BLCH", args[2] ?? "bUSDC");
    await page.getByLabel("Quote", { exact: true }).waitFor({ timeout: 60000 });
    const reconfirm = page.getByRole("button", { name: /Reconfirm at the latest price/ });
    await page.waitForTimeout(3000);
    if (await reconfirm.count()) await reconfirm.click();
    await page.getByRole("button", { name: "Swap", exact: true }).click();
    await page.getByText(/Waiting for the next L2 block/).waitFor({ timeout: 60000 });
    const hash = await page.getByLabel("Transactions").locator("code").first().innerText();
    result.notes.hash = hash;
    await shot(page, "pending");
    writeFileSync(`${OUT}/${name}.marker`, hash);
    console.log(`MARK ${hash}`);
    const watch = Number(args[3] ?? 600) * 1000;
    const t0 = Date.now(), timeline = [];
    let last = "";
    while (Date.now() - t0 < watch) {
      const now = await page.getByLabel("Transactions").innerText().catch(() => "(no Transactions list)");
      if (now !== last) { timeline.push({ s: Math.round((Date.now() - t0) / 1000), text: now.slice(0, 300) }); last = now; await shot(page, `t${Math.round((Date.now() - t0) / 1000)}`); }
      if (/: mined/.test(now)) break;
      await page.waitForTimeout(3000);
    }
    result.notes.timeline = timeline;
    result.notes.swapEnabledAtEnd = await page.getByRole("button", { name: "Swap", exact: true }).isEnabled().catch(() => null);
    result.notes.failed = log.failed.slice(0, 20);
  },
};
try {
  await scenes[scene]();
} catch (error) {
  result.error = String(error).slice(0, 600);
  console.log(`ERROR ${result.error}`);
}
result.console = log.console.filter((l) => !l.startsWith("debug"));
result.shots = shots;
result.end = new Date().toISOString();
writeFileSync(`${OUT}/${name}.json`, JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.error || result.checks.some((c) => !c.ok) ? 1 : 0);
