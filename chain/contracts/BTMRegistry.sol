// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BTMRegistry
/// @notice Append-only, auditable registry of behind-the-meter (rooftop) solar capacity estimates
///         per grid station or feeder. Each attestation stores the estimate, its uncertainty and
///         the SHA-256 of the evidence bundle (the exact net-load, irradiance and temperature file
///         the estimator was run on) plus a hash of the estimator source code, so a regulator or
///         any third party can later check exactly what an estimate was based on and re-run it.
/// @dev    Roles: one REGULATOR (accepts or disputes attestations, manages estimators, two-step
///         handover) and any number of ESTIMATORS (submit attestations). The regulator can never
///         hold the estimator role, so no account can hold both roles at once.
///         What the chain proves: the evidence file has not changed since it was anchored, who
///         anchored it and when. What it cannot prove: that the meter readings were honest
///         (the oracle problem); that is what the regulator's review and the open data are for.
contract BTMRegistry {
    enum Status { Pending, Accepted, Disputed }

    /// @dev Packed into 4 storage slots: (estimator, timestamp, periodStart) | (periodEnd,
    ///      capacityKwEff, uncertaintyKw, energyRecoveryBp, status) | evidenceHash | codeHash.
    struct Attestation {
        address estimator;
        uint64  timestamp;        // block time of the attestation
        uint32  periodStart;      // yyyymmdd
        uint32  periodEnd;        // yyyymmdd
        uint32  capacityKwEff;    // estimated effective capacity, kW at 1000 W/m2
        uint32  uncertaintyKw;    // +/- kW, estimator-defined (documented in the evidence manifest)
        uint16  energyRecoveryBp; // energy recovery vs. an independent PV reference, basis points (0 if none); the manifest says whether it is in-sample
        Status  status;
        bytes32 evidenceHash;     // SHA-256 of the evidence file bytes
        bytes32 codeHash;         // SHA-256 of the estimator source (see src/invisible_solar/evidence.py)
    }

    address public regulator;
    address public pendingRegulator;
    mapping(address => bool) public isEstimator;
    // stationId = keccak256(bytes("AEMO/NSW1")) or keccak256(bytes("LESCO/<grid-station>")), etc.
    mapping(bytes32 => Attestation[]) private _att;

    event RegulatorTransferStarted(address indexed from, address indexed to);
    event RegulatorTransferred(address indexed from, address indexed to);
    event EstimatorSet(address indexed estimator, bool allowed);
    event Attested(bytes32 indexed stationId, uint256 indexed index, address indexed estimator,
                   uint32 capacityKwEff, bytes32 evidenceHash, bytes32 codeHash, string evidenceURI);
    event StatusChanged(bytes32 indexed stationId, uint256 indexed index, Status status, string note);

    error NotRegulator();
    error NotPendingRegulator();
    error NotEstimator();
    error RegulatorCannotEstimate();
    error ZeroAddress();
    error EmptyEvidence();
    error BadPeriod();
    error BadIndex();
    error BadStatus();

    modifier onlyRegulator() {
        if (msg.sender != regulator) revert NotRegulator();
        _;
    }

    constructor() {
        regulator = msg.sender;
        emit RegulatorTransferred(address(0), msg.sender);
    }

    /// @notice Start a two-step handover of the regulator role (e.g. to a multisig).
    function transferRegulator(address next) external onlyRegulator {
        if (next == address(0)) revert ZeroAddress();
        pendingRegulator = next;
        emit RegulatorTransferStarted(regulator, next);
    }

    /// @notice Complete the handover; must be called by the nominated address.
    function acceptRegulator() external {
        if (msg.sender != pendingRegulator) revert NotPendingRegulator();
        if (isEstimator[msg.sender]) revert RegulatorCannotEstimate();
        emit RegulatorTransferred(regulator, msg.sender);
        regulator = msg.sender;
        pendingRegulator = address(0);
    }

    /// @notice Grant or revoke the estimator role. The regulator itself can never be an estimator.
    function setEstimator(address who, bool allowed) external onlyRegulator {
        if (who == address(0)) revert ZeroAddress();
        if (allowed && who == regulator) revert RegulatorCannotEstimate();
        isEstimator[who] = allowed;
        emit EstimatorSet(who, allowed);
    }

    /// @notice Anchor a hidden-PV estimate and the hash of the evidence it was computed from.
    /// @param evidenceURI where the evidence file can be downloaded (emitted, not stored).
    function attest(
        bytes32 stationId,
        uint32 periodStart,
        uint32 periodEnd,
        uint32 capacityKwEff,
        uint32 uncertaintyKw,
        uint16 energyRecoveryBp,
        bytes32 evidenceHash,
        bytes32 codeHash,
        string calldata evidenceURI
    ) external returns (uint256 index) {
        if (!isEstimator[msg.sender]) revert NotEstimator();
        if (periodEnd < periodStart) revert BadPeriod();
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();
        _att[stationId].push(Attestation({
            estimator: msg.sender,
            timestamp: uint64(block.timestamp),
            periodStart: periodStart,
            periodEnd: periodEnd,
            capacityKwEff: capacityKwEff,
            uncertaintyKw: uncertaintyKw,
            energyRecoveryBp: energyRecoveryBp,
            status: Status.Pending,
            evidenceHash: evidenceHash,
            codeHash: codeHash
        }));
        index = _att[stationId].length - 1;
        emit Attested(stationId, index, msg.sender, capacityKwEff, evidenceHash, codeHash, evidenceURI);
    }

    /// @notice Regulator decision on an attestation: Accepted or Disputed (never back to Pending).
    function setStatus(bytes32 stationId, uint256 index, Status s, string calldata note) external onlyRegulator {
        if (index >= _att[stationId].length) revert BadIndex();
        if (s == Status.Pending) revert BadStatus();
        _att[stationId][index].status = s;
        emit StatusChanged(stationId, index, s, note);
    }

    function count(bytes32 stationId) external view returns (uint256) {
        return _att[stationId].length;
    }

    function get(bytes32 stationId, uint256 index) external view returns (Attestation memory) {
        if (index >= _att[stationId].length) revert BadIndex();
        return _att[stationId][index];
    }

    /// @notice Latest ACCEPTED attestation for a station, as a planner would read it.
    /// @dev Linear scan from the newest entry; intended for off-chain eth_call, not for other contracts.
    function latestAccepted(bytes32 stationId) external view returns (bool found, Attestation memory a) {
        Attestation[] storage arr = _att[stationId];
        for (uint256 i = arr.length; i > 0; i--) {
            if (arr[i - 1].status == Status.Accepted) return (true, arr[i - 1]);
        }
    }

    /// @notice True if a locally recomputed evidence hash matches the anchored one.
    function verify(bytes32 stationId, uint256 index, bytes32 evidenceHash) external view returns (bool) {
        if (index >= _att[stationId].length) revert BadIndex();
        return _att[stationId][index].evidenceHash == evidenceHash;
    }
}
