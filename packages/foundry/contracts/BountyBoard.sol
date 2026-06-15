// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title  BountyBoard
 * @notice ERC-8183 (Draft) — Open-submission decentralized bounty board.
 *
 * @dev    Deviations from base ERC-8183 spec:
 *           - provider = address(0) at creation (open to anyone)
 *           - provider is "locked" per-submission (each Submission.worker is immutable)
 *           - Job.winner is set at acceptance time, filling the provider role
 *           - Funding is ERC-20 only (no native ETH)
 *           - Multiple submissions per job, evaluated in strict FCFS order
 *           - Rejected workers may resubmit (hasPendingSubmission gates, not hasEverSubmitted)
 *
 *         Flow:
 *           1. Creator creates a job, funding it with ERC-20 tokens (pulled via transferFrom)
 *           2. Anyone submits work — address locked per submission
 *           3. Evaluator (creator) accepts or rejects the current FCFS submission
 *              - Accept → reward paid immediately, job Completed
 *              - Reject → submission marked Rejected, queue advances to next
 *           4. Same/different addresses may resubmit after their submission is rejected
 *           5. If evaluator is unresponsive past verificationDeadline → first pending
 *              submission can claim via claimAfterTimeout() (permissionless)
 *
 *         ERC-8004 integration: Phase 2 — see Phase2_ERC8004.md
 */
contract BountyBoard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    enum JobStatus {
        Open,       // Accepting submissions; reward locked in escrow
        Completed,  // Evaluator accepted a submission; reward paid out
        Cancelled,  // Cancelled by creator; reward returned
        Disputed    // verificationDeadline expired; first pending submission claimed reward
    }

    enum SubmissionStatus {
        Pending,    // Awaiting evaluation
        Accepted,   // Chosen as winner
        Rejected    // Rejected by evaluator; worker may resubmit
    }

    struct Job {
        uint256 id;
        address creator;
        address token;                // ERC-20 reward token
        uint256 reward;               // token amount (in token's native decimals)
        string  descriptionURI;       // IPFS/HTTPS — task description + acceptance criteria
        uint256 submissionDeadline;   // unix timestamp; 0 = open indefinitely
        uint256 verificationWindow;   // seconds evaluator has to act after window closes
        uint256 verificationDeadline; // 0 until set at creation or first submission
        JobStatus status;
        uint256 submissionCount;      // total submissions (including rejected)
        uint256 nextEvalIndex;        // FCFS pointer — index of next Pending submission to evaluate
        address winner;               // address(0) until Completed or Disputed
    }

    struct Submission {
        address worker;               // locked at submit time; address(0) never set here
        string  workURI;              // IPFS/HTTPS — deliverables + evidence
        uint256 timestamp;
        SubmissionStatus status;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public jobCount;

    /// @dev jobId → Job
    mapping(uint256 => Job) public jobs;

    /// @dev jobId → submissionIndex → Submission
    mapping(uint256 => mapping(uint256 => Submission)) public submissions;

    /// @dev jobId → worker → currently has a Pending submission
    ///      Reset to false when rejected — allows resubmission
    mapping(uint256 => mapping(address => bool)) public hasPendingSubmission;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant MIN_VERIFICATION_WINDOW = 1;
    uint256 public constant MAX_VERIFICATION_WINDOW = 90;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event JobCreated(
        uint256 indexed jobId,
        address indexed creator,
        address indexed token,
        uint256 reward,
        string  descriptionURI,
        uint256 submissionDeadline,
        uint256 verificationDeadline
    );

    event WorkSubmitted(
        uint256 indexed jobId,
        uint256 indexed submissionIndex,
        address indexed worker,
        string  workURI,
        uint256 verificationDeadline
    );

    event SubmissionAccepted(
        uint256 indexed jobId,
        uint256 indexed submissionIndex,
        address indexed winner,
        uint256 reward
    );

    event SubmissionRejected(
        uint256 indexed jobId,
        uint256 indexed submissionIndex,
        address indexed worker,
        uint256 nextEvalIndex
    );

    event JobCancelled(
        uint256 indexed jobId,
        address indexed creator,
        uint256 refund
    );

    event DisputeClaimed(
        uint256 indexed jobId,
        uint256 indexed submissionIndex,
        address indexed claimant,
        uint256 reward
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error ZeroReward();
    error ZeroToken();
    error InvalidSubmissionDeadline();
    error BadVerificationWindow();
    error JobDoesNotExist(uint256 jobId);
    error JobNotOpen(uint256 jobId);
    error SubmissionsClosed(uint256 jobId);
    error SelfSubmission();
    error AlreadyHasPendingSubmission();
    error NotCreator();
    error NoPendingSubmissions();
    error VerificationWindowActive();
    error NoPendingSubmissionsLeft();
    error TransferFailed();

    // ─────────────────────────────────────────────────────────────────────────
    // Job Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a new bounty job funded with ERC-20 tokens.
     *         Caller must have approved this contract for `amount` of `token` first.
     *
     * @param token               ERC-20 reward token address.
     * @param amount              Reward amount in token's native decimals.
     * @param descriptionURI      IPFS/HTTPS URI with full task description + acceptance criteria.
     * @param submissionDeadline  Unix timestamp after which no new submissions accepted.
     *                            Pass 0 for no deadline (verificationDeadline set on first submission).
     * @param verificationWindow  Seconds evaluator has to accept/reject after the submission window closes.
     *                            Must be between 1 day and 90 days.
     */
    function createJob(
        address token,
        uint256 amount,
        string calldata descriptionURI,
        uint256 submissionDeadline,
        uint256 verificationWindow
    ) external returns (uint256 jobId) {
        if (token == address(0)) revert ZeroToken();
        if (amount == 0) revert ZeroReward();
        if (submissionDeadline != 0 && submissionDeadline <= block.timestamp)
            revert InvalidSubmissionDeadline();
        if (verificationWindow < MIN_VERIFICATION_WINDOW || verificationWindow > MAX_VERIFICATION_WINDOW)
            revert BadVerificationWindow();

        jobId = ++jobCount;

        uint256 verificationDeadline = submissionDeadline != 0
            ? submissionDeadline + verificationWindow
            : 0; // set dynamically on first submission

        jobs[jobId] = Job({
            id:                   jobId,
            creator:              msg.sender,
            token:                token,
            reward:               amount,
            descriptionURI:       descriptionURI,
            submissionDeadline:   submissionDeadline,
            verificationWindow:   verificationWindow,
            verificationDeadline: verificationDeadline,
            status:               JobStatus.Open,
            submissionCount:      0,
            nextEvalIndex:        0,
            winner:               address(0)
        });

        // Pull reward tokens into escrow
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit JobCreated(jobId, msg.sender, token, amount, descriptionURI, submissionDeadline, verificationDeadline);
    }

    /**
     * @notice Submit completed work for a job. Open to any address except the creator.
     *
     *         Rules:
     *         - You cannot submit while you already have a Pending submission for this job
     *         - If your previous submission was Rejected, you may resubmit (new queue position)
     *         - Submissions always join the back of the FCFS queue
     *
     * @param jobId    The job to submit work for.
     * @param workURI  IPFS/HTTPS URI with deliverables and evidence of completion.
     */
    function submitWork(uint256 jobId, string calldata workURI) external {
        Job storage job = _requireOpen(jobId);

        if (job.submissionDeadline != 0 && block.timestamp > job.submissionDeadline)
            revert SubmissionsClosed(jobId);
        if (msg.sender == job.creator) revert SelfSubmission();
        if (hasPendingSubmission[jobId][msg.sender]) revert AlreadyHasPendingSubmission();

        uint256 subIndex = job.submissionCount;

        submissions[jobId][subIndex] = Submission({
            worker:    msg.sender,
            workURI:   workURI,
            timestamp: block.timestamp,
            status:    SubmissionStatus.Pending
        });

        hasPendingSubmission[jobId][msg.sender] = true;
        job.submissionCount++;

        // Start verification clock on first submission (no submissionDeadline case)
        if (job.submissionDeadline == 0 && subIndex == 0) {
            job.verificationDeadline = block.timestamp + job.verificationWindow;
        }

        emit WorkSubmitted(jobId, subIndex, msg.sender, workURI, job.verificationDeadline);
    }

    /**
     * @notice Accept the current FCFS submission and release the reward.
     *         Only callable by the job creator (evaluator).
     *
     *         The evaluator cannot skip forward — they must accept/reject in order.
     *
     * @param jobId  The job ID.
     */
    function acceptSubmission(uint256 jobId) external {
        Job storage job = _requireOpen(jobId);
        if (msg.sender != job.creator) revert NotCreator();
        if (job.nextEvalIndex >= job.submissionCount) revert NoPendingSubmissions();

        uint256 evalIdx = job.nextEvalIndex;
        Submission storage sub = submissions[jobId][evalIdx];

        // Mark state before transfer
        job.status  = JobStatus.Completed;
        job.winner  = sub.worker;
        sub.status  = SubmissionStatus.Accepted;

        emit SubmissionAccepted(jobId, evalIdx, sub.worker, job.reward);

        // Release reward
        IERC20(job.token).safeTransfer(sub.worker, job.reward);
    }

    /**
     * @notice Reject the current FCFS submission. Queue advances to the next submission.
     *         The rejected worker's hasPendingSubmission is cleared — they may resubmit.
     *         Only callable by the job creator (evaluator).
     *
     * @param jobId  The job ID.
     */
    function rejectSubmission(uint256 jobId) external {
        Job storage job = _requireOpen(jobId);
        if (msg.sender != job.creator) revert NotCreator();
        if (job.nextEvalIndex >= job.submissionCount) revert NoPendingSubmissions();

        uint256 evalIdx = job.nextEvalIndex;
        Submission storage sub = submissions[jobId][evalIdx];

        sub.status = SubmissionStatus.Rejected;
        hasPendingSubmission[jobId][sub.worker] = false; // allow resubmission

        job.nextEvalIndex++;

        emit SubmissionRejected(jobId, evalIdx, sub.worker, job.nextEvalIndex);
    }

    /**
     * @notice Cancel the job and return the reward to the creator.
     *
     *         Allowed when:
     *         - No submissions have been made, OR
     *         - All submissions have been reviewed (nextEvalIndex >= submissionCount)
     *           meaning no one is currently holding a Pending submission
     *
     *         Only callable by the creator.
     *
     * @param jobId  The job ID.
     */
    function cancelJob(uint256 jobId) external {
        Job storage job = _requireOpen(jobId);
        if (msg.sender != job.creator) revert NotCreator();

        // Must have no pending (unreviewed) submissions
        if (job.nextEvalIndex < job.submissionCount) revert NoPendingSubmissionsLeft();

        job.status = JobStatus.Cancelled;
        uint256 refund = job.reward;

        emit JobCancelled(jobId, msg.sender, refund);

        IERC20(job.token).safeTransfer(msg.sender, refund);
    }

    /**
     * @notice Claim the reward after the verification deadline expires.
     *         Pays the worker at `nextEvalIndex` (first pending submission in FCFS order).
     *         Permissionless — anyone can trigger this on behalf of the claimant.
     *
     *         This prevents creators from ignoring valid work indefinitely.
     *
     * @param jobId  The job ID.
     */
    function claimAfterTimeout(uint256 jobId) external {
        Job storage job = _requireOpen(jobId);

        if (job.nextEvalIndex >= job.submissionCount) revert NoPendingSubmissions();
        if (job.verificationDeadline == 0 || block.timestamp <= job.verificationDeadline)
            revert VerificationWindowActive();

        uint256 evalIdx = job.nextEvalIndex;
        Submission storage sub = submissions[jobId][evalIdx];

        job.status   = JobStatus.Disputed;
        job.winner   = sub.worker;
        sub.status   = SubmissionStatus.Accepted;

        emit DisputeClaimed(jobId, evalIdx, sub.worker, job.reward);

        IERC20(job.token).safeTransfer(sub.worker, job.reward);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getJob(uint256 jobId)
        external view returns (Job memory)
    {
        return jobs[jobId];
    }

    function getSubmission(uint256 jobId, uint256 subIndex)
        external view returns (Submission memory)
    {
        return submissions[jobId][subIndex];
    }

    /**
     * @notice Returns all submissions for a job (gas: read-only, not meant for onchain calls).
     */
    function getSubmissions(uint256 jobId)
        external view returns (Submission[] memory result)
    {
        uint256 count = jobs[jobId].submissionCount;
        result = new Submission[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = submissions[jobId][i];
        }
    }

    /**
     * @notice Returns true if the job has a pending submission ready for evaluation.
     */
    function hasPendingEval(uint256 jobId) external view returns (bool) {
        Job storage job = jobs[jobId];
        return job.status == JobStatus.Open && job.nextEvalIndex < job.submissionCount;
    }

    /**
     * @notice Returns true if the timeout claim is available.
     */
    function isClaimable(uint256 jobId) external view returns (bool) {
        Job storage job = jobs[jobId];
        return
            job.status == JobStatus.Open &&
            job.nextEvalIndex < job.submissionCount &&
            job.verificationDeadline != 0 &&
            block.timestamp > job.verificationDeadline;
    }

    /**
     * @notice Returns true if the job is still accepting new submissions.
     */
    function isAcceptingSubmissions(uint256 jobId) external view returns (bool) {
        Job storage job = jobs[jobId];
        return
            job.status == JobStatus.Open &&
            (job.submissionDeadline == 0 || block.timestamp <= job.submissionDeadline);
    }

    /**
     * @notice Returns the submission currently at the front of the evaluation queue.
     *         Reverts if no pending submissions.
     */
    function currentEvalSubmission(uint256 jobId)
        external view returns (Submission memory, uint256 index)
    {
        Job storage job = jobs[jobId];
        if (job.nextEvalIndex >= job.submissionCount) revert NoPendingSubmissions();
        index = job.nextEvalIndex;
        return (submissions[jobId][index], index);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _requireOpen(uint256 jobId) internal view returns (Job storage job) {
        job = jobs[jobId];
        if (job.creator == address(0)) revert JobDoesNotExist(jobId);
        if (job.status != JobStatus.Open) revert JobNotOpen(jobId);
    }
}
