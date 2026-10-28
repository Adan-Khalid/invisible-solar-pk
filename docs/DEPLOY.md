# Deploying BTMRegistry to the Sepolia testnet (Windows)

This guide puts the contract and the four AEMO evidence attestations on Sepolia, a public
Ethereum **test** network. Test ETH is free and has no value. Until you do this, every
on-chain result in the repository comes from a local Hardhat network, and
`chain/deployments/sepolia.json` does not exist.

Allow about 30 minutes, most of it spent getting test ETH. Option A (Hardhat) is
recommended. Option B (Remix IDE) needs no Node.js for the transactions themselves.

> **Safety rules**
> - Use two **new** accounts that exist only for this testnet, in a wallet whose Secret
>   Recovery Phrase has never controlled real funds. Never send real ETH to these accounts.
> - If your MetaMask already holds real funds, do **not** add the test accounts to it.
>   Accounts added there share its recovery phrase, and step 3 copies their private keys into
>   a plain-text file. Create a separate browser profile instead and install a fresh MetaMask
>   in it, with a new recovery phrase (step 1).
> - A private key gives full control of its account. Put the keys only in `.env`, which is
>   git-ignored. Never commit `.env`, paste it anywhere or show it in a screenshot or video.
> - Before you push, check that `git status` does not list `.env`.

## Why two accounts

`BTMRegistry` separates duties. The **regulator** deploys the contract, authorises
estimators and accepts or disputes estimates. The **estimator** submits estimates
(`attest`). The contract refuses to let one address hold both roles at the same time
(`RegulatorCannotEstimate`), so a current estimator cannot accept its own work; `deploy.js`
also stops if both keys belong to the same account. See [SECURITY.md](SECURITY.md),
section 4, for the full role model and its one governance gap (a former estimator that later
becomes regulator).

## Option A: Hardhat (recommended)

### 0. Prerequisites

- **Node.js 22 or 24** (LTS) and Git. Check with `node --version`. Hardhat 2.29 also runs on
  Node 20, which reached end of life in April 2026; CI tests all three.
- **Install and test.** In the repository root, run `npm ci`, then `npm test`. The test run
  should end with `57 passing`. Then run `npm run test:scripts`
  (`node --test chain/scripts/lib.test.js`). It tests the checks the deployment scripts run
  before sending anything, and should report `pass 42` and `fail 0`.
- **If PowerShell says "running scripts is disabled"** for `npm`/`npx`, use Command Prompt or
  Git Bash instead, or type `npm.cmd` / `npx.cmd`.

**Rehearse locally first (optional, about 5 minutes, no keys, nothing leaves your machine).**
Steps 4, 5 and 7 have local twins that run against a throwaway Hardhat node with funded
test accounts:

```
npm run node            # terminal 1: starts a local node at http://127.0.0.1:8545; leave it running
npm run deploy:local    # terminal 2
npm run anchor:local
npm run verify:local
```

The last command should print `MATCH`. Locally, `EVIDENCE_BASE_URI` may stay unset: the
evidence URI then defaults to the repo-relative `chain/evidence/<file>`. (If `.env` still holds
the template placeholder uncommented, the scripts refuse it here too.) The record goes to
`chain/deployments/localhost.json`, which git ignores, together with any
`localhost.previous*.json`, because the node forgets everything when you stop it (Ctrl+C in
terminal 1). After restarting the node, run `npm run deploy:local` again: a record whose
contract is gone is simply replaced on a local node. Local runs never change
`docs/data/deployment.json` or `results/tables/chain_attestations.csv`.

### 1. Create the two MetaMask accounts

1. Use a MetaMask that has never held real funds. If yours has, open a new browser profile
   (Chrome or Edge: profile icon, then Add) and install MetaMask there. Choose "Create a new
   wallet" and write down the new recovery phrase.
2. Create two accounts and name them, for example, `BTM regulator (testnet)` and
   `BTM estimator (testnet)`.
3. Turn on test networks: in the network selector, enable "Show test networks". Then
   select **Sepolia**.
4. Copy both addresses (`0x...`); you will need the estimator address in Option B.

### 2. Get free Sepolia ETH (regulator only)

**How much.** Send faucet ETH to the **regulator** address. About 0.05 Sepolia ETH is a
comfortable amount. From the local gas measurements in `results/tables/chain_gas_report.txt`:

- **Regulator:** deployment (986,475 gas), `setEstimator` (about 48,000), the estimator
  top-up transfer (21,000) and four `setStatus` calls (about 36,500 each) come to about 1.2
  million gas.
- **Estimator:** four `attest` calls (about 143,500 each with the short local URI, slightly
  more with a full `https://` evidence URI) come to about 0.6 million gas.
- **Top-up:** `deploy.js` funds the estimator from the regulator automatically. If the
  estimator holds less than the `attest` calls still to be made need at the current fee, with
  50 % headroom (and at least 0.005 ETH), it sends the shortfall, at least 0.01 ETH. Stations
  already anchored on the contract are not counted, so a re-run sends only what is missing.

As an example, at a fee of 10 gwei per gas, both accounts together (about 1.8 million gas)
spend about 0.018 ETH. Before sending
anything, `deploy.js` checks that the regulator can pay for all of its transactions and the
top-up at the current fee, and `anchor.js` does the same for the estimator. If an account is
short, the script prints how much it needs and stops with "Nothing was sent".

**Faucets.** The faucets below were listed as available in a third-party comparison checked
on 13 Oct 2026; the author has not tested them. Faucet rules change often, so read each page
before using it:

| Faucet | Requirements |
|---|---|
| [Google Cloud Web3 faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) | Google account, rate-limited per account and address; a small drip (about 0.05 ETH reported). May ask for a mainnet balance check on flagged requests. |
| [Chainlink faucet](https://faucets.chain.link/sepolia) | Connect the wallet (MetaMask); per-address limits |
| [Sepolia PoW faucet (pk910)](https://sepolia-faucet.pk910.de/) | No account and no mainnet balance; you "mine" in the browser tab for a while, then claim |

Several other faucets (Alchemy, for example) require the wallet to hold a little **real**
mainnet ETH. Skip those rather than putting real money in a throwaway wallet.

### 3. Put the keys in `.env`

Create `.env` from the template and open it (PowerShell; in cmd use `copy`):

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill it in:

| Variable | Value |
|---|---|
| `REGULATOR_PRIVATE_KEY` | Private key of the regulator account. In MetaMask: account menu, then account details, then show private key; it asks for your MetaMask password. 64 hex characters; the `0x` prefix is optional; no quotes or spaces. |
| `ESTIMATOR_PRIVATE_KEY` | Private key of the estimator account |
| `SEPOLIA_RPC_URL` | Keep the public default, or use your own free Alchemy/Infura Sepolia URL if the public one is slow |
| `EVIDENCE_BASE_URI` | **Required for Sepolia** (step 5 and Option B). Commented out in the template. Once the repository is public on GitHub, remove the leading `# `, replace `<your-github-username>` with your real user name, and use your branch name if it is not `main`. See the rules below. |
| `ETHERSCAN_API_KEY` | Optional; see step 6 |

Confirm that git ignores the file. `git check-ignore -v .env` should print a `.gitignore`
line ending in `.env`.

**Rules for `EVIDENCE_BASE_URI`.** `anchor.js` puts this prefix in front of each evidence file
name and writes the result into the `Attested` event, where it stays for good. It is checked
before anything is sent, by `anchor.js` and by `npm run remix-args`:

- On Sepolia it must be a full `https://` URL. If it is unset or a relative path, both scripts
  stop before sending anything, with a message ending in `nothing was sent`.
- It must not contain the template placeholder (`<...>` or `your-github-username`), a user name
  or password, a query (`?...`) or a fragment (`#...`), spaces, quotes or other characters a
  URL cannot hold, and must not start with `//`. A raw link copied from a **private** repository carries `?token=...`; that token
  would be published on chain, which is why queries are refused. Make the repository public
  and use the plain URL.
- A missing trailing `/` is added.
- Check the URL before anchoring: with your user name filled in,
  `https://raw.githubusercontent.com/<your-github-username>/invisible-solar-pk/main/chain/evidence/manifest.json`
  must open in a browser.
- Only if you must anchor before the repository is public, set
  `ALLOW_RELATIVE_EVIDENCE_URI=1` as well (in `.env` or for one run). The events then carry
  the repo-relative path `chain/evidence/<file>`, which nobody can download from the event,
  and that cannot be changed later. Avoid it for the hackathon record.
- On the local node (`*:local`) and in `npm run demo`, the repo-relative path is the default
  and no URL is needed.

### 4. Deploy

```
npm run deploy:sepolia
```

This runs `hardhat run chain/scripts/deploy.js --network sepolia`, which:

1. checks that `.env` holds two **different** keys and prints both addresses and balances;
   it also re-hashes the evidence files and the estimator source and stops if either no
   longer matches `chain/evidence/manifest.json`, so no gas is spent on a contract that could
   not be anchored
2. checks that the regulator can pay for the steps below at the current fee
3. deploys `BTMRegistry` from the regulator, records it in `chain/deployments/sepolia.json`
   at once, and waits for 2 confirmations
4. calls `setEstimator(estimator, true)`
5. tops up the estimator if needed (step 2)
6. writes `chain/deployments/sepolia.json`, `docs/data/deployment.json` and
   `results/tables/chain_attestations.csv`
7. prints the Etherscan links and the exact `npx hardhat verify` command

If the run stops part-way (a timeout, a closed laptop), run the same command again. The
contract address is recorded before the script waits for the network, so a re-run never
deploys a second contract by accident:

- **Deployment still pending:** the re-run stops (`is not mined yet`) and asks you to wait a
  few minutes.
- **Deployed, setup unfinished:** the re-run finishes the setup (`setEstimator`, top-up). It
  first checks that the contract's regulator is the `REGULATOR_PRIVATE_KEY` account.
- **Everything set up:** it refuses to deploy again (`already points at a live BTMRegistry`);
  anchor to the existing contract instead. If the estimator has run short since, a re-run
  tops it up.
- **No contract at the recorded address:** a slow public RPC can report this for a while, so
  the script does not replace the record by itself. It prints the address and deploy
  transaction to check on Etherscan and stops. Only if Etherscan confirms there is no
  contract, deploy a new one with `REDEPLOY=1` (below).

To deploy a new contract anyway, run `npx cross-env REDEPLOY=1 npm run deploy:sepolia`. The
old record is kept as `chain/deployments/sepolia.previous.json` (then
`sepolia.previous-2.json`, `-3`, ..., so an earlier copy is never overwritten). The new
contract replaces the old one in `sepolia.json`, `docs/data/deployment.json` and the CSV
straight away, with no attestations until you run step 5 again. The old contract and its
attestations stay on Sepolia.

Go on to step 5 before you push anything: until then the website record lists no
attestations.

### 5. Anchor the four evidence files

```
npm run anchor:sepolia
```

This runs `hardhat run chain/scripts/anchor.js --network sepolia`:

1. **Check.** Before sending anything, it re-hashes every file in `chain/evidence/` (and its
   copy in `docs/evidence/`) and the estimator source in `src/invisible_solar/`, and stops if
   either no longer matches `manifest.json`. It also checks `EVIDENCE_BASE_URI` (step 3
   rules) and the estimator's balance, and prints the evidence URI base it will use. Read
   that line: it is what goes on chain.
2. **Attest.** For each station, the **estimator** calls `attest` with the manifest values,
   `0x` + `evidence_sha256`, `0x` + `code_hash` and the evidence URI.
3. **Accept.** The **regulator** then calls `setStatus(stationId, index, 1 /* Accepted */,
   note)` when the in-sample energy recovery against AEMO's published rooftop PV is within
   70-130 %, with a note such as `checked against AEMO rooftop PV: in-sample recovery 73.52%`.
   This is a demonstration rule, not a regulatory standard. The current manifest values all
   fall inside it; records outside it stay `Pending`. If the regulator is short of test ETH,
   the script says so and the affected records stay `Pending` until you add ETH and run it
   again.
4. **Write.** It writes `chain/deployments/sepolia.json`, `docs/data/deployment.json` and
   `results/tables/chain_attestations.csv`.

The run can be repeated safely. A station already anchored with the same evidence hash is
not attested again, so after a timeout just run it again. Missing transaction details are
read back from the contract's events (best effort; some public RPCs limit log queries).

### 6. Publish the source code on the explorers (optional, recommended)

```
npx hardhat verify --network sepolia <contract address>
```

The constructor takes no arguments. This submits the source to **Etherscan** and to
**Sourcify** (enabled in `hardhat.config.js`, no key needed). Etherscan needs a free API key
(etherscan.io, then My Account, then API Keys) in `ETHERSCAN_API_KEY`. Without one, the
Etherscan part fails with a missing-API-key error and the command exits with an error, but
the Sourcify part still runs. "Already verified" is fine. If the result is "does not have
bytecode", wait a minute for the explorer to index the contract and retry.

### 7. Check it like an auditor

```
npm run verify:sepolia
```

This re-hashes `chain/evidence/AEMO_NSW1_2024.csv` and calls `verify()` on the contract in
`chain/deployments/sepolia.json`. It prints `MATCH` (exit code 0) or `MISMATCH` (exit code 1).
It needs no private key. To check another station, a downloaded copy or another attestation:

```
npx cross-env STATION=AEMO/QLD1 FILE=path/to/AEMO_QLD1_2024.csv npm run verify:sepolia
```

`STATION` defaults to `AEMO/NSW1`; `FILE` (an absolute path, or one relative to the
repository root) to that station's file in `chain/evidence/`; and `INDEX` to the station's
newest `Accepted` attestation (the newest one if none is accepted). `CONTRACT_ADDRESS=0x...`
checks a contract that has no record file. `npm run verify:local` does the same against the
local node.

Without Node: after the Etherscan part of step 6 has succeeded, open the contract on
Etherscan, then Contract, then Read Contract, and call `verify(stationId, 0, 0x<evidence_sha256>)`. It
should return `true`. Take `stationId` from `docs/data/deployment.json` and the hash from
`chain/evidence/manifest.json`. Etherscan shows the Read Contract tab only for contracts
whose source it has verified.

### 8. Commit and push

The files that change are:

- `chain/deployments/sepolia.json`
- `docs/data/deployment.json`
- `results/tables/chain_attestations.csv`
- `chain/deployments/sepolia.previous*.json`, only if you used `REDEPLOY=1`
- `chain/deployments/remix-args.json`, only if you ran `npm run remix-args` (Option B)

Commit them (not `.env`) and push. `chain/deployments/localhost*.json` from a local rehearsal
is git-ignored and never needs committing. The website reads `docs/data/deployment.json`. Once
GitHub Pages rebuilds (a minute or two), it shows the Sepolia contract with Etherscan links
instead of the local Hardhat demo record, and can call `verify()` on Sepolia from the
browser. A published Sepolia record is never overwritten by the local demo
(`chain/scripts/demo.js`).

Update the wording in the README and the Devpost text from "local Hardhat network" to
"Sepolia testnet" with the contract address. It is still a testnet, not a production
deployment.

### Screenshots for proof

Take these for the Devpost gallery and the video. Keep them outside the repository, and
never capture `.env` or MetaMask's private-key screen.

1. The Etherscan contract page, with the verified-source tick if you did step 6
2. The contract's **Events** tab, showing four `Attested` and four `StatusChanged` events
3. **Read Contract** (after step 6): `verify(...)` returning `true`, and `latestAccepted(stationId)`
4. The terminal output of `deploy:sepolia`, `anchor:sepolia` and `verify:sepolia` (no keys are printed)
5. The website showing the live Sepolia record

## Option B: Remix IDE (no Node.js)

1. **Accounts and ETH.** Do steps 1-2 above. In Remix nothing tops up the estimator
   automatically, so send it about 0.01 Sepolia ETH from the regulator with MetaMask's
   **Send** (more if Sepolia fees are unusually high: the four `attest` calls use about 0.6
   million gas). The estimator pays for the `attest` transactions.
2. **Source.** Open <https://remix.ethereum.org>, create `BTMRegistry.sol` and paste the
   exact contents of `chain/contracts/BTMRegistry.sol`.
3. **Compile.** In the **Solidity compiler** tab, choose compiler `0.8.24`. Under Advanced
   configurations, tick **Enable optimization** with **200** runs and set **EVM version**
   to `paris`. These are this project's Hardhat settings (`hardhat.config.js`); Remix's
   default EVM version for 0.8.24 differs. Then compile.
4. **Deploy.** In the **Deploy & run transactions** tab, set Environment to **Injected
   Provider - MetaMask**. Select the regulator account in MetaMask, on Sepolia. Deploy
   `BTMRegistry`, confirm in MetaMask, and copy the contract address from "Deployed
   Contracts".
5. **Authorise the estimator.** As the regulator, call
   `setEstimator(<estimator address>, true)`.
6. **Attest.** Switch MetaMask to the **estimator** account; Remix's Account field follows.
   For each station, open `attest` (click the arrow to show one box per argument) and fill
   in:

   | Argument | Value |
   |---|---|
   | `stationId` | `stationId` of that station in `docs/data/deployment.json`. It is `keccak256("AEMO/NSW1")` etc. and the same on every network. |
   | `periodStart`, `periodEnd`, `capacityKwEff`, `uncertaintyKw`, `energyRecoveryBp` | `period_start`, `period_end`, `capacity_kw_eff`, `uncertainty_kw`, `energy_recovery_bp` in `chain/evidence/manifest.json` |
   | `evidenceHash` | `0x` + that station's `evidence_sha256` |
   | `codeHash` | `0x` + the manifest's top-level `code_hash` |
   | `evidenceURI` | for example `https://raw.githubusercontent.com/<user>/invisible-solar-pk/main/chain/evidence/AEMO_NSW1_2024.csv`, with your real GitHub user name |

   If Node is available (after `npm ci`), `npm run remix-args` prints all of this for you:
   for each station, the complete one-line `attest`, `setStatus` and `verify` arguments with
   the `0x` prefixes, for the single box next to each function. It reads
   `EVIDENCE_BASE_URI` from `.env` and applies the step 3 rules for Sepolia: without a valid
   `https://` URL it stops and writes nothing. It also stops if an evidence file or the
   estimator source no longer matches the manifest. It saves the output in
   `chain/deployments/remix-args.json`. Before pasting, check the first line it prints: it
   shows the evidence base URI that will go on chain.

   The `remix-args.json` already in the repository was generated with the repo-relative path
   (`ALLOW_RELATIVE_EVIDENCE_URI=1`) and carries a `warning` saying so. It is an example of the
   format only: regenerate it with your URL before pasting anything into Remix. To set the URL
   for one run without `.env` (PowerShell; a variable set this way wins over `.env`):

   ```powershell
   $env:EVIDENCE_BASE_URI="https://raw.githubusercontent.com/<user>/invisible-solar-pk/main/chain/evidence/"; npm run remix-args
   ```
7. **Accept.** Switch back to the **regulator** and call
   `setStatus(stationId, 0, 1, "checked against AEMO rooftop PV")` for each station (or paste
   the `setStatus` line from step 6). Here `0` is the first attestation index for that station
   on this contract, and `1` means `Accepted`.
8. **Check.** `verify(stationId, 0, 0x<evidence_sha256>)` should return `true`, and
   `latestAccepted(stationId)` should show the record.
9. **Record it.** Remix writes no files. To put the deployment on the website, run the
   following on any machine with Node and the same two keys in `.env`:

   ```powershell
   $env:CONTRACT_ADDRESS="0xYourContract"; npm run anchor:sepolia
   ```

   `anchor.js` finds the stations already anchored with the same hash and does not attest
   them again. It reads the transactions, evidence URIs and status notes back from the
   contract's events (best effort; some public RPCs limit log queries) and writes the three
   files listed in step 8, with `deployTx` left empty. Afterwards, close the window or run
   `Remove-Item Env:CONTRACT_ADDRESS`. To publish the source, use Remix's **Contract
   verification** plugin. It submits Remix's own compiler input, which `hardhat verify` would
   not match because the source paths differ.

## Troubleshooting

| Message | Fix |
|---|---|
| `has 0 account(s) but needs two` / `has 1 account(s)` | Both private keys must be in `.env`, in the repository root. If a `... is not a 64-hex-character private key` warning is printed above it, fix that key first. |
| `regulator and estimator must be different accounts` | Use two different MetaMask accounts |
| `REGULATOR_PRIVATE_KEY is not a 64-hex-character private key` (or `ESTIMATOR_...`) | The key must be 64 hex characters (optional `0x`), with no spaces or line breaks. Until both keys are valid, `--network sepolia` gets no accounts; local tasks (`npm test`, `npm run demo`) keep working. The warning names the variable, never its value. |
| `... holds ... ETH but ... about ... ETH ... Nothing was sent.` | Regulator: get more test ETH from a faucet. Estimator: run `npm run deploy:sepolia` again (it tops the estimator up from the regulator) or send it test ETH with MetaMask. Then run the same command again. |
| `insufficient funds for gas` | As above; gas prices rose between the check and the transaction |
| `EVIDENCE_BASE_URI ... still holds the .env.example placeholder` / `must be an https:// URL on sepolia` | Fix `EVIDENCE_BASE_URI` in `.env` (step 3), or comment it out to use the repo-relative path |
| `already points at a live BTMRegistry` | This is intended. Run `anchor:sepolia`, or deploy again with `REDEPLOY=1` (step 4). |
| `is not mined yet` | The deployment transaction is still pending. Wait a few minutes and run the same command again. |
| `signer 1 (...) is not an authorised estimator` | `.env` keys do not match this deployment, or `setEstimator` was not called |
| `SHA-256 ... != manifest ...; refusing to anchor` / `the published copy must be byte-identical` | An evidence CSV was changed (for example opened and saved in Excel, or converted to CRLF). Restore it with `git restore chain/evidence docs/evidence`. |
| Timeouts, HTTP 429, `eth_getLogs` range errors | The public RPC is rate-limiting. Put your own Alchemy/Infura Sepolia URL in `SEPOLIA_RPC_URL` and re-run; anchoring resumes where it stopped. |
| `MISMATCH` from `verify:sepolia` | The file differs from the anchored one (check that it was downloaded as raw bytes, not re-saved), or `INDEX` points at another attestation |
| Remix: "Gas estimation failed" | The call would revert. Usually the wrong MetaMask account is selected (`NotEstimator`/`NotRegulator`), the status is `0` (`BadStatus`), or the index is wrong (`BadIndex`). |
| Etherscan: bytecode does not match | Compiler `0.8.24`, optimizer on, 200 runs, EVM `paris`, and the exact source file |
