// Auditor check: recompute the SHA-256 of an evidence file and compare it with the hash anchored on chain.
//   npx hardhat run chain/scripts/verify-evidence.js --network localhost
//   npx cross-env STATION=AEMO/QLD1 FILE=downloads/AEMO_QLD1_2024.csv hardhat run chain/scripts/verify-evidence.js --network sepolia
// Env: STATION (default AEMO/NSW1), FILE (default the manifest's file in chain/evidence), INDEX (default the
// newest Accepted attestation for the station, as latestAccepted() would return it; the newest attestation if
// none is Accepted), CONTRACT_ADDRESS (as for anchor.js; CONTRACT is accepted too; default
// chain/deployments/<network>.json). Exit code 1 on MISMATCH.
// Read-only: no private key is needed.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const lib = require("./lib");

function evidencePath(station) {
  if (process.env.FILE) return path.resolve(process.env.FILE);
  return path.join(lib.EVIDENCE_DIR, lib.manifestEntry(lib.loadManifest(), station).evidence_file);
}

function shown(p) {
  const r = path.relative(lib.ROOT, p);
  return r.startsWith("..") || path.isAbsolute(r) ? p : r.split(path.sep).join("/");
}

/** INDEX from the environment, or the newest Accepted attestation (else the newest one), with the reason. */
async function chooseIndex(registry, sid, count) {
  const raw = (process.env.INDEX || "").trim();
  if (raw !== "") {
    if (!/^\d+$/.test(raw) || Number(raw) >= count) throw new Error(`INDEX must be 0..${count - 1} (got "${process.env.INDEX}")`);
    return { index: Number(raw), why: "set by INDEX" };
  }
  for (let i = count - 1; i >= 0; i--) {
    if (lib.statusName((await registry.get(sid, i)).status) === "Accepted") {
      return { index: i, why: "newest Accepted; set INDEX to check another" };
    }
  }
  return { index: count - 1, why: "newest; none is Accepted" };
}

async function main() {
  const { ethers, network } = hre;
  const name = network.name;
  if (name === "hardhat") {
    throw new Error("nothing is deployed on the in-process hardhat network; use --network localhost (after deploy.js "
      + "and anchor.js) or --network sepolia; chain/scripts/demo.js runs this check end to end");
  }
  const station = process.env.STATION || "AEMO/NSW1";
  const file = evidencePath(station);
  if (!fs.existsSync(file)) throw new Error(`evidence file not found: ${file}`);
  const record = lib.readDeployment(name);
  const address = lib.contractAddressFromEnv() || (record && record.address);
  if (!address) throw new Error(`no CONTRACT_ADDRESS and no ${lib.rel(lib.deploymentPath(name))}`);
  if (!ethers.isAddress(address)) throw new Error(`not an address: ${address}`);
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`no contract at ${address} on ${name}`);

  const registry = await ethers.getContractAt("BTMRegistry", address);
  const sid = lib.stationId(station);
  const count = Number(await registry.count(sid));
  if (count === 0) throw new Error(`${station} has no attestation on ${address}`);
  const { index, why } = await chooseIndex(registry, sid, count);

  const local = lib.sha256File(file);
  const a = await registry.get(sid, index);
  const status = lib.statusName(a.status);
  const match = await registry.verify(sid, index, lib.bytes32(local));
  console.log(`network   ${name}  contract ${address}`);
  console.log(`station   ${station}  index ${index} (${why}; ${count} on chain)  status ${status}  capacity ${lib.fmtInt(Math.round(Number(a.capacityKwEff) / 1000))} MW`);
  console.log(`file      ${shown(file)}`);
  console.log(`local     sha256 ${local}`);
  console.log(`on-chain  sha256 ${lib.bareHex(a.evidenceHash)}`);
  console.log(match ? "MATCH: the file is exactly the one that was anchored" : "MISMATCH: the file differs from the anchored evidence");
  if (status === "Disputed") console.log("note: the regulator disputed this attestation; latestAccepted() does not return it");
  else if (status === "Pending") console.log("note: this attestation is still Pending (not reviewed by the regulator yet)");
  if (!match) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.shortMessage || err.message);
  process.exitCode = 1;
});
