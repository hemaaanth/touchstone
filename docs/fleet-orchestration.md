# Touchstone Fleet Orchestration + Bulletin — Architecture Spec

Status: draft / track `wt/fleet-orchestration`. Decisions locked with the operator:
**product fleet** (not just dev workflow), **Bulletin-primary**, **start now, own track**.

## 1. Goal

The operator talks to ONE **coordinator** agent. The coordinator, at its discretion,
spins up many **parallel hunter agents** that work concurrently on a red-team RUN — across
different modules, the same module, or free-form — each with a mix of toolkits, pointed at
the job of finding a provable vulnerability. The agents coordinate through a shared,
durable **Bulletin**. The operator console visualizes the fleet (a panel beside the files
pane) and renders the bulletin feed with the app UI framework. The operator does not chat
with the children; they watch and can click into any of them.

## 2. Trust tiers (this shapes everything)

Touchstone has two fundamentally different agent populations. Conflating them breaks the
core claim ("a finding is real only when a replay proves it").

- **Tier 0 — Operator ↔ Coordinator** (trusted). The only conversational surface.
- **Tier 1 — Coordinator + hunter/analyst agents** (trusted orchestration). They plan the
  run, shard work, triage leads, and dispatch verification. Run as Pi sub-agents.
- **Tier 2 — Attacker workers** (UNTRUSTED). NEAR AI abliterated models in offline
  sandboxes that write the PoC / signed raw-tx. **Their bulletin posts are evidence
  submissions, not control messages.** They never get trusted-peer messaging. They post to
  a quarantined evidence lane that the harness/oracle validates before anything is promoted
  to the shared bulletin. This keeps an untrusted model's words out of the trusted control
  plane.

> **Runtime boundary (this is load-bearing).** Touchstone ships as a self-contained product.
> Its agent engine is **Pi** (open-source `omp` / pi-mono), which can be bundled, so a stranger
> runs Touchstone with no accounts and no BB. **BB is only the dev harness used to BUILD
> Touchstone; it is never a product runtime dependency.** Earlier drafts of this section said
> "BB channels" — that was wrong and is corrected below.

## 3. Bulletin — primary comms, on the `pi-bulletin` extension (durable)

- **Substrate: the `pi-bulletin` Pi extension** (community, blackboard pattern — "cheap
  eventing + batched digests + reconcile-on-conflict"). Core Pi spawns parallel sub-agents but
  they cannot talk mid-run; `pi-bulletin` is the shared board that fills that gap. We **vendor
  and wrap** it, we do not rebuild a message bus. Durability comes from the extension's
  persisted board, not an in-process bus. (License check + THIRD_PARTY.md entry before vendoring.)
- **One board per RUN, two topics/lanes:** `run:<id>:bulletin` (trusted lane) +
  `run:<id>:evidence` (quarantined Tier-2 lane). Topic naming owned by
  `bulletinChannel()` in `app/src/lib/fleet.ts`.
- **Lead message schema:**
  `{ id, author(agentId), tier, module, toolkit, claim, mechanism, evidenceRef,
     severity, status: proposed|corroborated|verifying|proven|dismissed, replyTo }`
- **Posting rules (THIS is the only bespoke layer we write on top of `pi-bulletin`):** Tier-1
  posts leads / triage / dispatch freely to the bulletin. Tier-2 posts ONLY to the evidence
  lane; promotion to the shared bulletin requires harness validation (the oracle / replay
  proof). The board is Pi's; the "nothing graduates without a proof" rule is Touchstone's
  domain logic and does not exist in `pi-bulletin` — it is ours to enforce.
- **Corroboration:** this is the live form of the ensemble model already in the harness
  (`sarifLeads` → "leads merge and corroborate in the ensemble"). One hunter's recon feeds
  another's exploit.

## 4. Messenger — secondary, direct handoffs (the `pi-messenger` extension)

The `pi-messenger` Pi extension (tiered parallel sub-agents, `@mentions`, loop guard, file
locks, context broker) for directed Tier-1 handoffs ("you verify my finding", "take module X").
Also vendored/wrapped, not rebuilt. Not available to Tier-2. Kept thin; the bulletin is the
spine. (Its file-lock + loop-guard features are a bonus for the parallel hunters.)

## 5. Coordinator loop

plan run → shard work (module / toolkit / free-form) → spawn hunters → watch bulletin →
route each `proposed` lead to the oracle/replay proof → promote `proven`, dismiss the rest →
report. Discretion to scale the fleet up or down mid-run.

## 6. UI (operator console)

- **Fleet panel beside the files pane:** one row per agent — name, tier, model, status,
  current task, token/$ spend. Click → agent detail (its activity, current tool, its posts).
- **Bulletin feed:** rendered with `page-parts` / OpenUI components — Lead cards with a
  severity chip, module/toolkit tags, mechanism, a status timeline, an evidence link, and
  reactions. Properly formatted, never raw text.
- **Design tension for the design track:** the `operator-console-continuous-canvas` rule
  ("keep model identity static when there is only one model") assumes a single model. A
  fleet has many identities; the panel must show multiple agent/model identities while
  still reading as one continuous workspace, not separate rounded cards. Needs design input
  before the panel is built.

### 6a. Locked UI rules (from the design track)

The design track resolved the multi-identity tension. These are binding for the panel:

- **No model picker; runtime identity is read-only in all cases.** The console never lets
  the operator reassign a running agent's model.
- **Agent name is the primary identity; its assigned model is neutral text in the same
  row** — not a brand, not a color.
- **One flat fleet list.** No per-agent or per-model cards, no colour-coded model brands.
- **Selected row = "Inspecting &lt;agent&gt;"** in a read-only activity region. The
  coordinator stays the sole composer; the operator inspects, never types at a child.
- **T1/T2 trust is an explicit registry-derived label**, never inferred from the model name.
- **Agent Done/Failed are neutral.** Success/danger signalling is reserved for an
  authoritative *proven* lead — not for an agent merely finishing or erroring.

### 6b. Row geometry + layout (design note `fleet.v1-notes.md`, thread thr_qen9sj2438)

The design track delivered the concrete direction (its source note is `design-directions/`,
which is gitignored scratch, so the binding parts are copied here):

- **Fleet row: one 56–64px record per child.** Aligned fields on the primary line —
  `Agent / short id · Tier · Model · Status · Spend` — with the current task truncated to
  one line below. Agent name is primary; tier and model are secondary text. Show
  **`T2 untrusted` explicitly**. Dollar spend right-aligned; tokens in the disclosure;
  unknown spend is `—`, not `0`. Neutral lifecycle states (Done is not green, Failed is not
  red). **Row order is stable** as status/spend change; a new agent must not steal selection.
- **Selection:** one neutral `bg-muted` step opens a joined, read-only activity region below
  the list — current work, folded tool output, links to the agent's Bulletin posts. Labelled
  **"Inspecting [agent]"**, never "Speaking to". No child composer, no model switcher. The
  main composer stays **"Message coordinator."**
- **Presence:** coordinator identity in the conversation header; children live in Fleet. A
  compact **"Fleet · 8 agents · 5 active"** summary (unique child ids, not posts/models). No
  model-specific colours; identity stays legible through text, not an avatar legend.
- **Bulletin feed:** flat, full-width entries — square edges, one bottom separator, no
  per-entry shadow or rounded frame. Each keeps author/tier, module/toolkit tags, mechanism,
  severity, status timeline, evidence link, reactions. High/Critical chips stay **neutral
  until proven**. Render **recorded transitions only** — never infer earlier stages from the
  latest state; `proven` and `dismissed` are alternative terminal outcomes. Reactions and
  corroboration are not proof; only the harness/oracle result earns `proven`. **Trusted leads
  and Evidence submissions stay visibly separate**; Tier-2 submissions are quarantined and get
  no controls implying trusted-peer access.
- **Placement in the continuous canvas:** center dock = `Conversation | Bulletin`; right dock
  = `Files | Fleet`. On wide (≥ ~1680px) desktops Files and Fleet may pin side by side with a
  shared divider; at 1440px do not force four narrow columns. Preserve selection + scroll when
  switching dock views.
- **Reuse, don't invent:** existing line Tabs, neutral Badges, ScrollArea, Collapsible, and
  assistant-ui activity leaves. No new card system or palette.

These field requirements are already reflected in the step-1 data model (`app/src/lib/fleet.ts`):
nullable `AgentSpend` (`—` not 0), recorded-only `Lead.transitions`, the `BulletinLane` split,
registry-derived `Tier`, and neutral `AgentStatus`.

## 7. Durability

Bulletin = the persisted `pi-bulletin` board. Fleet/agent registry lives in persisted run state. The
coordinator is a durable Pi session. Worker sandboxes are ephemeral, but their
evidence is written to the run's evidence store before teardown. On restart the coordinator
re-reads channel history + run state and resumes.

## 8. Shared infrastructure with F1 review finding R1 (important)

The independent review of the F1 raw-tx replay proof returned a BLOCKING **R1**: the lab's
Anvil is reachable on host loopback, so an in-process attacker can port-scan, find the lab,
and forge a credited drain. The required fix is an **out-of-process attacker sandbox** —
own network namespace, no docker socket, no host network, IPC-only lab socket.

**That is exactly the Tier-2 isolation this fleet needs.** Build it ONCE here (§2 Tier-2),
and F1 productionization (raw-tx replay) sits on top of the same sandbox. We must not build
attacker isolation twice.

## 9. Build order (this track)

1. Data model + types in `app/src/lib` — `Lead` / `Fleet` / `HunterAgent`. New files, low
   conflict with the console tracks.
2. Bulletin policy layer over `pi-bulletin` — Lead validate / post / read / promote, with the quarantined
   evidence lane.
3. Coordinator orchestration loop — spawn, shard, dispatch, promote.
4. **Untrusted worker sandbox — shared with F1-R1.**
5. UI — fleet panel + bulletin feed, coordinated with the design track.
