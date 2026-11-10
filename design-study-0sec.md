# Redesign study — learnings from `0sec-labs/0` (2026-11-09)

A read-only study of [`0sec-labs/0`](https://github.com/0sec-labs/0) ("the open-source AI
security harness", MIT), our closest domain twin. Six worker threads dug distinct dimensions;
this is the synthesis. Reference paths are relative to `reference/0sec-0/`. Our paths are
relative to `app/`.

> **Why this repo.** It is in our exact category (AI security), so it is rich for BOTH design
> and product/roadmap. It ships a `@0/ui` design system, a `DESIGN.md`, a `docs/design/` set,
> a `ROADMAP.md`, and a 52KB `NEGATIVE-RESULTS.md` (what they tried and dropped).

---

## The one idea

Not decoration — **restraint plus progressive disclosure**. The reference shows a short
inventory first and pushes every heavy detail (raw payloads, logs, hashes, tool inputs) behind
one quiet one-line "disclosure" row. That single repeated primitive is what makes it read as
calm and premium. It maps directly onto the three complaints about our UI:

- **"Shows too much"** → `run.tsx` renders **nine fully-expanded sections** in a 440px panel;
  `finding.tsx` stacks every fact, hash, refuter, model list open at once.
- **"Ugly / over-complicated"** → they use **one accent color**, neutral dark surfaces, and
  separate blocks by tone + spacing, **not stacked borders and rings**.
- **"Weak sidebar / chat"** → a thin collapsible rail + a ⌘K palette over a single chat
  console; run status/controls live on the composer, not in panel chrome.

Underneath the UI, their load-bearing idea reinforces **our moat**: a finding is real **only
when a deterministic oracle reproduces it** — the model never adjudicates. We already have this
(NEAR writes the exploit, Foundry proves the drain in Docker, a human approves). We should make
"proven by replay" the single source of a green state.

---

## Design changes — do now

Effort in parens. All on our existing `@graphical` components.

1. **Rebuild `run.tsx`** (medium) — default to a live status line + Stop, at most one compact
   pending-approval card, and Result. Move Plan / Agents / ModelsUsed / Sandbox / Trace /
   Cleanup into an accordion that defaults **closed**.
   *Our files:* `src/components/app/panel/run.tsx` (RunPanel ~30-48, Sandbox 404-473, Trace 477-491).
   *Ref:* `console/tool-activity.tsx:70-100`, `console/activity-row.tsx:8-22`.

2. **One compact `ApprovalCard`** (medium) — dot + "Needs your OK" + `approval.plain` +
   Approve/Deny, keep the auto-deny timer. Hide permissions/tool-input/KeyValues behind a nested
   collapsible. Reuse in both the chat stream and run panel. Resolved approvals shrink to a
   one-line history row. This is our differentiator — it should feel like one question + two
   buttons, not a 10-row form.
   *Our files:* `run.tsx` (WaitingApproval 178-250, Raw ProofBlock 211-215); `chat.tsx`; new primitive.
   *Ref:* `console/approvals.tsx:26-62,270-286,307-313`; `transcript-turns.tsx:49`.

3. **Collapse agent work into phases** (medium) — a Graphical `Collapsible` primitive
   (grid-template-rows 0fr/1fr + `inert`, on our `--cte-*` tokens). Each phase (Reading contract
   / Writing exploit / Running in sandbox / Proving drain) is one quiet line: live status while
   running, one-line summary when done. Raw Foundry command / exploit source / full stdout sit
   behind a second "Raw details" fold reusing `ProofBlock`. **Single biggest lever on
   information burden.**
   *Our files:* `src/components/app/chat.tsx` (AgentTurn 50-65); `src/lib/words.tsx`; new
   `graphical/collapsible`; add a canonical block to `src/screens/Kit.tsx`.
   *Ref:* `packages/ui/src/components/disclosure.tsx:4-27`; `console/tool-activity.tsx:14-31,45-63`.

4. **`finding.tsx` collapse** (medium) — default shows only verdict + why + Where + Accept. Fold
   Refuter, History, and the hashes/models/retention parts of Evidence (split Evidence into
   "Proof" default + "Files & hashes" + "Models"). Group Accept / Copy-fix / Report into one
   sticky action cluster.
   *Our files:* `src/components/app/panel/finding.tsx` (137-251, Accept 150-161, Refuter 204-212,
   History 214-229, Evidence 371-417).
   *Ref:* `finding-workflow-board.tsx:248-295`; `findings-page.tsx:636-760`; `evidence-tabs.tsx:13-48`.

5. **Findings → Review queue** (medium) — a Tabs header `Review / All / Board`. Review = findings
   whose machine verdict is Proven awaiting human Accept (`finding.tsx:130 canAccept`) and is the
   default landing view. Keep the current flat table as "All". Move the four always-on filters
   into a Sheet behind a "Filters" button with a count badge; echo active filters as removable Tag
   chips; add one free-text search; persist filter state.
   *Our files:* `src/screens/Findings.tsx` (table 74-200, filters 82-115). Reuse `Tag` from `blocks.tsx`.
   *Ref:* `pages/findings-page.tsx:406-477,479-558`; `finding-workflow-board.tsx:63-156`.

6. **Restraint spec in `GUI.md`, enforced in `AGENTS.md`** (small) — ONE reserved accent role
   (`--cte-accent`) for a single meaning (active attack / primary CTA); **red reserved strictly
   for confirmed findings**; neutral-only dark surfaces; separation from `--neutral-*` surface
   steps + `--space-*` gaps using our `divide-*` inset-shadow utilities **instead of real
   borders**; a single focus-ring; a one-row role-named radius table (control/menu/panel). Audit
   `components/graphical` for hardcoded hex; route every color through `--cte-*`/`--color-*`.
   *Our files:* `GUI.md`; `AGENTS.md`; `src/index.css` (radius 26, @theme 32-52, divide/focus 110-124).
   *Ref:* `packages/ui/src/styles/tokens.css:3-6`; `DESIGN.md:7-13,15-26,41-55`; `styles.css:258-287`.

7. **One status enum = proof is the only green** (medium) — `hypothesis | reproduced | approved`
   drives all badge colors. Deterministic Foundry replay is the ONLY path to `reproduced`/green,
   in both UI and durable store. Un-replayed model output renders as a distinct, non-green "lead".
   Severity stays explicitly unassessed until separately established.
   *Our files:* `src/lib/answer.ts` (verdictLabel); `src/lib/tones.ts`; `Findings.tsx` (165-172);
   `finding.tsx`.
   *Ref:* `0verse/ROADMAP.md:100-105,271-275`; `0verse/docs/EVAL-GROUNDTRUTH.md:29-43`.

8. **Anti "silent zero" pipeline-health record** (small) — attach to every run: sandbox booted?
   model answered? Foundry compiled? exploit executed? Surface as a chip. **Never** render a
   reassuring "no vulnerabilities / clean" unless all stages provably ran — degraded stages show
   "inconclusive — sandbox did not run", not "safe". Their most-cited failure: it bit them **six
   times in four days**.
   *Our files:* `run.tsx` + run model; `Settings.tsx`.
   *Ref:* `0verse/AGENTS.md` failure table; `docs/runtime-verifier.md:75-88`.

---

## The shell / sidebar / chat (what the owner loves most)

Our shell already has the right bones — `Rail`, `TopBar`, `PanelHost`, hash router with `?panel`.
Gaps: the Rail lacks collapse/search, there is **no command palette at all**, and `TopBar`
carries heavy always-on info. Ordered by leverage:

- **⌘K command palette** (large, **highest leverage**) — build one (cmdk-style) indexed off
  `lib/route.ts` ROUTES + fixtures (AUTOMATIONS, PROJECTS, open findings, live runs, scope
  proposals). Wire ⌘K + bare "/" in `App.tsx`, dispatching to `window.location.hash` /
  `openPanel()` (`route.ts:72-81`). Make it context-aware off `useRoute()`/`usePanel()`: a finding
  panel open → surface Accept / Dismiss / Investigate. **This is what lets us thin the TopBar** —
  everything stays one keystroke away.
  *Ref:* `components/command-palette.tsx:148-345`; `components/app-search.ts:1-28`; `operations-app.tsx:39-70`.

- **Thin `TopBar`** (medium) — today it always renders project, scope text, Ceiling/Run-mode tag,
  Needs-you count, Spend, Health, and Stop-all. Reduce to the essential always-on safety controls
  (**Stop all**, one Needs-you count). Move Spend (`TopBar.tsx:105-127`), Health (129-160),
  scope/ceiling into (a) palette actions/status rows and (b) the rail project/host dropdown.
  *Ref:* `navigation-rail.tsx:89-108`; `DESIGN.md:31-34`.

- **Rail pin/hover-collapse** (medium) — persisted `collapsed` flag; switch `App.tsx` grid to
  `[56px_1fr]` when collapsed; render an absolutely-positioned overlay on hover so main never
  reflows; labels get `aria-hidden` + opacity-0 in compact mode; keyboard toggle. Content stays
  mounted.
  *Ref:* `navigation-rail.tsx:22-47,49-51,73-78,92-101`.

- **Reorder Rail zones** (small) — New-chat + Search trigger pinned at TOP (above the 5 places);
  live Running list (`Rail.tsx:60-80`) moves into a scrolling `flex-1` middle; Settings/Kit/
  switches stay in the `mt-auto` bottom zone. No new router.
  *Ref:* `navigation-rail.tsx:62-110`; `app-shell.tsx:30-46`.

- **Project switcher doubles as host/health** (small) — extend `ProjectSwitcher`
  (`Rail.tsx:106-138`) with a status dot (reuse our `Dot` blocks) so it carries the sandbox/health
  signal pulled out of TopBar; collapse to icon-only in compact rail.
  *Ref:* `components/backend-connection-picker.tsx:11-35`.

- **Composer owns run status** (medium) — Send becomes Stop while a run is live, with a one-line
  status strip above ("Running step 3" / "Waiting for your OK" / "Worked for 12s"). Model/mode as a
  small ghost-button bar. Transcript stays permanent so run noise never pollutes the record.
  *Our files:* `chat.tsx` (Composer 80-114, Agent-time 53-55); `run.tsx` (StopRun 141-173).
  *Ref:* `console/conversation.tsx:255-273`; `turn-timeline.tsx:8-41`.

- **PanelHost "well attached" feel** (medium) — do NOT adopt Dockview. Borrow the feel: add a
  subtle enter/exit transform to the `PanelHost` aside (translateX + opacity, 190ms, respect
  reduced-motion) and persist the last-open panel. Graduate to a 2-slot split later if we want
  side-by-side runs+findings.
  *Ref:* `console/dock-workspace.tsx:58-120` (FLIP); our `PanelHost.tsx:24-40`.

- **Shared `PageHeader` + one 1600px canvas** (small) — route all six screens through one
  PageHeader + PageContent so titles/actions/gutters are identical; kills per-screen layout drift.
  *Ref:* `components/page-header.tsx:5-34`.

- **Quiet activity language** (medium) — cap "agents working" avatar stacks at 3 + "+N"; animate
  only in-progress steps, freeze completed; neutral (non-red) ring meter for sandbox/token budget;
  masked scroll fades on log/finding/chat panes; skeletons reserve exact final size.
  *Ref:* `packages/ui/src/components/activity-chip.tsx`, `context-ring.tsx`, `styles/motion.css:18-54`.

---

## Roadmap — adopt or change

**Add (now):**
- Deterministic replay as the single confirmation gate (UI badge, durable store, pitch metric).
- Per-run pipeline-health / anti-silent-zero record, surfaced on every run and empty state.
- Benchmark discipline: any "drains N of M" = median over ≥3 runs with range, same model/budget;
  no false-positive rate without a clean-control contract set.

**Add (soon):**
- Negative-results log: one classified record per no-drain run (model-refused / compile-failed /
  no-exploit-path / ran-clean / sandbox-degraded) → honest coverage feed ("scanned 40, 3 drained,
  37 clean-with-reason").
- Operator-settable business-impact axis, separate from technical severity; rank un-assessed in
  the middle so proven drains never sink below low-severity noise.
- Automation scheduling (hourly/daily/weekly) so "continuously attacks your code" is real behavior.
- Per-action durable journal with correlation IDs + branch-from-entry fork (resume mid-run; "try
  another exploit from step N") — extends our kill-proof approval.
- Multi-format export (Markdown + JSON) of a single finding and of the visible filtered set.

**Add (later):**
- Evidence rail/tab with deep-link anchors from a finding to the exact run step.
- Source-fingerprinted Learning/Memory (lesson keyed to contract file + hash; re-check hash before
  reuse; claim-work queue, no auto-activation).
- Attack runs as a small typed JSON workflow graph rendered as a vertical list (NOT a canvas),
  with 2-3 templates; optional thin CLI + MCP over the same run-store.

**Change course (reference is smarter than our current plan):**
- One `severity` field → split into business priority (operator-set) vs technical severity.
- Approval-boundary-only durability → per-action journal + fork (superset of our guarantee).
- On-demand one-shot slice → scheduler for real continuous behavior.
- Flat findings table → default Review queue, with All + Board as secondary tabs.

---

## Pitfalls to avoid (from their NEGATIVE-RESULTS)

1. **The "silent zero"** — a broken sandbox/engine returning a clean-looking result that reads as
   "safe". Gate every clean result on a proven-healthy pipeline. (Bit them six times in four days.)
2. **Letting the LLM adjudicate** whether a finding is real — only a deterministic oracle may confirm.
3. **Headline "drains N of M" from a single run**, or quoting a false-positive rate with no
   clean-control set.
4. **Auto-activating learned memory** without re-checking the source hash.
5. **Building a canvas/node-graph workflow editor** — they render the DAG as a plain vertical list,
   zero graph-lib. Don't spend hackathon days on it.
6. **Mono-fonting the chrome** — reserve mono for addresses, hashes, diffs, amounts only.
7. **Conflating "implemented" with "validated"** — decide the eval corpus first; be willing to
   report "no improvement".

---

## Suggested build order (if we proceed)

Cheap wins that change the resting feel most, first:

1. Restraint spec in GUI.md/AGENTS.md (#6) + `Collapsible` primitive (#3) — the two foundations.
2. `run.tsx` rebuild (#1) + `ApprovalCard` (#2) — fixes the worst "shows too much" surface.
3. ⌘K palette → thin TopBar (shell) — biggest resting-chrome reduction.
4. `finding.tsx` collapse (#4) + Findings Review queue (#5).
5. Status enum + pipeline-health chip (#7, #8) — cheap, protects the demo's credibility.
6. Rail collapse/reorder + composer status + PageHeader — polish.
