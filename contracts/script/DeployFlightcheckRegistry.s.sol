// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {FlightcheckRegistry} from "../src/FlightcheckRegistry.sol";

/// @notice Deploys FlightcheckRegistry after checking the intended chain.
contract DeployFlightcheckRegistry is Script {
    error UnexpectedChainId(uint256 actual, uint256 expected);
    error ZeroDeployerPrivateKey();

    function run() external returns (FlightcheckRegistry registry) {
        return _deploy(vm.envUint("FLIGHTCHECK_EXPECTED_CHAIN_ID"), vm.envUint("FLIGHTCHECK_DEPLOYER_PRIVATE_KEY"));
    }

    function _deploy(uint256 expectedChainId, uint256 deployerPrivateKey)
        internal
        returns (FlightcheckRegistry registry)
    {
        if (block.chainid != expectedChainId) {
            revert UnexpectedChainId(block.chainid, expectedChainId);
        }
        if (deployerPrivateKey == 0) revert ZeroDeployerPrivateKey();

        vm.startBroadcast(deployerPrivateKey);
        registry = new FlightcheckRegistry();
        vm.stopBroadcast();
    }
}
