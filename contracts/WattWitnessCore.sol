// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title WattWitnessCore
/// @notice Pure functions that MUST agree bit-for-bit with the TypeScript core in src/.
library WattWitnessCore {
    /// @dev All fields are static types, so abi.encode(struct) is a flat sequence of
    ///      32-byte words. TypeScript mirrors this layout in src/hash.ts.
    struct BaselinePackage {
        uint16 version;
        bytes32 siteId;
        bytes32 claimType;
        uint32 baselineStartDay;
        uint32 baselineEndDay;
        uint32 baselineMilliHoursPerDayLow;
        uint32 baselineMilliHoursPerDayHigh;
        bytes32 baselineEvidenceRoot;
        bytes32 classifierVersion;
        bytes32 salt;
    }

    uint32 internal constant HOURS_MASK = 0xFFFFFF; // 24 hourly bits
    uint64 internal constant SECONDS_PER_DAY = 86400;

    function hashBaseline(BaselinePackage memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    /// @dev Uniqueness key for an economic claim: one claim per (site, period, claim type).
    function claimKey(bytes32 siteId, uint32 startDay, uint32 endDay, bytes32 claimType)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(siteId, startDay, endDay, claimType));
    }

    function observationLeaf(
        bytes32 siteId,
        uint32 day,
        bytes32 sourceId,
        uint32 runningMask,
        uint32 coverageMask
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(siteId, day, sourceId, runningMask, coverageMask));
    }

    /// @dev Sorted-pair hashing (commutative), compatible with common Merkle proof verifiers.
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev A commitment is timely only if it was made strictly before the claim period
    ///      starts (00:00:00 UTC of startDay).
    function commitmentIsTimely(uint64 commitTimestamp, uint32 claimStartDay)
        internal
        pure
        returns (bool)
    {
        return commitTimestamp < uint64(claimStartDay) * SECONDS_PER_DAY;
    }

    /// @dev Hour h (0..23) is set in the result iff at least `quorum` masks have bit h set.
    ///      Bits above 23 are ignored. quorum == 0 is rejected.
    function quorumMask(uint32[] memory masks, uint8 quorum) internal pure returns (uint32 out) {
        require(quorum > 0, "quorum=0");
        for (uint8 h = 0; h < 24; h++) {
            uint256 count = 0;
            for (uint256 i = 0; i < masks.length; i++) {
                if ((masks[i] >> h) & 1 == 1) count++;
            }
            if (count >= quorum) out |= uint32(1) << h;
        }
    }

    /// @dev Number of set bits among the 24 hourly bits (bits above 23 ignored).
    function popcount24(uint32 mask) internal pure returns (uint32 n) {
        uint32 m = mask & HOURS_MASK;
        while (m != 0) {
            m &= m - 1;
            n++;
        }
    }
}
