// Anchor every evidence file in chain/evidence/manifest.json on a deployed BTMRegistry, then have the
// regulator accept each attestation whose in-sample recovery vs AEMO is within 70-130 %:
//   npx hardhat run chain/scripts/anchor.js --network localhost   (after deploy.js; or --network sepolia)
// Env: CONTRACT_ADDRESS (CONTRACT is accepted too; default: chain/deployments/<network>.json) and
// EVIDENCE_BASE_URI. On localhost it defaults to the repo-relative chain/evidence/. On sepolia it must be an
// https:// URL with no user name, password, query or fragment; the repo-relative path is allowed there only
// with ALLOW_RELATIVE_EVIDENCE_URI=1. The .env.example placeholder is always refused.
// Before any transaction it re-hashes every evidence file and the estimator source (src/invisible_solar) and
// refuses if either no longer matches the manifest, so no stale evidenceHash or codeHash reaches the chain.
// Stations already anchored with the same evidence hash are not attested again, so a failed run can be resumed.
// A record that is missing or lost rows (e.g. a contract deployed from Remix) is rebuilt from the chain: the
// attest tx, block and URI from the Attested event and the regulator's tx and note from StatusChanged.
const hre = require("hardhat");
const lib = require("./lib");

const eth = (wei) => `${hre.ethers.formatEther(wei)} ETH`;
const gwei = (wei) => `${hre.ethers.formatUnits(wei, "gwei")} gwei`;

async function openRegistry(name, manifest) {
  const { ethers } = hre;
  const { provider } = ethers;
  let record = lib.readDeployment(name);
  const recordPath = lib.rel(lib.deploymentPath(name));
  const address = lib.contractAddressFromEnv() || (record && record.address);
  if (!address) throw new Error(`no ${recordPath} and no CONTRACT_ADDRESS; run deploy.js --network ${name} first`);
  if (!ethers.isAddress(address)) throw new Error(`not an address: ${address}`);
  if (record && record.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`CONTRACT_ADDRESS/CONTRACT ${address} differs from ${recordPath} (${record.address}); `
      + "move that record aside first so it is not overwritten");
  }
  if ((await provider.getCode(address)) === "0x") {
    const pending = record && record.deployTx && (await provider.getTransaction(record.deployTx));
    if (pending && pending.blockNumber === null) {
      throw new Error(`the deployment of ${address} (tx ${record.deployTx}) is not mined yet; wait for it, then run deploy.js again to finish the setup`);
    }
    throw new Error(`no contract at ${address} on ${name}${name === "localhost" ? " (was the node restarted? run deploy.js again)" : ""}`);
  }
  const registry = await ethers.getContractAt("BTMRegistry", address);
  const signers = await ethers.getSigners();
  if (signers.length < 2) {
    throw new Error(`--network ${name} has ${signers.length} account(s) but needs two (regulator, estimator); see docs/DEPLOY.md`);
  }
  const estimator = signers[1];
  if (!(await registry.isEstimator(estimator.address))) {
    throw new Error(`signer 1 (${estimator.address}) is not an authorised estimator on ${address}; the regulator must call setEstimator first`);
  }
  const regulatorAddress = await registry.regulator();
  const regulator = signers.find((s) => s.address === regulatorAddress) || null;
  if (!record) {
    record = {
      network: name,
      chainId: Number((await provider.getNetwork()).chainId),
      contract: "BTMRegistry",
      address,
      regulator: regulatorAddress,
      estimator: estimator.address,
      deployTx: null,
      explorer: lib.explorerFor(name),
      ephemeral: name !== "sepolia",
      note: `${name}; contract deployed outside deploy.js (CONTRACT_ADDRESS)`,
      codeHash: manifest.code_hash,
      attestations: [],
      generatedAt: null,
    };
  }
  // Event queries start at the deployment block when it is known (public RPCs often limit log ranges).
  let fromBlock = 0;
  if (record.deployTx) {
    const receipt = await provider.getTransactionReceipt(record.deployTx);
    if (receipt) fromBlock = receipt.blockNumber;
  }
  return { registry, record, regulator, estimator, fromBlock };
}

/** tx/block/URI of an attestation made in an earlier run that the record does not know about (best effort). */
async function lookupAttested(registry, sid, index, fromBlock) {
  try {
    const [ev] = await registry.queryFilter(registry.filters.Attested(sid, index), fromBlock);
    if (ev) return { tx: ev.transactionHash, block: ev.blockNumber, evidenceURI: ev.args.evidenceURI };
  } catch (_) { /* some public RPCs limit eth_getLogs ranges */ }
  return null;
}

/** tx and note of the newest StatusChanged event of an attestation (best effort), or null. */
async function lookupStatus(registry, sid, index, fromBlock) {
  try {
    const events = await registry.queryFilter(registry.filters.StatusChanged(sid, index), fromBlock);
    const ev = events.at(-1);
    if (ev) return { statusTx: ev.transactionHash, statusNote: ev.args.note };
  } catch (_) { /* some public RPCs limit eth_getLogs ranges */ }
  return null;
}

/** Per manifest entry: station id, bytes32 hash, existing index (-1 if not anchored yet) and on-chain status. */
async function makePlan(registry, manifest) {
  const plan = [];
  for (const e of manifest.attestations) {
    const sid = lib.stationId(e.station);
    const hash = lib.bytes32(e.evidence_sha256);
    const index = await lib.findAnchored(registry, sid, hash);
    const status = index >= 0 ? lib.statusName((await registry.get(sid, index)).status) : "Pending";
    plan.push({ e, sid, hash, index, status });
  }
  return plan;
}

/** Fail before any transaction if the estimator cannot pay for its attest calls; warn if the regulator is short. */
async function checkFunds(plan, estimator, regulator) {
  const { provider } = hre.ethers;
  const fee = await lib.feePerGas(provider);
  const nAttest = plan.filter((p) => p.index < 0).length;
  if (nAttest > 0) {
    const need = lib.GAS_BUDGET.attest * BigInt(nAttest) * fee;
    const have = await provider.getBalance(estimator.address);
    if (have < need) {
      throw new Error(`the estimator ${estimator.address} holds ${eth(have)} but ${nAttest} attest call(s) need about `
        + `${eth(need)} at the current max fee of ${gwei(fee)}/gas; run deploy.js again (it tops the estimator up from `
        + "the regulator) or send it test ETH yourself, then run this again. Nothing was sent.");
    }
  }
  const nAccept = plan.filter((p) => p.status === "Pending" && lib.withinAcceptBand(p.e.energy_recovery_bp)).length;
  if (regulator && nAccept > 0) {
    const need = lib.GAS_BUDGET.setStatus * BigInt(nAccept) * fee;
    const have = await provider.getBalance(regulator.address);
    if (have < need) {
      console.log(`note: the regulator holds ${eth(have)}, less than the ${eth(need)} that ${nAccept} setStatus call(s) may `
        + "reserve; attestations it cannot pay for stay Pending until you add test ETH and run this again");
    }
  }
}

async function main() {
  const name = hre.network.name;
  if (name === "hardhat") {
    throw new Error("nothing is deployed on the in-process hardhat network; start `npx hardhat node` and use --network localhost, "
      + "or run chain/scripts/demo.js");
  }
  const manifest = lib.loadManifest();
  for (const e of manifest.attestations) lib.checkEvidenceFile(e); // abort before any transaction if a file changed
  lib.checkCodeHash(manifest); // ... or if the estimator source no longer hashes to the manifest's code_hash
  const evidenceBase = lib.evidenceBaseUri(name); // ... or on a placeholder, unsafe or (on sepolia) relative URI
  const { registry, record, regulator, estimator, fromBlock } = await openRegistry(name, manifest);
  const confirmations = lib.confirmationsFor(name);
  const explorer = lib.explorerFor(name);
  const link = (tx) => (explorer ? `${explorer}/tx/${tx}` : tx);
  const codeHash = lib.bytes32(manifest.code_hash);
  record.codeHash = manifest.code_hash;
  console.log(`network ${name}  contract ${record.address}`);
  console.log(`code_hash  ${manifest.code_hash} (matches ${lib.rel(lib.SRC_DIR)}/)`);
  let baseNote = "";
  if (lib.isRelativeBase(evidenceBase)) {
    baseNote = lib.LOCAL_NETWORKS.has(name)
      ? " (repo-relative path)"
      : " (repo-relative path, allowed by ALLOW_RELATIVE_EVIDENCE_URI=1; it stays in the Attested events for good)";
  }
  console.log(`evidence URI base ${evidenceBase}${baseNote}`);
  if (!regulator) console.log(`note: the regulator ${record.regulator} is not a configured signer, so attestations stay Pending`);

  const plan = await makePlan(registry, manifest);
  await checkFunds(plan, estimator, regulator);

  const save = () => {
    record.generatedAt = new Date().toISOString();
    return lib.writeDeployment(name, record);
  };

  for (const { e, sid, hash, index: anchoredAt } of plan) {
    let index = anchoredAt;
    let row = null;
    let origin; // tx, block and evidenceURI of the attest transaction
    if (index >= 0) {
      console.log(`${e.station}: already anchored with this evidence hash at index ${index}; not attesting again`);
      row = record.attestations.find((r) => r.station === e.station && r.index === index) || null;
      if (!row) {
        origin = await lookupAttested(registry, sid, index, fromBlock);
        if (!origin) {
          console.log(`${e.station}: could not read its Attested event (the RPC may limit log queries); tx, block and URI left empty`);
          origin = { tx: null, block: null, evidenceURI: null };
        }
      }
    } else {
      const uri = lib.evidenceUri(e.evidence_file, evidenceBase);
      const tx = await lib.sendTx(registry.connect(estimator), "attest", sid, e.period_start, e.period_end,
        e.capacity_kw_eff, e.uncertainty_kw, e.energy_recovery_bp, hash, codeHash, uri);
      const receipt = await tx.wait(confirmations);
      const ev = receipt.logs.map((l) => registry.interface.parseLog(l)).find((p) => p && p.name === "Attested");
      index = Number(ev.args.index);
      console.log(`${e.station}: attested index ${index}  block ${receipt.blockNumber}  gas ${lib.fmtInt(receipt.gasUsed)}  ${link(receipt.hash)}`);
      origin = { tx: receipt.hash, block: receipt.blockNumber, evidenceURI: uri };
    }
    if (!row) {
      row = {
        station: e.station, stationId: sid, index, evidenceSha256: e.evidence_sha256,
        capacityKwEff: e.capacity_kw_eff, uncertaintyKw: e.uncertainty_kw, energyRecoveryBp: e.energy_recovery_bp,
        status: "Pending", ...origin, statusTx: null, statusNote: null,
      };
      record.attestations.push(row);
    }
    const onChain = lib.statusName((await registry.get(sid, index)).status);
    if (onChain !== "Pending" && (onChain !== row.status || !row.statusTx)) {
      // decided outside this record (an earlier run, Remix, another machine): take the tx and note from the event
      const decided = await lookupStatus(registry, sid, index, fromBlock);
      if (decided) Object.assign(row, decided);
      else console.log(`${e.station}: could not read its StatusChanged event (the RPC may limit log queries); statusTx and note left empty`);
    }
    row.status = onChain;
    save();

    const pct = `${(e.energy_recovery_bp / 100).toFixed(2)}%`;
    if (row.status !== "Pending") {
      console.log(`${e.station}: status ${row.status}${row.statusNote ? ` ("${row.statusNote}")` : ""}`);
    } else if (!lib.withinAcceptBand(e.energy_recovery_bp)) {
      console.log(`${e.station}: left Pending (in-sample recovery ${pct} is outside ${lib.ACCEPT_MIN_BP / 100}-${lib.ACCEPT_MAX_BP / 100}%)`);
    } else if (regulator) {
      const note = lib.acceptNote(e.energy_recovery_bp);
      const tx = await lib.sendTx(registry.connect(regulator), "setStatus", sid, index, 1, note);
      const receipt = await tx.wait(confirmations);
      Object.assign(row, { status: lib.statusName((await registry.get(sid, index)).status), statusTx: receipt.hash, statusNote: note });
      console.log(`${e.station}: ${row.status} by the regulator ("${note}")  gas ${lib.fmtInt(receipt.gasUsed)}  ${link(receipt.hash)}`);
      save();
    }
  }

  const { file, published, csv } = save();
  console.log(`wrote ${file}${published ? `, ${published} and ${csv}` : " (local record; the website copy and CSV are left unchanged)"}`);
  console.log(`audit one file: npx cross-env STATION=AEMO/NSW1 hardhat run chain/scripts/verify-evidence.js --network ${name}`);
}

main().catch((err) => {
  console.error(err.shortMessage || err.message);
  process.exitCode = 1;
});
