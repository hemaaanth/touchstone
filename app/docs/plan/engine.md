# Engine changes: orchestrator, streaming cognition, multi-finding, task graph

Status: spec. Target files: `spike/agent-run.mjs` (the engine worker), `spike/lib/*`
(new `orchestrator.mjs`), `app/server/runs.mjs` (SSE bridge). Nothing here upgrades a
dependency; every call is against the real `@earendil-works/pi-durable` API as read from
`spike/node_modules/@earendil-works/pi-durable/dist/harness/*.d.ts` and `types.d.ts`.

The engine today runs ONE agent on the reserved root conversation, blocks the whole
worker on a single `root.submit({ requestId: "run1" }).wait()`, and only ever surfaces
tool-call events. This spec turns it into an **orchestrator + task-owned subagents** that
stream their reasoning, surface several findings per run, keep accepting steering, and
expose the subagent graph — all as new `EVENT` lines the existing `pipeEvents`/`broadcast`
path in `runs.mjs` already forwards verbatim to the browser.

Everything below keeps the worker's existing contract with `runs.mjs`: one
`console.log("EVENT " + JSON.stringify({ t, ev, ... }))` per step, plus the events file.
`event()` in `agent-run.mjs` is unchanged; we only add new `ev` names and one new consumer
loop. The reducer in `app/src/lib/runModel.ts` is extended to match (separate UI spec).

---

## 0. Shapes we build on (verified against the `.d.ts`)

- `ToolExecutionApi` (one tool invocation) exposes: `taskId`, `conversationId`, `callId`,
  `agent(ctx)`, `commit(change, ctx, opts?)`, `memo(name[, candidate], ctx)`,
  `createTask(task, input, Omit<TaskOptions,"conversationId">, ctx)`,
  `getTask(id, ctx)`, `waitForTask(id, ctx)`, `conversation(id, ctx) → ConversationHandle`,
  `executeTool(name, args, ctx, opts?)`, plus `watchDoc`/`snapshot` via `DocumentObserver`.
- `Tx` (inside any `commit`): `createConversation({ ownership })`,
  `createTask(task, input, TaskOptions)`, `appendEntry`, `createSubmission`,
  `doc(token, …)`, `settleSubmission`.
- `ConversationOwnership = { kind: "ownerless" } | { kind: "task"; taskId }`. A **task-owned**
  child conversation copies the stored agent of its owner task's conversation
  (`agent.ts#createAgent`: "a new task-owned conversation copies the stored agent of its
  owner task's conversation") and gets its **own context window** (its own `pi.live`,
  `pi.agent`, transcript).
- `ConversationHandle.submit(submission, ctx) → Submission`; `Submission.wait(ctx) →
  SettledSubmissionRecord` (`status: "done" | "unanswered"`).
- `Harness.watchDoc(LiveDoc, conversationId, ctx) → DocumentWatch<LiveState>`;
  `LiveState.generation.message` is the throttled in-flight `AssistantMessage`
  (`JsonRepresentation<AssistantMessage>`), content blocks `TextContent{type:"text",text}`,
  `ThinkingContent{type:"thinking",thinking,thinkingSignature?}`, `ToolCall{type:"toolCall"}`.
- `Harness.watchTaskGraph(ctx) → WatchHandle<TaskGraph>`; `TaskGraph.tasks` is
  `Record<decimalTaskId, TaskGraphNode>` with `{ id, kind, conversationId, owner?,
  background, abortRequested, state:{status,phase,…}, conversations }`.
- `WatchHandle<T>`: `.value: T`, `.start((call,ctx)=>Promise<void>)`, `.stop()`; each
  `call` is `{ kind:"value", value } | { kind:"failed", error }` (same handle the spike
  already uses for `Approval`/`Pending`).
- `configure(tx, conversationId, change)` is exported from `pi-durable` (agent.ts) — used
  to scope a child's instructions / strip a tool inside the creating commit.
- `defineTask` is exported for the `createTask` alternative in §1.

---

## 1. Orchestrator + task-owned subagents

### 1.1 The orchestrator agent

The root conversation becomes the **orchestrator**. New extension `orchestrator`, installed
alongside `contracts` in `openHarness()`:

```js
// spike/lib/orchestrator.mjs
import { defineExtension, defineTool, configure } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

// One conversation-scoped ledger per subagent conversation: the proven findings it
// recorded. submit_finding (in the contracts extension) appends here instead of blocking.
export const Findings = defineDoc({
  kind: "app.findings", version: 1, scope: "conversation",
  initial: () => ({ items: [] }),       // items: { id, title, severity, poc, area, provenAt }
  checkpointWhen: () => false,
});

const MAX_PARALLEL = Number(process.env.MAX_SUBAGENTS ?? 3);
```

The orchestrator's `instructions` (system section) tell it: *read the brief / list sources,
split the target into non-overlapping module/areas, and call `spawn_subagent` once per area
(areas run in parallel). Do not audit code yourself; collect each subagent's findings and
write the final roll-up.*

### 1.2 The `spawn_subagent` tool — exact `ToolExecutionApi` calls

```js
const spawnSubagent = defineTool({
  name: "spawn_subagent",
  description:
    "Hand one module/area of the target to a fresh subagent with its own context window. " +
    "It inherits your tools and model, audits only that area, proves exploits with run_poc, " +
    "and records each proven finding. Returns the findings it proved. Call once per area.",
  parameters: obj({
    area: str({ description: "short label, e.g. 'withdraw/deposit accounting' or 'Vault.sol:claim'" }),
    brief: str({ description: "scoped instructions: which files/functions this subagent must audit" }),
  }),
  replay: "safe",               // idempotent via the childId memo below
  execute: async (args, api, ctx) => {
    event("subagent-request", { area: args.area, parent: api.conversationId });

    // (A) Create the task-owned child conversation in ONE commit. Owned by THIS tool's
    //     task (api.taskId), so it inherits our agent (model + contracts tools + system)
    //     and carries its own context window. Dedup across a replay with a memo.
    const childId = await api.memo(`child:${args.area}`, ctx)
      ?? await api.commit(async (tx) => {
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },   // << task-owned
        });
        // Scope the subagent: area instructions, and REMOVE spawn_subagent so a subagent
        // can never recurse into spawning more subagents.
        await configure(tx, child.id, {
          instructions: `${SUBAGENT_PREAMBLE}\nYour area ONLY: ${args.area}.`,
          modelTools: { remove: [spawnSubagent] },
        });
        return child.id;
      }, ctx);
    await api.memo(`child:${args.area}`, childId, ctx);      // remember for replay
    event("subagent-spawned", { conv: childId, task: String(api.taskId), area: args.area,
                                model: (await api.agent(ctx)).model?.modelId ?? null,
                                parent: api.conversationId });

    // (B) Submit the area task to the child and await its run via the conversation handle.
    const handle = await api.conversation(childId, ctx);     // ConversationHandle
    const sub = await handle.submit({ type: "input", content: args.brief }, ctx); // Submission
    const settled = await sub.wait(ctx);                     // SettledSubmissionRecord

    // (C) Collect every finding this subagent proved (its own Findings ledger).
    const found = await api.commit(async (tx) => {
      const d = await tx.doc(Findings, childId, { items: [] });
      return d.items;
    }, ctx);
    event("subagent-done", { conv: childId, area: args.area,
                             status: settled.status, findings: found.length });

    return {
      structuredOutput: { area: args.area, status: settled.status, findings: found },
      output: [{ type: "text",
        text: `Subagent for "${args.area}" settled (${settled.status}) with ${found.length} proven finding(s): `
            + found.map((f) => `${f.title} [${f.severity}]`).join("; ") || "none." }],
    };
  },
});

export const orchestratorExt = defineExtension({
  name: "orchestrator", tools: [spawnSubagent],
});
```

**`createTask` vs `commit+createConversation+submit+waitForTask`.** Two mechanisms exist;
we use the second because a subagent must be a *real agent run* (it uses the built-in
generation loop, tools, compaction), not a bespoke state machine:

- `commit → createConversation → handle.submit → sub.wait` *(chosen)*: the child is an
  ordinary conversation; `submit` admits a user input that starts its generation run;
  `Submission.wait` resolves `done`/`unanswered` when that run settles. This is the agent
  path, and it is what §3's multi-finding lifecycle also relies on.
- `api.createTask(SubagentTask, input, { ownership:{kind:"task",taskId:api.taskId} }, ctx)`
  then `api.waitForTask(id, ctx)`: for a *non-agent* durable child (e.g. a pure Foundry
  sweep task). `createTask` returns a `TaskId<R>`; `waitForTask` returns `SettledTask<R>`
  with the typed result. We keep `defineTask` imported for this path but do not use it for
  subagents in v1. (`api.waitForTask` is also how you would await the child's *generation*
  task directly if you read its id from the child `pi.live.run.taskId`; `sub.wait` is the
  clean equivalent and survives generation hand-over, so we prefer it.)

### 1.3 Parallelism and collecting multiple findings

- The orchestrator emits several `spawn_subagent` calls in **one tool round**. Round tools
  run in parallel by default (`ToolRegistration.executionMode` defaults to the harness
  `toolExecution`, which is `"parallel"`), so each `execute()` awaits its own child
  concurrently. **Up to `MAX_PARALLEL` (default 3)** subagents run at once; the orchestrator
  is instructed to batch areas in groups of `MAX_PARALLEL` so spend stays under the NEAR cap
  (`guard()` is unchanged).
- Each subagent writes proven findings into its own `Findings` ledger (conversation-scoped).
  The spawn tool returns them as `structuredOutput`, and the orchestrator aggregates all
  returns into its final answer. Independently, the **host** (§3/§4) also mirrors every new
  ledger item into a session-level `finding` event, so the UI's findings panel fills as
  subagents prove things, without waiting for the orchestrator's roll-up.

---

## 2. Streaming cognition (watch `LiveDoc`)

Today the UI only sees tool calls. We add a watcher per conversation that turns
`LiveState.generation.message` (the throttled in-flight `AssistantMessage`) into text and
thinking deltas. One watcher on the orchestrator conversation plus one per subagent
conversation (opened when §4's task graph first reports a new conversation id).

```js
// spike/agent-run.mjs — new: stream cognition for one conversation id
const emitted = new Map(); // key `${conv}` -> { text: number, thinking: number }

async function streamCognition(harness, conv) {
  const w = await harness.watchDoc(LiveDoc, conv, ctx); // DocumentWatch<LiveState>
  if (!w) return;
  const pump = (live) => {
    const msg = live?.generation?.message;
    if (!msg) return;
    const off = emitted.get(conv) ?? { text: 0, thinking: 0 };
    let text = "", thinking = "";
    for (const b of msg.content ?? []) {
      if (b.type === "text") text += b.text ?? "";
      else if (b.type === "thinking") thinking += b.thinking ?? "";
    }
    if (text.length > off.text) {
      event("assistant-delta", { conv, task: live.run?.taskId ? String(live.run.taskId) : null,
                                 attempt: live.generation?.attempt ?? 0,
                                 delta: text.slice(off.text), len: text.length });
      off.text = text.length;
    }
    if (thinking.length > off.thinking) {
      event("thinking-delta", { conv, task: live.run?.taskId ? String(live.run.taskId) : null,
                                attempt: live.generation?.attempt ?? 0,
                                delta: thinking.slice(off.thinking), len: thinking.length });
      off.thinking = thinking.length;
    }
    emitted.set(conv, off);
  };
  pump(w.value);
  w.start(async (call) => { if (call.kind === "value") pump(call.value); });
  return w;
}
```

Notes:
- `generation.message` is **throttled** (`settings.progress.partialIntervalMs`), so deltas
  arrive in human-sized chunks, not token-by-token — exactly what the chat wants.
- We key by `conv` and carry `task` so the UI can route a delta to the orchestrator thread
  or the right subagent panel. `attempt` lets the UI reset a partial if the provider retried
  (a new attempt restarts `message`).
- When a generation ends, `generation` is cleared and the final text lands as a committed
  assistant entry; the UI already renders those from tool/transcript events. We reset the
  per-conversation offset when `live.generation` goes absent so the next attempt starts clean.

**Event shapes:**

```jsonc
// ev: "assistant-delta"   (NEW)
{ "t": 1731200000000, "ev": "assistant-delta",
  "conv": "c-0a1b", "task": "42", "attempt": 1, "delta": " so the withdraw path…", "len": 184 }

// ev: "thinking-delta"    (NEW)
{ "t": 1731200000001, "ev": "thinking-delta",
  "conv": "c-0a1b", "task": "42", "attempt": 1, "delta": " checking reentrancy guard…", "len": 512 }
```

---

## 3. Multi-finding run lifecycle (remove the single-shot lock)

### 3.1 What goes away

- No more `root.submit({ type:"input", requestId:"run1", … })` followed by one
  `const settled = await sub.wait(ctx)` that owns the whole worker.
- No more "kill the worker at `approval-pending`, resume a `decide` child" two-phase gate as
  the *only* path. Approval becomes **non-blocking**: `submit_finding` records the proven
  finding into the `Findings` ledger and returns immediately (auto-accept, consistent with
  the app's "a proven replay records itself" model). The operator can dismiss later from the
  ledger. (The durable watch-for-approval path still exists for a future manual-gate mode,
  but it no longer blocks the run or forces a process kill.)

### 3.2 `submit_finding`, de-blocked

```js
// contracts extension, submit_finding.execute — replaces the watch/approval block
// … proven-by-replay gate against PocPassed is UNCHANGED (hard gate stays) …
const id = randomUUID();
await api.commit(async (tx) => {
  const d = await tx.doc(Findings, api.conversationId, { items: [] });
  if (!d.items.some((x) => x.poc === args.poc_contract))
    d.items.push({ id, title: args.title, severity: args.severity,
                   poc: args.poc_contract, explanation: args.explanation,
                   area: /* from agent instructions / args */ null, provenAt: Date.now() });
}, ctx);
event("finding", { id, conv: api.conversationId, title: args.title,
                   severity: args.severity, poc: args.poc_contract, proven: true });
return { output: [{ type: "text", text: `Finding recorded: ${args.title} (${args.severity}).` }] };
```

Because this no longer blocks, a single subagent thread can call `submit_finding` **several
times** (several proven findings in its area), and the orchestrator can collect findings
from several subagents.

### 3.3 New worker lifecycle (`child("run")`)

```js
// 1. Open harness, resume scheduling.
const { harness, root } = await openHarness(db, ws);
harness.resume();

// 2. Start the task-graph watcher (§4) and the orchestrator cognition stream (§2).
const graphWatch = await streamTaskGraph(harness);    // §4
const rootWatch  = await streamCognition(harness, root.id);

// 3. Kick off the orchestrator. No requestId lock; this starts the run but we do NOT
//    pin the worker's life to one submission.
await root.submit({ type: "input", content: openingBrief(ws, leadBlocks) }, ctx);

// 4. Native steering stays (see §5) — stdin JSON lines become steer submissions.

// 5. Keep the worker alive until the orchestrator's whole subtree is idle. waitForIdle
//    resolves only when this conversation AND every task-owned subagent conversation have
//    no live non-background task — i.e. the orchestrator answered and all subagents settled.
await root.waitForIdle(ctx);

// 6. Final roll-up + settle event, then close.
const s = await summarize(root);
const usage = await chargeUsage(harness);
event("run-complete", { status: "idle", summary: s, usage, reports });
await graphWatch?.stop(); await rootWatch?.stop();
await harness.close(ctx);
```

- The run **surfaces findings as they are proven** (`finding` events) while still running,
  and **keeps accepting steering** the entire time (`root.waitForIdle` does not reject new
  input; a steer with `whenBusy:"steer"` rides the live generation, a steer while idle
  queues the next run).
- `run-complete` replaces the old `settled` event's role as "the worker is done." The host
  (`runs.mjs`) maps `run-complete` to terminal status: `recorded` if any `finding` landed,
  else `no-finding`, else `error` from `reports`. (`settled` is retired for the run path; the
  manual-gate `decide` path, if ever enabled, keeps its own events.)

---

## 4. Task graph → events (`watchTaskGraph`)

One watcher drives both the **subagent list** and **per-subagent agent-status**. On the
first time the graph reports a conversation id we have not seen, we also open a cognition
stream for it (§2), so subagent reasoning streams too.

```js
async function streamTaskGraph(harness) {
  const w = await harness.watchTaskGraph(ctx);     // WatchHandle<TaskGraph>
  const seenConvs = new Set([/* root.id */]);
  const push = (graph) => {
    const agents = Object.values(graph.tasks)
      .filter((n) => n.kind === "pi.generation" || n.kind === "pi.tool")
      .map((n) => ({
        task: String(n.id),
        conv: n.conversationId,
        kind: n.kind,                               // "pi.generation" | "pi.tool" | …
        owner: n.owner ? String(n.owner) : null,
        status: n.state.status,                     // pending|running|waiting|sleeping|completing
        phase: n.state.phase,                       // e.g. "request" | "tools" | "prepare"
        background: n.background,
        abortRequested: n.abortRequested,
        blocked: n.blocked ?? null,
        done: n.state.status === "completing",
      }));
    event("agent-graph", { agents });
    // Open cognition + mark a subagent conversation the first time we see it.
    for (const a of agents) {
      if (!seenConvs.has(a.conv)) {
        seenConvs.add(a.conv);
        streamCognition(harness, a.conv);           // §2
      }
    }
  };
  push(w.value);
  w.start(async (call) => { if (call.kind === "value") push(call.value); });
  return w;
}
```

- `agent-graph` carries the **full live node set on every advance** (snapshot, not a diff),
  so the reducer just replaces its map — simplest correct thing, and the graph is small
  (one orchestrator + ≤`MAX_PARALLEL` subagents + their generation/tool tasks).
- `subagent-spawned` (§1.2, emitted by the spawn tool) carries the **human metadata the
  graph lacks**: `area` and `model`. The UI joins `agent-graph` nodes to `subagent-spawned`
  rows by `conv` to render the subagent strip with area labels, model, live phase, and a
  done tick.

**Event shapes:**

```jsonc
// ev: "agent-graph"   (NEW — full snapshot each advance)
{ "t": 1731200000002, "ev": "agent-graph", "agents": [
  { "task":"7","conv":"c-root","kind":"pi.generation","owner":null,
    "status":"running","phase":"request","background":false,"abortRequested":false,
    "blocked":null,"done":false },
  { "task":"42","conv":"c-0a1b","kind":"pi.generation","owner":"7",
    "status":"waiting","phase":"tools","background":false,"abortRequested":false,
    "blocked":null,"done":false }
] }

// ev: "subagent-spawned"   (NEW — emitted by spawn_subagent at creation)
{ "t": 1731200000003, "ev": "subagent-spawned",
  "conv":"c-0a1b", "task":"7", "area":"withdraw/deposit accounting",
  "model":"deepseek-v4.1-flash-abl", "parent":"c-root" }
```

---

## 5. Steering lifecycle (pending chip → admitted message)

The operator's steer should show instantly as a **pending "steering" chip**, then become a
normal operator message the moment pi-durable admits it into the live turn. Today only the
admitted side exists (`operator-message`, emitted after the steer submission resolves).

Two events, reconciled by a shared `id`:

```js
// spike/agent-run.mjs — stdin steering, now id-tagged and two-phase
process.stdin.on("data", (chunk) => {
  /* …line framing… */
  const id = randomUUID();
  event("steer-pending", { id, conv: root.id, text });     // (1) optimistic chip
  root.submit({ type: "input", requestId: `steer-${id}`, content: text, whenBusy: "steer" }, ctx)
    .then(() => event("operator-message", { id, conv: root.id, text, state: "admitted" }))  // (2)
    .catch((e) => event("steer-rejected", { id, conv: root.id, text,
                                             error: String(e?.message ?? e) }));             // (2')
});
```

- `steer-pending` fires the instant the operator submits — the UI renders a muted chip
  ("steering…") in the composer/transcript.
- `operator-message` now carries the **same `id`** plus `state:"admitted"`; the reducer
  replaces the pending chip with a real operator message at the exact point it landed in the
  turn (matches the current interleaving semantics, just id-reconciled).
- `steer-rejected` (renamed from `steer-error`) clears the chip with an error if admission
  failed (e.g. the run already settled). `steerRun()` in `runs.mjs` still writes one JSON
  line per message to the worker's stdin; no change there.

**Event shapes:**

```jsonc
// ev: "steer-pending"     (NEW)
{ "t": 1, "ev": "steer-pending", "id": "s-91", "conv": "c-root", "text": "focus on the fee math" }
// ev: "operator-message"  (EXISTING — now { id, conv, state } added)
{ "t": 2, "ev": "operator-message", "id": "s-91", "conv": "c-root",
  "text": "focus on the fee math", "state": "admitted" }
// ev: "steer-rejected"    (NEW — replaces "steer-error")
{ "t": 3, "ev": "steer-rejected", "id": "s-91", "conv": "c-root", "text": "…", "error": "run settled" }
```

---

## 6. Complete event vocabulary

`NEW` = introduced here; `EXISTING` = already emitted (shape unchanged unless noted);
`CHANGED` = existing name, fields added. Host = emitted by `runs.mjs`; Worker = emitted by
`agent-run.mjs`/tools. Every event is `{ t, ev, …payload }`.

### Run framing (Host)
| ev | status | payload |
|----|--------|---------|
| `scope` | EXISTING | `{ scope: TargetScope }` |
| `modules` | EXISTING | `{ modules: ModulePlan }` (via `modulesEvent`) |
| `status` | EXISTING | `{ status: RunStatus, pending?, decision?, error? }` |
| `closed` | EXISTING | `{}` |

### Pre-pass (Worker/Host)
| ev | status | payload |
|----|--------|---------|
| `static-scan` | EXISTING | `{ engines[], suspects, top[] }` |
| `fuzz-scan` | EXISTING | `{ engines[], suspects, top[], applicable }` |

### Agent session + cognition (Worker)
| ev | status | payload |
|----|--------|---------|
| `opened` | EXISTING | `{ mode: "run"\|"decide" }` |
| `assistant-delta` | **NEW** | `{ conv, task, attempt, delta, len }` |
| `thinking-delta` | **NEW** | `{ conv, task, attempt, delta, len }` |
| `run-complete` | **NEW** | `{ status, summary, usage, reports }` (replaces `settled` for the run path) |
| `settled` | EXISTING | retained only for the manual-gate `decide` path |

### Tool calls (Worker, EXISTING — now also carry `conv`)
`list_sources`, `read_source` `{file}`, `fetch_source` `{url}`, `fetch_source-done`
`{url,ok,kind,files,warmed}`, `static_findings`, `fuzz_findings`, `run_poc`
`{contract,attempt}`, `run_poc-done` `{contract,passed,failed,timedOut}`, `run_poc-capped`
`{contract,attempts}`, `submit-rejected` `{poc}`. **CHANGED:** each now includes
`conv` (the conversation that made the call) so the UI routes it to the orchestrator thread
or a subagent panel.

### Subagents + task graph (Worker)
| ev | status | payload |
|----|--------|---------|
| `subagent-request` | **NEW** | `{ area, parent }` (orchestrator asked to spawn) |
| `subagent-spawned` | **NEW** | `{ conv, task, area, model, parent }` |
| `subagent-done` | **NEW** | `{ conv, area, status, findings }` |
| `agent-graph` | **NEW** | `{ agents: AgentNode[] }` full snapshot (`task,conv,kind,owner,status,phase,background,abortRequested,blocked,done`) |

### Findings (Worker)
| ev | status | payload |
|----|--------|---------|
| `finding` | **NEW** | `{ id, conv, title, severity, poc, proven }` (one per proven, auto-recorded finding) |
| `approval-pending` | EXISTING | retained for manual-gate mode only; auto mode emits `finding` instead |
| `approval-decided` | EXISTING | manual-gate / `decide` path only |
| `host-deciding` | EXISTING | `decide` path only |

### Steering (Worker)
| ev | status | payload |
|----|--------|---------|
| `steer-pending` | **NEW** | `{ id, conv, text }` (optimistic chip) |
| `operator-message` | **CHANGED** | `{ id, conv, text, state:"admitted" }` (added `id,conv,state`) |
| `steer-rejected` | **NEW** | `{ id, conv, text, error }` (renames `steer-error`) |

### Host-synthesized terminal (Host)
`no-finding` `{final}` EXISTING; emitted when `run-complete` lands with zero `finding`s.
`error` surfaced via `status`.

### Reducer impact (for the app spec)
- `assistant-delta` / `thinking-delta` → append to the active message bubble per `conv`
  (thinking in a collapsible reasoning block; reset on `attempt` change or generation end).
- `agent-graph` + `subagent-spawned` → the subagent strip (join by `conv`; phase/status/done).
- `finding` → findings panel card (proven, green only after replay — unchanged invariant).
- `steer-pending` → pending chip keyed by `id`; `operator-message{id}` replaces it;
  `steer-rejected{id}` removes it with an error.
- `run-complete` → terminal state (`recorded` if any `finding`, else `no-finding`).
