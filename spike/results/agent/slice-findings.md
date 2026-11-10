# Vertical slice — real Contracts agent loop (2026-11-09)

**What it is.** One end-to-end Contracts run, nothing canned: a NEAR abliterated model
drives a pi-durable loop with real tools over a per-run Docker/Foundry sandbox, finds
the planted reentrancy bug, writes its OWN exploit, proves it, and the finding is gated
behind a human decision.

**Pieces.**
- `lib/provider.mjs` — NEAR AI Cloud as a pi-ai provider (maxTokens 20000 so a
  reasoning-on turn can finish; 8192 ended turns mid-think with no answer).
- `lib/sandbox.mjs` — per-run workspace (copies src/, lib/, foundry.toml; the agent
  never sees oracle/). Runs `forge test` offline: `--network none` + a warmed
  `foundry-svm` solc-cache volume + `--offline --use 0.8.38`. `distill()` strips the
  forge-std warning spam so the agent sees the real compile error, not noise.
- `agent-run.mjs` — tools (list_sources, read_source, run_poc, submit_finding) and the
  durable approval dance.

**Tools the agent gets.** `list_sources`, `read_source` (path-guarded, src/ only),
`run_poc` (writes the agent's Solidity into the sandbox, compiles+runs it, returns real
forge output; capped at MAX_POC=6 attempts), `submit_finding` (approval-gated).

**Durable approval.** The way pi-durable intends it: the agent worker runs until
submit_finding, persists the pending request, and the process is KILLED. A separate
"decide" process resumes over the same SQLite and approves/denies. The agent process
can be fully down while waiting — this is milestone 3's shape (the UI server is the
decider).

**Result (qwen-abl).**
- APPROVE run: read source → wrote PoC → 1 failed compile → fixed it → PoC PASSED
  (proved the drain) → submit_finding → worker killed at the gate → resumed in a fresh
  process → approved → run done. `pocProved: true, recorded: true`. 131s, $0.0088.
- DENY run: same up to the gate; decider denied; submit_finding threw "denied" and the
  agent wrapped up. Deny branch proven (`approval-decided: denied`).

**Observations for the demo.**
1. Iteration count varies a lot: 2 PoC attempts one run, 11 the next (~9 min). The
   MAX_POC cap now bounds this; consider surfacing attempts in the UI as "agent is
   iterating" rather than hiding it.
2. Usage is charged only at `settled`. A process killed before settling under-counts
   the ledger (the deny run's ~11 attempts went uncharged). Fine under the $2 cap, but
   wire incremental charging before trusting the ledger for billing.
3. Better `run_poc` feedback (real error vs warning spam) cut the approve run from
   "gave up after 1 try" to "fixed and passed on try 2". Tool feedback quality is the
   single biggest lever on whether the agent succeeds.

**Spend.** NEAR ledger $0.5841; add ~$0.03 for the uncharged deny run ≈ $0.61 of $2.
