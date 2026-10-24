// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WattWitnessCore} from "./WattWitnessCore.sol";

/// @title WattWitnessRegistry
/// @notice Enforces protocol RULES around evidence supplied by registered sources.
///         It does NOT make that evidence true: a registered address that lies is still lying.
///         "Corroborated by N registered sources" means N distinct wallets, each registered under
///         a distinct declared controller id. It never means N distinct human beings.
///
/// Two different objects exist and are never conflated:
///   * Attestation: evidence from one registered source for one site and day. Many sources may
///     legitimately attest the same physical generator.
///   * Claim: a consumable protocol-level claim for (site, period, claimType). A claim is created
///     only by the site owner, only against a committed-and-revealed baseline, and is bounded by a
///     conservative amount that the CONTRACT derives from stored attestations.
///
/// Off-chain (TypeScript core): confidence and classifier-version filtering, emissions ranges,
/// ablation, explanations. On-chain (here): commitments, timing, registration, one attestation per
/// source and day, per-hour quorum, conservative bound, claim uniqueness, no overlapping claims,
/// challenge freeze, finalisation.
contract WattWitnessRegistry {
    // ---------------------------------------------------------------- constants & config
    uint16 public constant PROTOCOL_VERSION = 1;
    uint8 public constant MAX_ATTESTERS = 8;
    uint32 public constant MAX_CLAIM_DAYS = 31;
    uint32 public constant MAX_MILLI_HOURS_PER_DAY = 24_000;
    uint64 private constant PRESENT = uint64(1) << 63; // distinguishes "no attestation" from an all-zero one

    /// @notice Minimum number of distinct registered sources that must agree for an hour to count.
    uint8 public immutable quorum;
    /// @notice Required share (per mille) of claim-period hours covered by at least `quorum` sources.
    uint16 public immutable minCoverageMilli;
    /// @notice Seconds a claim must stay ELIGIBLE (unchallenged) before it can be finalised.
    uint64 public immutable challengeWindow;
    /// @notice Single address that can resolve challenges. A deliberate Phase 2 placeholder, see docs.
    address public immutable resolver;

    // ---------------------------------------------------------------- types
    enum ClaimState {
        NONE,
        ELIGIBLE,
        CHALLENGED,
        FINALIZED,
        INVALIDATED
    }

    struct Site {
        address owner;
    }

    struct BaselineSlot {
        bytes32 commitment;
        uint64 committedAt;
        bool revealed;
        uint32 baselineStartDay;
        uint32 baselineEndDay;
        uint32 lowMilliHoursPerDay;
        uint32 highMilliHoursPerDay;
        bytes32 evidenceRoot;
    }

    struct Claim {
        ClaimState state;
        uint32 startDay;
        uint32 endDay;
        bytes32 siteId;
        bytes32 claimType;
        uint64 claimedMilliHours;
        uint64 createdAt;
        uint64 eligibleSince;
        uint64 finalizedAt;
        address challenger;
    }

    struct Evidence {
        uint32 running; // hours corroborated as running
        uint32 off; // hours corroborated as not running
        uint32 disputed; // hours with quorum coverage but disagreement
        uint32 under; // hours without quorum coverage
        uint32 totalHours;
        uint32 coverageMilli;
    }

    // ---------------------------------------------------------------- storage
    mapping(bytes32 => Site) public sites;
    mapping(bytes32 => address[]) private siteAttesters;
    mapping(bytes32 => mapping(address => bool)) public isAttester;
    mapping(bytes32 => mapping(bytes32 => bool)) public controllerUsed;
    mapping(bytes32 => bytes32) public controllerOf; // keccak(site, attester) => controller (audit)
    /// site => day => attester => packed attestation (PRESENT | coverage << 24 | running)
    mapping(bytes32 => mapping(uint32 => mapping(address => uint64))) public attestationOf;

    mapping(bytes32 => BaselineSlot) public baselines; // key = baselineKey(site, claimType, postStartDay)
    mapping(bytes32 => Claim) public claims; // key = claimKey
    mapping(bytes32 => mapping(address => bool)) public hasChallenged;
    /// keccak(site, claimType) => (last claimed end day + 1). New claims must start at or after it.
    mapping(bytes32 => uint32) public claimedThrough;

    // ---------------------------------------------------------------- errors
    error InvalidConfig();
    error SiteExists();
    error UnknownSite();
    error NotSiteOwner();
    error NotRegisteredAttester();
    error NotResolver();
    error ZeroAddress();
    error ZeroController();
    error AlreadyRegistered();
    error ControllerAlreadyRegistered();
    error TooManyAttesters();
    error FutureDay();
    error InvalidMask();
    error DuplicateAttestation();
    error ZeroCommitment();
    error TimingViolation();
    error CommitmentExists();
    error NoCommitment();
    error AlreadyRevealed();
    error CommitmentMismatch();
    error InvalidBaselinePackage(uint8 reason);
    error InvalidPeriod();
    error PeriodTooLong();
    error PeriodNotFinished();
    error BaselineNotRevealed();
    error ZeroAmount();
    error DuplicateClaim();
    error OverlapsPreviousClaim();
    error InsufficientCoverage();
    error ExceedsConservativeBound();
    error UnknownClaim();
    error WrongState();
    error ChallengeWindowOpen();
    error AlreadyChallengedByYou();
    error StaleEvidence();
    error ClaimStillValid();

    // ---------------------------------------------------------------- events (identifiers only)
    event SiteRegistered(bytes32 indexed siteId, address indexed owner);
    event AttesterRegistered(bytes32 indexed siteId, address indexed attester, bytes32 controllerId);
    event BaselineCommitted(
        bytes32 indexed siteId, bytes32 indexed claimType, uint32 postStartDay, bytes32 commitment, uint64 committedAt
    );
    event BaselineRevealed(
        bytes32 indexed siteId,
        bytes32 indexed claimType,
        uint32 postStartDay,
        uint32 baselineStartDay,
        uint32 baselineEndDay,
        uint32 lowMilliHoursPerDay,
        uint32 highMilliHoursPerDay,
        bytes32 evidenceRoot
    );
    event AttestationSubmitted(
        bytes32 indexed siteId, uint32 indexed day, address indexed attester, uint32 runningMask, uint32 coverageMask
    );
    event ClaimCreated(
        bytes32 indexed claimKey,
        bytes32 indexed siteId,
        uint32 startDay,
        uint32 endDay,
        bytes32 claimType,
        uint64 claimedMilliHours,
        uint64 conservativeMilliHours
    );
    event ClaimChallenged(bytes32 indexed claimKey, address indexed challenger, bytes32 evidenceHash);
    event ChallengeResolved(bytes32 indexed claimKey, bool upheld);
    event ClaimFinalized(bytes32 indexed claimKey, uint64 claimedMilliHours);
    /// @dev reason: 1 = evidence no longer supports the claim, 2 = challenge upheld.
    event ClaimInvalidated(bytes32 indexed claimKey, uint8 reason);

    constructor(uint8 quorum_, uint16 minCoverageMilli_, uint64 challengeWindow_, address resolver_) {
        if (quorum_ < 2 || quorum_ > MAX_ATTESTERS || minCoverageMilli_ > 1000 || resolver_ == address(0)) {
            revert InvalidConfig();
        }
        quorum = quorum_;
        minCoverageMilli = minCoverageMilli_;
        challengeWindow = challengeWindow_;
        resolver = resolver_;
    }

    // ================================================================ sites & attesters

    /// @notice Registers a pseudonymous site. The id is bound to the caller, so nobody can squat
    ///         an id another owner intends to use. No personal data, location or audio goes on-chain.
    function registerSite(bytes32 salt) external returns (bytes32 siteId) {
        siteId = siteIdFor(msg.sender, salt);
        if (sites[siteId].owner != address(0)) revert SiteExists();
        sites[siteId].owner = msg.sender;
        emit SiteRegistered(siteId, msg.sender);
    }

    /// @notice Registers a source for a site under a declared controller id. A wallet may attest
    ///         for several sites, but only once per site; a controller id may appear once per site.
    ///         Controller ids are DECLARED by the site owner and are not proven.
    function addAttester(bytes32 siteId, address attester, bytes32 controllerId) external {
        _ownedSite(siteId);
        if (attester == address(0)) revert ZeroAddress();
        if (controllerId == bytes32(0)) revert ZeroController();
        if (isAttester[siteId][attester]) revert AlreadyRegistered();
        if (controllerUsed[siteId][controllerId]) revert ControllerAlreadyRegistered();
        if (siteAttesters[siteId].length >= MAX_ATTESTERS) revert TooManyAttesters();

        isAttester[siteId][attester] = true;
        controllerUsed[siteId][controllerId] = true;
        controllerOf[keccak256(abi.encode(siteId, attester))] = controllerId;
        siteAttesters[siteId].push(attester);
        emit AttesterRegistered(siteId, attester, controllerId);
    }

    function getAttesters(bytes32 siteId) external view returns (address[] memory) {
        return siteAttesters[siteId];
    }

    // ================================================================ attestations (observations)

    /// @notice One attestation per (site, day, attester). Never overwritten. Hour h of the day is
    ///         bit h. coverageMask = hours this source was listening; runningMask = hours it
    ///         classified the generator as running (must be a subset of coverage).
    function submitAttestation(bytes32 siteId, uint32 day, uint32 runningMask, uint32 coverageMask) external {
        if (sites[siteId].owner == address(0)) revert UnknownSite();
        if (!isAttester[siteId][msg.sender]) revert NotRegisteredAttester();
        if (day > block.timestamp / WattWitnessCore.SECONDS_PER_DAY) revert FutureDay();
        if (coverageMask > WattWitnessCore.HOURS_MASK || (runningMask & ~coverageMask) != 0) revert InvalidMask();
        if (attestationOf[siteId][day][msg.sender] != 0) revert DuplicateAttestation();

        attestationOf[siteId][day][msg.sender] = PRESENT | (uint64(coverageMask) << 24) | uint64(runningMask);
        emit AttestationSubmitted(siteId, day, msg.sender, runningMask, coverageMask);
    }

    // ================================================================ baseline commit / reveal

    /// @notice Commits to a baseline package BEFORE the post-intervention period starts.
    ///         The commitment is keccak256(abi.encode(BaselinePackage)): the Phase 1 fixed layout.
    ///         `postStartDay` is declared here and binds the claim that may later use this baseline.
    function commitBaseline(bytes32 siteId, bytes32 claimType, uint32 postStartDay, bytes32 commitment) external {
        _ownedSite(siteId);
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (!WattWitnessCore.commitmentIsTimely(uint64(block.timestamp), postStartDay)) revert TimingViolation();
        BaselineSlot storage b = baselines[baselineKey(siteId, claimType, postStartDay)];
        if (b.commitment != bytes32(0)) revert CommitmentExists();

        b.commitment = commitment;
        b.committedAt = uint64(block.timestamp);
        emit BaselineCommitted(siteId, claimType, postStartDay, commitment, uint64(block.timestamp));
    }

    /// @notice Reveals the committed package. The contract recomputes the hash itself.
    function revealBaseline(WattWitnessCore.BaselinePackage calldata pkg, uint32 postStartDay) external {
        _ownedSite(pkg.siteId);
        BaselineSlot storage b = baselines[baselineKey(pkg.siteId, pkg.claimType, postStartDay)];
        if (b.commitment == bytes32(0)) revert NoCommitment();
        if (b.revealed) revert AlreadyRevealed();
        if (WattWitnessCore.hashBaseline(pkg) != b.commitment) revert CommitmentMismatch();
        _validatePackage(pkg, postStartDay);

        b.revealed = true;
        b.baselineStartDay = pkg.baselineStartDay;
        b.baselineEndDay = pkg.baselineEndDay;
        b.lowMilliHoursPerDay = pkg.baselineMilliHoursPerDayLow;
        b.highMilliHoursPerDay = pkg.baselineMilliHoursPerDayHigh;
        b.evidenceRoot = pkg.baselineEvidenceRoot;
        emit BaselineRevealed(
            pkg.siteId,
            pkg.claimType,
            postStartDay,
            pkg.baselineStartDay,
            pkg.baselineEndDay,
            pkg.baselineMilliHoursPerDayLow,
            pkg.baselineMilliHoursPerDayHigh,
            pkg.baselineEvidenceRoot
        );
    }

    function _validatePackage(WattWitnessCore.BaselinePackage calldata p, uint32 postStartDay) private pure {
        if (p.version != PROTOCOL_VERSION) revert InvalidBaselinePackage(1);
        if (p.baselineEndDay < p.baselineStartDay) revert InvalidBaselinePackage(2);
        if (p.baselineMilliHoursPerDayLow > p.baselineMilliHoursPerDayHigh) revert InvalidBaselinePackage(3);
        if (p.baselineMilliHoursPerDayHigh > MAX_MILLI_HOURS_PER_DAY) revert InvalidBaselinePackage(4);
        if (p.baselineEvidenceRoot == bytes32(0)) revert InvalidBaselinePackage(5);
        if (p.salt == bytes32(0)) revert InvalidBaselinePackage(6);
        if (p.baselineEndDay >= postStartDay) revert InvalidBaselinePackage(7);
    }

    // ================================================================ claims

    /// @notice Creates a claim for [startDay, endDay]. The caller states an amount; the contract
    ///         derives the conservative bound from stored attestations and the revealed baseline and
    ///         rejects anything above it. `startDay` must equal the committed `postStartDay`.
    function createClaim(bytes32 siteId, uint32 startDay, uint32 endDay, bytes32 claimType, uint64 claimedMilliHours)
        external
        returns (bytes32 key)
    {
        _ownedSite(siteId);
        if (claimedMilliHours == 0) revert ZeroAmount();
        if (endDay < startDay) revert InvalidPeriod();
        if (uint256(endDay) - uint256(startDay) + 1 > MAX_CLAIM_DAYS) revert PeriodTooLong();
        if (block.timestamp < (uint256(endDay) + 1) * WattWitnessCore.SECONDS_PER_DAY) revert PeriodNotFinished();

        BaselineSlot storage b = baselines[baselineKey(siteId, claimType, startDay)];
        if (!b.revealed) revert BaselineNotRevealed();

        key = WattWitnessCore.claimKey(siteId, startDay, endDay, claimType);
        if (claims[key].state != ClaimState.NONE) revert DuplicateClaim();
        bytes32 wm = keccak256(abi.encode(siteId, claimType));
        if (startDay < claimedThrough[wm]) revert OverlapsPreviousClaim();

        (uint64 bound, bool covered) = _boundFor(siteId, startDay, endDay, b);
        if (!covered) revert InsufficientCoverage();
        if (claimedMilliHours > bound) revert ExceedsConservativeBound();

        claimedThrough[wm] = endDay + 1;
        Claim storage c = claims[key];
        c.state = ClaimState.ELIGIBLE;
        c.startDay = startDay;
        c.endDay = endDay;
        c.siteId = siteId;
        c.claimType = claimType;
        c.claimedMilliHours = claimedMilliHours;
        c.createdAt = uint64(block.timestamp);
        c.eligibleSince = uint64(block.timestamp);
        emit ClaimCreated(key, siteId, startDay, endDay, claimType, claimedMilliHours, bound);
    }

    /// @notice Any registered source of the claim's site may freeze an ELIGIBLE claim. Each source
    ///         can challenge a given claim once. The evidence itself stays off-chain (hash only).
    function challengeClaim(bytes32 key, bytes32 evidenceHash) external {
        Claim storage c = claims[key];
        if (c.state == ClaimState.NONE) revert UnknownClaim();
        if (!isAttester[c.siteId][msg.sender]) revert NotRegisteredAttester();
        if (c.state != ClaimState.ELIGIBLE) revert WrongState();
        if (hasChallenged[key][msg.sender]) revert AlreadyChallengedByYou();

        hasChallenged[key][msg.sender] = true;
        c.state = ClaimState.CHALLENGED;
        c.challenger = msg.sender;
        emit ClaimChallenged(key, msg.sender, evidenceHash);
    }

    /// @notice Placeholder dispute authority (single immutable address). Upheld invalidates the
    ///         claim permanently; rejected returns it to ELIGIBLE and restarts the challenge window.
    function resolveChallenge(bytes32 key, bool upheld) external {
        if (msg.sender != resolver) revert NotResolver();
        Claim storage c = claims[key];
        if (c.state != ClaimState.CHALLENGED) revert WrongState();
        if (upheld) {
            c.state = ClaimState.INVALIDATED;
            emit ChallengeResolved(key, true);
            emit ClaimInvalidated(key, 2);
        } else {
            c.state = ClaimState.ELIGIBLE;
            c.eligibleSince = uint64(block.timestamp);
            emit ChallengeResolved(key, false);
        }
    }

    /// @notice Finalises (consumes) a claim. Only the site owner, only when ELIGIBLE, only after the
    ///         challenge window, and only if the CURRENT evidence still supports the claimed amount.
    function finalizeClaim(bytes32 key) external {
        Claim storage c = claims[key];
        if (c.state == ClaimState.NONE) revert UnknownClaim();
        if (sites[c.siteId].owner != msg.sender) revert NotSiteOwner();
        if (c.state != ClaimState.ELIGIBLE) revert WrongState();
        if (block.timestamp < uint256(c.eligibleSince) + uint256(challengeWindow)) revert ChallengeWindowOpen();

        (uint64 bound, bool covered) =
            _boundFor(c.siteId, c.startDay, c.endDay, baselines[baselineKey(c.siteId, c.claimType, c.startDay)]);
        if (!covered || c.claimedMilliHours > bound) revert StaleEvidence();

        c.state = ClaimState.FINALIZED;
        c.finalizedAt = uint64(block.timestamp);
        emit ClaimFinalized(key, c.claimedMilliHours);
    }

    /// @notice Anyone may invalidate an ELIGIBLE claim whose claimed amount is no longer supported
    ///         by the attestations stored on-chain (for example because a source later disagreed).
    function invalidateStaleClaim(bytes32 key) external {
        Claim storage c = claims[key];
        if (c.state != ClaimState.ELIGIBLE) revert WrongState();
        (uint64 bound, bool covered) =
            _boundFor(c.siteId, c.startDay, c.endDay, baselines[baselineKey(c.siteId, c.claimType, c.startDay)]);
        if (covered && c.claimedMilliHours <= bound) revert ClaimStillValid();
        c.state = ClaimState.INVALIDATED;
        emit ClaimInvalidated(key, 1);
    }

    // ================================================================ views & key helpers

    /// @notice What the contract would compute for a claim right now (does not change state).
    function previewClaim(bytes32 siteId, uint32 startDay, uint32 endDay, bytes32 claimType)
        external
        view
        returns (Evidence memory e, uint64 conservativeMilliHours, uint64 generousMilliHours, bool baselineRevealed)
    {
        if (endDay < startDay || uint256(endDay) - uint256(startDay) + 1 > MAX_CLAIM_DAYS) revert InvalidPeriod();
        BaselineSlot storage b = baselines[baselineKey(siteId, claimType, startDay)];
        e = _evidence(siteId, startDay, endDay);
        baselineRevealed = b.revealed;
        if (baselineRevealed) {
            (conservativeMilliHours, generousMilliHours) = _bounds(b, e, endDay - startDay + 1);
        }
    }

    function siteIdFor(address owner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }

    function baselineKey(bytes32 siteId, bytes32 claimType, uint32 postStartDay) public pure returns (bytes32) {
        return keccak256(abi.encode(siteId, claimType, postStartDay));
    }

    // ================================================================ internals

    function _ownedSite(bytes32 siteId) private view {
        address owner = sites[siteId].owner;
        if (owner == address(0)) revert UnknownSite();
        if (owner != msg.sender) revert NotSiteOwner();
    }

    function _boundFor(bytes32 siteId, uint32 startDay, uint32 endDay, BaselineSlot storage b)
        private
        view
        returns (uint64 conservative, bool covered)
    {
        Evidence memory e = _evidence(siteId, startDay, endDay);
        covered = (e.running + e.off + e.disputed) > 0 && e.coverageMilli >= minCoverageMilli;
        (conservative,) = _bounds(b, e, endDay - startDay + 1);
    }

    /// @dev Mirrors the Phase 1 evaluator exactly (integer milli-hours):
    ///      conservative = max(0, baselineLow * days - (totalHours - off) * 1000)
    ///      generous     = max(0, baselineHigh * days - running * 1000)
    function _bounds(BaselineSlot storage b, Evidence memory e, uint32 nDays)
        private
        view
        returns (uint64 conservative, uint64 generous)
    {
        uint256 baseLow = uint256(b.lowMilliHoursPerDay) * nDays;
        uint256 baseHigh = uint256(b.highMilliHoursPerDay) * nDays;
        uint256 postHigh = (uint256(e.totalHours) - e.off) * 1000;
        uint256 postLow = uint256(e.running) * 1000;
        conservative = uint64(baseLow > postHigh ? baseLow - postHigh : 0);
        generous = uint64(baseHigh > postLow ? baseHigh - postLow : 0);
    }

    /// @dev Per-hour quorum classification, identical in meaning to Phase 1 `summarizePeriod`:
    ///      running  : >= quorum sources report running
    ///      off      : >= quorum sources listened and NONE reported running
    ///      disputed : >= quorum listened, some reported running, fewer than quorum agree
    ///      under    : fewer than quorum listened
    ///      Zero-padded entries (sources with no attestation that day) contribute no bits.
    function _evidence(bytes32 siteId, uint32 startDay, uint32 endDay) private view returns (Evidence memory e) {
        address[] storage list = siteAttesters[siteId];
        uint256 n = list.length;
        uint32[] memory runs = new uint32[](n);
        uint32[] memory covs = new uint32[](n);
        for (uint32 day = startDay; day <= endDay; day++) {
            uint32 anyRunning;
            for (uint256 i = 0; i < n; i++) {
                uint64 a = attestationOf[siteId][day][list[i]];
                if (a & PRESENT != 0) {
                    runs[i] = uint32(a & WattWitnessCore.HOURS_MASK);
                    covs[i] = uint32((a >> 24) & WattWitnessCore.HOURS_MASK);
                    anyRunning |= runs[i];
                } else {
                    runs[i] = 0;
                    covs[i] = 0;
                }
            }
            uint32 runQ = WattWitnessCore.quorumMask(runs, quorum);
            uint32 covQ = WattWitnessCore.quorumMask(covs, quorum);
            uint32 off = covQ & ~anyRunning & WattWitnessCore.HOURS_MASK;
            uint32 disp = covQ & anyRunning & ~runQ & WattWitnessCore.HOURS_MASK;
            e.running += WattWitnessCore.popcount24(runQ);
            e.off += WattWitnessCore.popcount24(off);
            e.disputed += WattWitnessCore.popcount24(disp);
            e.under += WattWitnessCore.popcount24(~covQ & WattWitnessCore.HOURS_MASK);
        }
        e.totalHours = (endDay - startDay + 1) * 24;
        e.coverageMilli = uint32((uint256(e.running + e.off + e.disputed) * 1000) / e.totalHours);
    }
}
