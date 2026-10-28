// Shared helpers for the BTMRegistry Hardhat scripts (deploy, anchor, verify-evidence, remix-args, demo).
// Plain Node + ethers only, so it can be required without booting Hardhat.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { id, parseEther } = require("ethers");

const ROOT = path.resolve(__dirname, "..", "..");
const EVIDENCE_DIR = path.join(ROOT, "chain", "evidence");
const PUBLISHED_EVIDENCE_DIR = path.join(ROOT, "docs", "evidence"); // byte-identical copies served by the website
const MANIFEST_PATH = path.join(EVIDENCE_DIR, "manifest.json");
const DEPLOYMENTS_DIR = path.join(ROOT, "chain", "deployments");
const SITE_DEPLOYMENT_PATH = path.join(ROOT, "docs", "data", "deployment.json");
const ATTESTATIONS_CSV_PATH = path.join(ROOT, "results", "tables", "chain_attestations.csv");

const STATUS = ["Pending", "Accepted", "Disputed"]; // order of BTMRegistry.Status
const EXPLORERS = { sepolia: "https://sepolia.etherscan.io" };
const MANIFEST_SCHEMA = "invisible-solar-pk/evidence/v1";

// The regulator accepts an attestation whose in-sample energy recovery vs AEMO is within 70-130 %.
const ACCEPT_MIN_BP = 7000;
const ACCEPT_MAX_BP = 13000;

// deploy.js and anchor.js send every transaction with gasLimit = the node's estimate + 20 % (sendTx), and a
// sender must hold gasLimit x maxFeePerGas up front. GAS_BUDGET is that limit per call, rounded up from the
// largest values measured on the local Hardhat network (results/tables/chain_gas_report.txt and
// chain_demo_log.txt: attest <= 143,664, setStatus <= 36,552 with the real notes, setEstimator <= 47,980),
// used to check balances before anything is sent. A plain ETH transfer is exactly 21,000.
const GAS_HEADROOM_PCT = 20n;
const GAS_BUDGET = { attest: 175000n, setStatus: 45000n, setEstimator: 60000n, transfer: 21000n };
// deploy.js keeps the estimator funded for its attest calls: at least ESTIMATOR_MIN_BALANCE, or 1.5x what the
// attest calls would reserve at the current fee if that is more; each top-up sends at least TOP_UP_MIN.
const ESTIMATOR_MIN_BALANCE = parseEther("0.005");
const TOP_UP_MIN = parseEther("0.01");

// evidenceURI prefix when EVIDENCE_BASE_URI is unset: the repo-relative folder of the evidence files. On a public
// network it is used only with the explicit opt-in ALLOW_RELATIVE_EVIDENCE_URI=1 (see evidenceBaseUri).
const DEFAULT_EVIDENCE_BASE = "chain/evidence/";
const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

// The estimator source covered by manifest.code_hash: same files and rule as invisible_solar.evidence.code_hash
// and the "Estimator source matches the anchored code_hash" step of .github/workflows/ci.yml.
const SRC_DIR = path.join(ROOT, "src", "invisible_solar");
const ESTIMATOR_FILES = Object.freeze(["evidence.py", "features.py", "hidden_pv.py", "metrics.py"]);

// Largest values the BTMRegistry.Attestation fields can hold (uint32 / uint16).
const UINT32_MAX = 2 ** 32 - 1;
const UINT16_MAX = 2 ** 16 - 1;
const ZERO_HEX_64 = "0".repeat(64);

/** Repo-relative path with forward slashes (keeps absolute user paths out of logs and records). */
function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

/** True for an integer yyyymmdd that is a real calendar date (20240229 yes, 20241399 and 20230229 no). */
function isYyyymmdd(n) {
  if (!Number.isInteger(n) || n < 10000101 || n > 99991231) return false;
  const y = Math.floor(n / 10000);
  const m = Math.floor(n / 100) % 100;
  const d = n % 100;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isUint(v, max) {
  return Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * Throw unless `m` is a manifest every script can anchor as is. The contract itself only checks
 * periodEnd >= periodStart and a non-zero evidenceHash, so the rest is enforced here, before any transaction:
 * known schema; a non-zero 64-hex code_hash; at least one attestation; unique, non-empty station names;
 * evidence_file a bare file name (no folders, so nothing outside chain/evidence/ is read); a non-zero 64-hex
 * evidence_sha256; real yyyymmdd dates with period_end >= period_start; capacity_kw_eff 1..2^32-1 kW;
 * uncertainty_kw 0..2^32-1 kW; energy_recovery_bp 0..65535.
 */
function validateManifest(m, where = rel(MANIFEST_PATH)) {
  if (!m || typeof m !== "object") throw new Error(`${where}: not a JSON object`);
  if (m.schema !== MANIFEST_SCHEMA) throw new Error(`${where}: unexpected schema "${m.schema}"`);
  if (!/^[0-9a-f]{64}$/.test(m.code_hash || "")) throw new Error(`${where}: code_hash is not 64 lower-case hex chars`);
  if (m.code_hash === ZERO_HEX_64) throw new Error(`${where}: code_hash is all zeros`);
  if (!Array.isArray(m.attestations) || m.attestations.length === 0) throw new Error(`${where}: no attestations`);
  const seen = new Set();
  for (const a of m.attestations) {
    const who = (a && a.station) || "?";
    for (const k of ["station", "evidence_file", "evidence_sha256", "period_start", "period_end",
      "capacity_kw_eff", "uncertainty_kw", "energy_recovery_bp"]) {
      if (a[k] === undefined || a[k] === null) throw new Error(`${where}: ${who} lacks ${k}`);
    }
    if (typeof a.station !== "string" || a.station.trim() === "") throw new Error(`${where}: a station name is empty`);
    if (seen.has(a.station)) throw new Error(`${where}: station ${a.station} is listed twice`);
    seen.add(a.station);
    if (typeof a.evidence_file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.evidence_file)) {
      throw new Error(`${where}: ${who} evidence_file "${a.evidence_file}" must be a bare file name inside chain/evidence/`);
    }
    if (!/^[0-9a-f]{64}$/.test(a.evidence_sha256) || a.evidence_sha256 === ZERO_HEX_64) {
      throw new Error(`${where}: ${who} evidence_sha256 is not a non-zero 64 lower-case hex value`);
    }
    for (const k of ["period_start", "period_end"]) {
      if (!isYyyymmdd(a[k])) throw new Error(`${where}: ${who} ${k} ${a[k]} is not a real yyyymmdd date`);
    }
    if (a.period_end < a.period_start) throw new Error(`${where}: ${who} period_end ${a.period_end} is before period_start ${a.period_start}`);
    if (!isUint(a.capacity_kw_eff, UINT32_MAX) || a.capacity_kw_eff === 0) {
      throw new Error(`${where}: ${who} capacity_kw_eff ${a.capacity_kw_eff} is not an integer in 1..${UINT32_MAX}`);
    }
    if (!isUint(a.uncertainty_kw, UINT32_MAX)) throw new Error(`${where}: ${who} uncertainty_kw ${a.uncertainty_kw} is not an integer in 0..${UINT32_MAX}`);
    if (!isUint(a.energy_recovery_bp, UINT16_MAX)) {
      throw new Error(`${where}: ${who} energy_recovery_bp ${a.energy_recovery_bp} is not an integer in 0..${UINT16_MAX}`);
    }
  }
  return m;
}

/** chain/evidence/manifest.json (or `file`), checked with validateManifest. */
function loadManifest(file = MANIFEST_PATH) {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${rel(file)}: cannot read the manifest (${e.message})`);
  }
  return validateManifest(m, rel(file));
}

/**
 * SHA-256 of the estimator source, same rule as invisible_solar.evidence.code_hash: for each file in sorted
 * order, its name, a NUL byte, the file bytes with CRLF replaced by LF, and a NUL byte. Lower-case hex.
 */
function sourceCodeHash(srcDir = SRC_DIR, files = ESTIMATOR_FILES) {
  const h = crypto.createHash("sha256");
  for (const name of [...files].sort()) {
    const file = path.join(srcDir, name);
    if (!fs.existsSync(file)) throw new Error(`${rel(file)} not found; the estimator source is needed to check code_hash`);
    // latin1 maps each byte to one code unit and back, so this is a byte-level CRLF -> LF replacement
    const bytes = Buffer.from(fs.readFileSync(file).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    h.update(Buffer.from(`${name}\0`, "utf8"));
    h.update(bytes);
    h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}

/**
 * Throw unless the estimator source in `srcDir` hashes to manifest.code_hash, so a stale manifest never puts a
 * codeHash on chain that the published source does not produce. Returns the hex hash.
 */
function checkCodeHash(manifest, srcDir = SRC_DIR) {
  const got = sourceCodeHash(srcDir);
  if (got !== manifest.code_hash) {
    throw new Error(`the estimator source in ${rel(srcDir)}/ (${ESTIMATOR_FILES.join(", ")}) hashes to ${got}, `
      + `but the manifest code_hash is ${manifest.code_hash}: re-export the evidence (chain/export_evidence.py) or `
      + "restore the source; refusing to anchor, nothing was sent");
  }
  return got;
}

/** Manifest entry for one station ("AEMO/NSW1"); throws if absent. */
function manifestEntry(manifest, station) {
  const e = manifest.attestations.find((a) => a.station === station);
  if (!e) {
    const known = manifest.attestations.map((a) => a.station).join(", ");
    throw new Error(`station "${station}" is not in the manifest (known: ${known})`);
  }
  return e;
}

function sha256Bytes(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** SHA-256 of the exact file bytes, lower-case hex without 0x (same rule as the Python side). */
function sha256File(p) {
  return sha256Bytes(fs.readFileSync(p));
}

/**
 * Recompute the SHA-256 of a manifest entry's evidence file (and of its docs/evidence copy, if present)
 * and throw unless both equal the manifest value. Returns the hex hash.
 */
function checkEvidenceFile(entry, evidenceDir = EVIDENCE_DIR, publishedDir = PUBLISHED_EVIDENCE_DIR) {
  const file = path.join(evidenceDir, entry.evidence_file);
  if (!fs.existsSync(file)) throw new Error(`${rel(file)} not found; refusing to anchor`);
  const got = sha256File(file);
  if (got !== entry.evidence_sha256) {
    throw new Error(`${rel(file)}: SHA-256 ${got} != manifest ${entry.evidence_sha256}; refusing to anchor`);
  }
  const copy = path.join(publishedDir, entry.evidence_file);
  if (fs.existsSync(copy) && sha256File(copy) !== got) {
    throw new Error(`${rel(copy)} differs from ${rel(file)}; the published copy must be byte-identical`);
  }
  return got;
}

/** stationId = keccak256(utf8(station)), e.g. "AEMO/NSW1". */
function stationId(station) {
  return id(station);
}

/** "abc..." or "0xabc..." (64 hex) -> "0xabc..." lower-case, for bytes32 arguments. */
function bytes32(hex) {
  const h = String(hex).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`not a 32-byte hex value: ${hex}`);
  return `0x${h}`;
}

/** bytes32 "0xabc..." -> "abc..." (the bare-hex form used in manifest.json and the records). */
function bareHex(b32) {
  return String(b32).toLowerCase().replace(/^0x/, "");
}

/**
 * EVIDENCE_BASE_URI, checked before any transaction: the prefix that anchor.js and remix-args.js put in front
 * of each evidence file name in the Attested event, where it stays for good on a public chain. Reads `env`
 * (default process.env). Rules:
 * - Throws if the value still holds the .env.example placeholder, contains characters a URL cannot hold, or
 *   carries a user name or password, a query (?...) or a fragment (#...): a raw.githubusercontent.com link
 *   copied from a private repository carries ?token=..., which must never end up on a public chain.
 * - hardhat / localhost: unset or empty -> DEFAULT_EVIDENCE_BASE; any other usable prefix is accepted.
 * - Any other network (sepolia): an absolute https:// URL is required. The repo-relative path (unset, or set
 *   to a relative value) cannot be downloaded, so it is accepted only with ALLOW_RELATIVE_EVIDENCE_URI=1,
 *   for the case where the repository has no public remote yet.
 * Returns the prefix with a trailing slash.
 */
function evidenceBaseUri(network, env = process.env) {
  const local = LOCAL_NETWORKS.has(network);
  const allowRelative = local || (env.ALLOW_RELATIVE_EVIDENCE_URI || "").trim() === "1";
  const raw = (env.EVIDENCE_BASE_URI || "").trim();
  const example = "https://raw.githubusercontent.com/<github-user>/invisible-solar-pk/main/chain/evidence/";
  const how = `set EVIDENCE_BASE_URI to the public https:// URL of the chain/evidence/ folder (for example ${example})`;
  const fix = local
    ? `${how} or delete the line to use the repo-relative path "${DEFAULT_EVIDENCE_BASE}"; nothing was sent`
    : `${how}; nothing was sent`;
  const relativeFix = `${how}, or set ALLOW_RELATIVE_EVIDENCE_URI=1 to anchor the repo-relative path anyway; nothing was sent`;
  if (!raw) {
    if (allowRelative) return DEFAULT_EVIDENCE_BASE;
    throw new Error(`EVIDENCE_BASE_URI is not set: on ${network} the evidenceURI is written for good into every `
      + `Attested event, and the repo-relative "${DEFAULT_EVIDENCE_BASE}" cannot be downloaded: ${relativeFix}`);
  }
  if (/[<>]|your-github-username/i.test(raw)) {
    throw new Error(`EVIDENCE_BASE_URI "${raw}" still holds the .env.example placeholder: ${fix}`);
  }
  if (/[\s"'`{}|\\^]/.test(raw)) throw new Error(`EVIDENCE_BASE_URI "${raw}" contains characters a URL cannot hold: ${fix}`);
  if (/[?#]/.test(raw)) {
    throw new Error(`EVIDENCE_BASE_URI "${raw}" contains a query (?...) or fragment (#...), which would end up in `
      + `every evidenceURI (an access token from a private-repository link would be published): ${fix}`);
  }
  if (raw.startsWith("//")) throw new Error(`EVIDENCE_BASE_URI "${raw}" is protocol-relative; give the full URL: ${fix}`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch (_) {
      throw new Error(`EVIDENCE_BASE_URI "${raw}" is not a valid URL: ${fix}`);
    }
    if (url.username || url.password) {
      throw new Error(`EVIDENCE_BASE_URI "${raw}" contains a user name or password, which would be published in `
        + `every evidenceURI: ${fix}`);
    }
    if (!local && (url.protocol !== "https:" || !url.hostname)) {
      throw new Error(`EVIDENCE_BASE_URI must be an https:// URL on ${network} (got "${raw}"): ${fix}`);
    }
  } else if (!allowRelative) {
    throw new Error(`EVIDENCE_BASE_URI "${raw}" is a relative path, which cannot be downloaded from ${network}: ${relativeFix}`);
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** True when `base` is not an absolute URL (the repo-relative default or another relative prefix). */
function isRelativeBase(base) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(base);
}

/**
 * The contract address given in the environment: CONTRACT_ADDRESS (documented), or CONTRACT (accepted as an
 * alias by every script). Throws if both are set to different values; null if neither is set.
 */
function contractAddressFromEnv(env = process.env) {
  const primary = (env.CONTRACT_ADDRESS || "").trim();
  const alias = (env.CONTRACT || "").trim();
  if (primary && alias && primary.toLowerCase() !== alias.toLowerCase()) {
    throw new Error(`CONTRACT_ADDRESS (${primary}) and CONTRACT (${alias}) differ; set only CONTRACT_ADDRESS`);
  }
  return primary || alias || null;
}

/** Where the evidence file can be downloaded; emitted (not stored) in the Attested event. */
function evidenceUri(file, base = DEFAULT_EVIDENCE_BASE) {
  return (base.endsWith("/") ? base : `${base}/`) + file;
}

function statusName(n) {
  const s = STATUS[Number(n)];
  if (!s) throw new Error(`unknown status ${n}`);
  return s;
}

function explorerFor(network) {
  return EXPLORERS[network] || null;
}

/** Block confirmations to wait for: 2 on a public network, 1 locally. */
function confirmationsFor(network) {
  return network === "sepolia" ? 2 : 1;
}

function withinAcceptBand(energyRecoveryBp) {
  return energyRecoveryBp >= ACCEPT_MIN_BP && energyRecoveryBp <= ACCEPT_MAX_BP;
}

function acceptNote(energyRecoveryBp) {
  return `checked against AEMO rooftop PV: in-sample recovery ${(energyRecoveryBp / 100).toFixed(2)}%`;
}

/** A node's gas estimate plus GAS_HEADROOM_PCT, as the gasLimit to send with. */
function withHeadroom(estimate) {
  return (BigInt(estimate) * (100n + GAS_HEADROOM_PCT)) / 100n;
}

/**
 * contract.method(...args) sent with an explicit gasLimit = estimate + 20 %. Without it, hardhat-ethers sends
 * every transaction on --network localhost with a fixed 2^24 gas limit, which the node accepts only from an
 * account that can pay for all of it; on sepolia it would use the bare estimate.
 */
async function sendTx(contract, method, ...args) {
  const fn = contract.getFunction(method);
  const gasLimit = withHeadroom(await fn.estimateGas(...args));
  return fn(...args, { gasLimit });
}

/** Wei per gas a sender must be able to reserve now: EIP-1559 maxFeePerGas, else the legacy gasPrice. */
async function feePerGas(provider) {
  const fd = await provider.getFeeData();
  const fee = fd.maxFeePerGas ?? fd.gasPrice;
  if (fee === null || fee === undefined) throw new Error("the RPC endpoint returned no gas-fee data");
  return fee;
}

/** Wei the estimator should hold for `nAttests` attest calls at `fee` wei/gas (1.5x the reservation). */
function estimatorNeed(fee, nAttests) {
  return (GAS_BUDGET.attest * BigInt(nAttests) * fee * 3n) / 2n;
}

/**
 * Wei to send an estimator holding `balance` so it can pay for `nAttests` attest calls at `fee` wei/gas:
 * 0 if no attest call is left or it already holds max(ESTIMATOR_MIN_BALANCE, estimatorNeed); otherwise the
 * shortfall, at least TOP_UP_MIN.
 */
function estimatorTopUp(balance, fee, nAttests) {
  if (nAttests <= 0) return 0n;
  const need = estimatorNeed(fee, nAttests);
  const target = need > ESTIMATOR_MIN_BALANCE ? need : ESTIMATOR_MIN_BALANCE;
  if (balance >= target) return 0n;
  const gap = target - balance;
  return gap > TOP_UP_MIN ? gap : TOP_UP_MIN;
}

/** 1234567 -> "1,234,567" (locale-independent, so logs are byte-stable). */
function fmtInt(n) {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Add `deltaMw` to net_load_mw of the data row whose timestamp equals `ts`, keeping the exact
 * 3-decimal format (integer milli-MW arithmetic). Shared by demo.js and chain/test/evidence.test.js, so the
 * demo and the tests always make the same edit. Throws if no data row (the header excluded) has timestamp `ts`.
 */
function tamperNetLoad(bytes, ts, deltaMw) {
  const lines = bytes.toString("utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${ts},`));
  if (i < 1) throw new Error(`row ${ts} not found`);
  const cols = lines[i].split(",");
  const milli = Math.round(Number(cols[1]) * 1000) + Math.round(deltaMw * 1000);
  const before = lines[i];
  cols[1] = (milli / 1000).toFixed(3);
  lines[i] = cols.join(",");
  return { tampered: Buffer.from(lines.join("\n"), "utf8"), before, after: lines[i] };
}

function readJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${rel(p)} is not valid JSON: ${e.message}`);
  }
}

function deploymentPath(name) {
  return path.join(DEPLOYMENTS_DIR, `${name}.json`);
}

/** chain/deployments/<name>.json, or null if absent. */
function readDeployment(name) {
  return readJsonOrNull(deploymentPath(name));
}

/**
 * Whether a record for `network` may replace the website copy (docs/data/deployment.json) and
 * results/tables/chain_attestations.csv: a public-testnet (sepolia) record always does; an
 * in-process hardhat record only while no sepolia record is published; localhost never (ephemeral).
 */
function shouldPublish(network, readCurrent = () => readJsonOrNull(SITE_DEPLOYMENT_PATH)) {
  if (network === "sepolia") return true;
  if (network !== "hardhat") return false;
  const current = readCurrent();
  return !current || current.network !== "sepolia";
}

/**
 * What deploy.js does with the network's existing record, given previousState() ("none", "live", "pending",
 * "gone") and whether REDEPLOY=1 is set. Returns { action, keepPrevious }, action being
 *   "deploy"       deploy a new contract (keepPrevious: first copy the old record to <network>.previous*.json),
 *   "resume"       finish the setup of the recorded, live contract,
 *   "wait"         refuse: the recorded deployment is not mined yet,
 *   "confirm-gone" refuse: a public network reports nothing at the recorded address. A lagging, load-balanced
 *                  RPC can report this for a while, so the user checks the old deploy tx on the explorer and
 *                  sets REDEPLOY=1 only if the contract really is not there.
 * On hardhat/localhost a "gone" record (a restarted node) is simply replaced.
 */
function deployPlan(state, network, redeploy) {
  const local = LOCAL_NETWORKS.has(network);
  switch (state) {
    case "none":
      return { action: "deploy", keepPrevious: false };
    case "pending":
      return { action: "wait", keepPrevious: false };
    case "live":
      return redeploy ? { action: "deploy", keepPrevious: true } : { action: "resume", keepPrevious: false };
    case "gone":
      if (local) return { action: "deploy", keepPrevious: false };
      return redeploy ? { action: "deploy", keepPrevious: true } : { action: "confirm-gone", keepPrevious: false };
    default:
      throw new Error(`unknown deployment state "${state}"`);
  }
}

/**
 * Path for a copy of the old <name>.json before a redeploy: <name>.previous.json, or <name>.previous-2.json,
 * -3, ... if that exists already, so an earlier copy is never overwritten.
 */
function previousRecordPath(name) {
  let p = deploymentPath(`${name}.previous`);
  for (let k = 2; fs.existsSync(p); k++) p = deploymentPath(`${name}.previous-${k}`);
  return p;
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * Write chain/deployments/<name>.json (name defaults to record.network) and, when
 * shouldPublish(record.network) and opts.publish !== false, docs/data/deployment.json and
 * results/tables/chain_attestations.csv too, so the website record and the CSV always describe the same
 * contract (a record with no attestations yet gives a header-only CSV).
 * Returns { file, published, csv } with repo-relative paths (published and csv are null when not written).
 */
function writeDeployment(name, record, opts = {}) {
  const file = deploymentPath(name || record.network);
  writeJson(file, record);
  const published = opts.publish !== false && shouldPublish(record.network);
  let csv = null;
  if (published) {
    writeJson(SITE_DEPLOYMENT_PATH, record);
    csv = writeAttestationsCsv(record.attestations, record.network, record.address);
  }
  return { file: rel(file), published: published ? rel(SITE_DEPLOYMENT_PATH) : null, csv };
}

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = ["station", "index", "capacity_kw_eff", "uncertainty_kw", "recovery_pct_in_sample",
  "evidence_sha256", "status", "tx", "station_id", "network", "contract"];

/** rows: deployment-record attestations -> results/tables/chain_attestations.csv. Returns the path. */
function writeAttestationsCsv(rows, network, address) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push([
      r.station, r.index, r.capacityKwEff, r.uncertaintyKw, (r.energyRecoveryBp / 100).toFixed(2),
      r.evidenceSha256, r.status, r.tx, r.stationId, network, address,
    ].map(csvCell).join(","));
  }
  fs.mkdirSync(path.dirname(ATTESTATIONS_CSV_PATH), { recursive: true });
  fs.writeFileSync(ATTESTATIONS_CSV_PATH, `${lines.join("\n")}\n`);
  return rel(ATTESTATIONS_CSV_PATH);
}

/** Index of the first attestation of `hash` (bytes32) for station id `sid` on `registry`, or -1. */
async function findAnchored(registry, sid, hash) {
  const n = Number(await registry.count(sid));
  for (let i = 0; i < n; i++) {
    if ((await registry.get(sid, i)).evidenceHash === hash) return i;
  }
  return -1;
}

/** Number of manifest stations whose evidence hash is not anchored on `registry` yet (attest calls still to do). */
async function attestsLeft(registry, manifest) {
  let n = 0;
  for (const e of manifest.attestations) {
    if ((await findAnchored(registry, stationId(e.station), bytes32(e.evidence_sha256))) < 0) n++;
  }
  return n;
}

/** Name of a BTMRegistry custom error inside an ethers/Hardhat revert, or null if it is not one. */
function revertName(err, iface) {
  if (err && err.revert && err.revert.name) return err.revert.name;
  const candidates = [err && err.data, err && err.error && err.error.data, err && err.info && err.info.error && err.info.error.data];
  for (const data of candidates) {
    if (typeof data !== "string" || !data.startsWith("0x") || !iface) continue;
    try {
      const parsed = iface.parseError(data);
      if (parsed) return parsed.name;
    } catch (_) { /* not one of ours */ }
  }
  const m = /custom error '(\w+)\(/.exec((err && (err.shortMessage || err.message)) || "");
  return m ? m[1] : null;
}

/** Run `fn` (a transaction or call expected to revert); return the custom error name, or null if it did not revert. */
async function expectRevert(fn, iface) {
  try {
    const tx = await fn();
    if (tx && typeof tx.wait === "function") await tx.wait();
    return null;
  } catch (err) {
    const name = revertName(err, iface);
    if (!name) throw err;
    return name;
  }
}

module.exports = {
  ROOT, EVIDENCE_DIR, PUBLISHED_EVIDENCE_DIR, MANIFEST_PATH, DEPLOYMENTS_DIR, SITE_DEPLOYMENT_PATH,
  ATTESTATIONS_CSV_PATH, STATUS, CSV_COLUMNS, ACCEPT_MIN_BP, ACCEPT_MAX_BP, GAS_HEADROOM_PCT, GAS_BUDGET, ESTIMATOR_MIN_BALANCE,
  TOP_UP_MIN, DEFAULT_EVIDENCE_BASE, LOCAL_NETWORKS, SRC_DIR, ESTIMATOR_FILES,
  rel, isYyyymmdd, validateManifest, loadManifest, manifestEntry, sha256Bytes, sha256File, checkEvidenceFile,
  sourceCodeHash, checkCodeHash, stationId, bytes32, bareHex,
  evidenceBaseUri, isRelativeBase, contractAddressFromEnv, evidenceUri, statusName, explorerFor, confirmationsFor,
  withinAcceptBand, acceptNote, withHeadroom, sendTx, feePerGas, estimatorNeed, estimatorTopUp, fmtInt, tamperNetLoad,
  readDeployment, deploymentPath, shouldPublish, deployPlan, previousRecordPath, writeDeployment,
  writeAttestationsCsv, writeJson, findAnchored, attestsLeft, revertName, expectRevert,
};
