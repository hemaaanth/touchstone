# Module packs

A pack is one Touchstone module: Contracts, Supply chain, Web and sign-in, and so on.
Each pack wraps existing open-source tools as agent tools. It adds the crypto
checks those tools do not have. It never rebuilds a tool that already exists.

The engine (`spike/agent-run.mjs`) is the same for every pack. It opens the
pi-durable harness, installs the pack's tools as one extension, streams the run,
and records the findings. A pack owns everything that is specific to its module.

## Folder

```
packs/<id>/
  pack.mjs    the manifest and the tools (code)
  SKILL.md    how the agent works this module (instructions)
  TOOLS.md    the integration research: one row per open-source tool
  lab/        a practice target with planted bugs (or a path to one under lab/)
```

Register the pack in `packs/index.mjs`. A run picks its pack from the
`.touchstone.json` field `pack`. A run with no `pack` field is a Contracts run.

## Manifest

`pack.mjs` exports one default object:

| Field     | Type                        | Meaning |
|-----------|-----------------------------|---------|
| `id`      | string                      | The module id. Also the pi-durable extension name. |
| `title`   | string                      | The name the UI shows. |
| `tier`    | `"P" \| "S" \| "I" \| "F"`  | The highest tier the pack can reach. See 08-proposed-ui.md §5.4. |
| `proof`   | `"forge" \| "http" \| "evidence"` | How a finding becomes real. See "Proof kinds". |
| `system`  | `(ws) => string`            | The system prompt for this run. |
| `tools`   | `(ws, state) => Tool[]`     | The pi-durable tools. The set must not change during a run. |
| `kickoff` | `(ws, env) => string`       | The first message. `env` carries the pre-pass leads. |
| `nudge`   | `(state) => string \| null` | One optional follow-up when the model stops early. |
| `prepass` | `(ws, { emit }) => Promise<{ env, record }>` | Optional tool scan before kickoff. Emits run events and returns leads and record data. |
| `prove` | `(ws, found, events, log) => Promise<Finding[]>` | Optional replay after the agent settles. Returns findings worst first. No hook means no findings. |
| `teardown` | `(ws) => Promise<void>` | Optional. Stops anything the pre-pass left running (a lab container). The server calls it before it deletes the workspace, on every ending. It must be safe to call twice. |

`state` is `{ poc, passed, found }`. `passed` maps a proof name to the exact
source that passed. `found` is the list of submitted findings. The engine
reads `found` when the run settles.

## Rules

1. **Wrap, do not rebuild.** Call the real tool as a separate binary in its own
   container. Parse its JSON or SARIF output. Turn each result into a lead.
   Also take its rule packs, detectors, prompts and workflows when the license
   allows. Where two tools overlap, run both on the lab and keep the better one,
   or merge them as an ensemble.
2. **Use open source by its license.** Permissive code (MIT, Apache-2.0, BSD,
   ISC) may be copied or adapted. Keep the notice and add a line to
   `THIRD_PARTY.md`. GPL and AGPL code runs as a separate program only.
   Non-commercial or unlicensed code is read, or run as a separate program, and
   never pasted. All third-party code runs in Docker, never on the host.
3. **Offline by default.** Every tool runs in Docker with `--network none`. A
   tool that needs the network says so in TOOLS.md. It runs only against a lab
   until the scope proxy and the grant exist (I tier).
4. **A lead is not a finding.** Tool output is a lead. A finding needs a proof
   that the engine can replay. The `submit_finding` gate refuses anything else.
5. **One finding per root cause.** One fix closes one finding.
6. **Stable tools.** Build the tool list from `.touchstone.json` once per run.
7. **Licenses.** Record every license in TOOLS.md. See rule 2.
8. **No secrets in output.** A secret scanner's lead shows a redacted value and
   a hash. It never shows the full secret.

## Shared helpers

- `lib/wrap.mjs` `runTool()` runs one tool in Docker. It mounts the workspace
  at `/work`, has no network, drops all capabilities, and runs as the host user.
- `lib/wrap.mjs` `sarifLeads()` turns a SARIF log into leads.
- `lib/ensemble.mjs` `mergeStatic()` merges leads from two or more engines. A
  spot two engines agree on is marked `corroborated` and ranks first.
- `lib/event.mjs` `event()` writes one run event.

Use these. Do not write a second Docker runner or SARIF parser in a pack.

## Fleet runs

`agent-run.mjs` adds `lib/fleet.mjs` beside the pack extension by default.
The root conversation coordinates trusted T1 children. Each child gets the
same model and pack tools, plus `message_agent`, `bulletin_post`, and
`bulletin_read`. Only the root gets `spawn_agent`.

- `spawn_agent({name, task, area})` starts one child in a background-owned
  conversation. Use one clear angle per child. `FLEET_MAX` caps the number
  of children in the run. The default is eight. The coordinator sizes the
  fleet to the scope within that cap.
- `message_agent({to, text})` accepts a child name, child id, or
  `coordinator`. It steers a busy child and starts a new turn for an idle
  or failed child. To retry, message the same child. To reassign, read its
  task from `bulletin_read` and send that task to another child.
- `bulletin_post({text, kind, severity?, tags?})` saves a note or lead.
  All current authors are T1, so all posts use the trusted lane.
  `bulletin_read()` returns the posts and the child roster with tasks.
- The roster, posts, delivery tasks, and child conversations are stored in
  pi-durable. A follow-up can reopen them from the run's SQLite session.
  Child failures produce `subagent-done` with plain error text. They do
  not throw into the coordinator.

`lib/event.mjs` is still the only event writer. Fleet wrappers use the tool's
`api.conversationId` to set its async-local child tag. They do not depend on
the spawn call's async context. The provider uses each conversation's saved
session id to tag its spend and budget events. Child cognition watches the
child's `LiveDoc`; spend snapshots watch its `UsageDoc`.

Children share the pack state and workspace. Pack tool calls run one at a
time so two proofs cannot overwrite the same file. Child model calls and
fleet messages can run in parallel. Reports are drained before the worker
emits `settled` or replays findings. Fleet cognition uses durable generation
task ids for `attempt`, so retries do not replace an earlier answer.

All responses, including child responses and failed attempts, go through
the same `budgetedApi` and `createRunBudget`. Usage snapshots do not charge
the budget a second time. The budget is checked between provider calls.
Responses already in flight can exceed the amount left when they started.

The operator picks Fleet or Solo for each app run.

- `FLEET=1` is a fleet run. The coordinator gets a plan step. After six pack
  tool calls without a spawn, pack tools refuse the coordinator's calls until
  it calls `spawn_agent`. Children are never gated.
- `FLEET=0` is a solo run. It omits the fleet extension, wrappers, and
  coordinator prompt.
- Unset keeps the fleet tools and leaves spawning to the model. Runs started
  before the choice existed, and CLI runs, use this.
The original single-agent pack path remains in place. No T2 worker or new
proof bypass is part of this implementation.

Run the focused runtime checks with:

```sh
node --test spike/test/fleet.test.mjs
```

## Proof kinds

| Kind       | A finding is real when…                                             | Modules |
|------------|----------------------------------------------------------------------|---------|
| `forge`    | its Foundry test replays green offline and shows the harm.           | Contracts, Keys and signing, Chain watch |
| `http`     | its request script replays against the practice service on a private sandbox network and the oracle sees the harm. | Web and sign-in, APIs, Nodes and RPC, AI and MCP, Infra and cloud (through moto or LocalStack) |
| `evidence` | its evidence replays against a pinned snapshot and the check still holds. | Supply chain and secrets, Domains and front end, Surface, People and brand |

Only `forge` exists today. The first pack that needs `http` or `evidence`
builds that replay in `lib/` so the other packs can share it.

## Integration research (TOOLS.md)

The market research is in `research/harness/sections/03-capabilities.md`
(M1–M27), `04-crypto-coverage.md`, and the gap notes in `07-*`. It names the
tools. It does not say how to plug each one in. Before a pack wraps a tool, fill
one row per tool:

| Column    | What to record |
|-----------|----------------|
| Tool      | Name and upstream repo. |
| License   | SPDX id. Flag AGPL, GPL, BSL and "non-commercial". |
| Runs as   | Docker image and tag, or a pinned binary. Record its size. |
| Offline   | Yes, or what it must reach. |
| Input     | What it reads (repo, URL, image, config). |
| Output    | JSON, SARIF, or text. Name the flag. |
| Lead      | How one result maps to our lead shape (check, impact, where, detail). |
| Proof     | Which proof kind turns a lead into a finding, and the oracle. |
| Overlap   | Other tools that find the same thing. Run them on the lab. Pick one, or merge them as an ensemble. |
| Lift      | What we take besides the binary: rule packs, detectors, prompts, workflows, report shapes. Name the license. |
| Crypto gap | What it misses for crypto targets, which we add as our own check. |
| Verdict   | `wrap`, `ensemble`, `read only`, or `skip`, with one reason. |

The `Crypto gap` column is the reason Touchstone exists. The union of the
`wrap` rows and the `Lift` column is our coverage of the open-source market.
The `Crypto gap` rows are what we add on top. The goal is a superset of the
open-source market, packaged for crypto teams.
