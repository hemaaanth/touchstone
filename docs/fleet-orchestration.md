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
  run, shard work, triage leads, and dispatch verification. Run as `bb agents` / Pi.
- **Tier 2 — Attacker workers** (UNTRUSTED). NEAR AI abliterated models in offline
  sandboxes that write the PoC / signed raw-tx. **Their bulletin posts are evidence
  submissions, not control messages.** They never get trusted-peer messaging. They post to
  a quarantined evidence lane that the harness/oracle validates before anything is promoted
  to the shared bulletin. This keeps an untrusted model's words out of the trusted control
  plane.

## 3. Bulletin — primary comms, on BB channels (durable)

- **Substrate: `bb agents channel` / the `channel_*` tools.** Persisted history,
  searchable, reactions, survives restarts. Durability is preserved precisely because the
  bulletin is a persisted BB channel, not an ephemeral in-process bus.
- **One channel per RUN:** `run:<id>:bulletin` (trusted lane) + `run:<id>:evidence`
  (quarantined Tier-2 lane).
- **Lead message schema:**
  `{ id, author(agentId), tier, module, toolkit, claim, mechanism, evidenceRef,
     severity, status: proposed|corroborated|verifying|proven|dismissed, replyTo }`
- **Posting rules:** Tier-1 posts leads / triage / dispatch freely to the bulletin. Tier-2
  posts ONLY to the evidence lane; promotion to the shared bulletin requires harness
  validation (the oracle / replay proof).
- **Corroboration:** this is the live form of the ensemble model already in the harness
  (`sarifLeads` → "leads merge and corroborate in the ensemble"). One hunter's recon feeds
  another's exploit.

## 4. Messenger — secondary, direct handoffs

`SendMessage` / `bb thread tell` for directed Tier-1 handoffs ("you verify my finding",
"take module X"). Not available to Tier-2. Kept thin; the bulletin is the spine.

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

## 7. Durability

Bulletin = persisted BB channel. Fleet/agent registry lives in persisted run state. The
coordinator is a durable `bb agents` thread. Worker sandboxes are ephemeral, but their
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
2. Bulletin service on BB channels — create / post / read / promote, with the quarantined
   evidence lane.
3. Coordinator orchestration loop — spawn, shard, dispatch, promote.
4. **Untrusted worker sandbox — shared with F1-R1.**
5. UI — fleet panel + bulletin feed, coordinated with the design track.
