// Headless render check of #/mainnet against a rehearsal chain: the committed
// build ("Not yet live", no RPC traffic), then a live build reading the chain
// cross-origin through the CORS gateway rig, with an injected EIP-6963 test
// wallet (the rig signs with a throwaway key; no key is in the page).
//
//   node shot.mjs <browser-exe> <out-dir> <user> <committed-url> <live-url> <rpc-url> <actions.sh>
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const { chromium } = createRequire(`${process.env.PLAYWRIGHT_DIR}/`)("playwright-core");
const [exe, outDir, user, committedUrl, liveUrl, rpcUrl, actions] = process.argv.slice(2);
const act = (...args) => execFileSync("bash", [actions, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const result = {};
const expect = (ok, what) => {
  if (!ok) throw new Error(`render check failed: ${what}`);
  (result.checks ??= []).push(what);
};
const browser = await chromium.launch({ executablePath: exe, headless: true });

async function open(url, wallet) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const log = { console: [], requests: [], bodies: [] };
  page.on("console", (m) => log.console.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.console.push(`pageerror: ${e.message}`));
  page.on("request", (r) => {
    if (r.url().startsWith(rpcUrl) && r.method() === "POST") {
      log.requests.push(r.url());
      log.bodies.push(JSON.parse(r.postData() ?? "{}"));
    }
  });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  if (wallet)
    await page.addInitScript(
      ({ account, rpc }) => {
        let chainId = "0x1";
        let added = false;
        let id = 1_000_000;
        window.__wallet = [];
        const forward = async (method, params) => {
          const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
          const body = await r.json();
          if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
          return body.result;
        };
        const provider = {
          async request({ method, params }) {
            window.__wallet.push({ method, params });
            if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
            if (method === "eth_chainId") return chainId;
            if (method === "wallet_switchEthereumChain") {
              if (!added) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
              chainId = params[0].chainId;
              return null;
            }
            if (method === "wallet_addEthereumChain") {
              added = true;
              chainId = params[0].chainId;
              return null;
            }
            return forward(method, params);
          },
          on() {},
          removeListener() {},
        };
        const announce = () =>
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: Object.freeze({
                info: { uuid: "6f1c2c55-4b8e-4c55-9a51-0d6c3b1e7a10", name: "Render test wallet", icon: "", rdns: "invalid.render-test" },
                provider,
              }),
            }),
          );
        window.addEventListener("eip6963:requestProvider", announce);
      },
      { account: user, rpc: rpcUrl },
    );
  await page.goto(url);
  return { page, log };
}
const shot = (page, name) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
const connect = async (page) => {
  await page.getByRole("button", { name: /Connect Render test wallet/ }).click();
  await page.getByLabel("Finalized balances").waitFor({ timeout: 30000 });
};
const quoteForm = async (page, amount) => {
  await page.getByLabel("You pay").selectOption({ label: "bUSDC" });
  await page.getByLabel("You receive").selectOption({ label: "BLCH" });
  await page.getByLabel("Amount").fill(amount);
  await page.getByRole("button", { name: "Get quote" }).click();
};

// A: committed build, not yet live, no RPC traffic, WBLCH/bUSDC only.
{
  const { page, log } = await open(committedUrl, false);
  await page.getByText("Not yet live", { exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await shot(page, "A-not-live");
  const text = await page.locator("main").innerText();
  result.notLive = { text: text.slice(0, 1500), csp: await page.evaluate(() => window.__csp), console: log.console };
  expect(log.requests.length === 0, "committed build: 0 RPC requests");
  expect(/WBLCH\/bUSDC/.test(text) && !/wGSMH/.test(text), "committed build: planned pools are WBLCH/bUSDC only");
  expect(result.notLive.csp.length === 0, "committed build: no CSP violation");
  await page.close();
}

// B: live build.
{
  const { page, log } = await open(liveUrl, true);
  await page.getByRole("table").waitFor({ timeout: 30000 });
  await shot(page, "B-live");
  const live = (result.live = { pools: await page.getByRole("table").innerText() });
  await connect(page);
  live.balances = await page.getByLabel("Finalized balances").innerText();

  // Cap revert explained before any transaction.
  await quoteForm(page, "900");
  await page.getByLabel("Why this swap would revert").waitFor();
  live.overCap = await page.getByLabel("Why this swap would revert").innerText();
  expect(/RESERVE_CAP/.test(live.overCap), "over-cap amount is explained with BDEX: RESERVE_CAP");
  await shot(page, "C-over-cap");

  // Stale quote: the rehearsal moved the pool after the finalized block.
  await quoteForm(page, "10");
  await page.getByLabel("Quote", { exact: true }).waitFor();
  await page.getByLabel("Stale quote").waitFor({ timeout: 15000 });
  live.staleWarning = await page.getByLabel("Stale quote").innerText();
  live.finalizedQuote = await page.getByLabel("Quote", { exact: true }).innerText();
  expect(/worse than this quote/.test(live.staleWarning), "stale quote: warning shown");
  expect(await page.getByRole("button", { name: "Swap", exact: true }).isDisabled(), "stale quote: Swap disabled before reconfirmation");
  await shot(page, "D-stale-warning");
  const approve = page.getByRole("button", { name: /Approve 10 bUSDC/ });
  if (await approve.count()) {
    await approve.click();
    await page.getByText(/Approve 10 bUSDC: mined/).waitFor({ timeout: 120000 });
  }
  await page.getByRole("button", { name: /Reconfirm at the latest price/ }).click();
  live.reconfirmedQuote = await page.getByLabel("Quote", { exact: true }).innerText();
  expect(/Latest block \d+, not finalized/.test(live.reconfirmedQuote), "stale quote: reconfirmed quote is labelled latest");
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await page.getByText(/Swap 10 bUSDC for BLCH: (mined|failed)/).waitFor({ timeout: 120000 });
  live.steps = await page.getByLabel("Transactions").innerText();
  expect(/Swap 10 bUSDC for BLCH: mined/.test(live.steps), "stale quote: the reconfirmed swap was mined");
  await shot(page, "E-swapped");

  const reads = log.bodies.filter((b) => ["eth_call", "eth_getBalance", "eth_getCode"].includes(b.method));
  const latest = reads.filter((b) => b.params?.[1] === "latest");
  live.reads = { total: reads.length, atBlockHash: reads.filter((b) => b.params?.[1]?.blockHash).length, atLatest: latest.length };
  // Selector of BDexLens.bestExactInput (the stale-quote cross-check).
  const quoteSelector = execFileSync("cast", ["sig", "bestExactInput(uint256,address[][],uint256)"], { encoding: "utf8" }).trim();
  const appLatest = latest.filter((b) => b.method === "eth_call" && b.params[0]?.data);
  expect(appLatest.every((b) => b.params[0].data.startsWith(quoteSelector)), "the only eth_call at latest is the lens quote");
  const multicall = process.env.MULTICALL3;
  expect(reads.some((b) => b.method === "eth_call" && b.params[0]?.to?.toLowerCase() === multicall && b.params[1]?.blockHash), "balances are read through the recorded Multicall3 at the finalized block");
  live.csp = await page.evaluate(() => window.__csp);
  expect(live.csp.length === 0, "live build: no CSP violation with the cross-origin RPC");
  live.console = log.console.filter((l) => !l.startsWith("debug"));
  live.wallet = await page.evaluate(() => window.__wallet.map((w) => w.method));
  await page.close();
}

// C: a donation above the cap shows the pending excess, and one click skims it.
{
  act("donate-and-finalize");
  const { page } = await open(liveUrl, true);
  await page.getByRole("table").waitFor({ timeout: 30000 });
  await connect(page);
  const hint = page.getByLabel("Pending excess");
  await hint.waitFor({ timeout: 30000 });
  const excess = (result.excess = { hint: await hint.innerText() });
  expect(/revert until someone calls skim/.test(excess.hint), "donation above the cap: the UI shows the blocking excess and the skim hint");
  await quoteForm(page, "1");
  await page.getByLabel("Why this swap would revert").waitFor();
  excess.blockedRoute = await page.getByLabel("Why this swap would revert").innerText();
  expect(/above its reserves/.test(excess.blockedRoute), "donation above the cap: the blocked route names the excess");
  await shot(page, "F-pending-excess");
  await page.getByRole("button", { name: "Skim to my wallet" }).click();
  await page.getByText(/Skim mined in block/).waitFor({ timeout: 120000 });
  await page.close();
  act("finalize");
  const second = await open(liveUrl, true);
  await second.page.getByRole("table").waitFor({ timeout: 30000 });
  await second.page.waitForTimeout(2000);
  expect((await second.page.getByLabel("Pending excess").count()) === 0, "after skim and finality the hint is gone");
  await shot(second.page, "G-after-skim");
  await second.page.close();
}

await browser.close();
writeFileSync(`${outDir}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.checks, null, 2));
