// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FlightcheckRegistry} from "../src/FlightcheckRegistry.sol";

contract FlightcheckRegistryHandler is Test {
    FlightcheckRegistry private immutable _registry;

    address[] private _runners;
    bytes32[] private _reportHashes;
    mapping(bytes32 identity => bool seen) private _seen;

    constructor(FlightcheckRegistry registry) {
        _registry = registry;
    }

    function anchor(address runner, bytes32 reportHash, uint8 outcomeBitmap) external {
        if (runner == address(0) || reportHash == bytes32(0)) return;

        bytes32 identity = _identity(runner, reportHash);
        if (_seen[identity]) return;

        vm.prank(runner);
        _registry.anchorReport(reportHash, outcomeBitmap);

        _seen[identity] = true;
        _runners.push(runner);
        _reportHashes.push(reportHash);
    }

    function recordCount() external view returns (uint256) {
        return _runners.length;
    }

    function record(uint256 index) external view returns (address runner, bytes32 reportHash) {
        return (_runners[index], _reportHashes[index]);
    }

    function isSeen(address runner, bytes32 reportHash) external view returns (bool) {
        return _seen[_identity(runner, reportHash)];
    }

    function _identity(address runner, bytes32 reportHash) private pure returns (bytes32) {
        return keccak256(abi.encode(runner, reportHash));
    }
}

contract FlightcheckRegistryInvariantTest is StdInvariant, Test {
    FlightcheckRegistry private registry;
    FlightcheckRegistryHandler private handler;

    function setUp() public {
        registry = new FlightcheckRegistry();
        handler = new FlightcheckRegistryHandler(registry);
        targetContract(address(handler));
    }

    function invariant_RecordedAnchorsRemainTrue() public view {
        uint256 count = handler.recordCount();
        for (uint256 index = 0; index < count; ++index) {
            (address runner, bytes32 reportHash) = handler.record(index);
            assertTrue(registry.isAnchored(runner, reportHash));
        }
    }

    function invariant_RunnerAndHashIdentitiesRemainIsolated() public view {
        uint256 count = handler.recordCount();
        for (uint256 index = 0; index < count; ++index) {
            (address runner, bytes32 reportHash) = handler.record(index);

            address neighborRunner = address(uint160(runner) ^ 1);
            if (!handler.isSeen(neighborRunner, reportHash)) {
                assertFalse(registry.isAnchored(neighborRunner, reportHash));
            }

            bytes32 neighborHash = bytes32(uint256(reportHash) ^ 1);
            if (!handler.isSeen(runner, neighborHash)) {
                assertFalse(registry.isAnchored(runner, neighborHash));
            }
        }
    }
}
