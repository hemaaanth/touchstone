# Build sequence — Touchstone console rebuild

Status: spec. Ordered, dependency-first task list synthesized from
`docs/plan/engine.md` (engine/events), `docs/plan/elements.md` (Element installs),
`docs/plan/integration.md` (component tree + reducer). The implementer (main agent) follows
this top to bottom. **LOCAL commits only** at each boundary below — the owner holds all
pushes. No dep upgrades, no `bun add` beyond what `shadcn add` pulls (all satisfied).

---

## 0. Resolve these cross-spec conflicts BEFORE writing code

The three specs disagree on the event wire format. **engine.md is canonical** (it is the
superset: multi-subagent, `conv`-routed); integration.md's shapes are the single-agent
subset and must be reconciled to engine.md, NOT implemented as-is. Decisions the implementer
must lock first (write them into `lib/types.ts` as the one source of truth):

| Concern | engine.md (CANONICAL) | integration.md (reconcile away) | Decision |
|---|---|---|---|
| Streamed prose | `assistant-delta {conv,task,attempt,delta,len}` | `assistant-delta/-done {seq,text}` | Use engine.md fields. Key by `conv` (not `seq`); derive a `say` Step per `conv`+`attempt`. Drop `-done`; generation-end clears `generation` → freeze Step. |
| Streamed thinking | `thinking-delta {conv,...}` | `reasoning-delta/-done {seq,tokens}` | Use `thinking-delta`; `reasoning` StepKind keyed by `conv`+`attempt`. |
| Subagents | `subagent-spawned {conv,task,area,model,parent}` + `agent-graph` snapshot + `subagent-done {conv,area,status,findings}` | `subagent {id,label,kind}` + `subagent-done {id,status,summary}` | Use engine.md. `SubagentList` joins `agent-graph` nodes to `subagent-spawned` by `conv`. |
| Steering | `steer-pending {id}` → `operator-message {id,state:"admitted"}` → `steer-rejected {id}` | reconcile by `text`, event `steer-error` | Use engine.md: reconcile by **`id`**, rejected event is **`steer-rejected`**. |
| Findings/approval | `submit_finding` de-blocked → auto `finding {id,conv,...,proven}`; `approval-pending` manual-gate-only | ProofCard `pending→approval-decided→recorded`; `awaiting-approval` status | **Auto-record** path is default. ArtifactCard pending(amber)→proven(green) now flips on the `finding` event, not `approval-decided`. Keep `approval-*` reducer cases for manual-gate mode but don't gate the run. |
| Run terminal | `run-complete {status,summary,usage,reports}` (replaces `settled`) | `live = !state.closed`; `closed` event | Emit BOTH: `run-complete` carries terminal status; host still sends `closed` once. `live = !!state && !state.closed`. |
| Element source | install stock base Elements into `components/assistant-ui/elements/*` (surfaces-based) | build our own `@/components/ui/*` Elements in `run/*`,`findings/*` | **Both, layered:** stock base Elements are headless/surfaces-only (NOT the pre-styled kit AGENTS.md forbids) — install them as the primitive, then our `run/*`/`findings/*` wrappers adapt our data to them. If a stock element's look fights base-nova, wrap don't fork. |

Gaps to accept (do not invent behavior): no native checkpoints (`checkpointWhen:()=>false`)
→ `checkpoint-history` is read-only, **no `onRestore`**; no native handoff → `agent-handoff`
is derived context, labeled as such; `subagent-list` doubles as module strip only if no real
subagents are live. Multiple findings per run needs additive `FindingSummary.runId` /
`Finding.runId` in `server/findings.mjs`.

---

## Phase 1 — Shim + CSS + helpers (must land first; blocks every compile)

Per elements.md §0.3/§0.4/§0.8. These are the single blocking setup:

1. `app/src/lib/utils.ts` → `export { cn } from "cn"` (bridges the `@/lib/utils` alias the
   generated elements import). Do NOT rewrite elements to import from `"cn"`.
2. `app/src/index.css` → add `@import "tw-shimmer";` after `@import "tailwindcss";`.
3. `app/src/lib/format.ts` → add additive `elapsed(startedAt, now?)` helper.

**COMMIT 1:** `chore(app): cn shim, tw-shimmer import, elapsed() helper`

---

## Phase 2 — Element installs (no source changes; pure scaffolding)

Per elements.md §1. Install by **full `/base/` URL** (the `@assistant-ui` alias 404s for 6
of 9). Shared registries first, then leaves, in this exact order:

```
elements-surfaces, elements-range,
elements-agent-status, elements-tool-group, elements-artifact-card, elements-agent-handoff,
elements-background-inbox, elements-checkpoint-history, elements-canvas-split,
elements-subagent-list, elements-conversation-map
```

Lands files under `src/components/assistant-ui/elements/*` + `utils/{range,useIsomorphicLayoutEffect}`.
`thread-list-sidebar` has NO registry item — build the run list from headless
`ThreadListPrimitive` later (Phase 6), do not chase the 404. Verify each file compiles
against the Phase 1 shim; zero `bun add` expected.

**COMMIT 2:** `chore(app): install assistant-ui base elements (surfaces+9)`

---

## Phase 3 — Engine: events + orchestrator (engine.md)

Additive EVENT lines only; `event()` and the `runs.mjs` `pipeEvents` contract are unchanged.
Split into coherent commits:

3a. **Streaming cognition** — `agent-run.mjs`: `streamCognition(harness, conv)` watching
   `LiveDoc.generation.message`, emitting `assistant-delta` / `thinking-delta`. Wire the root
   watcher into the worker lifecycle.
   **COMMIT 3a:** `feat(engine): stream assistant/thinking deltas via LiveDoc watch`

3b. **Orchestrator + subagents** — new `spike/lib/orchestrator.mjs` (`Findings` doc,
   `spawn_subagent` tool, `orchestratorExt`); install alongside `contracts` in `openHarness()`.
   `streamTaskGraph` emitting `agent-graph` + per-new-conv `streamCognition`. Emits
   `subagent-request/-spawned/-done`.
   **COMMIT 3b:** `feat(engine): orchestrator + task-owned subagents, agent-graph events`

3c. **Multi-finding lifecycle** — de-block `submit_finding` (auto-record into `Findings`,
   emit `finding`); replace the single-shot `root.submit(...).wait()` lock with
   `root.waitForIdle` + `run-complete`; host mirrors ledger items to session `finding` events.
   **COMMIT 3c:** `feat(engine): de-block submit_finding, multi-finding run-complete lifecycle`

3d. **Steering two-phase** — `steer-pending`→`operator-message{id,state}`→`steer-rejected`,
   id-tagged. `runs.mjs` relays new EVENT names verbatim; add `run-complete`→terminal status
   mapping and additive `runId` on `FindingSummary`/`Finding` in `server/findings.mjs`.
   **COMMIT 3d:** `feat(engine): id-tagged two-phase steering + relay new events, finding.runId`

(No app run here — engine is headless. Sanity-check by tailing an events file from a spike run
if one is cheap; otherwise defer verification to Phase 4+ where the UI consumes the events.)

---

## Phase 4 — Reducer + types (integration.md §4d/§6, engine.md §reducer impact)

The seam between engine and UI. Do before any UI so components have real state to read.

4. `lib/types.ts` — new `StepKind: "reasoning" | "say"`; `RunState.activity:
   "thinking"|"working"|"typing"|"idle"`; `FindingSummary.runId`/`Finding.runId`;
   `AgentNode` type for `agent-graph`; subagent/finding event field types.
5. `lib/runModel.ts` — handle `assistant-delta`/`thinking-delta` (append to open Step by
   `conv`+`attempt`, reset on attempt change / generation end), `agent-graph` (replace node
   map snapshot), `subagent-spawned`/`-done`, `finding`, `steer-pending`/`steer-rejected`,
   `run-complete`, `operator-message{id}` reconcile. Set `activity` from last delta kind.
   `buildMessages`: `say`→`{type:"text"}`, `reasoning`→`{type:"reasoning"}`.
6. Unit-sanity: feed a captured `.events` file (e.g. `spike/results/agent/run-ds-abl-*.events`)
   through `reduceEvents` in a scratch script; confirm no throw and status progression is sane.

**COMMIT 4:** `feat(app): reduce streaming/subagent/finding/steer events into RunState`

---

## Phase 5 — UI, center column (integration.md §4). ONE commit per coherent step.

> **PER-UI-STEP REMINDER (MANDATORY, every step 5–8):** after writing each step, the
> implementer MUST `bun run dev`, open the app via **bb-browser**, drive the real run flow,
> and VISUALLY inspect: dark-by-default holds; green appears ONLY on proven findings
> (`finding.proven`/`step.state==="pass"`/`recorded`); restraint + progressive-disclosure
> (low-signal steps folded); no layout break at <1280px. Then SELF-CRITIQUE in writing
> (what's off, what you'd cut) and fix it BEFORE presenting to the owner. Do not present an
> unrun UI step.

5a. `run/message-parts.tsx` — extract `StepPart`/`PocRow`/`ProofCard` from `run-chat.tsx`,
   add `ReasoningPart` (collapsible, `Loader2` while open) + `SayPart` (trailing `▍` caret
   while streaming). Shared by thread + timeline. **Inspect + critique. COMMIT 5a.**
5b. `run/run-top-bar.tsx` (title only — drop blurb/kind/pill/alias) + `run-chat.tsx` live/status
   fixes: `live = !!state && !state.closed`; `status = state.events.length>0 ? state.status :
   run.status` (kills the "Starting" flash and the one-finding composer lock).
   **Inspect + critique. COMMIT 5b.**
5c. `run/agent-status.tsx` (AgentStatus Element; `statusToAgentState` guard: only `recorded`→
   `done`), `run/tool-group.tsx` (fold `list/read/scan/note`, keep PoC rows full-width),
   `run/agent-handoff.tsx` (derived, labeled). **Inspect + critique. COMMIT 5c.**
5d. `run/steering-chip.tsx` + composer flow: optimistic `steer-pending` chip reconciled by
   `id` to `operator-message`, `steer-rejected`→red+retry. **Inspect + critique. COMMIT 5d.**
5e. `run/subagent-list.tsx` (join `agent-graph`+`subagent-spawned` by `conv`),
   `run/conversation-map.tsx` (hidden <1280px/<12 steps), `run/checkpoint-history.tsx`
   (read-only, NO `onRestore`). **Inspect + critique. COMMIT 5e.**

---

## Phase 6 — UI, shell + findings rail (integration.md §2/§3/§5/§7)

6a. `run/run-workspace.tsx` — wraps `RunChat` + per-run `RunArtifacts`; rewrite `App.tsx`
   (drop global `findings`/`FindingsPanel`, add `inbox` set, render `RunWorkspace key=run.id`).
   **Inspect + critique. COMMIT 6a.**
6b. Findings rail: `findings/run-artifacts.tsx` + `artifact-card.tsx` (ArtifactCard;
   pending amber → proven green on the `finding` event), `lib/useRunFindings.ts`
   (`f.runId===runId`). Delete `findings-panel.tsx`. **Inspect + critique. COMMIT 6b.**
6c. Finding detail: re-port `lib/explanation.ts`, `lib/highlight.ts`, `findings/bits.tsx`,
   `run-timeline.tsx`, `pipeline-strip.tsx`, `replay-proof.tsx`, `finding-detail.tsx` (onto
   `@/components/ui/*`), opened in `findings/canvas-split.tsx` (Sheet <1280px / split pane
   ≥1280px; `saved`↔`finding.proven`). **Inspect + critique. COMMIT 6c.**
6d. Sidebar rebuild: `sidebar/app-sidebar.tsx` (+ `scopes-group.tsx`, `runs-group.tsx`,
   `background-inbox.tsx` via `ThreadListPrimitive`/`ui/sidebar`); delete old
   `components/app-sidebar.tsx`. **Inspect + critique. COMMIT 6d.**

---

## Risks (watch throughout)

1. **Event-vocabulary drift (highest).** engine.md and integration.md describe the same
   features with different field names/keys. If the reducer and the engine are built from
   different specs the stream silently no-ops. Lock the Phase 0 table into `types.ts` first;
   build engine and reducer against THAT, not the prose.
2. **Green leaking early.** Six Elements render an emerald check on generic "done"/"ready"/
   "saved". Every adapter must map ONLY `recorded`/`proven`/`pass` to those states; every
   other terminal (`no-finding`/`denied`/`error`) → neutral/`failed`. Verify visually each
   UI step — this is the restraint invariant and the product's whole point.
3. **Orchestrator scope/cost + unverified engine.** The multi-subagent orchestrator (Phase 3b)
   is the biggest, least-reversible change and runs headless, so bugs only surface in Phase 5+.
   Guard: cap `MAX_SUBAGENTS` (default 3, keeps the NEAR `guard()` cap), dedup child creation
   via the `child:<area>` memo (idempotent replay), and validate 3a/3c against a captured
   `.events` replay before relying on live UI inspection.
