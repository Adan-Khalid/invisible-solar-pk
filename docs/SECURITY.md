# Security and data-integrity note

This note is for judges, auditors and regulators. It explains what `BTMRegistry`
(`chain/contracts/BTMRegistry.sol`) records, how anyone can check a record without trusting
this project, and what the chain does **not** prove.

In short, the chain proves that a specific evidence file and a declared version of the
estimator code were committed to by a specific estimator address at a specific time, and
that the regulator later accepted or disputed that record. It does not prove that the meter
readings inside the file were honest, or that the estimate is right. Those questions are
answered by open data, independent re-estimation and the regulator's review.

Unless a file under `chain/deployments/` says otherwise, every on-chain number in this
repository comes from a **local Hardhat network**. Nothing is on a public network until the
author follows [DEPLOY.md](DEPLOY.md).

## 1. What one attestation stores

| Field | Meaning |
|---|---|
| `stationId` | `keccak256` of the UTF-8 station name, for example `keccak256("AEMO/NSW1")` (`ethers.id(...)`) |
| `periodStart`, `periodEnd` | Period covered, as `yyyymmdd` |
| `capacityKwEff` | Estimated effective hidden-PV capacity in kW at 1000 W/m2. This is the mean of the 12 monthly estimates. |
| `uncertaintyKw` | **Seasonal spread**: the standard deviation of the 12 monthly capacity estimates. It is **not a confidence interval**. |
| `energyRecoveryBp` | Estimated rooftop-PV energy divided by the energy of an independent PV reference series, in basis points (10000 = 100 %). For the four AEMO records the reference is AEMO-published rooftop PV (`ROOFTOP_PV_ACTUAL`, type `MEASUREMENT`): AEMO's measurement-based estimate, upscaled from metered systems, not a census and not metered output of every system. The figure is **in-sample**: the model is fitted on the same year's net load and irradiance (the PV series is never used in fitting) and then compared with that series. Where no independent PV reference exists (the Pakistan use case), the contract's convention is 0. |
| `evidenceHash` | SHA-256 of the evidence file bytes |
| `codeHash` | SHA-256 over the estimator source (section 3). It is declared by the estimator; the contract cannot check it. |
| `estimator`, `timestamp` | Sender address and block time. Both are set by the contract and cannot be supplied by the caller. |
| `status` | `Pending`, `Accepted` or `Disputed` (section 5) |
| `evidenceURI` | Where the file can be downloaded. It is emitted in the `Attested` event, not stored in contract state. |

The values for each region, with the validation details (`validation.kind`,
`validation.truth`, `uncertainty_rule`), are in `chain/evidence/manifest.json`. Read the
numbers there, not from this note. The contract's NatSpec describes `energyRecoveryBp` as
energy recovery against an independent PV reference and leaves it to the manifest to say
whether the figure is in-sample. For the four anchored AEMO records it is
(`validation.kind`).

## 2. The evidence file and its hash

Each attestation points to one CSV in `chain/evidence/` (a byte-identical copy is published
in `docs/evidence/`) with this header:

```
timestamp,net_load_mw,ghi_wm2,t2m_c,rooftop_pv_mw_measured
```

- `timestamp`: hour-beginning, on a fixed-offset clock with no daylight saving. For all four
  AEMO regions, SA included, that clock is NEM market time (AEST, UTC+10). AEMO stamps its
  values at the end of each interval, so the hour starting 10:00 is the mean of the values
  stamped after 10:00 up to and including 11:00. NASA POWER's hourly "LST" stamps (UTC plus a
  whole-hour longitude-band offset) are shifted onto the same clock (Adelaide by +1 h).
- `net_load_mw`: the utility-side net load, which is the only grid input the estimator uses
- `ghi_wm2`, `t2m_c`: NASA POWER satellite irradiance and 2 m temperature
- `rooftop_pv_mw_measured`: AEMO-published rooftop PV. The column name follows AEMO's type
  label `MEASUREMENT`; the values are AEMO's measurement-based estimate, not metered output of
  every system. It is used **only to validate**, never to fit.

The format is canonical, so the hash is reproducible. Files are UTF-8 without a BOM, use LF
line endings and fixed 3-decimal numbers, and are written by
`src/invisible_solar/evidence.py`. The hash rule is plain SHA-256 of the file bytes. No
project code is needed to check it:

```
sha256sum chain/evidence/AEMO_NSW1_2024.csv                           # Linux, Git Bash
shasum -a 256 chain/evidence/AEMO_NSW1_2024.csv                       # macOS
certutil -hashfile chain\evidence\AEMO_NSW1_2024.csv SHA256           # Windows cmd
Get-FileHash chain\evidence\AEMO_NSW1_2024.csv -Algorithm SHA256      # PowerShell (prints upper case)
```

The project website also hashes a file in the browser, with WebCrypto or a pure-JavaScript
fallback (`docs/assets/verify.js`); nothing is uploaded.

To compare the result with the chain, call `verify(stationId, index, 0x<sha256>)`. It returns
`true` only for the anchored hash; `get(stationId, index).evidenceHash` returns the anchored
value itself. Where you can do that today:

- **Local run (works now).** `npm run demo` deploys the contract on Hardhat's in-process
  network, anchors the four files, and runs the same `verify` check, including a +1 MW
  tamper that must fail.
- **Sepolia (only after a deployment exists).** There is no `chain/deployments/sepolia.json`
  yet, so nothing below works today. Once the author has deployed (DEPLOY.md), this read-only
  script checks a downloaded copy and needs no key:

  ```
  npx cross-env STATION=AEMO/NSW1 FILE=path/to/AEMO_NSW1_2024.csv hardhat run chain/scripts/verify-evidence.js --network sepolia
  ```

  It checks the station's newest accepted attestation (the newest one if none is accepted)
  unless `INDEX` is set, and reads the address from `chain/deployments/sepolia.json` unless
  `CONTRACT_ADDRESS` is set. Etherscan's "Read
  Contract" tab offers the same `verify` and `get` calls, but only once the source has been
  verified on Etherscan (DEPLOY.md, step 6).

The bytes must be exact. Re-saving the file in Excel, converting the line endings to CRLF or
cutting a single byte changes the hash. `.gitattributes` marks the evidence CSVs `-text` so
that git never rewrites them on Windows. The test suite shows that +1 MW on one hourly
reading, removing one byte and a CRLF conversion each make `verify()` fail.

## 3. The code hash and re-running the estimator

`codeHash` is SHA-256 over the four modules on the evidence-to-estimate path:
`evidence.py`, `features.py`, `hidden_pv.py` and `metrics.py`. They are processed in sorted
order, and each one contributes its file name, a NUL byte, the file text with CRLF
normalised to LF, and another NUL byte (`invisible_solar.evidence.code_hash`). The
normalisation makes Windows and Linux checkouts hash the same.

`python chain/verify_estimate.py`, run from the repository root with the packages in
`requirements-lock.txt` installed, starts from the published files only. It:

1. recomputes the estimator `code_hash` and compares it with the manifest
2. hashes each evidence file and compares it with the manifest's `evidence_sha256`
3. reads the CSV and refits the hourly IRR estimator on it
4. compares the resulting capacity, uncertainty and energy recovery with the anchored
   integers, and the covered period (`period_start`, `period_end`, `n_hours`) with the manifest

It exits with an error if any of these checks fails. The option `--allow-code-change` turns
a `code_hash` difference into a warning, for checking a modified estimator against the old
anchors. CI's separate `evidence` job also recomputes the code hash, with Python's `hashlib`
alone and no project code.

CI runs both on every push, with the exact library versions from `requirements-lock.txt`.
That pinning matters: the refit is an exact-integer check, and a very different
numpy/pandas/statsmodels build could in principle move the last digit of the rounded kW.

Not covered by `codeHash`:
- third-party library versions (numpy, pandas, statsmodels, and `holidays`, which sets the public-holiday day type)
- the raw-data preparation that produced the evidence file (`data.py`, `chain/export_evidence.py`)

An auditor checks the file itself against the public AEMO and NASA POWER sources.

## 4. Roles and separation of duties

| Role | Can | Cannot |
|---|---|---|
| Regulator (deployer) | Grant and revoke estimators, accept or dispute attestations, start a handover | Be an estimator: `setEstimator(regulator, true)` reverts `RegulatorCannotEstimate` |
| Estimator | `attest` | Change any status (`NotRegulator`), so while it holds the role it cannot accept its own work |
| Anyone | Read `get`, `count`, `latestAccepted`, `verify`, `regulator`, `pendingRegulator`, `isEstimator` and the events | Write anything |

- **Two-step handover.** `transferRegulator(next)` only nominates. Power moves when `next`
  itself calls `acceptRegulator()`, so a typo cannot lock the contract. A nominee that holds
  the estimator role is refused (`RegulatorCannotEstimate`).
- **Production.** The regulator should be a multisig (for example a Safe controlled by
  several officials), installed with `transferRegulator(safe)` followed by `acceptRegulator()`
  from the Safe. A single key is acceptable for a demo only.
- **Limits.** Separation is enforced per address and at one point in time, not per person.
  - `setStatus` does not compare the caller with the attestation's `estimator`. An address
    that was an estimator, was revoked and later became regulator could therefore accept
    attestations it submitted itself. Governance must not hand the regulator role to a
    former estimator.
  - A pending nomination cannot be cleared to `address(0)`. To cancel one, nominate the
    current regulator and accept.

## 5. Status lifecycle

```
attest -> Pending --setStatus--> Accepted <--setStatus--> Disputed
                  \--setStatus--> Disputed
```

- Only the regulator calls `setStatus`, and every call carries a note in the
  `StatusChanged` event.
- Re-review is allowed (Accepted to Disputed and back). Nothing returns to `Pending`
  (`BadStatus`).
- Records are append-only: nothing is ever deleted, and the estimate fields (period,
  capacity, uncertainty, recovery and both hashes) can never change. Only `status` changes,
  and each change emits a `StatusChanged` event. A corrected estimate is a new attestation
  with a new index.
- `latestAccepted(stationId)` returns the newest `Accepted` record, which is what a planner
  should read.
- Revoking an estimator blocks its future attestations but leaves its past ones untouched.
  The regulator disputes those individually if needed.

## 6. Threat model

| Threat | Outcome | Mitigation |
|---|---|---|
| Evidence file edited after anchoring | **Detected.** Its SHA-256 no longer matches, and `verify()` returns false. | Hash on chain; anyone can re-hash |
| Estimator code changed after anchoring | **Detected** in this repository: the source no longer hashes to the anchored `codeHash` (CI checks it). | Code hash; open source |
| Estimator submits numbers or a `codeHash` that did not come from the published file and code | **Not detected by the chain.** The contract stores what it is given; it cannot run the estimator. | Independent re-estimation: `chain/verify_estimate.py` must reproduce the anchored integers exactly from the published file; regulator review before `Accepted` |
| Rogue or careless estimator | Its records stay visible but are not accepted. | Regulator disputes them and revokes the role; the history stays public. |
| Estimator tries to accept its own estimate | **Blocked** (`NotRegulator`) | Role separation, tested |
| Compromised regulator key | Attacker could accept or dispute records, change estimators or take over the regulator role. Every action is a public event. | A multisig regulator is the real mitigation. Moving to a new key with the two-step handover is best effort only: an attacker holding the same key can re-nominate first. If control is lost, deploy a new registry; the old records stay readable. |
| Dishonest meter data (oracle problem) | **Not solved by the chain.** A hash of false data is still a valid hash. | Open data, satellite irradiance cross-checks, independent re-estimation from the published file, regulator review |
| Evidence file unavailable | The hash cannot be checked without the file. | `evidenceURI` in the event; GitHub copy in `docs/evidence/`. A long-term mirror (for example Zenodo) is recommended; none exists yet. |
| Privacy | Only aggregate region or grid-station series are anchored; no household data goes on chain or in the evidence files. | Aggregate-only evidence format. Regulator and estimator addresses are public by design. |
| Front-running / MEV | Nothing of value to take: no funds or ordering-dependent payoff, and only allow-listed estimators can attest. | None needed |

## 7. Known limits

- **Single-regulator trust.** One address decides the status. A multisig reduces but does not remove that trust.
- **Minimal input checks.** `attest` checks only that the estimator is authorised, that `periodEnd` is not before `periodStart` and that the evidence hash is non-zero. Station names, numbers, `codeHash` and `evidenceURI` are taken as given; they are checked off chain (section 3).
- **`latestAccepted` is a linear scan.** It walks back from the newest record. It is intended for off-chain `eth_call`; other contracts should not call it on long histories.
- **No upgradeability, by design.** A new version means a new deployment. Old records stay readable at the old address.
- **Timestamps are block time.** Precision is seconds, set by the block producer. The data period is `periodStart`/`periodEnd`.
- **Validation is Australian only.** The estimator is validated where an independent rooftop-PV series is published: AEMO's estimates for four NEM regions. There is no Pakistani ground truth on chain.
- **Network.** Everything reported in this repository ran on a local Hardhat network unless a `chain/deployments/sepolia.json` record exists. A testnet is not a production ledger.

## 8. Test evidence

- `npm test`: 57 Hardhat tests. 37 are contract unit tests (roles, reverts, lifecycle, handover); 20 run on the real evidence bundles (hashes, LF format, docs copies, anchoring the manifest values, tamper cases).
- `npm run coverage`: 100 % statement, branch, function and line coverage of `BTMRegistry.sol`.
- `npm run test:scripts` (`node --test chain/scripts/lib.test.js`): 42 tests of the checks the deployment scripts run before sending anything (`EVIDENCE_BASE_URI` rules, manifest validation, evidence and code-hash checks, estimator top-up arithmetic, the redeploy plan, which records may replace the website copy). No network is used.
- `npm run demo`: the end-to-end run (deploy, attest, accept, verify, tamper check) on Hardhat's in-process network.
- `pytest -q`: the Python suite in `tests/` (105 tests). With the raw AEMO and NASA POWER downloads present, 104 pass and 1 is an expected failure (`xfail`); without them, as in CI, the `rawdata` tests skip.
- `npm run test:web` (`node docs/assets/verify.test.mjs`): the browser hashing helpers.
- CI (`.github/workflows/ci.yml`) runs the Hardhat tests, the deployment-script tests, the demo and the browser hashing tests on Node 20, 22 and 24; pytest and `chain/verify_estimate.py` with the pinned Python packages; and the plain-tool hash checks, on every push.

Gas on the local Hardhat network (solc 0.8.24, optimizer 200 runs, EVM `paris`), from
`results/tables/chain_gas_report.txt` (`npm run test:gas` prints the same table):

| Method | Min | Max | Avg | Calls |
|---|---:|---:|---:|---:|
| `attest` | 125,946 | 143,664 | 138,063 | 31 |
| `setStatus` | 35,052 | 36,348 | 35,518 | 19 |
| `setEstimator` | 25,930 | 47,980 | 37,957 | 15 |
| `transferRegulator` | 30,643 | 47,755 | 45,616 | 8 |
| `acceptRegulator` | - | - | 30,454 | 4 |
| Deployment | - | - | 986,475 | (1.6 % of block limit) |

## 9. Dependencies

After `npm ci`, `npm audit` lists advisories against the Hardhat 2 development toolchain: in
October 2026, 38 (14 low, 7 moderate, 17 high, none critical). The counts change as advisories
are published, and GitHub lists the same packages as Dependabot alerts if those are enabled for
the repository. All of them come in through two direct devDependencies, `hardhat` 2.29.1 and
`@nomicfoundation/hardhat-toolbox` 6.1.2, mostly through transitive packages such as `undici`,
`lodash`, `adm-zip`, `tmp` and `solidity-coverage`. The project has no runtime npm dependencies,
so `npm audit --omit=dev` reports 0.

These packages run only on a developer machine and in CI, to compile and test the contract, run
the local demo and, optionally, run the Sepolia deployment scripts. Nothing from `node_modules`
ships:

- `BTMRegistry.sol` imports nothing; the deployed bytecode is that one file compiled by solc 0.8.24.
- The website is the static files in `docs/`, with no build step. Its only third-party script is
  ethers 6.13.4 from cdnjs, pinned by exact version and an SRI hash, and loaded only for the
  optional live Sepolia read.

The fixes `npm audit` offers are `hardhat` 3.x and `hardhat-toolbox` 7.0.0, both breaking
major versions. Moving to Hardhat 3 is left until after the hackathon; it means porting the
config, tests and scripts to the new plugin API and re-running the tests, coverage, demo and gas
report. Do **not** run `npm audit fix --force`: it installs those majors without that port, so
the config, the tests and the scripts stop working. Meanwhile, `.env` must only ever hold
throwaway testnet keys (DEPLOY.md), because the deployment scripts load it into this toolchain.

CI runs with a read-only `GITHUB_TOKEN`, pins every third-party action to a full commit SHA
(Dependabot proposes updates) and checks out without persisting credentials, so package install
scripts cannot read the token from `.git/config`.

## Reporting a problem

Open an issue on the GitHub repository, or a private security advisory if the repository
has them enabled. Please do not publish an exploit against a live deployment before the
maintainer has had a chance to respond.
