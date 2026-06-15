"use client";

import { useState } from "react";
import type { NextPage } from "next";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";

// ─── Types ───────────────────────────────────────────────────────────────────

const JOB_STATUS_LABELS: Record<number, string> = {
  0: "Open",
  1: "Completed",
  2: "Cancelled",
  3: "Disputed",
};

const SUB_STATUS_LABELS: Record<number, string> = {
  0: "Pending",
  1: "Accepted",
  2: "Rejected",
};

const JOB_STATUS_COLORS: Record<number, string> = {
  0: "badge-success",
  1: "badge-info",
  2: "badge-error",
  3: "badge-warning",
};

const SUB_STATUS_COLORS: Record<number, string> = {
  0: "badge-warning",
  1: "badge-success",
  2: "badge-error",
};

const ERC20_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortenAddress(addr: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}

function formatDeadline(ts: bigint) {
  if (ts === 0n) return "None";
  return new Date(Number(ts) * 1000).toLocaleString();
}

// ─── JobCard ─────────────────────────────────────────────────────────────────

function JobCard({
  jobId,
  connectedAddress,
  bountyBoardAddress: _bountyBoardAddress,
}: {
  jobId: number;
  connectedAddress?: string;
  bountyBoardAddress?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [workUri, setWorkUri] = useState("");
  const [showSubmitForm, setShowSubmitForm] = useState(false);

  const { data: job } = useScaffoldReadContract({
    contractName: "BountyBoard",
    functionName: "getJob",
    args: [BigInt(jobId)],
  });

  const { data: submissions } = useScaffoldReadContract({
    contractName: "BountyBoard",
    functionName: "getSubmissions",
    args: [BigInt(jobId)],
    watch: expanded,
  });

  const { data: isClaimable } = useScaffoldReadContract({
    contractName: "BountyBoard",
    functionName: "isClaimable",
    args: [BigInt(jobId)],
    watch: true,
  });

  const { data: isAcceptingSubmissions } = useScaffoldReadContract({
    contractName: "BountyBoard",
    functionName: "isAcceptingSubmissions",
    args: [BigInt(jobId)],
    watch: true,
  });

  const { writeContractAsync: writeContract } = useScaffoldWriteContract({
    contractName: "BountyBoard",
  });

  // Derive view state (all hooks above this line)
  const isCreator = connectedAddress?.toLowerCase() === (job?.creator ?? "")?.toLowerCase();
  const isOpen = Number(job?.status ?? 99) === 0;
  const canSubmit = !!isAcceptingSubmissions && !isCreator;
  const hasPendingEval = isOpen && (job?.nextEvalIndex ?? 0n) < (job?.submissionCount ?? 0n);

  if (!job) return null;

  return (
    <div className="card bg-base-100 shadow-md border border-base-300 mb-4">
      <div className="card-body p-4">
        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-bold text-lg">Job #{jobId}</h3>
            <a
              href={job.descriptionURI}
              target="_blank"
              rel="noopener noreferrer"
              className="link link-primary text-sm break-all"
            >
              {job.descriptionURI}
            </a>
          </div>
          <span className={`badge ${JOB_STATUS_COLORS[Number(job.status)]} ml-2`}>
            {JOB_STATUS_LABELS[Number(job.status)]}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm mt-2">
          <div>
            <span className="text-base-content/60">Reward:</span>{" "}
            <span className="font-mono font-semibold">{formatUnits(job.reward, 18)}</span>
          </div>
          <div>
            <span className="text-base-content/60">Token:</span>{" "}
            <span className="font-mono">{shortenAddress(job.token)}</span>
          </div>
          <div>
            <span className="text-base-content/60">Creator:</span>{" "}
            <span className="font-mono">{shortenAddress(job.creator)}</span>
          </div>
          <div>
            <span className="text-base-content/60">Submissions:</span>{" "}
            <span>
              {Number(job.submissionCount)} (eval @ #{Number(job.nextEvalIndex)})
            </span>
          </div>
          <div>
            <span className="text-base-content/60">Submit Deadline:</span>{" "}
            <span>{formatDeadline(job.submissionDeadline)}</span>
          </div>
          <div>
            <span className="text-base-content/60">Verify Deadline:</span>{" "}
            <span>{formatDeadline(job.verificationDeadline)}</span>
          </div>
          {job.winner !== "0x0000000000000000000000000000000000000000" && (
            <div className="col-span-2">
              <span className="text-base-content/60">Winner:</span>{" "}
              <span className="font-mono">{shortenAddress(job.winner)}</span>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 mt-3 flex-wrap">
          <button className="btn btn-sm btn-outline" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide Details" : "Show Details"}
          </button>

          {isClaimable && connectedAddress && (
            <button
              className="btn btn-sm btn-warning"
              onClick={() =>
                writeContract({
                  functionName: "claimAfterTimeout",
                  args: [BigInt(jobId)],
                })
              }
            >
              Claim (Timeout)
            </button>
          )}
        </div>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-4 border-t border-base-300 pt-4">
            {/* Submissions */}
            <h4 className="font-semibold mb-2">Submissions</h4>
            {!submissions || submissions.length === 0 ? (
              <p className="text-sm text-base-content/60">No submissions yet.</p>
            ) : (
              <div className="space-y-2">
                {(submissions as { worker: string; workURI: string; timestamp: bigint; status: number }[]).map(
                  (sub, i) => {
                    const isCurrent = BigInt(i) === job.nextEvalIndex && isOpen;
                    return (
                      <div
                        key={i}
                        className={`p-3 rounded-lg border text-sm ${
                          isCurrent ? "border-primary bg-primary/5" : "border-base-300"
                        }`}
                      >
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-mono text-xs">{shortenAddress(sub.worker)}</span>
                          <div className="flex gap-1 items-center">
                            {isCurrent && <span className="badge badge-primary badge-xs">Current</span>}
                            <span className={`badge badge-xs ${SUB_STATUS_COLORS[Number(sub.status)]}`}>
                              {SUB_STATUS_LABELS[Number(sub.status)]}
                            </span>
                          </div>
                        </div>
                        <a
                          href={sub.workURI}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link link-secondary text-xs break-all"
                        >
                          {sub.workURI}
                        </a>
                        {/* Creator accept/reject for current pending */}
                        {isCreator && isCurrent && Number(sub.status) === 0 && isOpen && (
                          <div className="flex gap-2 mt-2">
                            <button
                              className="btn btn-xs btn-success"
                              onClick={() =>
                                writeContract({
                                  functionName: "acceptSubmission",
                                  args: [BigInt(jobId)],
                                })
                              }
                            >
                              Accept
                            </button>
                            <button
                              className="btn btn-xs btn-error"
                              onClick={() =>
                                writeContract({
                                  functionName: "rejectSubmission",
                                  args: [BigInt(jobId)],
                                })
                              }
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  },
                )}
              </div>
            )}

            {/* Submit Work */}
            {canSubmit && connectedAddress && (
              <div className="mt-4">
                {!showSubmitForm ? (
                  <button className="btn btn-sm btn-primary" onClick={() => setShowSubmitForm(true)}>
                    Submit Work
                  </button>
                ) : (
                  <div className="flex gap-2 items-end">
                    <div className="form-control flex-1">
                      <label className="label">
                        <span className="label-text text-xs">Work URI (IPFS/HTTPS)</span>
                      </label>
                      <input
                        className="input input-sm input-bordered"
                        placeholder="ipfs://... or https://..."
                        value={workUri}
                        onChange={e => setWorkUri(e.target.value)}
                      />
                    </div>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={!workUri}
                      onClick={async () => {
                        await writeContract({
                          functionName: "submitWork",
                          args: [BigInt(jobId), workUri],
                        });
                        setWorkUri("");
                        setShowSubmitForm(false);
                      }}
                    >
                      Submit
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setShowSubmitForm(false)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Creator cancel job */}
            {isCreator && isOpen && !hasPendingEval && (
              <button
                className="btn btn-sm btn-error mt-4"
                onClick={() =>
                  writeContract({
                    functionName: "cancelJob",
                    args: [BigInt(jobId)],
                  })
                }
              >
                Cancel Job (Refund)
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── BrowseJobs ───────────────────────────────────────────────────────────────

function BrowseJobs({
  connectedAddress,
  bountyBoardAddress: _bountyBoardAddress,
}: {
  connectedAddress?: string;
  bountyBoardAddress?: string;
}) {
  const { data: jobCount } = useScaffoldReadContract({
    contractName: "BountyBoard",
    functionName: "jobCount",
    watch: true,
  });

  const count = jobCount ? Number(jobCount) : 0;

  if (count === 0) {
    return (
      <div className="text-center py-16 text-base-content/50">
        <p className="text-xl">No jobs posted yet.</p>
        <p className="text-sm mt-2">Switch to &quot;Post a Job&quot; to create the first bounty!</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-base-content/60 mb-4">{count} job(s) found</p>
      {Array.from({ length: count }, (_, i) => i + 1)
        .reverse()
        .map(id => (
          <JobCard key={id} jobId={id} connectedAddress={connectedAddress} bountyBoardAddress={_bountyBoardAddress} />
        ))}
    </div>
  );
}

// ─── PostJob ─────────────────────────────────────────────────────────────────

function PostJob({ bountyBoardAddress }: { bountyBoardAddress?: string }) {
  const { address: connectedAddress } = useAccount();

  const [tokenAddress, setTokenAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [descUri, setDescUri] = useState("");
  const [deadline, setDeadline] = useState(""); // date-time local
  const [verificationDays, setVerificationDays] = useState("7");
  const [approved, setApproved] = useState(false);
  const [approving, setApproving] = useState(false);
  const [creating, setCreating] = useState(false);

  const { writeContractAsync: approveToken } = useWriteContract();
  const { writeContractAsync: writeContract } = useScaffoldWriteContract({
    contractName: "BountyBoard",
  });

  if (!connectedAddress) {
    return (
      <div className="text-center py-16 text-base-content/50">
        <p className="text-xl">Connect your wallet to post a job.</p>
      </div>
    );
  }

  if (!bountyBoardAddress) {
    return (
      <div className="text-center py-16">
        <div className="alert alert-warning max-w-md mx-auto">
          <span>
            BountyBoard contract not yet deployed. Run{" "}
            <code className="font-mono text-xs bg-base-200 px-1 rounded">yarn deploy --network sepolia</code> first.
          </span>
        </div>
      </div>
    );
  }

  const handleApprove = async () => {
    if (!tokenAddress || !amount || !bountyBoardAddress) return;
    setApproving(true);
    try {
      const amountParsed = parseUnits(amount, 18);
      await approveToken({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [bountyBoardAddress as `0x${string}`, amountParsed],
      });
      setApproved(true);
    } catch (e) {
      console.error("Approve failed:", e);
    } finally {
      setApproving(false);
    }
  };

  const handleCreateJob = async () => {
    if (!tokenAddress || !amount || !descUri || !verificationDays) return;
    setCreating(true);
    try {
      const amountParsed = parseUnits(amount, 18);
      const deadlineTs = deadline ? BigInt(Math.floor(new Date(deadline).getTime() / 1000)) : 0n;
      const verificationWindow = BigInt(Number(verificationDays) * 24 * 60 * 60);

      await writeContract({
        functionName: "createJob",
        args: [tokenAddress as `0x${string}`, amountParsed, descUri, deadlineTs, verificationWindow],
      });

      // Reset form
      setTokenAddress("");
      setAmount("");
      setDescUri("");
      setDeadline("");
      setVerificationDays("7");
      setApproved(false);
    } catch (e) {
      console.error("Create job failed:", e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-xl font-bold mb-6">Post a New Job</h2>
      <div className="space-y-4">
        <div className="form-control">
          <label className="label">
            <span className="label-text font-semibold">ERC-20 Token Address</span>
          </label>
          <input
            className="input input-bordered w-full font-mono"
            placeholder="0x..."
            value={tokenAddress}
            onChange={e => {
              setTokenAddress(e.target.value);
              setApproved(false);
            }}
          />
        </div>

        <div className="form-control">
          <label className="label">
            <span className="label-text font-semibold">Reward Amount</span>
            <span className="label-text-alt text-base-content/60">(in token units, 18 decimals assumed)</span>
          </label>
          <input
            className="input input-bordered w-full"
            type="number"
            placeholder="100"
            value={amount}
            onChange={e => {
              setAmount(e.target.value);
              setApproved(false);
            }}
          />
        </div>

        <div className="form-control">
          <label className="label">
            <span className="label-text font-semibold">Description URI</span>
            <span className="label-text-alt text-base-content/60">IPFS or HTTPS</span>
          </label>
          <input
            className="input input-bordered w-full"
            placeholder="ipfs://... or https://..."
            value={descUri}
            onChange={e => setDescUri(e.target.value)}
          />
        </div>

        <div className="form-control">
          <label className="label">
            <span className="label-text font-semibold">Submission Deadline</span>
            <span className="label-text-alt text-base-content/60">Optional — leave blank for no deadline</span>
          </label>
          <input
            className="input input-bordered w-full"
            type="datetime-local"
            value={deadline}
            onChange={e => setDeadline(e.target.value)}
          />
        </div>

        <div className="form-control">
          <label className="label">
            <span className="label-text font-semibold">Verification Window (days)</span>
            <span className="label-text-alt text-base-content/60">1–90 days</span>
          </label>
          <input
            className="input input-bordered w-full"
            type="number"
            min="1"
            max="90"
            value={verificationDays}
            onChange={e => setVerificationDays(e.target.value)}
          />
        </div>

        {/* Step 1: Approve */}
        <div className="divider">Step 1</div>
        <button
          className="btn btn-secondary w-full"
          disabled={!tokenAddress || !amount || approving || approved}
          onClick={handleApprove}
        >
          {approving ? <span className="loading loading-spinner" /> : approved ? "✅ Token Approved" : "Approve Token"}
        </button>

        {/* Step 2: Create */}
        <div className="divider">Step 2</div>
        <button
          className="btn btn-primary w-full"
          disabled={!approved || !descUri || !verificationDays || creating}
          onClick={handleCreateJob}
        >
          {creating ? <span className="loading loading-spinner" /> : "Create Job"}
        </button>

        {!approved && (
          <p className="text-xs text-center text-base-content/50">
            You must approve the token spend before creating a job.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const Home: NextPage = () => {
  const { address: connectedAddress } = useAccount();
  const [activeTab, setActiveTab] = useState<"browse" | "post">("browse");

  const { data: deployedContract } = useDeployedContractInfo({ contractName: "BountyBoard" });
  const bountyBoardAddress = deployedContract?.address;

  return (
    <div className="min-h-screen bg-base-200">
      {/* Header */}
      <div className="navbar bg-base-100 shadow px-6">
        <div className="flex-1">
          <span className="text-2xl font-bold">🏆 Bounty Board</span>
          <span className="ml-3 badge badge-outline badge-sm">ERC-8183</span>
        </div>
        <div className="flex-none">
          {bountyBoardAddress && (
            <span className="text-xs font-mono text-base-content/50 mr-4 hidden md:block">
              {shortenAddress(bountyBoardAddress)}
            </span>
          )}
        </div>
      </div>

      {/* Not deployed banner */}
      {!bountyBoardAddress && (
        <div className="alert alert-info rounded-none border-0">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            className="stroke-current shrink-0 w-6 h-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>
            BountyBoard not deployed yet. Run{" "}
            <code className="font-mono bg-base-100 px-1 rounded text-xs">yarn deploy --network sepolia</code> to get
            started.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <div className="tabs tabs-boxed mb-6 w-fit">
          <button
            className={`tab ${activeTab === "browse" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("browse")}
          >
            Browse Jobs
          </button>
          <button className={`tab ${activeTab === "post" ? "tab-active" : ""}`} onClick={() => setActiveTab("post")}>
            Post a Job
          </button>
        </div>

        {activeTab === "browse" ? (
          <BrowseJobs connectedAddress={connectedAddress} bountyBoardAddress={bountyBoardAddress} />
        ) : (
          <PostJob bountyBoardAddress={bountyBoardAddress} />
        )}
      </div>
    </div>
  );
};

export default Home;
