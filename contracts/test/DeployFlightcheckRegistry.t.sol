// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployFlightcheckRegistry} from "../script/DeployFlightcheckRegistry.s.sol";
import {FlightcheckRegistry} from "../src/FlightcheckRegistry.sol";

contract DeployFlightcheckRegistryHarness is DeployFlightcheckRegistry {
    function deployForTest(uint256 expectedChainId, uint256 deployerPrivateKey)
        external
        returns (FlightcheckRegistry registry)
    {
        return _deploy(expectedChainId, deployerPrivateKey);
    }
}

contract DeployFlightcheckRegistryTest is Test {
    DeployFlightcheckRegistryHarness private deployer;

    function setUp() public {
        deployer = new DeployFlightcheckRegistryHarness();
    }

    function test_DeploysOnExplicitExpectedChain() public {
        FlightcheckRegistry registry = deployer.deployForTest(block.chainid, 1);

        assertGt(address(registry).code.length, 0);
        assertFalse(registry.isAnchored(address(this), keccak256("unknown")));
    }

    function test_RevertWhen_ChainIdDiffersFromExplicitExpectation() public {
        uint256 expectedChainId = block.chainid + 1;

        vm.expectRevert(
            abi.encodeWithSelector(DeployFlightcheckRegistry.UnexpectedChainId.selector, block.chainid, expectedChainId)
        );
        deployer.deployForTest(expectedChainId, 1);
    }

    function test_RevertWhen_DeployerPrivateKeyIsZero() public {
        vm.expectRevert(DeployFlightcheckRegistry.ZeroDeployerPrivateKey.selector);
        deployer.deployForTest(block.chainid, 0);
    }
}
