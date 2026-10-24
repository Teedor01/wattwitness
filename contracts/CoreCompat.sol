// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WattWitnessCore} from "./WattWitnessCore.sol";

/// @notice Phase 1 compatibility oracle: thin external wrappers over the shared library.
contract CoreCompat {
    function hashBaseline(WattWitnessCore.BaselinePackage calldata p) external pure returns (bytes32) {
        return WattWitnessCore.hashBaseline(p);
    }

    function claimKey(bytes32 siteId, uint32 startDay, uint32 endDay, bytes32 claimType)
        external
        pure
        returns (bytes32)
    {
        return WattWitnessCore.claimKey(siteId, startDay, endDay, claimType);
    }

    function observationLeaf(
        bytes32 siteId,
        uint32 day,
        bytes32 sourceId,
        uint32 runningMask,
        uint32 coverageMask
    ) external pure returns (bytes32) {
        return WattWitnessCore.observationLeaf(siteId, day, sourceId, runningMask, coverageMask);
    }

    function hashPair(bytes32 a, bytes32 b) external pure returns (bytes32) {
        return WattWitnessCore.hashPair(a, b);
    }

    function commitmentIsTimely(uint64 commitTimestamp, uint32 claimStartDay) external pure returns (bool) {
        return WattWitnessCore.commitmentIsTimely(commitTimestamp, claimStartDay);
    }

    function quorumMask(uint32[] calldata masks, uint8 quorum) external pure returns (uint32) {
        return WattWitnessCore.quorumMask(masks, quorum);
    }
}
