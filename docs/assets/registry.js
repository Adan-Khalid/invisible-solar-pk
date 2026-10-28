// BTMRegistry read helpers for the demo page (no DOM, so docs/assets/verify.test.mjs can import them).
// REGISTRY_ABI is the subset of chain/contracts/BTMRegistry.sol the page calls; the unit tests check it
// against the compiled artifact when chain/artifacts exists.
import { normalizeHash } from "./verify.js";

export const REGISTRY_ABI = [
  "function count(bytes32 stationId) view returns (uint256)",
  "function get(bytes32 stationId, uint256 index) view returns (tuple(address estimator, uint64 timestamp, uint32 periodStart, uint32 periodEnd, uint32 capacityKwEff, uint32 uncertaintyKw, uint16 energyRecoveryBp, uint8 status, bytes32 evidenceHash, bytes32 codeHash))",
  "function verify(bytes32 stationId, uint256 index, bytes32 evidenceHash) view returns (bool)",
];

/** Order of BTMRegistry.Status. */
export const STATUS_NAMES = ["Pending", "Accepted", "Disputed"];

/**
 * The station's reference record, read from the contract: the newest Accepted attestation (what a
 * planner's latestAccepted() returns), else the newest attestation; null when the station has none.
 * `registry` needs count(stationId) and get(stationId, index), e.g. an ethers Contract.
 */
export async function referenceRecord(registry, stationId) {
  const n = Number(await registry.count(stationId));
  let newest = null;
  for (let i = n - 1; i >= 0; i--) {
    const a = await registry.get(stationId, i);
    const status = STATUS_NAMES[Number(a.status)] ?? `status ${a.status}`;
    const rec = { stationId, index: i, status, hash: normalizeHash(a.evidenceHash) };
    if (status === "Accepted") return rec;
    newest ??= rec;
  }
  return newest;
}
