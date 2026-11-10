# assistant-ui Elements — port + data-contract spec

Scope: port the nine assistant-ui **base** Elements into the Touchstone console
(`app/`, React 19 + Vite + Tailwind 4 + TS 7, shadcn `base-nova` on
`@base-ui/react`, assistant-ui `ExternalStoreRuntime`). This file is the install
plan and, per element, the exact API + how it binds to **our** data
(`RunState` / `Step` / `Finding` / `RunSummary`). No deps are upgraded; every new
transitive dep is already in `package.json`.

Source of truth: the registry JSON downloaded to `/tmp/aui/base-<name>.json`
(`.tsx` in `files[0].content`), plus shared `base-surfaces.json` and
`base-range.json`. Our data shapes: `src/lib/types.ts`, `src/lib/runModel.ts`,
`src/lib/api.ts`. Current integration seam: `src/components/run-chat.tsx`
(`ExternalStoreRuntime`, `buildMessages`, `StepPart`) and
`src/components/findings-panel.tsx`.

---

## 0. Cross-cutting facts (read first)

### 0.1 Install URL — use the `/base/` path, NOT the `@assistant-ui` alias
`components.json` defines `registries["@assistant-ui"]` =
`https://r.assistant-ui.com/styles/{style}/{name}.json` → resolves to
`styles/base-nova/elements-<name>.json`. **That path 404s for 6 of the 9
elements** (only `agent-status`, `tool-group`, `conversation-map` have a
`styles/base-nova` variant; `agent-handoff`, `artifact-card`, `background-inbox`,
`canvas-split`, `checkpoint-history`, `subagent-list` return
`"The page could not be found"`). The reliable, consistent source — and the one
the registry's own `registryDependencies` point at — is the **full `/base/` URL**:

```
https://r.assistant-ui.com/base/elements-<name>.json
```

Add every element by full URL. Do **not** use `bunx shadcn add @assistant-ui/...`
for these.

### 0.2 Where files land
Alias `components` = `@/components`, so shadcn writes:
- elements → `src/components/assistant-ui/elements/<name>.tsx`
- shared (from `elements-surfaces`) →
  `src/components/assistant-ui/elements/surfaces.tsx` and
  `src/components/assistant-ui/utils/useIsomorphicLayoutEffect.ts`
- shared (from `elements-range`) → `src/components/assistant-ui/utils/range.ts`

Inside the elements, `surfaces` is imported relative (`./surfaces`) and range as
`../utils/range` — those resolve locally, no alias involved.

### 0.3 The `cn` shim (REQUIRED, one-time)
Every element imports `import { cn } from "@/lib/utils"` (shadcn rewrites to the
`utils` alias, which `components.json` sets to `@/lib/utils`). **We have no
`src/lib/utils.ts`** — our own `ui/*` import `cn` from the `cn` npm package
(`import { cn } from "cn"`). So before/after adding any element, create the shim
so the generated files compile:

```ts
// src/lib/utils.ts
export { cn } from "cn"
```

This is the single blocking piece of setup. (Do not rewrite the elements to
import `cn` from `"cn"` — keep them stock so future `shadcn add` re-runs are
clean; the shim bridges the alias.)

### 0.4 CSS setup (REQUIRED for shimmer)
`surfaces.tsx` (`ShimmerLabel`) and `subagent-list` use the `shimmer` /
`shimmer-bg` utilities from **tw-shimmer**, which is a Tailwind v4 CSS plugin
(`@utility shimmer`) exported as `./src/index.css`. It is in `package.json`
(`tw-shimmer@^0.4.14`) **but is not imported in `src/index.css`**. Add it:

```css
/* src/index.css — after "@import \"tailwindcss\";" */
@import "tw-shimmer";
```

`animate-in` / `fade-in` / `zoom-in` / `slide-in-from-*` are already provided by
`tw-animate-css` (line 2 of `index.css`), so no action there.

### 0.5 New npm deps — none to install
Element `dependencies` across the nine: `lucide-react` (have `^1.70.0`),
`@base-ui/react` (have `^1.9.0`, only `conversation-map`). Shared `surfaces`
pulls `tw-shimmer@^0.4.14` (have it). `range` has no deps. `class-variance-
authority` is **not** required by any of these elements (it is already a dep
regardless). **Net: zero `bun add`.** `bunx shadcn add` may still try to install
already-satisfied deps — that is fine and additive, no upgrade.

### 0.6 Which of our `@/components/ui/*` the elements need
**None.** All nine are self-contained on `surfaces` + `lucide-react` + `cn`
(+ `@base-ui/react` `PreviewCard` for `conversation-map`). They import **no**
`@/components/ui/*`. So there is **no missing ui component** to author for the
elements themselves. The surrounding integration (folding, dialogs, scroll) can
reuse what we already have: `collapsible`, `dialog`, `sheet`, `scroll-area`,
`tabs`, `button`, `badge`, `card`, `tooltip`, `separator`, `sidebar` — all
present in `src/components/ui/`.

### 0.7 Restraint guardrail (AGENTS.md / restraint.md)
One accent meaning: green **only** on a proven finding (`finding.proven` /
`step.state === "pass"` / `status === "recorded"`). Several elements render an
emerald check on their "done"/"ready"/"saved" state — when we feed them, we map
**only** `recorded`/`proven` to those states; every other terminal outcome
(`no-finding`, `denied`, `error`) maps to a neutral or `failed` state so green
never shows early. Each element section below states its specific guard.

### 0.8 One additive helper you will want
`agent-status` and `background-inbox` want a live `mm:ss` elapsed string.
`format.ts` only has coarse `ago()`. Add (additive):

```ts
// src/lib/format.ts
export function elapsed(startedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, "0")}`
}
```

---

## 1. Install plan (exact order)

Deterministic order — install shared registries first, then leaves. (shadcn
auto-resolves `registryDependencies`, so adding any leaf would pull `surfaces` /
`range` anyway; doing them first keeps the run idempotent and the console quiet.)

```bash
# 0. one-time shim + css (manual, before or after — see 0.3 / 0.4)
#    - create src/lib/utils.ts  ->  export { cn } from "cn"
#    - add  @import "tw-shimmer";  to src/index.css

# 1. shared deps (surfaces pulls tw-shimmer + useIsomorphicLayoutEffect util)
bunx shadcn add https://r.assistant-ui.com/base/elements-surfaces.json
bunx shadcn add https://r.assistant-ui.com/base/elements-range.json

# 2. leaves (surfaces-only)
bunx shadcn add https://r.assistant-ui.com/base/elements-agent-status.json
bunx shadcn add https://r.assistant-ui.com/base/elements-tool-group.json
bunx shadcn add https://r.assistant-ui.com/base/elements-artifact-card.json
bunx shadcn add https://r.assistant-ui.com/base/elements-agent-handoff.json
bunx shadcn add https://r.assistant-ui.com/base/elements-background-inbox.json
bunx shadcn add https://r.assistant-ui.com/base/elements-checkpoint-history.json
bunx shadcn add https://r.assistant-ui.com/base/elements-canvas-split.json

# 3. leaves that also use range (+ @base-ui/react for the map)
bunx shadcn add https://r.assistant-ui.com/base/elements-subagent-list.json
bunx shadcn add https://r.assistant-ui.com/base/elements-conversation-map.json
```

New deps pulled, by element: `agent-status`/`tool-group`/`artifact-card`/
`agent-handoff`/`background-inbox`/`checkpoint-history`/`canvas-split` →
`lucide-react` (+ `surfaces` → `tw-shimmer`). `subagent-list` → `lucide-react` +
`elements-range` (+ `surfaces`). `conversation-map` → `@base-ui/react` +
`elements-range` (+ `surfaces`). All already satisfied.

**thread-list-sidebar: NOT FOUND.** `r.assistant-ui.com/base/elements-thread-
list-sidebar.json` 404s (`"The page could not be found"`), and so does the
`styles/base-nova` variant. There is no such registry item. Recommendation:
**do not chase a registry name — build the sidebar from assistant-ui's headless
`ThreadListPrimitive`** (`ThreadListPrimitive.Root` / `.New` / `.Items`, and
`ThreadListItemPrimitive.Root` / `.Trigger` / `.Title` / `.Archive`) styled with
our `base-nova` classes, exactly as `run-chat.tsx` already drives
`ThreadPrimitive`. We already have `src/components/app-sidebar.tsx` on our
`ui/sidebar`; the run list there is the natural home, and `background-inbox`
(§6) covers the "running elsewhere" subset. If a styled starting point is
wanted, the closest real registry item is assistant-ui's
`@assistant-ui/thread-list` (styles path), but it drags in the pre-styled kit
AGENTS.md tells us to avoid — prefer the headless primitive.

---

## 2. `agent-status` → `AgentStatus`

- **File:** `components/assistant-ui/elements/agent-status.tsx`
- **Export + API:**
  ```ts
  export type AgentState = "working" | "waiting" | "done" | "failed"
  export interface StatusStep { state: AgentState; label: string }
  export function AgentStatus(props:
    Omit<ComponentProps<"span">, "children" | "state" | "label" | "elapsed"> & {
      state: AgentState
      label: string
      elapsed?: string | undefined
      trailing?: ReactNode | undefined
    }): JSX.Element
  ```
- **Primitives/hooks:** none (pure presentational `<span>`). lucide:
  `CheckIcon, PauseIcon, RotateCcwIcon, XIcon`. surfaces: `mono, paper`.
- **ui/* needed:** none. (Replaces the hand-rolled status pill in
  `run-chat.tsx` lines 92–96.)
- **Imports:** `cn` from `@/lib/utils` (needs §0.3 shim); `./surfaces`.
- **Data contract → ours:** drive from `RunState.status: RunStatus`.
  Adapter `statusToAgentState(s)`:
  - `starting|running|deciding` → `"working"`
  - `awaiting-approval` → `"waiting"`
  - `recorded` → `"done"` (emerald check — allowed, it is proven)
  - `error|denied|no-finding` → `"failed"`
  `label` = `statusLabel(status)` (`format.ts`). `elapsed` =
  `elapsed(run.startedAt)` (§0.8); the element hides it once state is
  `done`/`failed`. `trailing` optional — pass our own control (e.g. a re-run
  `Button`) or leave undefined for the built-in pause/rotate glyph.
  **Guard:** only `recorded` maps to `done`; `no-finding` must NOT be `done`
  (that would paint a green check on a non-finding).

---

## 3. `tool-group` → `ToolGroup`

- **File:** `components/assistant-ui/elements/tool-group.tsx`
- **Export + API:**
  ```ts
  export type GroupedToolState = "running" | "done" | "failed"
  export interface GroupedTool {
    id: string; name: string; target: string
    state: GroupedToolState; durationMs?: number
  }
  export function ToolGroup(props:
    Omit<ComponentProps<"div">, "children"|"label"|"tools"|"open"|"onOpenChange"> & {
      label: string
      tools: readonly GroupedTool[]
      open: boolean
      onOpenChange?: (open: boolean) => void
    }): JSX.Element
  ```
- **Primitives/hooks:** none; `open` is controlled by the caller (a local
  `useState`, or our `ui/collapsible` if we want its a11y). lucide:
  `CheckIcon, ChevronRightIcon, Loader2Icon, XIcon`. surfaces: `mono, paper`.
- **ui/* needed:** none required (self-folds via its own `<button>`); optional
  `ui/collapsible` if we prefer shared open-state semantics.
- **Imports:** `cn` from `@/lib/utils` (§0.3); `./surfaces`.
- **Data contract → ours:** fold a contiguous run of low-signal `Step`s
  (`kind ∈ {list, read, scan, note}`) from `RunState.steps` into one group —
  this is the progressive-disclosure fold AGENTS.md asks for, replacing the flat
  stack of `StepPart` rows in `run-chat.tsx`. Per `Step`:
  - `id` = `step.key`
  - `name` = `step.kind` (shown mono, e.g. `read`, `scan`)
  - `target` = `step.label` (e.g. `Read Vault.sol`) and `step.detail` folded in
  - `state` = `"done"` (these kinds carry no `state`); a PoC-bearing group would
    use `step.state` (`running|pass→done|fail→failed`)
  - `durationMs` = optional; compute from adjacent `RunEvent.t` deltas
    (`types.ts RunEvent.t?: number`) or omit.
  `label` = a header like `"Read 4 sources"` / `"Pre-pass scans"`.
  **Keep PoC attempts OUT of the fold** — they stay full-width `PocRow`s so the
  proven/green line is never hidden behind a collapsed group.

---

## 4. `artifact-card` → `ArtifactCard`

- **File:** `components/assistant-ui/elements/artifact-card.tsx`
- **Export + API:**
  ```ts
  export function ArtifactCard(props:
    Omit<ComponentProps<"div">, "children"|"title"|"meta"|"generating"|"words"> & {
      title: string
      meta: string
      generating?: boolean
      words?: number
    }): JSX.Element
  ```
- **Primitives/hooks:** none. lucide: `ArrowUpRightIcon, FileTextIcon`.
  surfaces: `mono, paper, ShimmerLabel` (ShimmerLabel → needs §0.4 tw-shimmer).
- **ui/* needed:** none. Lives in the **right column** (`findings-panel.tsx`),
  one card per finding — the "findings as artifact cards" IA from AGENTS.md.
- **Imports:** `cn` from `@/lib/utils` (§0.3); `./surfaces`.
- **Data contract → ours:** map a `FindingSummary`/`Finding` (`types.ts`):
  - `title` = `finding.title`
  - `meta` = e.g. `` `${finding.severity} · ${finding.module}` `` or
    `finding.proof.tool` (`"forge"`) once proven
  - `generating` = run is still live and not yet proven
    (`!finding.proven && !isTerminal(status)`); drives the `Writing…` shimmer
  - `words` = no word-count in our data — repurpose as attempt count
    (`finding.proof.runs.length`) or omit (defaults to `0`).
  **Guard:** the card body is intentionally neutral; put the proven/denied accent
  on a `ui/badge` you render in the card's `meta`/`trailing`, keyed off
  `finding.proven` / `finding.dismissed` — not on the card surface.

---

## 5. `agent-handoff` → `AgentHandoff`

- **File:** `components/assistant-ui/elements/agent-handoff.tsx`
- **Export + API:**
  ```ts
  export function AgentHandoff(props:
    Omit<ComponentProps<"div">, "children"|"from"|"to"|"reason"|"carried"|"settled"> & {
      from: string
      to: string
      reason: string
      carried: readonly string[]
      settled: boolean
    }): JSX.Element
  ```
- **Primitives/hooks:** none. lucide: `ArrowRightIcon, BotIcon`. surfaces:
  `field, mono`.
- **ui/* needed:** none.
- **Data contract → ours (SYNTHESIZED — we have no multi-agent handoff):** our
  engine is single-agent; there is no native handoff event. Two honest mappings,
  pick per surface:
  1. **Pre-pass → agent** (recommended, render once static/fuzz land): `from` =
     `staticScan.engines.join(" + ")` + `fuzzScan.engines` (e.g.
     `"Slither + Echidna"`), `to` = `run.alias` / `ModelChoice.alias` (the
     abliterated model), `reason` = `"Handing ranked suspects to the red-team
     agent"`, `carried` = top suspect `check` strings
     (`staticScan.top[].check`, `fuzzScan.top[].check`), `settled` =
     `steps.some(s => s.kind === "poc")` (agent has started acting).
  2. **Agent → host recorder** (render at proof time): `from` = model alias,
     `to` = `"Host recorder"`, `reason` = `"Exploit proven by replay — recording
     the finding"`, `carried` = `[pending.title, proof.contract,
     proof.rerunCommand]`, `settled` = `isTerminal(status)`.
  Label it in the UI as derived context, not a live agent-to-agent event.

---

## 6. `background-inbox` → `BackgroundInbox`

- **File:** `components/assistant-ui/elements/background-inbox.tsx`
- **Export + API:**
  ```ts
  export type BackgroundState = "running" | "ready" | "failed"
  export interface BackgroundRun {
    id: string; title: string; state: BackgroundState
    elapsed: string; summary?: string
  }
  export function BackgroundInbox(props:
    Omit<ComponentProps<"div">, "children"|"runs"|"onCollect"> & {
      runs: readonly BackgroundRun[]
      onCollect?: (id: string) => void
    }): JSX.Element
  ```
- **Primitives/hooks:** none. lucide: `CheckIcon, Loader2Icon, XIcon`. surfaces:
  `mono, paper`.
- **ui/* needed:** none. Best home: the **left sidebar** (`app-sidebar.tsx`) as a
  "Running elsewhere" block — the direct, native fit of all nine.
- **Data contract → ours:** map `RunSummary[]` from `fetchRuns()` (`api.ts`),
  excluding the run currently in the center column. Per `RunSummary`:
  - `id` = `run.id`
  - `title` = `run.title ?? run.alias`
  - `state` from `run.status`: `recorded` → `"ready"`;
    `starting|running|awaiting-approval|deciding` → `"running"`;
    `denied|error|no-finding` → `"failed"`
  - `elapsed` = `ago(run.startedAt)` or `elapsed(run.startedAt)` (§0.8)
  - `summary` = optional, e.g. `` `${run.severity ?? ""} ${statusLabel(run.status)}` ``
  `onCollect(id)` = select that run (swap the center column to it).
  **Guard:** the emerald "ready" check fires only for `recorded`; keep
  `no-finding` on `failed`/neutral so a settled-empty run never reads green.

---

## 7. `checkpoint-history` → `CheckpointHistory`

- **File:** `components/assistant-ui/elements/checkpoint-history.tsx`
- **Export + API:**
  ```ts
  export interface Checkpoint { id: string; label: string; at: string; files: number }
  export function CheckpointHistory(props:
    Omit<ComponentProps<"div">, "children"|"checkpoints"|"currentId"|"onRestore"> & {
      checkpoints: readonly Checkpoint[]
      currentId: string
      onRestore?: (id: string) => void
    }): JSX.Element
  ```
- **Primitives/hooks:** none. lucide: `RotateCcwIcon`. surfaces: `mono, paper`.
- **ui/* needed:** none.
- **Data contract → ours (NO native checkpoints — `agent-run.mjs` sets
  `checkpointWhen: () => false`):** do **not** invent restore semantics; the
  harness never rewrites proven state. Two honest read-only repurposings:
  1. **Exploit-attempt ladder** (recommended): `checkpoints` = `steps.filter(s =>
     s.kind === "poc")` → `{ id: step.key, label: step.label ("Exploit attempt
     N"), at: <time from RunEvent.t>, files: <1 if step.contract else 0> }`;
     `currentId` = the last/selected attempt's key.
  2. **Verdict ladder** = the four `FindingStages` stations (`hypothesis →
     reproduced → proven → accepted`) as four fixed checkpoints, `currentId` =
     the furthest reached.
  **Render WITHOUT `onRestore`** (omit the prop) so the Restore button never
  shows — nothing in Touchstone rolls back a proof. If neither mapping earns its
  place, this element is optional; flag it as "adopt only if the attempt ladder
  reads better than inline `PocRow`s."

---

## 8. `canvas-split` → `CanvasSplit*` (compound)

- **File:** `components/assistant-ui/elements/canvas-split.tsx`
- **Exports + API:**
  ```ts
  export function CanvasSplit(props: ComponentProps<"div">)            // @container shell
  export function CanvasSplitThread(props: ComponentProps<"div">)      // left rail
  export function CanvasSplitMessage(props: ComponentProps<"div"> & { speaker: "user" | "assistant" })
  export function CanvasSplitDocument(props: ComponentProps<"div">)    // right pane
  export function CanvasSplitHeader(props:
    Omit<ComponentProps<"div">, "children"|"title"> & {
      title: string; version: number; saved: boolean
      onCopy?: () => void; onClose?: () => void
    })
  export function CanvasSplitBody(props: ComponentProps<"div"> & { writing?: boolean })
  export function CanvasSplitLine(props: ComponentProps<"p"> & { heading?: boolean })
  ```
- **Primitives/hooks:** none. lucide: `CheckIcon, CopyIcon, FileTextIcon,
  XIcon`. surfaces: `field, ghostButton, mono, paper`. Uses Tailwind
  `@container` queries (`@xl:*`) — Tailwind v4 container queries are built in, no
  plugin.
- **ui/* needed:** none; optionally mount inside `ui/dialog` or `ui/sheet` for a
  focused proof view.
- **Data contract → ours:** split the **proof** view of a `Finding` — chat on
  the left, the Foundry test on the right:
  - `CanvasSplitThread` + `CanvasSplitMessage speaker=…` ← `RunState.steps`
    (operator steps = `speaker="user"`, agent steps = `speaker="assistant"`) and
    `finding.hypothesis` / `finding.explanation`.
  - `CanvasSplitHeader` ← `title` = `` `${finding.proof.contract}.t.sol` ``
    (`proof.contract` / `proof.test`), `version` = `1` (or `proof.runs.length`),
    `saved` = `finding.proven`, `onCopy` = copy `finding.proof.rerunCommand`,
    `onClose` = close the panel.
  - `CanvasSplitBody writing={!finding.proven && live}` with one
    `CanvasSplitLine` per line of `finding.proof.testSource`
    (`heading` for `contract`/`function` lines).
  **Guard:** `saved` (emerald "saved") binds to `finding.proven` only — an
  unproven draft stays "editing".

---

## 9. `subagent-list` → `SubagentList`

- **File:** `components/assistant-ui/elements/subagent-list.tsx`
- **Export + API:**
  ```ts
  export interface SubagentItem { name: string; model: string }
  export function SubagentList(props:
    Omit<ComponentProps<"div">, "children"|"agents"|"completedCount"|"progress"|"showSummary"|"summaryAgent"> & {
      agents: readonly SubagentItem[]
      completedCount: number
      progress: readonly number[]   // 0..100 per agent
      showSummary: boolean
      summaryAgent: SubagentItem
    }): JSX.Element
  ```
- **Primitives/hooks:** none. lucide: `CheckIcon, Loader2Icon`. surfaces:
  `mono, paper`. range: `pct` (needs `elements-range`). Summary bar uses
  `shimmer shimmer-bg` → needs §0.4 tw-shimmer.
- **ui/* needed:** none.
- **Data contract → ours (NO native subagents — repurpose as the module/engine
  strip):** our run fans out across independent submodules (static engines, fuzz
  engines, the red-team agent, the replay prover) — model that pipeline here.
  `deriveModules(state)`:
  - `agents` = one `SubagentItem` per active module:
    `{ name: "Static scan", model: staticScan.engines.join("+") }`,
    `{ name: "Fuzzing", model: fuzzScan.engines.join("+") }`,
    `{ name: "Red-team agent", model: run.alias }`,
    `{ name: "Foundry replay", model: proof.compiler ?? "forge" }`.
  - `completedCount` = number of modules whose step has landed (e.g. a `scan`
    step present ⇒ that module done; a passed `poc` ⇒ replay done).
  - `progress[i]` = 0..100 per module (100 when its step resolved, a mid value
    while in flight).
  - `showSummary` = `!isTerminal(status)` and `summaryAgent` = the currently
    working module (usually the red-team agent).
  Label it as the module pipeline, not literal sub-agents. Alternative narrower
  mapping: one agent per PoC attempt with `progress` from attempt/budget.

---

## 10. `conversation-map` → `ConversationMap`

- **File:** `components/assistant-ui/elements/conversation-map.tsx`
- **Export + API:**
  ```ts
  export interface ConversationMapEntry { id: string; title: string; preview?: string }
  export function ConversationMap(props:
    Omit<ComponentProps<"nav">, "children"|"onSelect"> & {
      entries: readonly ConversationMapEntry[]
      activeId?: string | undefined
      visibleIds?: readonly string[] | undefined
      onSelect?: ((id: string) => void) | undefined
      side?: "left" | "right"   // default "right"
    }): JSX.Element
  ```
- **Primitives/hooks:** React `useCallback/useRef/useState`; **`@base-ui/react`
  `PreviewCard`** (`PreviewCard.createHandle/Trigger/Root/Portal/Positioner/
  Popup`) — the only element using a base-ui primitive. range: `clamp` (needs
  `elements-range`). surfaces: `floating`. No lucide.
- **ui/* needed:** none (uses `@base-ui/react` `PreviewCard` directly; we don't
  need a `ui/preview-card` wrapper).
- **Imports:** `cn` from `@/lib/utils` (§0.3); `./surfaces`; `../utils/range`;
  `@base-ui/react/preview-card`.
- **Data contract → ours:** a minimap rail for the run transcript, sitting to the
  right of the `ThreadPrimitive.Viewport` in `run-chat.tsx`. Map
  `RunState.steps`:
  - `entries` = `steps.map(s => ({ id: s.key, title: s.label, preview: s.detail }))`
    (optionally only "major" kinds: `poc`, `decided`, `scan`, `operator`).
  - `activeId` = key of the step nearest the viewport top (track with the same
    scroll container) or the last step while live.
  - `visibleIds` = keys currently in the viewport (optional; pass `[]` to start —
    the rail still works, in-view emphasis just stays off).
  - `onSelect(id)` = scroll that step into view
    (`document.getElementById(id)?.scrollIntoView(...)`, or stamp each
    `MessagePrimitive.Root` with its step key).
  `side="left"` when mounting on the right edge so the hover card opens inward.

---

## 11. Summary checklist

1. `src/lib/utils.ts` → `export { cn } from "cn"`  **(blocks all compiles)**
2. `src/index.css` → add `@import "tw-shimmer";`  **(blocks shimmer render)**
3. (optional) `src/lib/format.ts` → add `elapsed()` helper
4. `bunx shadcn add` the two shared + nine element `/base/` URLs, in §1 order
5. No `bun add` — every dep (`lucide-react`, `@base-ui/react`, `tw-shimmer`) is
   already present; no upgrade.
6. No new `@/components/ui/*` — elements are self-contained.
7. `thread-list-sidebar`: no registry item exists; build from headless
   `ThreadListPrimitive` on our `ui/sidebar` (`app-sidebar.tsx`).
8. Elements needing synthesized/repurposed data (no native source): `subagent-
   list` (module strip), `agent-handoff` (pre-pass→agent or agent→recorder),
   `checkpoint-history` (attempt/verdict ladder, no restore). Native-fit
   elements: `agent-status`, `background-inbox`, `artifact-card`, `canvas-split`,
   `tool-group`, `conversation-map`.
</content>
</invoke>
