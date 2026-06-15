// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./DeployHelpers.s.sol";
import "../contracts/BountyBoard.sol";

contract DeployBountyBoard is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        BountyBoard bountyBoard = new BountyBoard();
        console.logString(
            string.concat("BountyBoard deployed at: ", vm.toString(address(bountyBoard)))
        );
    }
}
