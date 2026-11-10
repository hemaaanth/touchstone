# Wave 1: the shared contract

Five bb threads build Wave 1 in parallel. Each has its own git worktree. The
parent thread (the coordinator) merges the work to `main`. This file is the
contract every thread follows. Read `packs/README.md` and the Contracts pack
first. Contracts is the worked example.

## Goal

Each module becomes a pack. A pack wraps the best open-source tools for its
module, lifts their rules and workflows where the license allows, and adds the
crypto checks they miss. The goal is a superset of the open-source market,
packaged for crypto teams. Do not rebuild a tool that already exists.

## Threads and owned paths

| # | Thread | Packs | Owns | Proof kind |
|---|--------|-------|------|------------|
| 1 | Supply chain and secrets | `supply-chain` | `spike/packs/supply-chain/`, `spike/lib/proof-evidence.mjs` | `evidence` (builds it) |
| 2 | Web and sign-in, APIs | `web` | `spike/packs/web/`, `spike/lib/proof-http.mjs` | `http` (builds it) |
| 3 | Keys and signing, Chain watch | `keys`, `chain-watch` | `spike/packs/keys/`, `spike/packs/chain-watch/` | `forge` (exists) |
| 4 | Domains and front end, Surface | `domains`, `surface` | `spike/packs/domains/`, `spike/packs/surface/` | `evidence` |
| 5 | Platform | none | `spike/agent-run.mjs`, `spike/lib/` (except the two proof files above), `spike/packs/index.mjs` loader, `app/` | all |

Shared files that every thread may touch, with care:

- `spike/packs/index.mjs`: add one import line and one map entry for your pack.
  Nothing else.
- `THIRD_PARTY.md`: append rows only.
- `spike/test/`: add your own test files. Do not edit other threads' tests.

Thread 4 needs the `evidence` proof that thread 1 builds. Until it lands, put
the replay in `spike/packs/<id>/proof.mjs` with the same interface as below.
The coordinator moves it to `lib/` when merging.

## Pack interface additions

The Platform thread wires these two optional manifest fields into the engine
(`agent-run.mjs`) and the app server (`app/server/runs.mjs`). Pack threads
implement them now and test them directly.

```js
// Before the agent starts. Runs the wrapped tools and returns leads.
//   ws     the run workspace
//   emit   (event) => void; writes one run event (see lib/event.mjs)
// Returns { env, record }.
//   env     string values passed to kickoff(ws, env), e.g. { LEADS: "..." }
//   record  JSON kept in the run record as `prepass`
prepass?: (ws, { emit }) => Promise<{ env, record }>

// After the run settles. Replays each submitted finding.
//   found   state.found, the submitted findings
//   events  every event of the run
// Returns the findings that replayed, worst first. Each finding carries
//   proof: { kind: "forge" | "http" | "evidence", status: "pass" | "fail", ... }
prove?: (ws, found, events, log) => Promise<Finding[]>
```

Contracts maps to these: `prepass` wraps `runPrepass`, and `prove` wraps
`proveFindings`. A pack with no `prove` has no findings, only leads.

## Proof kinds (the interfaces threads 1 and 2 build)

- `lib/proof-http.mjs`: start the practice service in Docker on a private
  network with no internet. Run the finding's request script in a second
  container on that network. The oracle checks the harm (for example, user B's
  data in user A's response). Pass or fail, plus the request and response log.
- `lib/proof-evidence.mjs`: a finding cites evidence (file path and line, DNS
  record, HTTP header, commit). The replay checks the evidence again against the
  pinned snapshot in the workspace. Pass if the check still holds. Secrets are
  shown redacted with a hash, never in full.

## Every thread's steps

1. **Tool pick.** Fill `spike/packs/<id>/TOOLS.md` with the template in
   `packs/README.md`. Start from `research/harness/sections/03-capabilities.md`,
   `04-crypto-coverage.md` and `07-gap-*`. Check each license and image at the
   upstream repo. Where tools overlap, run them on your lab and compare.
2. **Wrap.** Every `wrap` and `ensemble` row becomes a call through
   `lib/wrap.mjs` `runTool()`. Parse JSON or SARIF with the shared helpers.
3. **Lift.** Take rule packs, detectors, prompts and workflows where the
   license allows. Record each lift in `THIRD_PARTY.md`.
4. **Crypto gap.** Add our own checks for what the tools miss.
5. **Lab.** Build a practice target with planted bugs in
   `spike/packs/<id>/lab/` or `lab/<name>/`. It must run offline.
6. **Proof.** A finding is real only when its proof replays.
7. **Pack.** Write `pack.mjs` (manifest, tools, kickoff, nudge, prepass,
   prove) and `SKILL.md`. Register it in `packs/index.mjs`.
8. **Test.** Unit tests in `spike/test/<id>.test.mjs`. A smoke test that calls
   the tools directly with no model spend. Then live runs (see Spend).

## Environment in a worktree

The worktree has no secrets, no `node_modules` and no local tool binaries.
Set them up like this. `MAIN` is the main checkout.

```sh
MAIN=/home/hemanth/Projects/near/redteam-harness
bun install                      # in the worktree root and in app/ if you touch the app
mkdir -p spike/data tools/bin
ln -sf $MAIN/spike/data/providers.json spike/data/providers.json
ln -sf $MAIN/tools/bin/aderyn tools/bin/aderyn
set -a; . $MAIN/spike/.env.local; set +a   # loads the NEAR AI key; never print it
export SPEND_LEDGER=$MAIN/spike/spend.json SPEND_CAP_USD=50.85 RUN_BUDGET_USD=1
```

Never read, print or copy `.env.local`. Sourcing it is fine.

## Spend

- All five threads share one $50 budget for model calls. `SPEND_LEDGER` points
  every worktree at one ledger. `SPEND_CAP_USD` stops all calls once the total
  passes it. Never change these two values.
- A live run gets $1 (`RUN_BUDGET_USD=1`). Raise it to $2 only when a $1 run
  ran out before it finished.
- Build and test with no model spend first. Spend on a live run only after the
  smoke test passes.
- Report the spend of every live run in your result.

## Limits

- Never push, publish, post, sign a transaction, touch mainnet, or scan a
  target that is not a lab. Commit on your worktree branch only.
- Every third-party tool runs in Docker through `runTool()`, never on the host.
- Do not upgrade dependencies. Adding one is fine. Use bun.
- Do not delete real run records in `spike/results/`.
- Do not use xAI Grok or paid OpenRouter models.
- Write docs and comments in Simple Technical English: short sentences, one
  idea per sentence, the code's own words.

## Result to report

When done, report to the parent thread:

- The commit hash on your branch, and the changed paths.
- The TOOLS.md verdicts in one line per tool.
- Checks you ran and what they showed (tests, smoke, live runs with spend).
- What is not done, and open questions.
