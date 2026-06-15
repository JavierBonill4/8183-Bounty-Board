// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/BountyBoard.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock Token", "MTK") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

contract BountyBoardTest is Test {
    BountyBoard public board;
    MockERC20 public token;

    address creator = address(1);
    address worker = address(2);

    function setUp() public {
        board = new BountyBoard();
        token = new MockERC20();
        token.transfer(creator, 1000 ether);
    }

    function test_CreateJob() public {
        vm.startPrank(creator);
        token.approve(address(board), 100 ether);
        uint256 jobId = board.createJob(
            address(token),
            100 ether,
            "ipfs://test",
            0,
            1 days
        );
        vm.stopPrank();

        BountyBoard.Job memory job = board.getJob(jobId);
        assertEq(job.creator, creator);
        assertEq(job.reward, 100 ether);
        assertEq(uint256(job.status), 0); // Open
    }

    function test_SubmitAndAccept() public {
        vm.startPrank(creator);
        token.approve(address(board), 100 ether);
        uint256 jobId = board.createJob(address(token), 100 ether, "ipfs://test", 0, 1 days);
        vm.stopPrank();

        vm.prank(worker);
        board.submitWork(jobId, "ipfs://work");

        uint256 workerBalBefore = token.balanceOf(worker);

        vm.prank(creator);
        board.acceptSubmission(jobId);

        assertEq(token.balanceOf(worker), workerBalBefore + 100 ether);

        BountyBoard.Job memory job = board.getJob(jobId);
        assertEq(uint256(job.status), 1); // Completed
        assertEq(job.winner, worker);
    }
}
