// Narrated end-to-end BTMRegistry run on the in-process Hardhat network (screen recording and CI):
//   npx hardhat run chain/scripts/demo.js
// Deploys, exercises the role checks, anchors the 4 real AEMO 2024 evidence files, verifies them as an
// auditor, shows that a +1 MW edit is caught and walks through a disputed submission. Like anchor.js, it
// re-hashes the estimator source and each evidence file before anchoring and aborts if either no longer
// matches the manifest. Exit code 1 if any check fails. Writes results/tables/chain_demo_log.txt (plain text), chain/deployments/hardhat-demo.json
// and, unless a Sepolia record is published, docs/data/deployment.json + results/tables/chain_attestations.csv.
// Output lines stay under 100 columns for screen recording; colour only on a TTY (NO_COLOR=1 turns it off).
// The evidenceURI is always the repo-relative chain/evidence/<file>: EVIDENCE_BASE_URI in .env is for
// anchor.js and remix-args.js and does not change (or break) this local, ephemeral run.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const lib = require("./lib");

const LOG_PATH = path.join(lib.ROOT, "results", "tables", "chain_demo_log.txt");
const TAMPER_STATION = "AEMO/NSW1";
const TAMPER_TS = "2024-01-01T13:00";
const TAMPER_MW = 1.0;
const DISPUTE_NOTE = "auditor: evidence hash does not match the published file";
const STATUS = { Pending: 0, Accepted: 1, Disputed: 2 };

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, green, red, cyan] = ["1", "2", "32", "31", "36"].map(paint);

const plain = [];
function log(s = "") {
  console.log(s);
  plain.push(String(s).replace(/\x1b\[[0-9;]*m/g, ""));
}

const checks = [];
function check(ok, label) {
  checks.push({ ok: Boolean(ok), label });
  log(`    ${ok ? green("PASS") : red("FAIL")}  ${label}`);
}

function step(n, title) {
  log("");
  log(bold(`[${n}] ${title}`));
}

const short = (hex) => lib.bareHex(hex).slice(0, 12);
const verdict = (match) => (match ? green("MATCH") : red("MISMATCH"));
const publishedFile = (entry) => {
  const copy = path.join(lib.PUBLISHED_EVIDENCE_DIR, entry.evidence_file);
  return fs.existsSync(copy) ? copy : path.join(lib.EVIDENCE_DIR, entry.evidence_file);
};

function attestedIndex(registry, receipt) {
  for (const l of receipt.logs) {
    const parsed = registry.interface.parseLog(l);
    if (parsed && parsed.name === "Attested") return Number(parsed.args.index);
  }
  throw new Error(`no Attested event in tx ${receipt.hash}`);
}

async function anchor(registry, estimator, entry, codeHash, evidenceHash) {
  const tx = await registry.connect(estimator).attest(
    lib.stationId(entry.station), entry.period_start, entry.period_end, entry.capacity_kw_eff,
    entry.uncertainty_kw, entry.energy_recovery_bp, lib.bytes32(evidenceHash), codeHash,
    lib.evidenceUri(entry.evidence_file),
  );
  const receipt = await tx.wait();
  return {
    receipt,
    row: {
      station: entry.station,
      stationId: lib.stationId(entry.station),
      index: attestedIndex(registry, receipt),
      evidenceSha256: evidenceHash,
      capacityKwEff: entry.capacity_kw_eff,
      uncertaintyKw: entry.uncertainty_kw,
      energyRecoveryBp: entry.energy_recovery_bp,
      status: "Pending",
      tx: receipt.hash,
      block: receipt.blockNumber,
      evidenceURI: lib.evidenceUri(entry.evidence_file),
      statusTx: null,
      statusNote: null,
    },
  };
}

async function setStatus(registry, row, status, note) {
  const receipt = await (await registry.setStatus(row.stationId, row.index, STATUS[status], note)).wait();
  const onChain = lib.statusName((await registry.get(row.stationId, row.index)).status);
  Object.assign(row, { status: onChain, statusTx: receipt.hash, statusNote: note });
  return receipt;
}

async function run(state) {
  const { ethers } = hre;
  const manifest = lib.loadManifest();
  lib.checkCodeHash(manifest); // aborts if src/invisible_solar no longer hashes to the manifest's code_hash
  const n = manifest.attestations.length;
  const [regulator, estimator, auditor] = await ethers.getSigners();
  const codeHash = lib.bytes32(manifest.code_hash);
  const nsw = lib.manifestEntry(manifest, TAMPER_STATION);
  const nswId = lib.stationId(nsw.station);

  log(bold("BTMRegistry end-to-end demo"));
  log(dim("Network: in-process Hardhat network (local, ephemeral; nothing here is on a public chain)"));
  log(`Evidence: ${lib.rel(lib.MANIFEST_PATH)} - ${n} AEMO 2024 regions, estimator code_hash ${short(codeHash)}...`);
  log(`Accounts: 0 regulator ${regulator.address}`);
  log(`          1 estimator ${estimator.address}`);
  log(`          2 auditor / stranger ${auditor.address}`);

  step(1, "Deploy BTMRegistry; the deployer (account 0) becomes the regulator");
  const registry = await ethers.deployContract("BTMRegistry", [], regulator);
  await registry.waitForDeployment();
  const deployReceipt = await registry.deploymentTransaction().wait();
  const address = await registry.getAddress();
  const iface = registry.interface;
  log(`    contract ${cyan(address)}   gas ${lib.fmtInt(deployReceipt.gasUsed)}`);
  check((await registry.regulator()) === regulator.address, "regulator() is account 0");

  step(2, "The regulator tries to make itself an estimator");
  const err2 = await lib.expectRevert(() => registry.setEstimator(regulator.address, true), iface);
  check(err2 === "RegulatorCannotEstimate",
    `reverted with ${err2 || "nothing (no revert)"}: no address may hold both roles at once`);

  step(3, "The regulator authorises account 1 as an estimator");
  const rc3 = await (await registry.setEstimator(estimator.address, true)).wait();
  log(`    setEstimator(account 1, true)   gas ${lib.fmtInt(rc3.gasUsed)}`);
  check(await registry.isEstimator(estimator.address), "isEstimator(account 1) is true");

  step(4, "A stranger (account 2) tries to attest");
  const err4 = await lib.expectRevert(() => registry.connect(auditor).attest(
    nswId, nsw.period_start, nsw.period_end, nsw.capacity_kw_eff, nsw.uncertainty_kw, nsw.energy_recovery_bp,
    lib.bytes32(nsw.evidence_sha256), codeHash, lib.evidenceUri(nsw.evidence_file)), iface);
  check(err4 === "NotEstimator", `reverted with ${err4 || "nothing (no revert)"}`);

  step(5, `The estimator anchors the ${n} real AEMO 2024 regions`);
  const head = ["station".padEnd(10), "capacity MW".padStart(11), "+/- MW*".padStart(8),
    "in-sample recovery".padStart(19), "  sha256 (first 12)", "gas".padStart(9)].join("  ");
  log(dim(`    ${head}`));
  for (const entry of manifest.attestations) {
    const localHash = lib.checkEvidenceFile(entry); // aborts if the file no longer matches the manifest
    const { receipt, row } = await anchor(registry, estimator, entry, codeHash, localHash);
    state.rows.push(row);
    log("    " + [
      entry.station.padEnd(10),
      lib.fmtInt(Math.round(entry.capacity_kw_eff / 1000)).padStart(11),
      lib.fmtInt(Math.round(entry.uncertainty_kw / 1000)).padStart(8),
      `${(entry.energy_recovery_bp / 100).toFixed(1)} %`.padStart(19),
      `  ${short(localHash)}`.padEnd(19),
      lib.fmtInt(receipt.gasUsed).padStart(9),
    ].join("  "));
  }
  log(dim("    * +/- is the seasonal spread of the 12 monthly capacity estimates, not a confidence interval."));
  log(dim("    In-sample recovery = estimated energy / AEMO's rooftop-PV estimate, 2024; fitted on the"));
  log(dim("    same year's net load and irradiance, the model never sees AEMO's PV series."));
  for (const row of state.rows) {
    const e = lib.manifestEntry(manifest, row.station);
    const a = await registry.get(row.stationId, row.index);
    const same = a.estimator === estimator.address && Number(a.periodStart) === e.period_start
      && Number(a.periodEnd) === e.period_end && Number(a.capacityKwEff) === e.capacity_kw_eff
      && Number(a.uncertaintyKw) === e.uncertainty_kw && Number(a.energyRecoveryBp) === e.energy_recovery_bp
      && a.evidenceHash === lib.bytes32(e.evidence_sha256) && a.codeHash === codeHash
      && lib.statusName(a.status) === "Pending";
    check(same, `${row.station} index ${row.index}: on-chain record equals the manifest (Pending)`);
  }

  step(6, "The auditor (account 2) re-hashes each published file and calls verify()");
  const asAuditor = registry.connect(auditor);
  for (const row of state.rows) {
    const e = lib.manifestEntry(manifest, row.station);
    const file = publishedFile(e);
    const local = lib.sha256File(file);
    const onChain = (await asAuditor.get(row.stationId, row.index)).evidenceHash;
    const match = await asAuditor.verify(row.stationId, row.index, lib.bytes32(local));
    log(`    ${row.station.padEnd(10)}  ${lib.rel(file).padEnd(32)}  local ${short(local)}  on-chain ${short(onChain)}  ${verdict(match)}`);
    check(match, `${row.station}: verify() is true for the published file`);
  }

  step(7, `Tamper test: +${TAMPER_MW.toFixed(0)} MW on one hourly ${nsw.station} net_load reading (${TAMPER_TS})`);
  const nswRow = state.rows.find((r) => r.station === nsw.station);
  const { tampered, before, after } = lib.tamperNetLoad(fs.readFileSync(publishedFile(nsw)), TAMPER_TS, TAMPER_MW);
  const tamperedHash = lib.sha256Bytes(tampered);
  log(`    original row  ${before}`);
  log(`    edited row    ${after}`);
  const nswOnChain = (await asAuditor.get(nswId, nswRow.index)).evidenceHash;
  const tamperMatch = await asAuditor.verify(nswId, nswRow.index, lib.bytes32(tamperedHash));
  log(`    local ${short(tamperedHash)}  on-chain ${short(nswOnChain)}  ${verdict(tamperMatch)}`);
  check(!tamperMatch, `verify() rejects the edited file (1 of ${lib.fmtInt(nsw.n_hours)} hourly readings changed by ${TAMPER_MW.toFixed(3)} MW)`);

  step(8, "Review: the estimator tries to accept its own attestation; then the regulator decides");
  const err8 = await lib.expectRevert(
    () => registry.connect(estimator).setStatus(nswId, nswRow.index, STATUS.Accepted, "self-accept"), iface);
  check(err8 === "NotRegulator", `reverted with ${err8 || "nothing (no revert)"}`);
  const rangeText = `${lib.ACCEPT_MIN_BP / 100}-${lib.ACCEPT_MAX_BP / 100}%`;
  let rulesHeld = true;
  for (const row of state.rows) {
    const within = lib.withinAcceptBand(row.energyRecoveryBp);
    let gas = "";
    if (within) gas = `gas ${lib.fmtInt((await setStatus(registry, row, "Accepted", lib.acceptNote(row.energyRecoveryBp))).gasUsed)}`;
    const expected = within ? "Accepted" : "Pending";
    rulesHeld = rulesHeld && row.status === expected;
    const pct = `${(row.energyRecoveryBp / 100).toFixed(2)}%`;
    log(`    ${row.station.padEnd(10)}  in-sample recovery ${pct.padStart(7)} ${within ? "within" : "outside"} ${rangeText}  -> ${row.status.padEnd(8)}  ${gas}`);
  }
  const accepted = state.rows.filter((r) => r.status === "Accepted").length;
  check(rulesHeld, `on-chain statuses follow the ${rangeText} acceptance rule (${accepted}/${state.rows.length} Accepted)`);

  step(9, `A bad submission: a second ${nsw.station} attestation whose hash is not the published file's`);
  const { row: bad } = await anchor(registry, estimator, nsw, codeHash, tamperedHash);
  state.rows.push(bad);
  log(`    estimator: attest(${nsw.station}) -> index ${bad.index}, evidenceHash ${short(tamperedHash)}...`);
  log(`               evidenceURI ${bad.evidenceURI} (points at the published file)`);
  const published = lib.sha256File(publishedFile(nsw));
  const badMatch = await asAuditor.verify(nswId, bad.index, lib.bytes32(published));
  log(`    auditor:   sha256(published file) ${short(published)} vs on-chain ${short(tamperedHash)}  ${verdict(badMatch)}`);
  check(!badMatch, `auditor detects it: verify(${nsw.station}, ${bad.index}, sha256(published file)) is false`);
  await setStatus(registry, bad, "Disputed", DISPUTE_NOTE);
  log(`    regulator: setStatus(${nsw.station}, ${bad.index}, Disputed,`);
  log(`               "${DISPUTE_NOTE}")`);
  check(bad.status === "Disputed", `${nsw.station} index ${bad.index} is Disputed on chain`);
  const [found, latest] = await asAuditor.latestAccepted(nswId);
  const latestOk = found && latest.evidenceHash === lib.bytes32(nsw.evidence_sha256)
    && Number(latest.capacityKwEff) === nsw.capacity_kw_eff;
  log(`    planner:   latestAccepted(${nsw.station}) -> ${found ? `${lib.fmtInt(Math.round(Number(latest.capacityKwEff) / 1000))} MW, evidence ${short(latest.evidenceHash)}...` : "nothing"}`);
  check(latestOk, `latestAccepted(${nsw.station}) still returns the original, accepted attestation (index ${nswRow.index})`);

  return {
    network: "hardhat",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    contract: "BTMRegistry",
    address,
    regulator: regulator.address,
    estimator: estimator.address,
    deployTx: deployReceipt.hash,
    explorer: null,
    ephemeral: true,
    note: "in-process Hardhat network; addresses are ephemeral",
    codeHash: manifest.code_hash,
    attestations: state.rows,
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  if (hre.network.name !== "hardhat") {
    throw new Error(`demo.js runs on the in-process hardhat network only (got --network ${hre.network.name}); `
      + "use deploy.js and anchor.js for localhost or sepolia");
  }
  const state = { rows: [] };
  let record = null;
  try {
    record = await run(state);
  } catch (err) {
    check(false, `demo aborted: ${err.shortMessage || err.message}`);
  }

  const passed = checks.filter((c) => c.ok).length;
  const allPassed = passed === checks.length;
  step(10, "Result");
  log(`    ${(allPassed ? green : red)(`${passed}/${checks.length} checks passed`)}`);

  if (allPassed && record) {
    const { file, published, csv } = lib.writeDeployment("hardhat-demo", record);
    const outputs = [file];
    if (published) outputs.push(published, csv);
    else log(dim("    a Sepolia record is published, so docs/data/deployment.json and the CSV were left unchanged"));
    outputs.push(lib.rel(LOG_PATH));
    for (const o of outputs) log(`    wrote ${o}`); // one per line: short lines for recording
  }
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, `${plain.join("\n")}\n`);
  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.shortMessage || err.message);
  process.exitCode = 1;
});
