// Agent 144: headless #/mainnet run of the bUSDC hold status against the V3 bridge on anvil.
//   node hold-shot.mjs <browser-exe> <out-dir> <user> <live-url> <rpc-url> <actions.sh>
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const { chromium } = createRequire(`${process.env.PLAYWRIGHT_DIR}/`)("playwright-core");
const [exe, outDir, user, liveUrl, rpcUrl, actions] = process.argv.slice(2);
const act = (...a) => execFileSync("bash", [actions, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const result = { checks: [], failed: [], states: {} };
const check = (ok, what) => {
  (ok ? result.checks : result.failed).push(what);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleLog = [];
page.on("console", (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => consoleLog.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
await page.addInitScript(
  ({ account, rpc }) => {
    let chainId = "0x1";
    let added = false;
    let id = 1_000_000;
    const forward = async (method, params) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const body = await r.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    };
    const provider = {
      async request({ method, params }) {
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
          detail: Object.freeze({ info: { uuid: "6f1c2c55-4b8e-4c55-9a51-0d6c3b1e7a11", name: "Render test wallet", icon: "", rdns: "invalid.render-test" }, provider }),
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
  },
  { account: user, rpc: rpcUrl },
);

process.on("unhandledRejection", async (e) => {
  try {
    await page.screenshot({ path: `${outDir}/error.png`, fullPage: true });
    writeFileSync(`${outDir}/error.json`, JSON.stringify({ error: String(e?.stack ?? e), main: await page.locator("body").innerText().catch(() => ""), console: consoleLog, result }, null, 2));
  } finally {
    console.log(`hold browser: FAILED ${String(e).slice(0, 300)}`);
    process.exit(1);
  }
});
const banner = () => page.getByLabel("Bridge exit status");
const swapButton = () => page.getByRole("button", { name: "Swap", exact: true });
async function load() {
  await page.goto(liveUrl);
  await page.reload();
  await page.getByRole("table").waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: /Connect Render test wallet/ }).click();
  await page.getByLabel("Finalized balances").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500); // the hold read follows the snapshot
}
async function quoteIntoUsd(amount = "0.01") {
  await page.getByLabel("You pay").selectOption({ label: "BLCH" });
  await page.getByLabel("You receive").selectOption({ label: "bUSDC" });
  await page.getByLabel("Amount").fill(amount);
  await page.getByRole("button", { name: "Get quote" }).click();
  await page.getByLabel("Quote", { exact: true }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
}
async function phone(name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  await page.screenshot({ path: `${outDir}/${name}-phone.png`, fullPage: true });
  const b = (await banner().count()) ? await banner().boundingBox() : null;
  check(w.scroll <= w.client, `${name}: no horizontal scroll at 390 px (scrollWidth ${w.scroll}, clientWidth ${w.client})`);
  if (b) check(b.x >= 0 && b.x + b.width <= 390, `${name}: banner fits the 390 px width (x ${Math.round(b.x)}, w ${Math.round(b.width)})`);
  await page.setViewportSize({ width: 1280, height: 900 });
}
const ops = (state) => {
  const o = JSON.parse(act("ops", state));
  result.states[state] = { ...(result.states[state] ?? {}), ops: o };
  return o;
};

try {
// normal
await load();
check((await banner().count()) === 0, "normal: no bridge banner");
check((await page.getByLabel("Held exit LP notice").count()) === 0, "normal: no LP notice");
await quoteIntoUsd();
check((await page.getByLabel("bUSDC exit notice").count()) === 0, "normal: no pre-send notice on a swap into bUSDC");
check(!(await swapButton().isDisabled()), "normal: Swap enabled without acknowledgement");
await swapButton().click();
await page.getByText(/: mined/).first().waitFor({ timeout: 120000 });
check(true, "normal: swap BLCH -> bUSDC sent from the page and mined");
await page.screenshot({ path: `${outDir}/1-normal.png`, fullPage: true });
await phone("1-normal");
let o = ops("normal");
check(o.bridgeExit?.status === "OK", `normal: monitor bridge_exit OK (${o.bridgeExit?.detail?.slice(0, 120)})`);
check(/"bridgeExit":\s*"normal"/.test(o.keeper), "normal: keeper reports bridgeExit normal");

// paused
act("snapshot-eth");
act("pause");
await load();
let text = (await banner().count()) ? await banner().innerText() : "";
result.states.paused = { banner: text };
check(/bUSDC exits to Ethereum are paused\./.test(text) && /until \d{4}-\d\d-\d\d/.test(text), "paused: alert banner with the pause end");
check((await banner().getAttribute("role")) === "alert", "paused: banner role alert");
check((await page.getByLabel("Held exit LP notice").count()) === 1, "paused: LP notice on the bUSDC pool");
await quoteIntoUsd();
check(await swapButton().isDisabled(), "paused: Swap into bUSDC disabled before acknowledgement");
await page.screenshot({ path: `${outDir}/2-paused.png`, fullPage: true });
await phone("2-paused");
await page.getByLabel("bUSDC exit notice").getByRole("checkbox").check();
await page.waitForTimeout(300);
check(!(await swapButton().isDisabled()), "paused: Swap enabled after acknowledgement");
o = ops("paused");
check(o.bridgeExit?.status === "WARN", `paused: monitor bridge_exit WARN (${o.bridgeExit?.detail?.slice(0, 120)})`);
check(/"bridgeExit":\s*"paused"/.test(o.keeper), "paused: keeper reports bridgeExit paused");
act("revert-eth");
await load();
check((await banner().count()) === 0, "unpaused (Ethereum snapshot restored): banner gone");

// held, latest only, then final
act("forge");
await load();
text = (await banner().count()) ? await banner().innerText() : "";
result.states.heldLatest = { banner: text };
check(/bUSDC exits to Ethereum are held\./.test(text) && /not final yet/.test(text), "forged credit at latest only: held banner, 'not final yet'");
await page.screenshot({ path: `${outDir}/3-held-latest.png`, fullPage: true });
o = ops("held-latest");
check(o.bridgeExit?.status === "CRIT" && /latest blocks only/.test(o.bridgeExit.detail), "held latest-only: monitor bridge_exit CRIT");
act("finalize-l2");
await load();
text = (await banner().count()) ? await banner().innerText() : "";
result.states.held = { banner: text };
check(/bUSDC exits to Ethereum are held\./.test(text) && !/not final yet/.test(text) && /take out of a\s+pool/.test(text), "held (final): banner names bUSDC bought or taken out of a pool");
const lp = page.getByLabel("Held exit LP notice");
check((await lp.count()) === 1 && /bUSDC/.test(await lp.locator("xpath=ancestor::tr").innerText()), "held: LP notice on the WBLCH/bUSDC row");
await quoteIntoUsd();
const notice = page.getByLabel("bUSDC exit notice");
check(/You are buying bUSDC while its exits to Ethereum are held/.test(await notice.innerText()), "held: pre-send notice on a swap into bUSDC");
check(await swapButton().isDisabled(), "held: Swap disabled before acknowledgement");
await page.screenshot({ path: `${outDir}/4-held.png`, fullPage: true });
await phone("4-held");
await notice.getByRole("checkbox").check();
await page.waitForTimeout(300);
check(!(await swapButton().isDisabled()), "held: Swap enabled after acknowledgement");
await page.getByLabel("You pay").selectOption({ label: "bUSDC" });
await page.getByLabel("You receive").selectOption({ label: "BLCH" });
await page.getByLabel("Amount").fill("1");
await page.getByRole("button", { name: "Get quote" }).click();
await page.getByLabel("Quote", { exact: true }).waitFor({ timeout: 30000 });
check((await page.getByLabel("bUSDC exit notice").count()) === 0, "held: selling bUSDC shows no buy notice");
o = ops("held");
check(o.bridgeExit?.status === "CRIT" && o.monitorExit === 2 && /EXITS HELD/.test(o.bridgeExit.detail), "held: monitor bridge_exit CRIT, exit 2");
check(/"bridgeExit":\s*"held"/.test(o.keeper), "held: keeper reports bridgeExit held");

} catch (e) {
  await page.screenshot({ path: `${outDir}/error.png`, fullPage: true }).catch(() => {});
  result.failed.push(`exception: ${String(e?.message ?? e).slice(0, 400)}`);
  result.errorBody = await page.locator("body").innerText().catch(() => "");
  console.log(`FAIL exception ${String(e?.message ?? e).slice(0, 300)}`);
}
result.csp = await page.evaluate(() => window.__csp);
check(result.csp.length === 0, `no CSP violation (${result.csp.join("; ")})`);
result.console = consoleLog.filter((l) => /error/i.test(l)).slice(0, 20);
writeFileSync(`${outDir}/hold-result.json`, JSON.stringify(result, null, 2));
await browser.close();
console.log(`hold browser: ${result.checks.length} passed, ${result.failed.length} failed`);
process.exit(result.failed.length ? 1 : 0);
