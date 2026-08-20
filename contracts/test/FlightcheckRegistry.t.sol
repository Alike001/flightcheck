// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlightcheckRegistry} from "../src/FlightcheckRegistry.sol";

contract FlightcheckRegistryTest is Test {
    event ReportAnchored(bytes32 indexed reportHash, address indexed runner, uint64 anchoredAt, uint8 outcomeBitmap);

    FlightcheckRegistry private registry;

    address private constant RUNNER = address(0xA11CE);
    bytes32 private constant REPORT_HASH = keccak256("flightcheck-report");
    uint8 private constant VERIFIED_BITMAP = 7;
    uint64 private constant ANCHORED_AT = 1_787_174_400;

    function setUp() public {
        registry = new FlightcheckRegistry();
        vm.warp(ANCHORED_AT);
    }

    function test_AnchorReportEmitsCanonicalEventAndPersistsState() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit ReportAnchored(REPORT_HASH, RUNNER, ANCHORED_AT, VERIFIED_BITMAP);

        vm.prank(RUNNER);
        registry.anchorReport(REPORT_HASH, VERIFIED_BITMAP);

        assertTrue(registry.isAnchored(RUNNER, REPORT_HASH));
    }

    function test_RevertWhen_ReportHashIsZero() public {
        vm.expectRevert(FlightcheckRegistry.ZeroReportHash.selector);
        registry.anchorReport(bytes32(0), VERIFIED_BITMAP);
    }

    function test_RevertWhen_RunnerAnchorsSameReportTwice() public {
        vm.prank(RUNNER);
        registry.anchorReport(REPORT_HASH, VERIFIED_BITMAP);

        vm.expectRevert(abi.encodeWithSelector(FlightcheckRegistry.ReportAlreadyAnchored.selector, RUNNER, REPORT_HASH));
        vm.prank(RUNNER);
        registry.anchorReport(REPORT_HASH, VERIFIED_BITMAP);
    }

    function test_SameReportHashCanBeAnchoredByDifferentRunners() public {
        address secondRunner = address(0xB0B);

        vm.prank(RUNNER);
        registry.anchorReport(REPORT_HASH, VERIFIED_BITMAP);
        vm.prank(secondRunner);
        registry.anchorReport(REPORT_HASH, VERIFIED_BITMAP);

        assertTrue(registry.isAnchored(RUNNER, REPORT_HASH));
        assertTrue(registry.isAnchored(secondRunner, REPORT_HASH));
    }

    function test_SameRunnerCanAnchorDifferentReports() public {
        bytes32 secondHash = keccak256("second-flightcheck-report");

        vm.startPrank(RUNNER);
        registry.anchorReport(REPORT_HASH, VERIFIED_BITMAP);
        registry.anchorReport(secondHash, VERIFIED_BITMAP);
        vm.stopPrank();

        assertTrue(registry.isAnchored(RUNNER, REPORT_HASH));
        assertTrue(registry.isAnchored(RUNNER, secondHash));
    }

    function testFuzz_AnchorPreservesIdentityAndAllBitmapValues(
        address runner,
        bytes32 reportHash,
        uint8 outcomeBitmap,
        uint64 anchoredAt
    ) public {
        vm.assume(runner != address(0));
        vm.assume(reportHash != bytes32(0));
        vm.warp(anchoredAt);

        vm.expectEmit(true, true, false, true, address(registry));
        emit ReportAnchored(reportHash, runner, anchoredAt, outcomeBitmap);

        vm.prank(runner);
        registry.anchorReport(reportHash, outcomeBitmap);

        assertTrue(registry.isAnchored(runner, reportHash));
    }
}
