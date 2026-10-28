// Remix-ready arguments for the no-Node path (BTMRegistry.sol deployed from remix.ethereum.org + MetaMask):
//   node chain/scripts/remix-args.js        (or: npx hardhat run chain/scripts/remix-args.js)
// Writes chain/deployments/remix-args.json and prints, per station, the attest(), setStatus() and verify()
// inputs to paste into Remix's single-line argument boxes. Reads .env like the Hardhat scripts do: set
// EVIDENCE_BASE_URI to the public https:// URL of chain/evidence/ (e.g. the repository's raw GitHub URL)
// first, so the emitted evidenceURI is downloadable. The same rules as anchor.js on sepolia apply: the
// .env.example placeholder, user names, passwords, queries and fragments are refused, and the repo-relative
// path is used only with ALLOW_RELATIVE_EVIDENCE_URI=1. It also refuses if an evidence file or the estimator
// source (src/invisible_solar) no longer matches the manifest.
const path = require("path");
const lib = require("./lib");

try {
  require("dotenv").config({ path: path.join(lib.ROOT, ".env") }); // same .env as hardhat.config.js; never overrides set vars
} catch (_) { /* dotenv not installed (no npm ci): environment variables only */ }

const OUT = lib.deploymentPath("remix-args");
const q = (s) => JSON.stringify(s); // Remix parses the argument box as a JSON array body
// Must match hardhat.config.js and the Hardhat build-info (chain/artifacts/build-info/*.json, "evmVersion": "paris"),
// or Remix produces different bytecode from the tested artifact.
const COMPILER = { version: "0.8.24", optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" };

function main() {
  const manifest = lib.loadManifest();
  lib.checkCodeHash(manifest); // the codeHash pasted into Remix must be the one the published source produces
  const base = lib.evidenceBaseUri("sepolia"); // the Remix path targets Sepolia: https://, or relative by opt-in
  const relative = lib.isRelativeBase(base);
  const codeHash = lib.bytes32(manifest.code_hash);
  const stations = manifest.attestations.map((e) => {
    lib.checkEvidenceFile(e);
    const attest = {
      stationId: lib.stationId(e.station),
      periodStart: e.period_start,
      periodEnd: e.period_end,
      capacityKwEff: e.capacity_kw_eff,
      uncertaintyKw: e.uncertainty_kw,
      energyRecoveryBp: e.energy_recovery_bp,
      evidenceHash: lib.bytes32(e.evidence_sha256),
      codeHash,
      evidenceURI: lib.evidenceUri(e.evidence_file, base),
    };
    const accept = { stationId: attest.stationId, index: 0, status: 1, note: lib.acceptNote(e.energy_recovery_bp) };
    return {
      station: e.station,
      attest,
      attestInput: [q(attest.stationId), attest.periodStart, attest.periodEnd, attest.capacityKwEff, attest.uncertaintyKw,
        attest.energyRecoveryBp, q(attest.evidenceHash), q(attest.codeHash), q(attest.evidenceURI)].join(", "),
      accept,
      acceptInput: [q(accept.stationId), accept.index, accept.status, q(accept.note)].join(", "),
      verifyInput: [q(attest.stationId), 0, q(attest.evidenceHash)].join(", "),
    };
  });
  const steps = [
    "Remix: create BTMRegistry.sol with the contents of chain/contracts/BTMRegistry.sol",
    `Solidity compiler: version ${COMPILER.version}, optimization enabled, ${COMPILER.optimizer.runs} runs, `
      + `EVM version ${COMPILER.evmVersion} (Advanced configurations); compile`,
    "MetaMask on Sepolia with two new testnet-only accounts: fund the REGULATOR from a faucet, then send the "
      + "ESTIMATOR about 0.01 Sepolia ETH from it (the estimator pays for the attest transactions)",
    "Deploy & run: environment 'Injected Provider - MetaMask' on Sepolia; deploy from the REGULATOR account",
    "From the regulator: setEstimator(\"<estimator address>\", true); the estimator must be a different account",
    "Switch MetaMask to the ESTIMATOR account; for each station paste attestInput into attest() and transact",
    "Switch back to the REGULATOR; for each station paste acceptInput into setStatus() (index 0 = the station's first attestation)",
    "Anyone: verify() with verifyInput returns true; or run chain/scripts/verify-evidence.js with CONTRACT_ADDRESS=<address>",
  ];
  const relativeWarning = "evidenceURI is the repo-relative path (ALLOW_RELATIVE_EVIDENCE_URI=1), which cannot be "
    + "downloaded; set EVIDENCE_BASE_URI to the public https:// URL of chain/evidence/ and run this again before "
    + "attesting on Sepolia (the URI stays in the Attested event for good)";
  const out = {
    contract: "BTMRegistry",
    source: "chain/contracts/BTMRegistry.sol",
    compiler: COMPILER,
    codeHash,
    evidenceBaseUri: base,
    ...(relative ? { warning: relativeWarning } : {}),
    steps,
    stations,
  };
  lib.writeJson(OUT, out);

  console.log(`BTMRegistry via Remix (compiler ${COMPILER.version}, optimizer ${COMPILER.optimizer.runs} runs, `
    + `EVM ${COMPILER.evmVersion}); evidence base URI "${base}"`);
  if (relative) console.log(`note: ${relativeWarning}`);
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  for (const s of stations) {
    console.log(`\n${s.station}`);
    console.log("  attest(stationId, periodStart, periodEnd, capacityKwEff, uncertaintyKw, energyRecoveryBp, evidenceHash, codeHash, evidenceURI):");
    console.log(`  ${s.attestInput}`);
    console.log("  setStatus(stationId, index, status=1 Accepted, note):");
    console.log(`  ${s.acceptInput}`);
    console.log("  verify(stationId, index, evidenceHash):");
    console.log(`  ${s.verifyInput}`);
  }
  console.log(`\nwrote ${lib.rel(OUT)}`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
