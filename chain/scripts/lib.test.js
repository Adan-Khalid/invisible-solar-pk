// Unit tests for the guard logic in chain/scripts/lib.js: the checks deploy.js, anchor.js, remix-args.js and
// demo.js run before anything is sent. Plain Node (node:test), no Hardhat network and no contract calls, so
// they run in about a second and leave the Hardhat suite (npm test) and its gas figures unchanged:
//   node --test chain/scripts/lib.test.js
// Temporary files go to the OS temp folder and are removed afterwards; nothing in the repository is written.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEther, parseUnits } = require("ethers");
const lib = require("./lib");

const GWEI = parseUnits("1", "gwei");
const manifest = lib.loadManifest();
const nsw = lib.manifestEntry(manifest, "AEMO/NSW1");
const clone = (o) => JSON.parse(JSON.stringify(o));
/** The real manifest with `patch` applied to a copy of its first attestation. */
const withEntry = (patch) => {
  const m = clone(manifest);
  m.attestations[0] = { ...m.attestations[0], ...patch };
  return m;
};

describe("evidenceBaseUri", () => {
  const base = (network, env) => lib.evidenceBaseUri(network, env);

  it("defaults to the repo-relative chain/evidence/ on hardhat and localhost", () => {
    for (const n of ["hardhat", "localhost"]) {
      assert.equal(base(n, {}), lib.DEFAULT_EVIDENCE_BASE);
      assert.equal(base(n, { EVIDENCE_BASE_URI: "   " }), lib.DEFAULT_EVIDENCE_BASE);
    }
  });

  it("refuses an unset value on sepolia unless ALLOW_RELATIVE_EVIDENCE_URI=1", () => {
    assert.throws(() => base("sepolia", {}), /EVIDENCE_BASE_URI is not set.*ALLOW_RELATIVE_EVIDENCE_URI=1/);
    assert.throws(() => base("sepolia", { ALLOW_RELATIVE_EVIDENCE_URI: "true" }), /not set/);
    assert.equal(base("sepolia", { ALLOW_RELATIVE_EVIDENCE_URI: "1" }), lib.DEFAULT_EVIDENCE_BASE);
  });

  it("treats an explicit relative value like an unset one on sepolia", () => {
    assert.throws(() => base("sepolia", { EVIDENCE_BASE_URI: "chain/evidence/" }), /relative path/);
    assert.equal(base("sepolia", { EVIDENCE_BASE_URI: "chain/evidence", ALLOW_RELATIVE_EVIDENCE_URI: "1" }),
      "chain/evidence/");
    assert.equal(base("localhost", { EVIDENCE_BASE_URI: "chain/evidence" }), "chain/evidence/");
  });

  it("accepts an https:// URL on sepolia and adds the trailing slash", () => {
    const url = "https://raw.githubusercontent.com/someone/invisible-solar-pk/main/chain/evidence";
    assert.equal(base("sepolia", { EVIDENCE_BASE_URI: url }), `${url}/`);
    assert.equal(base("sepolia", { EVIDENCE_BASE_URI: `${url}/` }), `${url}/`);
  });

  it("refuses anything but https:// on sepolia, and protocol-relative URLs everywhere", () => {
    for (const v of ["http://example.org/e/", "ipfs://bafy/e/", "ftp://example.org/e/"]) {
      assert.throws(() => base("sepolia", { EVIDENCE_BASE_URI: v }), /must be an https:\/\/ URL on sepolia/);
    }
    assert.equal(base("localhost", { EVIDENCE_BASE_URI: "http://127.0.0.1:8000/e" }), "http://127.0.0.1:8000/e/");
    for (const n of ["sepolia", "localhost"]) {
      assert.throws(() => base(n, { EVIDENCE_BASE_URI: "//example.org/e/" }), /protocol-relative/);
    }
  });

  it("refuses a user name or password on every network", () => {
    for (const n of ["sepolia", "hardhat"]) {
      for (const v of ["https://user:pass@example.org/e/", "https://user@example.org/e/", "https://:pw@example.org/e/"]) {
        assert.throws(() => base(n, { EVIDENCE_BASE_URI: v }), /user name or password/, `${n} ${v}`);
      }
    }
  });

  it("refuses a query or fragment (for example a private-repo ?token=) on every network", () => {
    for (const n of ["sepolia", "localhost"]) {
      for (const v of ["https://example.org/a?b=", "https://example.org/a?", "https://example.org/e/#x",
        "https://raw.githubusercontent.com/u/r/main/chain/evidence/?token=ABC", "chain/evidence/?x"]) {
        assert.throws(() => base(n, { EVIDENCE_BASE_URI: v }), /query \(\?\.\.\.\) or fragment/, `${n} ${v}`);
      }
    }
  });

  it("refuses the .env.example placeholder and characters a URL cannot hold", () => {
    const placeholder = "https://raw.githubusercontent.com/<your-github-username>/invisible-solar-pk/main/chain/evidence/";
    for (const n of ["sepolia", "hardhat"]) {
      assert.throws(() => base(n, { EVIDENCE_BASE_URI: placeholder }), /placeholder/);
      assert.throws(() => base(n, { EVIDENCE_BASE_URI: "https://example.org/your-github-username/" }), /placeholder/);
      assert.throws(() => base(n, { EVIDENCE_BASE_URI: "https://example.org/a b/" }), /characters a URL cannot hold/);
      assert.throws(() => base(n, { EVIDENCE_BASE_URI: "https://example.org/\"x\"/" }), /characters a URL cannot hold/);
    }
  });

  it("refuses an unparseable URL", () => {
    assert.throws(() => base("sepolia", { EVIDENCE_BASE_URI: "https://" }), /not a valid URL/);
  });

  it("isRelativeBase tells the repo-relative path from an absolute URL", () => {
    assert.equal(lib.isRelativeBase(lib.DEFAULT_EVIDENCE_BASE), true);
    assert.equal(lib.isRelativeBase("https://example.org/e/"), false);
  });

  it("evidenceUri joins the base and the file name with exactly one slash", () => {
    assert.equal(lib.evidenceUri("A.csv"), "chain/evidence/A.csv");
    assert.equal(lib.evidenceUri("A.csv", "https://example.org/e"), "https://example.org/e/A.csv");
    assert.equal(lib.evidenceUri("A.csv", "https://example.org/e/"), "https://example.org/e/A.csv");
  });
});

describe("contractAddressFromEnv", () => {
  const a = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const b = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

  it("reads CONTRACT_ADDRESS, or CONTRACT as an alias", () => {
    assert.equal(lib.contractAddressFromEnv({ CONTRACT_ADDRESS: a }), a);
    assert.equal(lib.contractAddressFromEnv({ CONTRACT: ` ${a} ` }), a);
    assert.equal(lib.contractAddressFromEnv({ CONTRACT_ADDRESS: a, CONTRACT: a.toLowerCase() }), a);
  });

  it("returns null when neither is set and refuses two different addresses", () => {
    assert.equal(lib.contractAddressFromEnv({}), null);
    assert.equal(lib.contractAddressFromEnv({ CONTRACT_ADDRESS: "", CONTRACT: "  " }), null);
    assert.throws(() => lib.contractAddressFromEnv({ CONTRACT_ADDRESS: a, CONTRACT: b }), /differ/);
  });
});

describe("estimator funding arithmetic", () => {
  it("withHeadroom adds 20 % (integer division)", () => {
    assert.equal(lib.withHeadroom(100000n), 120000n);
    assert.equal(lib.withHeadroom(143664), 172396n);
    assert.ok(lib.withHeadroom(143664) <= lib.GAS_BUDGET.attest, "the attest budget covers the measured maximum");
  });

  it("estimatorNeed is 1.5 x GAS_BUDGET.attest x calls x fee", () => {
    assert.equal(lib.estimatorNeed(GWEI, 4), (175000n * 4n * GWEI * 3n) / 2n);
    assert.equal(lib.estimatorNeed(GWEI, 4), parseEther("0.00105"));
    assert.equal(lib.estimatorNeed(GWEI, 0), 0n);
  });

  it("estimatorTopUp sends nothing when no attest call is left or the balance is enough", () => {
    assert.equal(lib.estimatorTopUp(0n, 100n * GWEI, 0), 0n);
    assert.equal(lib.estimatorTopUp(0n, 100n * GWEI, -1), 0n);
    assert.equal(lib.estimatorTopUp(lib.ESTIMATOR_MIN_BALANCE, GWEI, 4), 0n); // need 0.00105 < minimum 0.005
    assert.equal(lib.estimatorTopUp(parseEther("0.105"), 100n * GWEI, 4), 0n); // exactly the need
  });

  it("estimatorTopUp tops up to max(minimum balance, need), sending at least TOP_UP_MIN", () => {
    // low fee: target is the 0.005 ETH minimum; a 0.001 ETH gap is rounded up to TOP_UP_MIN (0.01 ETH)
    assert.equal(lib.estimatorTopUp(parseEther("0.004"), GWEI, 4), lib.TOP_UP_MIN);
    // high fee: need = 0.105 ETH; from 0.1 the 0.005 gap becomes 0.01, from 0 the full 0.105 is sent
    assert.equal(lib.estimatorTopUp(parseEther("0.1"), 100n * GWEI, 4), lib.TOP_UP_MIN);
    assert.equal(lib.estimatorTopUp(0n, 100n * GWEI, 4), parseEther("0.105"));
  });
});

describe("shouldPublish (which records may replace docs/data/deployment.json)", () => {
  const site = (network) => () => (network ? { network } : null);

  it("a sepolia record always publishes; localhost and unknown networks never do", () => {
    assert.equal(lib.shouldPublish("sepolia", site("sepolia")), true);
    assert.equal(lib.shouldPublish("sepolia", site("hardhat")), true);
    assert.equal(lib.shouldPublish("localhost", site(null)), false);
    assert.equal(lib.shouldPublish("mainnet", site(null)), false);
  });

  it("a hardhat (demo) record publishes only while no sepolia record is published", () => {
    assert.equal(lib.shouldPublish("hardhat", site(null)), true);
    assert.equal(lib.shouldPublish("hardhat", site("hardhat")), true);
    assert.equal(lib.shouldPublish("hardhat", site("sepolia")), false);
  });

  it("does not read the website record for sepolia", () => {
    assert.equal(lib.shouldPublish("sepolia", () => { throw new Error("read"); }), true);
  });
});

describe("deployPlan (what deploy.js does with an existing record)", () => {
  it("deploys when there is no record and waits while the recorded deployment is pending", () => {
    for (const n of ["localhost", "sepolia"]) {
      assert.deepEqual(lib.deployPlan("none", n, false), { action: "deploy", keepPrevious: false });
      assert.deepEqual(lib.deployPlan("pending", n, true), { action: "wait", keepPrevious: false });
    }
  });

  it("resumes a live contract, or with REDEPLOY=1 deploys a new one and keeps the old record", () => {
    for (const n of ["localhost", "sepolia"]) {
      assert.deepEqual(lib.deployPlan("live", n, false), { action: "resume", keepPrevious: false });
      assert.deepEqual(lib.deployPlan("live", n, true), { action: "deploy", keepPrevious: true });
    }
  });

  it("replaces a gone record on a local node, but on sepolia asks for REDEPLOY=1 and keeps the old record", () => {
    assert.deepEqual(lib.deployPlan("gone", "localhost", false), { action: "deploy", keepPrevious: false });
    assert.deepEqual(lib.deployPlan("gone", "sepolia", false), { action: "confirm-gone", keepPrevious: false });
    assert.deepEqual(lib.deployPlan("gone", "sepolia", true), { action: "deploy", keepPrevious: true });
  });

  it("throws on an unknown state", () => {
    assert.throws(() => lib.deployPlan("odd", "sepolia", false), /unknown deployment state/);
  });

  it("previousRecordPath never points at an existing file", () => {
    const p = lib.previousRecordPath("no-such-network-for-tests");
    assert.equal(path.basename(p), "no-such-network-for-tests.previous.json");
    assert.equal(fs.existsSync(p), false);
  });
});

describe("manifest validation", () => {
  it("accepts the real manifest", () => {
    assert.equal(lib.validateManifest(clone(manifest)).attestations.length, 4);
  });

  it("isYyyymmdd accepts real dates only", () => {
    for (const d of [20240101, 20241231, 20240229]) assert.equal(lib.isYyyymmdd(d), true, String(d));
    for (const d of [20241399, 20240230, 20230229, 20240100, 2024010, 20240101.5, "20240101", 0]) {
      assert.equal(lib.isYyyymmdd(d), false, String(d));
    }
  });

  it("refuses values the contract would accept but no real estimate has", () => {
    const bad = [
      [{ period_start: 20241399 }, /period_start .* real yyyymmdd/],
      [{ period_end: 20240230 }, /period_end .* real yyyymmdd/],
      [{ period_start: 20241231, period_end: 20240101 }, /before period_start/],
      [{ capacity_kw_eff: 0 }, /capacity_kw_eff/],
      [{ capacity_kw_eff: 2 ** 32 }, /capacity_kw_eff/],
      [{ capacity_kw_eff: 1.5 }, /capacity_kw_eff/],
      [{ uncertainty_kw: -1 }, /uncertainty_kw/],
      [{ energy_recovery_bp: 65536 }, /energy_recovery_bp/],
      [{ evidence_sha256: "0".repeat(64) }, /evidence_sha256/],
      [{ evidence_sha256: "AB".repeat(32) }, /evidence_sha256/],
      [{ evidence_file: "../manifest.json" }, /bare file name/],
      [{ evidence_file: "sub/AEMO_NSW1_2024.csv" }, /bare file name/],
      [{ station: "  " }, /station name is empty/],
      [{ capacity_kw_eff: null }, /lacks capacity_kw_eff/],
    ];
    for (const [patch, re] of bad) assert.throws(() => lib.validateManifest(withEntry(patch)), re, JSON.stringify(patch));
  });

  it("refuses a zero or malformed code_hash, a duplicate station, an empty list and a wrong schema", () => {
    assert.throws(() => lib.validateManifest({ ...clone(manifest), code_hash: "0".repeat(64) }), /all zeros/);
    assert.throws(() => lib.validateManifest({ ...clone(manifest), code_hash: "abc" }), /code_hash/);
    const dup = clone(manifest);
    dup.attestations.push(clone(dup.attestations[0]));
    assert.throws(() => lib.validateManifest(dup), /listed twice/);
    assert.throws(() => lib.validateManifest({ ...clone(manifest), attestations: [] }), /no attestations/);
    assert.throws(() => lib.validateManifest({ ...clone(manifest), schema: "other/v0" }), /unexpected schema/);
  });

  it("manifestEntry finds a station or names the known ones", () => {
    assert.equal(nsw.evidence_file, "AEMO_NSW1_2024.csv");
    assert.throws(() => lib.manifestEntry(manifest, "AEMO/TAS1"), /known: AEMO\/NSW1, AEMO\/QLD1, AEMO\/VIC1, AEMO\/SA1/);
  });
});

describe("evidence and source hashing", () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btm-lib-test-")); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const dir = (name) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  it("checkEvidenceFile passes for every real evidence file and its docs/evidence copy", () => {
    for (const e of manifest.attestations) assert.equal(lib.checkEvidenceFile(e), e.evidence_sha256);
  });

  it("checkEvidenceFile refuses a changed file, a changed published copy and a missing file", () => {
    const original = fs.readFileSync(path.join(lib.EVIDENCE_DIR, nsw.evidence_file));
    const { tampered } = lib.tamperNetLoad(original, "2024-01-01T13:00", 1.0);
    const ev = dir("evidence");
    const pub = dir("published");
    fs.writeFileSync(path.join(ev, nsw.evidence_file), tampered);
    assert.throws(() => lib.checkEvidenceFile(nsw, ev, pub), /refusing to anchor/);
    fs.writeFileSync(path.join(ev, nsw.evidence_file), original);
    assert.equal(lib.checkEvidenceFile(nsw, ev, pub), nsw.evidence_sha256); // no published copy: fine
    fs.writeFileSync(path.join(pub, nsw.evidence_file), tampered);
    assert.throws(() => lib.checkEvidenceFile(nsw, ev, pub), /must be byte-identical/);
    assert.throws(() => lib.checkEvidenceFile(nsw, dir("empty"), pub), /not found/);
  });

  it("sourceCodeHash of src/invisible_solar equals the manifest code_hash (the rule CI uses)", () => {
    assert.equal(lib.sourceCodeHash(), manifest.code_hash);
    assert.equal(lib.checkCodeHash(manifest), manifest.code_hash);
  });

  it("sourceCodeHash ignores CRLF vs LF but sees any other edit", () => {
    const lf = dir("src-lf");
    const crlf = dir("src-crlf");
    const edited = dir("src-edited");
    for (const name of lib.ESTIMATOR_FILES) {
      const text = fs.readFileSync(path.join(lib.SRC_DIR, name)).toString("latin1").replace(/\r\n/g, "\n");
      fs.writeFileSync(path.join(lf, name), Buffer.from(text, "latin1"));
      fs.writeFileSync(path.join(crlf, name), Buffer.from(text.replace(/\n/g, "\r\n"), "latin1"));
      fs.writeFileSync(path.join(edited, name), Buffer.from(name === "metrics.py" ? `${text}# edit\n` : text, "latin1"));
    }
    assert.equal(lib.sourceCodeHash(lf), manifest.code_hash);
    assert.equal(lib.sourceCodeHash(crlf), manifest.code_hash);
    assert.notEqual(lib.sourceCodeHash(edited), manifest.code_hash);
    assert.throws(() => lib.checkCodeHash(manifest, edited), /refusing to anchor/);
    assert.throws(() => lib.sourceCodeHash(dir("src-missing")), /not found/);
  });

  it("sourceCodeHash follows the documented byte layout (name NUL text NUL, files sorted)", () => {
    const d = dir("src-layout");
    fs.writeFileSync(path.join(d, "b.py"), "y\r\n");
    fs.writeFileSync(path.join(d, "a.py"), "x\n");
    const expected = lib.sha256Bytes(Buffer.from("a.py\0x\n\0b.py\0y\n\0", "utf8"));
    assert.equal(lib.sourceCodeHash(d, ["b.py", "a.py"]), expected);
  });
});

describe("tamperNetLoad and small helpers", () => {
  const csv = Buffer.from([
    "timestamp,net_load_mw,ghi_wm2,t2m_c,rooftop_pv_mw_measured",
    "2024-01-01T12:00,100.000,1.000,2.000,3.000",
    "2024-01-01T13:00,6020.738,416.230,23.900,2033.479",
    "",
  ].join("\n"), "utf8");

  it("adds exactly +1.000 MW to one reading and changes nothing else", () => {
    const { tampered, before: b, after: a } = lib.tamperNetLoad(csv, "2024-01-01T13:00", 1.0);
    assert.equal(b, "2024-01-01T13:00,6020.738,416.230,23.900,2033.479");
    assert.equal(a, "2024-01-01T13:00,6021.738,416.230,23.900,2033.479");
    assert.equal(tampered.toString("utf8"), csv.toString("utf8").replace(b, a));
    assert.equal(lib.tamperNetLoad(csv, "2024-01-01T12:00", -0.5).after, "2024-01-01T12:00,99.500,1.000,2.000,3.000");
  });

  it("throws for a timestamp that is not a data row (the header never matches)", () => {
    assert.throws(() => lib.tamperNetLoad(csv, "2024-01-02T00:00", 1), /not found/);
    assert.throws(() => lib.tamperNetLoad(csv, "timestamp", 1), /not found/);
  });

  it("bytes32 / bareHex round-trip and reject anything but 32 bytes", () => {
    const h = nsw.evidence_sha256;
    assert.equal(lib.bytes32(h), `0x${h}`);
    assert.equal(lib.bytes32(`0X${h.toUpperCase()}`), `0x${h}`);
    assert.equal(lib.bareHex(lib.bytes32(h)), h);
    assert.throws(() => lib.bytes32("0x1234"), /not a 32-byte hex value/);
  });

  it("stationId is keccak256 of the station name", () => {
    assert.equal(lib.stationId("AEMO/NSW1"), "0x927048db1c3b3cf3f26a6818466d33b4b3d3d80c75566720c7c2d7c883bf8716");
  });

  it("fmtInt, statusName, withinAcceptBand and acceptNote", () => {
    assert.equal(lib.fmtInt(1234567n), "1,234,567");
    assert.equal(lib.fmtInt(999), "999");
    assert.deepEqual([0, 1, 2].map(lib.statusName), ["Pending", "Accepted", "Disputed"]);
    assert.throws(() => lib.statusName(3), /unknown status/);
    assert.deepEqual([6999, 7000, 13000, 13001].map(lib.withinAcceptBand), [false, true, true, false]);
    assert.equal(lib.acceptNote(7352), "checked against AEMO rooftop PV: in-sample recovery 73.52%");
  });

  it("revertName reads a custom error from ethers' revert field or the message", () => {
    assert.equal(lib.revertName({ revert: { name: "NotRegulator" } }), "NotRegulator");
    assert.equal(lib.revertName({ message: "reverted with custom error 'BadIndex()'" }), "BadIndex");
    assert.equal(lib.revertName({ message: "network timeout" }), null);
  });

  it("expectRevert returns the error name, null without a revert, and rethrows other errors", async () => {
    assert.equal(await lib.expectRevert(async () => { throw { revert: { name: "NotEstimator" } }; }), "NotEstimator");
    assert.equal(await lib.expectRevert(async () => ({ wait: async () => ({}) })), null);
    await assert.rejects(lib.expectRevert(async () => { throw new Error("socket hang up"); }), /socket hang up/);
  });
});
