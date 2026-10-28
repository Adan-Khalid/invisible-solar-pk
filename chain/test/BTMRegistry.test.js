// Unit tests for BTMRegistry: every function, every custom error and every event.
// Signers follow the repo convention: [0] regulator (deployer), [1] estimator, [2] stranger/auditor.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const Status = { Pending: 0n, Accepted: 1n, Disputed: 2n };
const NSW = ethers.id("AEMO/NSW1");
const QLD = ethers.id("AEMO/QLD1");
const EVIDENCE = ethers.sha256(ethers.toUtf8Bytes("evidence bundle A"));
const EVIDENCE_B = ethers.sha256(ethers.toUtf8Bytes("evidence bundle B"));
const CODE = ethers.sha256(ethers.toUtf8Bytes("estimator source v0.1.0"));
const URI = "chain/evidence/AEMO_NSW1_2024.csv";

// Argument list for attest(); override any field by name.
function attestArgs(overrides = {}) {
  const a = {
    stationId: NSW,
    periodStart: 20240101,
    periodEnd: 20241231,
    capacityKwEff: 4220911,
    uncertaintyKw: 1372599,
    energyRecoveryBp: 7349,
    evidenceHash: EVIDENCE,
    codeHash: CODE,
    evidenceURI: URI,
    ...overrides,
  };
  return [a.stationId, a.periodStart, a.periodEnd, a.capacityKwEff, a.uncertaintyKw,
    a.energyRecoveryBp, a.evidenceHash, a.codeHash, a.evidenceURI];
}

async function deployFixture() {
  const [regulator, estimator, stranger, other] = await ethers.getSigners();
  const registry = await ethers.deployContract("BTMRegistry", [], regulator);
  await registry.waitForDeployment();
  return { registry, regulator, estimator, stranger, other };
}

async function withEstimatorFixture() {
  const f = await deployFixture();
  await f.registry.connect(f.regulator).setEstimator(f.estimator.address, true);
  return f;
}

// Three attestations on NSW (indices 0, 1, 2) with distinct evidence, all Pending.
async function threeAttestationsFixture() {
  const f = await withEstimatorFixture();
  const r = f.registry.connect(f.estimator);
  for (let i = 0; i < 3; i++) {
    await r.attest(...attestArgs({ capacityKwEff: 1000 + i, evidenceHash: ethers.sha256(ethers.toUtf8Bytes(`ev${i}`)) }));
  }
  return f;
}

describe("BTMRegistry", function () {
  describe("deployment", function () {
    it("makes the deployer the regulator and emits RegulatorTransferred(0x0, deployer)", async function () {
      const { registry, regulator } = await loadFixture(deployFixture);
      expect(await registry.regulator()).to.equal(regulator.address);
      expect(await registry.pendingRegulator()).to.equal(ethers.ZeroAddress);
      expect(await registry.isEstimator(regulator.address)).to.equal(false);
      await expect(registry.deploymentTransaction())
        .to.emit(registry, "RegulatorTransferred")
        .withArgs(ethers.ZeroAddress, regulator.address);
    });

    it("starts with no attestations for any station", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.count(NSW)).to.equal(0n);
    });
  });

  describe("setEstimator", function () {
    it("reverts NotRegulator when called by a non-regulator (stranger or estimator)", async function () {
      const { registry, estimator, stranger } = await loadFixture(withEstimatorFixture);
      await expect(registry.connect(stranger).setEstimator(stranger.address, true))
        .to.be.revertedWithCustomError(registry, "NotRegulator");
      await expect(registry.connect(estimator).setEstimator(stranger.address, true))
        .to.be.revertedWithCustomError(registry, "NotRegulator");
    });

    it("reverts ZeroAddress for address(0)", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.setEstimator(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("reverts RegulatorCannotEstimate when the regulator tries to make itself an estimator", async function () {
      const { registry, regulator } = await loadFixture(deployFixture);
      await expect(registry.setEstimator(regulator.address, true))
        .to.be.revertedWithCustomError(registry, "RegulatorCannotEstimate");
      expect(await registry.isEstimator(regulator.address)).to.equal(false);
    });

    it("lets the regulator revoke its own (never granted) role as a harmless no-op", async function () {
      const { registry, regulator } = await loadFixture(deployFixture);
      await expect(registry.setEstimator(regulator.address, false))
        .to.emit(registry, "EstimatorSet").withArgs(regulator.address, false);
      expect(await registry.isEstimator(regulator.address)).to.equal(false);
    });

    it("grants the role and emits EstimatorSet(who, true)", async function () {
      const { registry, estimator } = await loadFixture(deployFixture);
      await expect(registry.setEstimator(estimator.address, true))
        .to.emit(registry, "EstimatorSet").withArgs(estimator.address, true);
      expect(await registry.isEstimator(estimator.address)).to.equal(true);
    });

    it("revokes the role (EstimatorSet(who, false)) after which attest reverts NotEstimator", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      await expect(registry.setEstimator(estimator.address, false))
        .to.emit(registry, "EstimatorSet").withArgs(estimator.address, false);
      expect(await registry.isEstimator(estimator.address)).to.equal(false);
      await expect(registry.connect(estimator).attest(...attestArgs()))
        .to.be.revertedWithCustomError(registry, "NotEstimator");
    });
  });

  describe("attest", function () {
    it("reverts NotEstimator for a stranger and for the regulator", async function () {
      const { registry, regulator, stranger } = await loadFixture(withEstimatorFixture);
      await expect(registry.connect(stranger).attest(...attestArgs()))
        .to.be.revertedWithCustomError(registry, "NotEstimator");
      await expect(registry.connect(regulator).attest(...attestArgs()))
        .to.be.revertedWithCustomError(registry, "NotEstimator");
    });

    it("reverts BadPeriod when periodEnd < periodStart, but accepts a one-day period", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      const r = registry.connect(estimator);
      await expect(r.attest(...attestArgs({ periodStart: 20241231, periodEnd: 20240101 })))
        .to.be.revertedWithCustomError(registry, "BadPeriod");
      await expect(r.attest(...attestArgs({ periodStart: 20240615, periodEnd: 20240615 }))).to.not.be.reverted;
    });

    it("reverts EmptyEvidence when evidenceHash is zero", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      await expect(registry.connect(estimator).attest(...attestArgs({ evidenceHash: ethers.ZeroHash })))
        .to.be.revertedWithCustomError(registry, "EmptyEvidence");
    });

    it("stores every field, the block timestamp and Pending status", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      const ts = (await time.latest()) + 3600;
      await time.setNextBlockTimestamp(ts);
      const tx = await registry.connect(estimator).attest(...attestArgs());
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const a = await registry.get(NSW, 0);
      expect(a.estimator).to.equal(estimator.address);
      expect(a.timestamp).to.equal(BigInt(ts));
      expect(a.timestamp).to.equal(BigInt(block.timestamp));
      expect(a.periodStart).to.equal(20240101n);
      expect(a.periodEnd).to.equal(20241231n);
      expect(a.capacityKwEff).to.equal(4220911n);
      expect(a.uncertaintyKw).to.equal(1372599n);
      expect(a.energyRecoveryBp).to.equal(7349n);
      expect(a.status).to.equal(Status.Pending);
      expect(a.evidenceHash).to.equal(EVIDENCE);
      expect(a.codeHash).to.equal(CODE);
    });

    it("accepts the maximum values of the packed integer fields", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      const U32 = 2n ** 32n - 1n;
      const U16 = 2n ** 16n - 1n;
      await registry.connect(estimator).attest(...attestArgs({
        periodStart: U32, periodEnd: U32, capacityKwEff: U32, uncertaintyKw: U32, energyRecoveryBp: U16,
      }));
      const a = await registry.get(NSW, 0);
      expect([a.periodStart, a.periodEnd, a.capacityKwEff, a.uncertaintyKw, a.energyRecoveryBp])
        .to.deep.equal([U32, U32, U32, U32, U16]);
      expect(a.status).to.equal(Status.Pending);
      expect(a.evidenceHash).to.equal(EVIDENCE);
    });

    it("returns the new index and increments it per station", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      const r = registry.connect(estimator);
      expect(await r.attest.staticCall(...attestArgs())).to.equal(0n);
      await r.attest(...attestArgs());
      expect(await r.attest.staticCall(...attestArgs({ evidenceHash: EVIDENCE_B }))).to.equal(1n);
      await r.attest(...attestArgs({ evidenceHash: EVIDENCE_B }));
      expect(await registry.count(NSW)).to.equal(2n);
      expect((await registry.get(NSW, 1)).evidenceHash).to.equal(EVIDENCE_B);
    });

    it("keeps stations isolated: indices and counts are per station", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      const r = registry.connect(estimator);
      await r.attest(...attestArgs());
      await r.attest(...attestArgs());
      expect(await r.attest.staticCall(...attestArgs({ stationId: QLD, evidenceHash: EVIDENCE_B }))).to.equal(0n);
      await r.attest(...attestArgs({ stationId: QLD, evidenceHash: EVIDENCE_B, capacityKwEff: 3594078 }));
      expect(await registry.count(NSW)).to.equal(2n);
      expect(await registry.count(QLD)).to.equal(1n);
      expect((await registry.get(QLD, 0)).capacityKwEff).to.equal(3594078n);
      expect((await registry.get(NSW, 0)).evidenceHash).to.equal(EVIDENCE);
      await expect(registry.get(QLD, 1)).to.be.revertedWithCustomError(registry, "BadIndex");
    });

    it("emits Attested with every argument including the evidenceURI", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      const r = registry.connect(estimator);
      await r.attest(...attestArgs());
      await expect(r.attest(...attestArgs({ evidenceHash: EVIDENCE_B, capacityKwEff: 42, evidenceURI: "ipfs://bafy/x.csv" })))
        .to.emit(registry, "Attested")
        .withArgs(NSW, 1n, estimator.address, 42n, EVIDENCE_B, CODE, "ipfs://bafy/x.csv");
    });
  });

  describe("setStatus", function () {
    it("an estimator cannot accept its own attestation (NotRegulator)", async function () {
      const { registry, estimator } = await loadFixture(threeAttestationsFixture);
      await expect(registry.connect(estimator).setStatus(NSW, 0, Status.Accepted, "self-accept"))
        .to.be.revertedWithCustomError(registry, "NotRegulator");
      expect((await registry.get(NSW, 0)).status).to.equal(Status.Pending);
    });

    it("reverts NotRegulator for a stranger", async function () {
      const { registry, stranger } = await loadFixture(threeAttestationsFixture);
      await expect(registry.connect(stranger).setStatus(NSW, 0, Status.Disputed, "x"))
        .to.be.revertedWithCustomError(registry, "NotRegulator");
    });

    it("reverts BadIndex for an index past the end and for an empty station", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await expect(registry.setStatus(NSW, 3, Status.Accepted, ""))
        .to.be.revertedWithCustomError(registry, "BadIndex");
      await expect(registry.setStatus(QLD, 0, Status.Accepted, ""))
        .to.be.revertedWithCustomError(registry, "BadIndex");
    });

    it("reverts BadStatus when setting Pending", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await expect(registry.setStatus(NSW, 0, Status.Pending, "back to pending"))
        .to.be.revertedWithCustomError(registry, "BadStatus");
    });

    it("moves Pending -> Accepted -> Disputed -> Accepted, emitting StatusChanged with the note", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await expect(registry.setStatus(NSW, 1, Status.Accepted, "matches feeder audit"))
        .to.emit(registry, "StatusChanged").withArgs(NSW, 1n, Status.Accepted, "matches feeder audit");
      expect((await registry.get(NSW, 1)).status).to.equal(Status.Accepted);

      await expect(registry.setStatus(NSW, 1, Status.Disputed, "meter data gap in July"))
        .to.emit(registry, "StatusChanged").withArgs(NSW, 1n, Status.Disputed, "meter data gap in July");
      expect((await registry.get(NSW, 1)).status).to.equal(Status.Disputed);

      await expect(registry.setStatus(NSW, 1, Status.Accepted, "gap filled, re-accepted"))
        .to.emit(registry, "StatusChanged").withArgs(NSW, 1n, Status.Accepted, "gap filled, re-accepted");
      expect((await registry.get(NSW, 1)).status).to.equal(Status.Accepted);
      // only the targeted attestation changed
      expect((await registry.get(NSW, 0)).status).to.equal(Status.Pending);
      expect((await registry.get(NSW, 2)).status).to.equal(Status.Pending);
    });

    it("can dispute a Pending attestation directly", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await expect(registry.setStatus(NSW, 0, Status.Disputed, "implausible capacity"))
        .to.emit(registry, "StatusChanged").withArgs(NSW, 0n, Status.Disputed, "implausible capacity");
      expect((await registry.get(NSW, 0)).status).to.equal(Status.Disputed);
    });
  });

  describe("latestAccepted", function () {
    it("returns found=false and an empty attestation when nothing is accepted", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      for (const id of [NSW, QLD]) {
        const [found, a] = await registry.latestAccepted(id);
        expect(found).to.equal(false);
        expect(a.estimator).to.equal(ethers.ZeroAddress);
        expect(a.evidenceHash).to.equal(ethers.ZeroHash);
      }
    });

    it("returns the newest Accepted attestation", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await registry.setStatus(NSW, 0, Status.Accepted, "");
      await registry.setStatus(NSW, 2, Status.Accepted, "");
      const [found, a] = await registry.latestAccepted(NSW);
      expect(found).to.equal(true);
      expect(a.capacityKwEff).to.equal(1002n);
      expect(a.status).to.equal(Status.Accepted);
    });

    it("skips newer Pending and Disputed attestations", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await registry.setStatus(NSW, 0, Status.Accepted, "");
      await registry.setStatus(NSW, 1, Status.Disputed, "");
      // index 2 stays Pending
      const [found, a] = await registry.latestAccepted(NSW);
      expect(found).to.equal(true);
      expect(a.capacityKwEff).to.equal(1000n);
    });

    it("falls back to the older Accepted one after the newest accepted is disputed", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await registry.setStatus(NSW, 0, Status.Accepted, "");
      await registry.setStatus(NSW, 2, Status.Accepted, "");
      expect((await registry.latestAccepted(NSW))[1].capacityKwEff).to.equal(1002n);
      await registry.setStatus(NSW, 2, Status.Disputed, "retracted");
      const [found, a] = await registry.latestAccepted(NSW);
      expect(found).to.equal(true);
      expect(a.capacityKwEff).to.equal(1000n);
      await registry.setStatus(NSW, 0, Status.Disputed, "retracted too");
      expect((await registry.latestAccepted(NSW))[0]).to.equal(false);
    });
  });

  describe("get / count / verify", function () {
    it("get reverts BadIndex past the end", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await expect(registry.get(NSW, 3)).to.be.revertedWithCustomError(registry, "BadIndex");
      await expect(registry.get(QLD, 0)).to.be.revertedWithCustomError(registry, "BadIndex");
    });

    it("verify returns true only for the anchored hash", async function () {
      const { registry, estimator } = await loadFixture(withEstimatorFixture);
      await registry.connect(estimator).attest(...attestArgs());
      expect(await registry.verify(NSW, 0, EVIDENCE)).to.equal(true);
      expect(await registry.verify(NSW, 0, EVIDENCE_B)).to.equal(false);
      expect(await registry.verify(NSW, 0, ethers.ZeroHash)).to.equal(false);
    });

    it("verify reverts BadIndex past the end", async function () {
      const { registry } = await loadFixture(threeAttestationsFixture);
      await expect(registry.verify(NSW, 3, EVIDENCE)).to.be.revertedWithCustomError(registry, "BadIndex");
      await expect(registry.verify(QLD, 0, EVIDENCE)).to.be.revertedWithCustomError(registry, "BadIndex");
    });

    it("anyone (an auditor with no role) can read and verify", async function () {
      const { registry, stranger } = await loadFixture(threeAttestationsFixture);
      const asAuditor = registry.connect(stranger);
      expect(await asAuditor.count(NSW)).to.equal(3n);
      const ev1 = ethers.sha256(ethers.toUtf8Bytes("ev1"));
      expect((await asAuditor.get(NSW, 1)).evidenceHash).to.equal(ev1);
      expect(await asAuditor.verify(NSW, 1, ev1)).to.equal(true);
    });
  });

  describe("two-step regulator transfer", function () {
    it("only the regulator can start a transfer (NotRegulator)", async function () {
      const { registry, estimator, stranger } = await loadFixture(withEstimatorFixture);
      await expect(registry.connect(stranger).transferRegulator(stranger.address))
        .to.be.revertedWithCustomError(registry, "NotRegulator");
      await expect(registry.connect(estimator).transferRegulator(estimator.address))
        .to.be.revertedWithCustomError(registry, "NotRegulator");
    });

    it("reverts ZeroAddress when nominating address(0)", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.transferRegulator(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("records the nominee and emits RegulatorTransferStarted without handing over power", async function () {
      const { registry, regulator, other } = await loadFixture(deployFixture);
      await expect(registry.transferRegulator(other.address))
        .to.emit(registry, "RegulatorTransferStarted").withArgs(regulator.address, other.address);
      expect(await registry.pendingRegulator()).to.equal(other.address);
      expect(await registry.regulator()).to.equal(regulator.address);
    });

    it("reverts NotPendingRegulator for anyone but the nominee, including when nobody is nominated", async function () {
      const { registry, regulator, stranger, other } = await loadFixture(deployFixture);
      await expect(registry.connect(stranger).acceptRegulator())
        .to.be.revertedWithCustomError(registry, "NotPendingRegulator");
      await registry.transferRegulator(other.address);
      await expect(registry.connect(stranger).acceptRegulator())
        .to.be.revertedWithCustomError(registry, "NotPendingRegulator");
      await expect(registry.connect(regulator).acceptRegulator())
        .to.be.revertedWithCustomError(registry, "NotPendingRegulator");
    });

    it("a second nomination replaces the first", async function () {
      const { registry, stranger, other } = await loadFixture(deployFixture);
      await registry.transferRegulator(other.address);
      await registry.transferRegulator(stranger.address);
      expect(await registry.pendingRegulator()).to.equal(stranger.address);
      await expect(registry.connect(other).acceptRegulator())
        .to.be.revertedWithCustomError(registry, "NotPendingRegulator");
    });

    it("an estimator nominee cannot accept (RegulatorCannotEstimate); once revoked it can, and could then accept its own earlier attestation (documented limit)", async function () {
      const { registry, estimator } = await loadFixture(threeAttestationsFixture);
      await registry.transferRegulator(estimator.address);
      await expect(registry.connect(estimator).acceptRegulator())
        .to.be.revertedWithCustomError(registry, "RegulatorCannotEstimate");
      // once the role is revoked the same nominee can accept
      await registry.setEstimator(estimator.address, false);
      await expect(registry.connect(estimator).acceptRegulator())
        .to.emit(registry, "RegulatorTransferred");

      // Known limit (docs/SECURITY.md section 4): separation of duties is per address and at one point in
      // time. setStatus does not compare the caller with the attestation's estimator, so this former
      // estimator, now regulator, could accept an attestation it submitted itself. Checked with a static
      // call (eth_call), so the attestation itself stays Pending.
      expect(await registry.regulator()).to.equal(estimator.address);
      expect(await registry.isEstimator(estimator.address)).to.equal(false);
      expect((await registry.get(NSW, 0)).estimator).to.equal(estimator.address);
      await expect(registry.connect(estimator).setStatus.staticCall(NSW, 0, Status.Accepted, "own attestation"))
        .to.not.be.reverted;
      expect((await registry.get(NSW, 0)).status).to.equal(Status.Pending);
    });

    it("after accept the old regulator loses power, the new one has it and pendingRegulator is cleared", async function () {
      const { registry, regulator, estimator, other } = await loadFixture(threeAttestationsFixture);
      await expect(registry.transferRegulator(other.address))
        .to.emit(registry, "RegulatorTransferStarted").withArgs(regulator.address, other.address);
      await expect(registry.connect(other).acceptRegulator())
        .to.emit(registry, "RegulatorTransferred").withArgs(regulator.address, other.address);

      expect(await registry.regulator()).to.equal(other.address);
      expect(await registry.pendingRegulator()).to.equal(ethers.ZeroAddress);

      // old regulator: every onlyRegulator function now reverts
      const old = registry.connect(regulator);
      await expect(old.setStatus(NSW, 0, Status.Accepted, "")).to.be.revertedWithCustomError(registry, "NotRegulator");
      await expect(old.setEstimator(regulator.address, true)).to.be.revertedWithCustomError(registry, "NotRegulator");
      await expect(old.transferRegulator(regulator.address)).to.be.revertedWithCustomError(registry, "NotRegulator");

      // new regulator: has every power, and still cannot make itself an estimator
      const neu = registry.connect(other);
      await expect(neu.setStatus(NSW, 0, Status.Accepted, "new regulator"))
        .to.emit(registry, "StatusChanged").withArgs(NSW, 0n, Status.Accepted, "new regulator");
      await expect(neu.setEstimator(other.address, true)).to.be.revertedWithCustomError(registry, "RegulatorCannotEstimate");
      await expect(neu.setEstimator(estimator.address, false))
        .to.emit(registry, "EstimatorSet").withArgs(estimator.address, false);

      // the nominee cannot accept a second time
      await expect(registry.connect(other).acceptRegulator())
        .to.be.revertedWithCustomError(registry, "NotPendingRegulator");
    });
  });
});
