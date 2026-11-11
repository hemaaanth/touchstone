# Pi extension research — comms, orchestration, code-intelligence

Findings from studying the real upstream sources (read-only, in an isolated
scratch dir outside the repo). This fixes the policy layer and the hunter
toolkit to the *actual* API surfaces, not guesses. **Nothing is vendored yet**
— THIRD_PARTY.md / TOOLS.md rows land at vendor time, not here.

Runtime boundary reminder: these are **Pi** extensions. Pi is Touchstone's
bundled product runtime. BB is only the dev harness. None of this depends on BB,
on any account, or on a hosted service.

## 1. pi-bulletin — PRIMARY comms (the shared board)

- **License:** MIT. Author Forrest Thomas. Repo `forrestbthomas/pi-bulletin`,
  npm `pi-bulletin@0.4.0`. Pure TS, ~8 files. Peer deps only
  `@mariozechner/pi-coding-agent` + `@sinclair/typebox`. No service, no network.
- **Model:** blackboard. CHEAP (pure file I/O, no LLM): post, read, symbolic
  conflict check. EXPENSIVE (one LLM call) only at a sync round: one digest.
  Decoupled from agent lifecycle — a stuck agent doesn't wedge the team.
- **Durable store** (`src/store.ts`): root `~/.pi/teams/<team>/` (override
  `PI_BULLETIN_ROOT`). Append-only `events.jsonl` + `digests.jsonl`, `state.json`
  snapshot, per-agent read watermarks. **Appends fsync'd before ack; snapshots
  written temp+fsync+rename; a torn tail is detected and truncated on next read.**
  This is exactly the durability guarantee §7 of the fleet spec needs — we get it
  for free, we do not build it.
- **Tool surface (the real API):**
  - `bulletin_status(team_name)` — root, event count, last digest, members.
  - `bulletin_post(team_name, kind=finding|signal|message, ref, claim, value, to, status)`
    — `status ∈ proposed|confirmed|contested|superseded` is the evidence tier.
  - `bulletin_read(team_name, since_seq?, limit?)` — per-agent watermark; returns
    only NEW events and advances the cursor.
  - `bulletin_conflicts(team_name, since_seq)` — symbolic, tiered hard/medium/soft.
  - `bulletin_resolve(team_name, ref, decision, decision_evidence?, supersedes?)`
    — LEAD ONLY; losing claims kept as superseded audit markers, never erased.
  - `bulletin_sync(team_name, digest, members?)` — LEAD ONLY; one digest/round.
  - `bulletin_compact(team_name, before_seq?)` — archive to `archive.jsonl`.
- **Identity:** `PI_BULLETIN_AGENT` env per session (the Pi extension API does not
  expose an agent name). The spawner/lead sets it. Our coordinator sets it per
  hunter.
- **Mapping to our model:** one `team_name` per lane →
  `bulletinChannel(runId, lane)` = `run:<id>:bulletin` and `run:<id>:evidence`.
  A `Lead` is a `bulletin_post` of `kind=finding` with our schema in `claim`/data.
  Our `LeadStatus` (proposed→corroborated→verifying→proven→dismissed) is a
  SUPERSET of pi-bulletin's `ClaimStatus` (proposed/confirmed/contested/
  superseded): we map `confirmed`→`corroborated`, and `proven`/`dismissed`/
  `verifying` are **ours** — the proof-gate states pi-bulletin has no concept of.
- **The one bespoke layer:** "nothing graduates to `proven` without the oracle's
  replay proof" and "Tier-2 posts are quarantined to the evidence lane" are
  Touchstone domain logic. pi-bulletin gives the board; the proof-gate is ours.

## 2. pi-messenger — SECONDARY, direct Tier-1 handoffs

- **License:** MIT. Author Nico Bailon. Repo `nicobailon/pi-messenger`,
  v0.15.2, ~109 files. Peer deps `@earendil-works/pi-ai|pi-agent-core|
  pi-coding-agent|pi-tui` + `typebox`. File-based, no daemon, no service.
- **What it is:** a full crew/swarm framework — inter-agent `@mentions` (wake a
  recipient as a steering prompt), file reservations/locks, agent registry,
  presence, activity feed, crew spawn/task handlers, loop guard, TUI overlay.
- **Durable state:** `~/.pi/agent/messenger/` (global registry/inboxes) +
  `.pi/messenger/crew/` (project-scoped tasks/planning/agents).
- **Use in the fleet:** Tier-1 ONLY (coordinator ↔ trusted analysts) for directed
  handoffs ("you verify my finding", "take module X") and the file-lock/loop-guard
  bonus for parallel hunters. **Never exposed to Tier-2.** Kept thin — the bulletin
  is the spine. Several primitives (spawn parallel workers, task assignment,
  registry) reduce bespoke orchestration work in build step 3.

## 3. pi-cbm + codebase-memory-mcp — hunter CODE-INTELLIGENCE (recommended, own track)

The hunters *read target source* to find vulns. This is the layer that makes that
efficient — orthogonal to comms (§1) and orchestration (§2).

- **pi-cbm** (wrapper): MIT, author alexykn, repo `alexykn/pi-cbm` v2.0.0. Pure TS
  Pi extension. Peer deps `@earendil-works/pi-*` + `typebox`. It implements **no
  MCP client** — it shells out to the `codebase-memory-mcp` CLI and registers the
  graph tools natively with Pi. Adds: auto-index the git root on session start +
  re-index on change (cross-process per-repo lease, bounded global concurrency),
  token-saving compact output, symbol-first helpers (`resolve_symbol`,
  `read_symbol` — fails closed on ambiguity), and batch source-reading
  (`get_code_snippets`, `read_symbols`, `search_and_read_symbols`). Query tools
  only; destructive/admin tools are NOT registered.
- **codebase-memory-mcp** (the actual engine): MIT, DeusData. **Pure C, no
  language runtime**, vendored grammars for 163 languages, Hybrid LSP type
  resolution, 17 MCP tools. **Indexing + graph queries need no hosted service and
  no API key** — fully offline. Index cached in `~/.cache/codebase-memory-mcp`.
- **Standalone-constraint verdict:** survives. No accounts, no network, no key,
  no runtime. The ONLY cost vs the clean "bundle JS Pi and go" story is shipping a
  **per-platform native binary** alongside Pi. Upstream already solves distribution
  (release archives + install.sh/ps1 + AUR `codebase-memory-mcp-bin`), so this is a
  packaging step, not a blocker. `PI_CBM_BIN` points at a vendored binary;
  `PI_CBM_SKIP_VERSION_CHECK=1` for a packaged build.
- **NOT redundant with our SARIF scanners.** The Contracts/web/infra packs and the
  `sarifLeads` ensemble are *scanners* — they emit candidate leads. pi-cbm is a
  *navigator* — it lets a hunter trace a candidate (data flow source→sink, all
  call sites of a sink, read N related symbols in one call) to investigate and
  build the PoC. Scanners find; cbm investigates. Complementary.
- **Slots into existing plumbing.** `types.ts:266` TargetScope already has a
  `local-source` kind and `catalog.ts` has `local-source`/`source-*` own-scopes.
  The scope *type* exists; the source-navigation *modules* behind it are the thin,
  under-built area. pi-cbm is what fills them out.
- **Where it lands (when adopted):** pi-cbm (TS, vendored/wrapped) → THIRD_PARTY.md;
  codebase-memory-mcp (a binary we only RUN) → a pack TOOLS.md, not THIRD_PARTY.md.
- **Decision:** adopt as its OWN track (hunter toolkit), parallel to and
  independent of the fleet comms/policy work. Does not block, and is not blocked
  by, build steps 1–5 of the fleet spec.

## Vendoring checklist (all four MIT — licensing clear per the OSS rule)

- [ ] pi-bulletin → vendor source + wrap; THIRD_PARTY.md row + LICENSE copy.
- [ ] pi-messenger → vendor source + wrap (Tier-1 only); THIRD_PARTY.md + LICENSE.
- [ ] pi-cbm → vendor source + wrap; THIRD_PARTY.md + LICENSE. (own track)
- [ ] codebase-memory-mcp → pin a release binary per platform; pack TOOLS.md row +
      upstream LICENSE/NOTICE; `PI_CBM_BIN` wired. (own track)
