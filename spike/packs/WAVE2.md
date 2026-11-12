# Wave 2: the shared contract

Seven bb threads build Wave 2 in parallel. Each has its own git worktree. The
parent thread (the coordinator) reviews and merges the work to `main`. This file
is the contract every thread follows. Read `packs/README.md`, `packs/WAVE1.md`,
and the Contracts pack first. Contracts is the worked example of a finished pack.

## Why this wave is different from Wave 1

Wave 1 built the frames. Most modules already have a pack, a lab, scanners, and a
test. They are PARTLY built, not empty. So Wave 2 is not "build from zero". It is
"complete, prove, and render". The bar is higher and the starting point is real.

The horizon is tomorrow morning. The product must be usable on real
infrastructure by then, not only on offline labs. The one rule we are learning:
get it right the first time. We lost days once to rework. The way we avoid that
this time is the SEAM rule below and verify-as-you-go.

## The acceptance bar (every module thread)

A module is done only when ALL of these hold. Not before.

1. It wraps its named open-source tools through `runTool()` (never on the host).
2. It has an offline lab with a planted bug that a clean scan would miss.
3. One real finding REPLAYS green through its proof (forge / http / evidence).
   A lead is not a finding. Navigation is not a finding.
4. That finding RENDERS in the app: prepass leads show, the finding shows, and
   its proof viewer (replay / http / evidence) shows the harm.
5. `npm test` for the pack passes, and a smoke test runs the tools with no model
   spend. Then one live lab run proves the end to end path.
6. Usable on real input: a code module reads a real repo or folder; a live module
   reaches a real target through the platform seam (see below), not just the lab.

If a module cannot meet the bar in the time, it reports the exact gap and the
proof that is missing. It does not lower the bar or fake a pass.

## The SEAM rule (this is the anti-rework rule — do not break it)

Module threads and platform threads must never touch each other's layer.

- A module reaches the outside world ONLY through three seams:
  - compute: `runTool()` in `lib/wrap.mjs` and the Foundry sandbox in
    `lib/sandbox.mjs`.
  - network: the scope-gated network the platform provides (never a raw socket
    or a raw `fetch` to a target).
  - browser: the platform browser tool (never a module's own headless browser).
- Platform threads swap WHAT is behind each seam (local Docker to Daytona; direct
  network to a scope proxy; headless to a non-blocked browser). They never change
  module logic.
- Because of this, the sandbox and live-target work lands WITHOUT reworking any
  module. If you find yourself editing a module to make execution work, stop:
  the change belongs behind the seam.

## Threads and owned paths

| # | Thread | Scope | Owns | Proof |
|---|--------|-------|------|-------|
| 1 | Keys and signing, Chain watch | complete + prove + render both | `spike/packs/keys/`, `spike/packs/chain-watch/` | `forge` (exists) |
| 2 | Supply chain and secrets | complete + prove + render | `spike/packs/supply-chain/` | `evidence` (exists) |
| 3 | Infra and cloud | complete + prove + render (IaC files now; live cloud via seam) | `spike/packs/infra-cloud/` | `http`/`evidence` |
| 4 | Domains and front end, Surface | complete + prove + render both | `spike/packs/domains/`, `spike/packs/surface/` | `evidence` |
| 5 | Web and APIs, AI and MCP (NEW) | finish web; CREATE `ai-mcp` as a new pack | `spike/packs/web/`, `spike/packs/ai-mcp/` (new) | `http` |
| 6 | Platform: Execution | Daytona backend behind the compute seam; Daytona key in Settings; swarm children on separate machines | `spike/lib/wrap.mjs`, `spike/lib/sandbox.mjs`, `app/server/settings.mjs`, `app/src/components/settings-page.tsx` | all |
| 7 | Platform: Reach and App | scope proxy + grant behind the network seam; non-blocked browser behind the browser seam; verify EVERY module renders; findings to a shareable report | `spike/lib/` (new scope/grant/browser files), `app/` (except settings files owned by #6) | all |

Shared files every thread may touch, with care:

- `spike/packs/index.mjs`: thread 5 adds ONE import line and ONE map entry for
  `ai-mcp`. Nothing else. No other thread edits this file.
- `THIRD_PARTY.md`: append rows only (record every lifted rule pack, detector,
  prompt, or workflow, with its license).
- `spike/test/`: add your own test files only. Do not edit another thread's tests.

Dependency note: module threads (1 to 5) can reach the full acceptance bar
against their LABS with no dependency on threads 6 or 7. Live-target reach
(real sites, real cloud) is added behind the seams by 6 and 7, so it lands for
every live module at once without touching module code.

## New module: AI and MCP (thread 5)

There is no pack for this today. Create `spike/packs/ai-mcp/`. The module tests
an AI agent or an MCP server the operator runs. The proof kind is `http`: the
practice service runs in Docker on a private network with no internet, and the
finding's request script replays against it while an oracle checks the harm.

Planted bugs the lab should carry (pick the ones you can prove, worst first):

- Prompt injection that makes the agent call a tool it should not (the oracle
  sees the forbidden tool call or its effect).
- A tool the MCP server exposes that leaks a secret or reaches outside its scope.
- An agent that follows an instruction hidden in untrusted content (a file, a
  web page, a task title) and takes a harmful action.
- Missing auth or weak scope on an MCP tool: a caller invokes a tool it was never
  granted.

A finding is real only when the request script replays and the oracle sees the
harm. A model saying "this looks unsafe" is a lead, never a finding. Reuse
`lib/proof-http.mjs`; mirror the Web pack's shape.

## Platform: Execution (thread 6)

Goal: a run's tools execute in a Daytona sandbox when the operator configures
one, and on local Docker otherwise. Modules do not change.

- Add a Daytona backend behind `runTool()` and `lib/sandbox.mjs`. Keep the exact
  signature and return shape. Local Docker stays the default and the fallback.
- Read the Daytona API key from Settings. Request it with `bb secret request`;
  never ask the operator to paste a key into chat, never print it.
- A swarm's child agents should each get their own sandbox machine when Daytona
  is on, so they do not share one host. Keep the fleet policy and the proven-gate
  untouched (hard boundary below).
- Prove it: a run with Daytona configured produces the same lab finding as the
  local run, with the tool execution shown to have run in the sandbox.

## Platform: Reach and App (thread 7)

Goal: live modules can safely test a real target, and every module's result
renders and exports.

- Scope proxy: one gate all target-bound network traffic passes through. It
  allows only hosts on the grant's list and blocks everything else, with a log.
- Grant: a record of scope (hosts), who approved, and when. For the operator's
  own infrastructure the grant is the operator confirming ownership. The grant
  fills the proxy allow-list. Live modules refuse to run without a grant.
- Non-blocked browser: the browser seam uses a real browser profile (bb-browser)
  so a Cloudflare-style bot wall does not block the web, domains, and surface
  modules on real sites.
- App end-to-end: open the app and confirm EVERY module renders: scopes to run to
  streaming agent chat with thinking, prepass leads, findings, and the right
  proof viewer. Fix what does not render. Do not change a module's logic to do it;
  file the gap to that module's thread.
- Report: a finished run exports a shareable report (the finding, its proof, the
  harm, the fix) for case studies.

## Every module thread's steps

1. **Discover the real gap first.** Run the pack's `npm test`, its smoke test,
   and one live lab run. Write down exactly what is missing against the
   acceptance bar. Do this BEFORE writing new code. This is how we avoid rework.
2. **Complete the wrap.** Every tool runs through `runTool()`. Parse JSON or
   SARIF with the shared helpers. Fix any tool that is stubbed or not wired.
3. **Lift.** Take rule packs, detectors, prompts, and workflows where the license
   allows. Record each lift in `THIRD_PARTY.md`.
4. **Crypto gap.** Add our own checks for what the tools miss.
5. **Lab.** The lab must plant a bug a clean scan would miss, and run offline.
6. **Proof.** A finding is real only when its proof replays green AND shows harm.
7. **Render.** Confirm the finding and its proof show in the app. If a viewer is
   missing, report it to thread 7; do not build app UI in a module thread.
8. **Test.** Unit tests in `spike/test/<id>.test.mjs`, a no-spend smoke test, then
   a live lab run. Report the spend.

## Environment in a worktree

The worktree has no secrets, no `node_modules`, and no local tool binaries. Set
them up like this. `MAIN` is the main checkout.

```sh
MAIN=/home/hemanth/Projects/near/redteam-harness
bun install                      # in the worktree root and in app/ if you touch the app
mkdir -p spike/data
ln -sf $MAIN/spike/data/providers.json spike/data/providers.json
set -a; . $MAIN/spike/.env.local; set +a   # loads the NEAR AI key; never print it
export SPEND_LEDGER=$MAIN/spike/spend.json SPEND_CAP_USD=50.85 RUN_BUDGET_USD=1
```

Never read, print, or copy `.env.local`. Sourcing it is fine.

## Spend

- Building the code runs on the operator's own model subscriptions. That budget
  is not the live-run budget. Do not confuse them.
- Live model RUNS still share ONE $50 budget. `SPEND_LEDGER` points every worktree
  at one ledger. `SPEND_CAP_USD` stops all calls once the total passes it. Never
  change these two values.
- A live run gets $1 (`RUN_BUDGET_USD=1`). Raise to $2 only when a $1 run ran out
  before it finished.
- Build and test with no model spend first. Spend on a live run only after the
  smoke test passes. Report the spend of every live run.

## Limits (hard boundaries)

- Do NOT modify `app/src/lib/{fleet,fleet-policy,coordinator}.ts`, their tests, or
  the proven-gate `if (verdict.proven === true)`.
- Never push, publish, post, sign a transaction, touch mainnet, or scan a target
  that is not a lab and not a granted, operator-owned target. Commit on your
  worktree branch only. The coordinator merges.
- Every third-party tool runs in Docker through `runTool()`, never on the host.
- Do not upgrade dependencies. Adding one is fine. Use bun. Never run prettier.
- Do not delete real run records in `spike/results/`.
- Do not use xAI Grok, paid OpenRouter, or a silent paid fallback. Use the
  operator's subscriptions: Claude via claude-code, GPT via codex or OMP.
- Use bb-browser (with the dash) for any browser work.
- Write docs and comments in Simple Technical English: short sentences, one idea
  per sentence, the code's own words.

## Review and merge

- One writer per worktree. The coordinator assigns an independent reviewer per
  thread; the reviewer did not author the work and reads it read-only.
- Normally at most two repair/review cycles, then reassess scope or report the
  blocker.
- The coordinator merges each reviewed branch to `main` and keeps the integration
  green (`spike npm test`, `app` tsc and lib tests).

## Result to report

When done, report to the parent (coordinator) thread:

- The commit hash on your branch, and the changed paths.
- The acceptance bar, line by line: which of the six hold, which do not.
- The TOOLS.md verdicts, one line per tool.
- Checks you ran and what they showed (tests, smoke, live runs with spend).
- What is not done, and open questions.
