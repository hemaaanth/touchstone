# Console integration + component tree

Target: `app/src/` (React 19 + Vite + Tailwind 4, shadcn base-nova on `@base-ui/react`,
assistant-ui `ExternalStoreRuntime`). Dark by default. UI only from `@/components/ui/*`,
`cn` from `"cn"`. No dep upgrades. This spec is the plan; it edits no source.

Reading sources: `App.tsx`, `run-chat.tsx`, `app-sidebar.tsx`, `findings-panel.tsx`,
`page-stub.tsx`, `new-run-dialog.tsx`, `lib/{runModel,api,format,types}.ts`, the engine
`spike/agent-run.mjs`, the relay `app/server/runs.mjs`, the owner note
`docs/ui-direction.md`, and the deleted `FindingDrawer.tsx` / `ReplayProof.tsx`
(recovered from `8d928a4^`).

---

## 1. The whole tree

```
App                                         (App.tsx — rewritten)
└─ SidebarProvider
   ├─ AppSidebar                            (components/sidebar/app-sidebar.tsx — rebuilt)
   │  ├─ SidebarHeader      → brand + <NewRunDialog> trigger
   │  ├─ ScopesGroup        → configured scopes (demo / local / brief)   [ui-direction]
   │  ├─ RunsGroup          → runs list, grouped Live / Settled
   │  ├─ BackgroundInbox    (orchestrator Element) — finished-while-away runs
   │  └─ SidebarFooter      → spend meter + Settings
   └─ main  (flex row)
      ├─ RunWorkspace       (components/run/run-workspace.tsx — NEW, replaces inline <main>)
      │  ├─ RunTopBar       (T3 minimal)                                  (c)
      │  ├─ CheckpointHistory  (orchestrator Element) — collapsed strip under bar
      │  ├─ RunThread        — assistant-ui Thread (the chat)
      │  │   ├─ ConversationMap (Element) — left gutter outline, long threads
      │  │   └─ Message
      │  │       └─ MessagePrimitive.Parts components={{
      │  │              Text, Reasoning, Empty, tools:{ by-name + Fallback } }}
      │  │          ├─ ReasoningPart     (agent thinking)                 (f)
      │  │          ├─ SayPart           (streamed assistant prose)       (f)
      │  │          ├─ ToolGroup (Element) — contiguous tool steps        tool-group
      │  │          ├─ AgentHandoff (Element) — mode / decide handoff
      │  │          └─ ProofCard         — live pending→proven
      │  ├─ AgentStatus (Element) — typing / thinking / working bar       (f)
      │  └─ Composer
      │      ├─ SubagentList (Element) — subagent chips as attachments
      │      └─ SteeringChip(s)   — pending steer → admitted message      (g)
      └─ RunArtifacts           (components/findings/run-artifacts.tsx — NEW)   (a)
         ├─ ArtifactCard (Element) ×N   — findings for THIS run only
         └─ CanvasSplit (Element) → FindingDetail (sheet/split canvas)    (b)
             ├─ Tabs: Conversation | Report
             ├─ RunTimeline      (read-only transcript)
             └─ ReplayProof      (proof / PoC diff / static+fuzz leads)
```

`PageStub` stays for Projects/Modules/Settings. `FindingsPanel` (the permanent
global right rail) is **deleted** — findings are now per-run (§5).

---

## 2. The 9 Elements — where each slots in

Elements are built as our own `@/components/ui/*`-based components (AGENTS.md forbids the
pre-styled assistant-ui registry). Each reads `step.state` / `finding.proven` directly so
green stays single-meaning.

| Element | File | Slots at | Fed by |
|---|---|---|---|
| **subagent-list** | `run/subagent-list.tsx` | on the `Composer` as attachment chips | new `subagent` / `subagent-done` events (§6); clicking opens that subagent's sub-thread in a `CanvasSplit` |
| **agent-status** | `run/agent-status.tsx` | between `Thread.Viewport` and `Composer` | `RunState.activity` (§6): `thinking` \| `working` \| `typing` \| `idle`, plus `isRunning` from the runtime |
| **agent-handoff** | `run/agent-handoff.tsx` | a tool-part inside `Message` | the `opened` event with `mode:"decide"` and `host-deciding` — the host→decide handoff that `reduceEvents` currently swallows |
| **tool-group** | `run/tool-group.tsx` | wraps a contiguous run of tool steps in `Message` | `reduceEvents` steps of kind `open/list/read/scan/note/poc/cap` (built on `Collapsible`) |
| **artifact-card** | `findings/artifact-card.tsx` | inside `RunArtifacts` | one `FindingSummary` (replaces `FindingCard` in `findings-panel.tsx`) |
| **canvas-split** | `findings/canvas-split.tsx` | opened from an `ArtifactCard` | holds `FindingDetail`; a `Sheet` (`side="right"`, `className="w-[min(680px,60vw)]"`) on narrow widths, an inline split pane ≥1280px |
| **conversation-map** | `run/conversation-map.tsx` | left gutter of `RunThread` (hidden <1280px / <12 steps) | `RunState.steps` reduced to section anchors (open, scan, each PoC, decide); click scrolls the `ThreadPrimitive.Viewport` |
| **checkpoint-history** | `run/checkpoint-history.tsx` | collapsed strip under `RunTopBar` | run lifecycle checkpoints: `scope` → `opened(run)` → first `run_poc` → `approval-decided` → `settled`, from `RunState` |
| **background-inbox** | `sidebar/background-inbox.tsx` | `AppSidebar`, above `SidebarFooter` | runs whose status flipped to `recorded`/`no-finding`/`error` while unfocused — tracked in `App` (§3) |

---

## 3. App.tsx data flow (rewrite)

Keep the current `useState` set (`models, targets, spend, provider, runs, view`) and the
`refreshModels` / `fetchRuns` bootstrap. Changes:

- **Drop** global `findings` + `selectedFinding` state and the `<FindingsPanel>` render.
  Findings are fetched per-run inside `RunWorkspace` (§5).
- **Keep** `onRunStatus(id,status,pending)` — still the one place `runs[]` rows update from
  the live stream — but it no longer calls `refreshFindings`. Add an `inbox` set:
  when `TERMINAL.includes(status)` and `view.id !== id`, push `id` into `inbox` for
  `BackgroundInbox`; clear on select.
- Center switch stays: `activeRun ? <RunWorkspace key={activeRun.id} run={activeRun}
  onStatus={…}/> : view.kind==="page" ? <PageStub/> : <empty/>`.
- `RunWorkspace` owns the old `<RunChat>` plus the per-run `RunArtifacts` rail, so the
  right rail lives and dies with the run (critique a).

`RunSummary.id === run.id`, and recorded findings carry `findingId === run.id`
(`runs.mjs:471`). To support **multiple findings per run** (critique e), add one additive
server field: `FindingSummary.runId` / `Finding.runId` (set in `server/findings.mjs`). The
client scopes findings by `f.runId === run.id` (§5). No other backend change.

---

## 4. The run thread (run-chat.tsx → split into run/*)

### 4a. T3 top bar (critique c) — `run/run-top-bar.tsx`
Replace the whole current `<header>` (run-chat.tsx:80–101). New bar holds **only**:
`SidebarTrigger` · `scope?.title ?? run.title ?? run.alias`. **No** blurb (drop
`scope?.blurb`), **no** `scope.kind` badge, **no** status pill, **no** alias badge. Status
now lives with findings/activity (critique c). Props: `{ title: string }`.

```tsx
<header className="flex h-12 items-center gap-2 border-b px-4">
  <SidebarTrigger />
  <h1 className="truncate text-sm font-medium">{title}</h1>
</header>
```

### 4b. Live/disabled + the "stop locking after one finding" fix (critique e)
Today `live = !isTerminal(status)` and `isDisabled: !live` (run-chat.tsx:50,63), so the
first `recorded` locks the composer. Change the live source to the stream's **`closed`**
event, which the server sends once (`runs.mjs:281,407,478`) when the agent session truly
ends:

```ts
const live = !!state && !state.closed        // was: !isTerminal(status)
```

`reduceEvents` already tracks `closed` (`runModel.ts:226`). A `recorded` finding mid-run no
longer disables the composer; the run keeps streaming and can record more findings. The
engine side (additive): keep the `run` turn open after `submit_finding` instead of
`process.exit` — but even without that, UI no longer locks on status alone.

### 4c. The "Starting" flash fix (critique d)
Root cause: `useRun` resets `events` to `[]` on run change; `reduceEvents([])` returns
`status:"starting"`, and `status = state?.status ?? run.status` (run-chat.tsx:48) trusts
that empty reduce for one tick, so a completed run flashes "Starting". Fix — trust the
stream only once it has produced events, else fall back to the (already-correct) `runs[]`
row:

```ts
const status = state && state.events.length > 0 ? state.status : run.status
```

(`run.status` is authoritative for a reopened run because `App` loads it from
`fetchRuns()`.) Complementary: have `reduceEvents` start `status` as `null` and let
`RunChat` coalesce — same effect, single line. Status is read this way everywhere
(CheckpointHistory, AgentStatus).

### 4d. Streaming: thinking / reasoning / messages (critique f)
Engine today emits only tool/stage events; `pi-durable` already streams
(`agent-run.mjs:402 stream:{timeoutMs}`). Add these **EVENT lines** (engine → `runs.mjs`
`parseEvents` → SSE verbatim, `RunEvent` shape `{t,ev,...}`):

```jsonc
{"ev":"reasoning-delta","seq":3,"text":"…partial thought…"}   // thinking stream
{"ev":"reasoning-done","seq":3,"tokens":412}
{"ev":"assistant-delta","seq":3,"text":"…partial prose…"}     // visible answer stream
{"ev":"assistant-done","seq":3,"text":"full assistant text"}
```

`reduceEvents` (runModel.ts) additions:
- new `StepKind`: `"reasoning" | "say"`. A `reasoning-delta` appends to an open reasoning
  Step keyed by `seq` (concatenate `text`); `reasoning-done` freezes it. Same for
  `assistant-delta`/`-done` → a `say` Step. Add `RunState.activity:
  "thinking"|"working"|"typing"|"idle"`, set from the last delta kind (reasoning→thinking,
  tool event→working, assistant→typing, else idle).
- `buildMessages` maps a `say` Step → `{type:"text"}`, a `reasoning` Step →
  `{type:"reasoning", text}`. `MessagePrimitive.Parts` gains a `Reasoning` slot
  (`ReasoningMessagePartComponent`, confirmed exported) rendered by `ReasoningPart`
  (collapsible, muted, `Loader2` while its Step is still open).
- `AgentStatus` reads `state.activity` + runtime `isRunning` → "Thinking…/Working…/Typing…"
  with the matching indicator (`Loader2` spin for thinking/working, a caret pulse for
  typing). Replaces the bare `empty` "Starting the agent session…" spinner.

Typing indicator inside a streaming `say`/`Reasoning` part: trailing `▍` while its Step
has no `-done`.

### 4e. Steering chip (critique g)
Flow uses the existing `steerRun` (api.ts:67) and the engine's admit-then-echo
(`agent-run.mjs:498–501`: `operator-message` on admit, `steer-error` on reject).

- `RunChat` gets `pendingSteers: {cid:string; text:string; state:"steering"|"error"}[]`.
- Composer `onNew` (run-chat.tsx:65) immediately pushes `{cid, text, state:"steering"}`
  and calls `steerRun`. On rejection (promise throw or a `steer-error` event with matching
  `text`) → `state:"error"`.
- Reconcile in `buildMessages`: a `pendingSteers` entry renders as a `SteeringChip`
  (amber, `Loader2`, "steering") trailing the thread. When an `operator-message` Step
  (runModel.ts:211) with the same `text` arrives, drop that pending entry — the chip is
  replaced by the normal user bubble the operator Step already produces. `steer-error`
  entries render red with a retry affordance; they never become messages.
- `SteeringChip` → `run/steering-chip.tsx`, props `{text, state, onRetry?}`.

Add `steer-error` to `reduceEvents` (currently unhandled) so the chip can resolve from the
stream, not just the POST promise.

---

## 5. Findings scoped to the run (critique a + b)

### `findings/run-artifacts.tsx` (replaces `findings-panel.tsx`)
Right rail that mounts **inside `RunWorkspace`**, so it is scoped to the active run and
unmounts with it. Props `{ runId, live, pending }`.

Data flow:
- `useRunFindings(runId)` (new, `lib/useRunFindings.ts`): `fetchFindings()` filtered by
  `f.runId === runId`; refetched on each terminal `onStatus` and on `approval-decided`.
- A **live** pending finding (`RunState.pending`) shows at the top as a not-yet-green
  `ArtifactCard` (amber) and flips green only when its `approval-decided` → recorded
  finding arrives (preserves the ProofCard pending→proven semantics, run-chat.tsx:264).
- Empty state: the run's own "No proven findings yet…" copy (reused from
  findings-panel.tsx:33). Header shows the run's status chip here (critique c: status
  belongs with findings), `statusLabel`/`statusTone`/`DOT` from `lib/format.ts`.

`ArtifactCard` is `FindingCard` (findings-panel.tsx:51) re-homed: `severityTone`, `DOT`,
`proven` → "Proven by replay". On click → opens `CanvasSplit`.

### `findings/finding-detail.tsx` — re-port of deleted `FindingDrawer.tsx` (critique b)
Rebuilt onto `@/components/ui/*` (the original used `@graphical`):

| original | re-port |
|---|---|
| `@graphical` `Tabs.Root/List/Tab/Panel` | `@/components/ui/tabs` `Tabs/TabsList/TabsTrigger/TabsContent` |
| `@graphical` `ScrollArea.*` | `@/components/ui/scroll-area` `ScrollArea` |
| `@graphical` `Separator` | `@/components/ui/separator` `Separator` |
| `@graphical` `ThemedIcon name=…` | `lucide-react` (`Check`, `Info`, `ArrowRight`) |
| `--space-*/--cte-*` tokens | Tailwind + shadcn vars (`text-muted-foreground`, `bg-muted`, `gap-3`, `p-4`) |
| opens as modal Drawer | opens in `CanvasSplit` (sheet/split) — review beside the thread, not a popup |

Keeps both tabs: **Conversation** (`reduceEvents(finding.events)` → `RunTimeline`,
read-only, `fetchFinding(id)` from api.ts:35 supplies `finding.events`) and **Report**
(`ReplayProof` + `DismissControl`). `fetchFinding` already returns the full `Finding`
(proof, staticScan, fuzzScan, explanation, calls, usage, events).

### `findings/replay-proof.tsx` — re-port of deleted `ReplayProof.tsx`
Same content, re-homed to shadcn: hero verdict (green only when
`finding.stages.proven && proof.pass`), **"Static analysis led here"** / **"Fuzzing led
here"** lead lists (`finding.staticScan`/`fuzzScan`, neutral, corroboration marks),
**"What the exploit moved"** (`proof.transfers` else `proof.balances`), **"Replay
logged"** / **"Replay checked"** / **"Reproduce it yourself"** (`proof.rerunCommand` +
copy), the engine **"Why it works"** explanation (code blocks), and `Collapsible` folds
for **Run details** / **Raw replay output** (replaces the deleted `Fold`).

Supporting re-ports (all deleted at `8d928a4`, recover + re-home):
- `lib/explanation.ts`, `lib/highlight.ts` — pure, recover verbatim from `8d928a4^`
  (`explanationSections`, `inlineParts`, `tokenize`; no UI deps).
- `findings/bits.tsx` — re-port `CopyButton`, `Fold`(→`Collapsible`), `Stat`, `SeverityChip`,
  `DismissControl`(→`Button`+`dismissFinding` api.ts:74), `formatNum`, `formatUsd`.
- `findings/run-timeline.tsx` — re-port `RunTimeline` (renders `Step[]`; reuse the
  `StepPart`/`PocRow` renderers already in run-chat.tsx, extracted to
  `run/message-parts.tsx` so thread + timeline share one renderer).
- `findings/pipeline-strip.tsx` — re-port `PipelineStrip` (the 4-station
  `FindingStages` ladder, types.ts:10).

---

## 6. New / changed events (summary)

All are engine `EVENT {json}` lines relayed verbatim by `runs.mjs` `parseEvents`; shape is
`RunEvent {t,ev,[k]}` (types.ts:213). Additive — no protocol break.

```jsonc
{"ev":"reasoning-delta","seq":3,"text":"…"}         // f
{"ev":"reasoning-done","seq":3,"tokens":412}         // f
{"ev":"assistant-delta","seq":3,"text":"…"}          // f
{"ev":"assistant-done","seq":3,"text":"…"}           // f
{"ev":"steer-error","text":"…","error":"…"}          // g (already emitted, now consumed)
{"ev":"subagent","id":"sa-1","label":"fuzz-triage","kind":"sandbox"}        // subagent-list
{"ev":"subagent-done","id":"sa-1","status":"done","summary":"…"}
```

Already present and consumed as-is: `scope`, `opened`, `static-scan`, `static_findings`,
`fuzz-scan`, `fuzz_findings`, `list_sources`, `read_source`, `run_poc`, `run_poc-done`,
`run_poc-capped`, `approval-pending`, `host-deciding`, `approval-decided`,
`operator-message`, `no-finding`, `status`, `closed`, `settled`.

---

## 7. Sidebar rebuild (critique d) — `sidebar/app-sidebar.tsx`

Current one is one flat Runs list + static page links. Rebuild to the `ui-direction.md`
IA, still on `@/components/ui/sidebar`:

- **SidebarHeader**: brand + `New run` button (opens `NewRunDialog`).
- **ScopesGroup** (`sidebar/scopes-group.tsx`): configured scopes (demo / local / brief),
  from `/api/scopes` (`runs-http.mjs:139`), each a `SidebarMenuButton`; add-brief affordance.
- **RunsGroup** (`sidebar/runs-group.tsx`): runs split into **Live** (`!isTerminal`) and
  **Settled**, each row = status `DOT` + title + `statusLabel · ago` (reuse current row
  markup, app-sidebar.tsx:70–91). Row status reads `runs[]`, kept live by `onRunStatus`.
- **BackgroundInbox** (§2) above the footer.
- **SidebarFooter**: spend meter (`spend`/`provider`, unchanged) + Settings link.

The flash fix (§4c) lives in `RunChat`; the sidebar row itself never flashes because it
reads the authoritative `runs[]` status, not the fresh reduce.

---

## 8. File plan

**Create**
- `components/run/run-workspace.tsx`, `run-top-bar.tsx`, `agent-status.tsx`,
  `tool-group.tsx`, `agent-handoff.tsx`, `subagent-list.tsx`, `conversation-map.tsx`,
  `steering-chip.tsx`, `message-parts.tsx` (extract `StepPart`/`PocRow`/`ProofCard` +
  new `ReasoningPart`/`SayPart`), `checkpoint-history.tsx`
- `components/findings/run-artifacts.tsx`, `artifact-card.tsx`, `finding-detail.tsx`,
  `replay-proof.tsx`, `canvas-split.tsx`, `run-timeline.tsx`, `pipeline-strip.tsx`,
  `bits.tsx`
- `components/sidebar/app-sidebar.tsx`, `scopes-group.tsx`, `runs-group.tsx`,
  `background-inbox.tsx`
- `lib/explanation.ts`, `lib/highlight.ts`, `lib/useRunFindings.ts`

**Edit**
- `App.tsx` — drop global findings/`FindingsPanel`; render `RunWorkspace`; add `inbox`.
- `lib/runModel.ts` — `reasoning`/`say` StepKinds, `activity`, `steer-error`, handoff step.
- `lib/types.ts` — add `runId` to `FindingSummary`/`Finding`; `RunState.activity`;
  reasoning/assistant event fields are open via the `[k]:unknown` index.
- `lib/format.ts` — (optional) an `activityLabel()` helper.
- `components/run/run-chat.tsx` — becomes the thread body only (header/live/status fixes).
- `server/findings.mjs` + `server/runs.mjs` — additive `runId`; relay new EVENT names.
- `spike/agent-run.mjs` — emit reasoning/assistant/subagent deltas; keep `run` turn open
  after `submit_finding`.

**Delete**
- `components/findings-panel.tsx` (replaced by `findings/run-artifacts.tsx` + per-run scope).
- `components/app-sidebar.tsx` (moves to `components/sidebar/app-sidebar.tsx`).

Restraint holds throughout: renderers read `step.state` / `finding.proven` /
`finding.stages.proven`; green appears only on a replay-proven PoC, never from assistant-ui
generic running/done status.
