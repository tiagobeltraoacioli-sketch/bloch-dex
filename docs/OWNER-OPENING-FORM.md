# Owner opening form (WBLCH/bUSDC)

One page. Fill `deployments/mainnet/opening-form.json` (public addresses and paths only, never a key), then run the two commands at the end. The tool checks every value, writes the DEX config, the page's network file and CSP, the monitor and keeper environment, and the exact seed commands. Background: `OPS-OPENING-KIT.md`, `OPS-INITIAL-LIQUIDITY.md`.

## A. Your decisions

| # | Field | Fill with | Recommended |
|---|---|---|---|
| 1 | `openingPrice` | P, bUSDC per BLCH, decimal (`"100"`, `"25.5"`) | Your call. P >= 80 keeps the 1,000 bUSDC cap |
| 2 | `busdcCap` | `"auto"`, or whole bUSDC | `"auto"` = min(1000, 10 x P). Anything outside 75-125% of 10 x P is refused |
| 3 | `firstDepositor` | A **new** EOA (hardware wallet) used only for the approve and the seed | Not a Safe owner, not the LP recipient, not the keeper, not the deployer. The tool refuses those |
| 4 | `lpRecipient` | Address that receives the LP shares | Not the Safe (principal and fee stay apart; an exit does not need 3 of 5) |
| 5 | `seederExit.policy`, `seederExit.floorBps` | `"keep-floor"` and 1000 or more | **Decided (round 10): `keep-floor`, `floorBps` 1000** (keep 10% of the seed position, 0.5 WBLCH + 50 bUSDC at P = 100). The tool refuses `full-exit` and a floor under 1000 |
| 6 | `keeper.address`, `keeper.keystore`, `keeper.passwordFile` | Hot gas-only key; absolute paths on the keeper host | Budget defaults: 0.05 BLCH and 48 tx per 24 h |
| 7 | `bridgeStatus.ethRpcUrl`, `bridgeStatus.vault`, `bridgeStatus.vaultCodeHash` | Ethereum RPC (https, serves `finalized`, CORS open), ProvenanceSourceVault address, its runtime code hash (or `null`) | Fill all three: without them the page and the monitor cannot see held or paused bUSDC exits |
| 8 | `site.*` | Public L2 RPC and its status, explorer, bridge links | `rpcStatus: "live"` only once the public RPC is up |

Optional: `seed.fractionBps` (default 5000, at most 7000, the planner's limit: at 8000 a balanced seed sits on the k ceiling, DEX-4), `seed.deadlineMin` (default 120; raise it if L2 blocks are slow).

## B. Values from earlier steps (copy, do not choose)

`fromEarlierSteps.dexDeployer` (kit item 8), `safeOwners` (items 1-5, for the key-reuse check), `busdcToken` and `busdcCodeHash` (bridge deployment), `busdcBucketCapacity` (`10000000000`). The Safe address comes from `deploy-safe.mjs blochinc`.

## C. What "full exit" means (decision 5)

The first-deposit rule only protects a pair with no shares. After the seed, 1,000 shares stay locked forever, so it never comes back. If the LP recipient removes everything (rehearsed, `scripts/ops/rehearse-opening.sh` section X):

- The pool keeps 1 unit of bUSDC and 1e8 wei of WBLCH; rounding puts its price at 10,000 instead of 100.
- Anyone can set any price for about 2e-8 WBLCH (donation + `sync`) and fill the pair to a cap at that price. After that, nobody else can deposit.
- A donation of about 1,600 bUSDC of value, synced to the k ceiling, fills the pair permanently: those reserves belong only to the locked shares, so no deposit or burn can ever change them. Reopening on your terms then means a new factory and a new DEX deployment.
- At 178's tip the kit's planner could not reopen from that dust (its price-correcting swap reverted). It now plans `reprice-by-donation` (donate WBLCH to set P, `sync`), then the top-up (`OPS-INITIAL-LIQUIDITY.md`).

With the floor kept, the same donation went to the LP recipient (6.75 BLCH + 675 bUSDC recovered in the rehearsal), and the room reopened when the LP exited. The monitor reports `lp_floor` CRIT if the recipient falls below the floor.

Decided for launch: no full exit. The form refuses `full-exit`, the planner's `remove` refuses a removal below the floor (unless `--allow-below-floor`), and the monitor's `lp_floor` is the backstop for a burn sent another way.

## D. Run

```
node scripts/ops/opening-form.mjs check --form deployments/mainnet/opening-form.json --bloch-inc blochinc.json --rpc http://127.0.0.1:18955 --eth-rpc TBD-owner
```

```
node scripts/ops/opening-form.mjs apply --form deployments/mainnet/opening-form.json --bloch-inc blochinc.json --out opening-out --rpc http://127.0.0.1:18955 --eth-rpc TBD-owner
```

Then: `opening-out/dex-mainnet.config.json` goes to `deploy-dex.mjs validate`, `plan`, `txs`; `frontend.network.json` and `_headers` replace the committed ones before the site build; `dex-ops.env` is `/etc/bloch-dex-ops/env`; `OPENING-COMMANDS.md` lists the seed, verify, monitor and keeper commands with your values. Exit 2 lists every problem; nothing is sent either way.

With `--rpc`, the checker requires the exact positive `bucketCapacity()` and
the token's Ethereum `sourceChainId()` and `sourceVault()` to match the form.
A reverted, unavailable, zero or malformed capacity read is a refusal. With
`--eth-rpc`, it requires vault code and a valid finalized block beyond genesis;
the optional vault code hash is checked when supplied. These are read-only
opening checks, not the finality gate or permission to seed the pool.
