// Integration tests on the REAL evidence bundles (chain/evidence/*.csv + manifest.json):
// the published files hash to the manifest, anchor with the manifest numbers, and any edit,
// even +1 MW on one hourly reading, makes on-chain verification fail.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
// The same +1 MW edit demo.js makes (one shared implementation, so the test and the demo cannot drift).
const { tamperNetLoad } = require("../scripts/lib");

const ROOT = path.join(__dirname, "..", "..");
const EVIDENCE_DIR = path.join(ROOT, "chain", "evidence");
const DOCS_EVIDENCE_DIR = path.join(ROOT, "docs", "evidence");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "manifest.json"), "utf8"));
const HEADER = "timestamp,net_load_mw,ghi_wm2,t2m_c,rooftop_pv_mw_measured";
const BASE_URI = process.env.EVIDENCE_BASE_URI || "chain/evidence/";
const Status = { Pending: 0n, Accepted: 1n, Disputed: 2n };

const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readEvidence = (entry) => fs.readFileSync(path.join(EVIDENCE_DIR, entry.evidence_file));
const stationId = (entry) => ethers.id(entry.station);

async function anchoredFixture() {
  const [regulator, estimator, auditor] = await ethers.getSigners();
  const registry = await ethers.deployContract("BTMRegistry", [], regulator);
  await registry.waitForDeployment();
  await registry.setEstimator(estimator.address, true);
  const codeHash = "0x" + MANIFEST.code_hash;
  const txs = [];
  for (const e of MANIFEST.attestations) {
    txs.push(await registry.connect(estimator).attest(
      stationId(e), e.period_start, e.period_end, e.capacity_kw_eff, e.uncertainty_kw,
      e.energy_recovery_bp, "0x" + e.evidence_sha256, codeHash, BASE_URI + e.evidence_file,
    ));
  }
  return { registry, regulator, estimator, auditor, codeHash, txs };
}

describe("Evidence bundles (real AEMO 2024 files)", function () {
  it("manifest lists the four NEM regions with 64-hex hashes", function () {
    expect(MANIFEST.schema).to.equal("invisible-solar-pk/evidence/v1");
    expect(MANIFEST.code_hash).to.match(/^[0-9a-f]{64}$/);
    expect(MANIFEST.attestations.map((e) => e.station))
      .to.deep.equal(["AEMO/NSW1", "AEMO/QLD1", "AEMO/VIC1", "AEMO/SA1"]);
    for (const e of MANIFEST.attestations) expect(e.evidence_sha256).to.match(/^[0-9a-f]{64}$/);
  });

  for (const entry of MANIFEST.attestations) {
    describe(entry.station, function () {
      it("SHA-256 of the file bytes equals the manifest evidence_sha256", function () {
        expect(sha256Hex(readEvidence(entry))).to.equal(entry.evidence_sha256);
      });

      it("is LF-only (no \\r) with the exact header and n_hours data rows", function () {
        const bytes = readEvidence(entry);
        expect(bytes.includes(0x0d), "CRLF conversion would change the hash").to.equal(false);
        const text = bytes.toString("utf8");
        expect(text.endsWith("\n")).to.equal(true);
        const lines = text.slice(0, -1).split("\n");
        expect(lines[0]).to.equal(HEADER);
        expect(lines.length - 1).to.equal(entry.n_hours);
        expect(lines[1]).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:00(,-?\d+\.\d{3}){4}$/);
      });

      it("docs/evidence copy is byte-identical", function () {
        const docsCopy = fs.readFileSync(path.join(DOCS_EVIDENCE_DIR, entry.evidence_file));
        expect(docsCopy.equals(readEvidence(entry))).to.equal(true);
      });
    });
  }

  describe("anchoring with the real manifest numbers", function () {
    it("stores the manifest values for all four regions and verify() passes on the local hash", async function () {
      const { registry, estimator, auditor, codeHash } = await loadFixture(anchoredFixture);
      const asAuditor = registry.connect(auditor);
      for (const e of MANIFEST.attestations) {
        const id = stationId(e);
        expect(await asAuditor.count(id)).to.equal(1n);
        const a = await asAuditor.get(id, 0);
        expect(a.estimator).to.equal(estimator.address);
        expect(a.periodStart).to.equal(BigInt(e.period_start));
        expect(a.periodEnd).to.equal(BigInt(e.period_end));
        expect(a.capacityKwEff).to.equal(BigInt(e.capacity_kw_eff));
        expect(a.uncertaintyKw).to.equal(BigInt(e.uncertainty_kw));
        expect(a.energyRecoveryBp).to.equal(BigInt(e.energy_recovery_bp));
        expect(a.status).to.equal(Status.Pending);
        expect(a.evidenceHash).to.equal("0x" + e.evidence_sha256);
        expect(a.codeHash).to.equal(codeHash);
        // the auditor re-hashes the published file locally and checks it against the chain
        expect(await asAuditor.verify(id, 0, "0x" + sha256Hex(readEvidence(e)))).to.equal(true);
      }
    });

    it("emits Attested with the station, estimate, hashes and evidence URI", async function () {
      const { registry, estimator, codeHash, txs } = await loadFixture(anchoredFixture);
      for (const [k, e] of MANIFEST.attestations.entries()) {
        await expect(txs[k]).to.emit(registry, "Attested").withArgs(
          stationId(e), 0n, estimator.address, BigInt(e.capacity_kw_eff),
          "0x" + e.evidence_sha256, codeHash, BASE_URI + e.evidence_file,
        );
      }
    });

    it("a planner reads the regulator-accepted estimate via latestAccepted()", async function () {
      const { registry } = await loadFixture(anchoredFixture);
      const nsw = MANIFEST.attestations[0];
      expect((await registry.latestAccepted(stationId(nsw)))[0]).to.equal(false);
      await registry.setStatus(stationId(nsw), 0, Status.Accepted, "checked against AEMO's rooftop-PV estimate");
      const [found, a] = await registry.latestAccepted(stationId(nsw));
      expect(found).to.equal(true);
      expect(a.capacityKwEff).to.equal(BigInt(nsw.capacity_kw_eff));
      expect(a.evidenceHash).to.equal("0x" + nsw.evidence_sha256);
    });

    it("the anchored hash is SHA-256, so a keccak256 of the same bytes does not verify", async function () {
      const { registry } = await loadFixture(anchoredFixture);
      const nsw = MANIFEST.attestations[0];
      expect(await registry.verify(stationId(nsw), 0, ethers.keccak256(readEvidence(nsw)))).to.equal(false);
    });
  });

  describe("tamper detection (NSW)", function () {
    const nsw = MANIFEST.attestations[0];

    it("+1.000 MW on one hourly net_load_mw reading changes the SHA-256 and fails verify()", async function () {
      const { registry } = await loadFixture(anchoredFixture);
      const original = readEvidence(nsw);
      const { tampered, before, after } = tamperNetLoad(original, "2024-01-01T13:00", 1.0);

      // exactly one field of one line changed, by exactly +1.000 MW
      const [b, a] = [before.split(","), after.split(",")];
      expect(a[0]).to.equal(b[0]);
      expect(a.slice(2)).to.deep.equal(b.slice(2));
      expect(Math.round(Number(a[1]) * 1000) - Math.round(Number(b[1]) * 1000)).to.equal(1000);
      expect(a[1]).to.match(/^-?\d+\.\d{3}$/);
      expect(tampered.toString("utf8").split("\n").length).to.equal(original.toString("utf8").split("\n").length);

      const tamperedHex = sha256Hex(tampered);
      expect(tamperedHex).to.not.equal(nsw.evidence_sha256);
      expect(await registry.verify(stationId(nsw), 0, "0x" + tamperedHex)).to.equal(false);
      // the untouched file still verifies
      expect(await registry.verify(stationId(nsw), 0, "0x" + sha256Hex(original))).to.equal(true);
    });

    it("removing a single trailing byte also fails verify()", async function () {
      const { registry } = await loadFixture(anchoredFixture);
      const original = readEvidence(nsw);
      const truncated = original.subarray(0, original.length - 1);
      const truncatedHex = sha256Hex(truncated);
      expect(truncatedHex).to.not.equal(nsw.evidence_sha256);
      expect(await registry.verify(stationId(nsw), 0, "0x" + truncatedHex)).to.equal(false);
    });

    it("converting the file to CRLF line endings also fails verify()", async function () {
      const { registry } = await loadFixture(anchoredFixture);
      const crlf = Buffer.from(readEvidence(nsw).toString("utf8").replace(/\n/g, "\r\n"), "utf8");
      expect(await registry.verify(stationId(nsw), 0, "0x" + sha256Hex(crlf))).to.equal(false);
    });
  });
});
