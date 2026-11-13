# Touchstone task list

One list for all open work. Each item has an ID, a state, and an owner thread when work starts.
The tool-row detail and the decision history live in the progress page ("Touchstone progress", v22).
The browser plan and the Daytona plan are their own pages; this list tracks their build items.

States: `todo` · `doing` · `review` · `done` · `blocked` (needs the owner) · `parked`.
Rule for every code item: one author thread, one separate reviewer thread, at most two repair rounds.

Last update: 2026-11-13.

---

## Rules of engagement

These rules are fixed. A thread does not guess around them.

**Roles**

- **Coordinator** (one thread): writes assignments, merges, runs the gates on `main`, pushes, keeps this file and the progress page current. It writes no product code.
- **Author** (one per branch): builds one assignment in its own git worktree, on a branch cut from local `main`.
- **Reviewer** (one per branch): a separate thread on a different model family. Read-only. Never the author.
- All of them are real bb child threads with the coordinator as parent. No hidden in-process agents.

**Models** (all subscription routes; no paid OpenRouter; no Grok)

| Job | Provider / model |
|-----|------------------|
| Author, normal work | `claude-code` / `claude-opus-5-5`, reasoning high |
| Author, root-cause or cross-cutting work (A, C) | `claude-code` / `claude-fable-5-2`, reasoning high |
| Author, fallback when a Claude route has trouble | `acp-omp` / DeepSeek V4.1 Flash abliterated ("DSF4.1-A"). Its commits end with `Authored-by: DSF4.1-A (omp)` |
| Reviewer | `codex` / `gpt-6.1-sol`, reasoning high |
| Tiny follow-up fix (minors only) | `claude-code` / `claude-sonnet-5-5` |

If a route is down, the coordinator picks another subscription route and writes that in the report. Never a silent paid route.
If the codex reviewer keeps raising findings that are not real, the coordinator takes it out of the rotation and uses a Claude reviewer on a different model than the author.

**Every assignment states**: objective · acceptance criteria · owned paths · forbidden paths · base commit · checks to run · stop conditions · the form of the result.

**Gates, in order**

1. **Author check.** `bunx tsc --noEmit -p .`, `bunx oxlint src server vite.config.ts`, `bun test` in `app/`; the spike suite in `spike/`. New logic has a test. The result names one commit.
2. **UI proof** (UI items only). The author runs the app from its worktree on its own port and takes before and after screenshots of each changed screen with `bb-browser`. Existing run records are the default. A paid run is allowed when the proof needs one.
3. **Independent review.** The reviewer gets the commit, the acceptance criteria, the owner's own words, and the screenshots. Verdict: READY or NOT READY, with findings marked blocker, major or minor.
4. **Repair.** Up to **three** repair rounds, each with a re-review. A round is only spent on findings that are real and important; the coordinator checks each finding before it sends it back. Still NOT READY after round three: the branch is parked, the reason goes in this file, and work moves on.
5. **Merge.** The coordinator merges one branch at a time into `main` with a merge commit. It runs gate 1 on `main`. Green: push to `origin/main`. Red: revert the merge and send it back.
6. **Merge confirm.** Only when the merge had conflicts: the reviewer checks the merged result.

Minor findings do not block a merge. They go to a minors list in this file and are cleared in batches.

**Order and conflicts**

- One writer per worktree. One owner per file per wave. Shared files (`runs.mjs`, `page-parts.tsx`, `settings-page.tsx`, `targets.mjs`) are named in each assignment.
- **Coalesce.** After every merge the coordinator pushes, then tells every open thread the new `main` commit. Each thread merges `main` into its branch at once and reruns its checks. No branch stays behind `main` for more than one merge. Local `main` and `origin/main` stay equal.
- Up to 16 working threads at one time, or the bb limit if that is lower. Reviewers count.

**Craft**

- Looks and craft are a review criterion, not a nice-to-have. A reviewer may fail a UI branch on craft alone.
- Use the assistant-ui elements (https://www.assistant-ui.com/elements) from our library (`app/src/components/assistant-ui/elements`, `app/src/components/ui`) wherever one fits. Add a missing element from that library before writing a custom one.
- `app/AGENTS.md` and `docs/restraint.md` hold for every UI change.

**Money and outside access**

- Paid model runs are allowed. Total budget: $100 across the project. Every thread reports what it spent.
- Access to the outside is allowed: the owner's own sites (hem.so, slant.page, sher.ing; their code is also local) and targets that an Immunefi program lists as in scope. Immunefi targets are tested on local forks only. No transaction on a live chain.
- Reports and posts to the outside are not allowed without the owner's yes.

**Stop conditions** (the thread stops that item, writes it under "Needs the owner", and continues other work)

- A change to `app/src/lib/{fleet,fleet-policy,coordinator}.ts`, their tests, or the gate `if (verdict.proven === true)`.
- A paid model run that would pass the total budget.
- A credential it does not have. Any secret in a file, a log or a report.
- A report or a post to the outside: PR comment, PR close, post, public repo, report to a project. A signed transaction.
- A dependency upgrade. A scan of a target outside the authorized scope. Mainnet.
- A third-party tool that would run outside Docker `runTool()` offline mode (the four approved network tools excepted).

**Reporting**

- This file changes state at every merge. The progress page is republished at the end of each wave.
- UI work that merged without the owner's eye goes on one "morning review" page with before and after screenshots.

---

## Waves

A wave starts when the items it depends on are on `main`. Items inside a wave run in parallel.

**Wave 0. Base (done at this commit).** All open app work is on `main` and pushed. A zip backup lives outside the repository.

**Wave 1. Foundations. Needs nothing from the owner. Started 2026-11-13 03:25.** Assignments are in the coordinator's thread storage (`wave/`). All three cloud PR branches now hold `main` 591d9b8.

| Thread | Items | Owns | Running as |
|--------|-------|------|------------|
| 1a Runs durability | A1, A2, A3, A4 | `app/server/runs.mjs`, workspace code in `spike/lib/targets.mjs`, tests | `thr_txmsg8rqzb`, branch `fix/run-continuity` |
| 1b Design language + Scopes | C1, C2, C3, D1 | `page-parts.tsx`, `ui/tooltip.tsx`, new module pill, `scopes-page.tsx` | `thr_bvswpfykz6`, branch `ui/design-language` |
| 1c Run view polish | B1, B2, B3, B5, B6 | run view components (not the sidebar file) | `thr_hvptu9ii6r`, branch `ui/run-view-polish` |
| 1d Cloud PR 4, then PR 7 | H1, H2 | the PR files | PR 4 review `thr_qxi2n9w6dn` (Claude; the codex reviewer was refused by its provider) (`merge/pr-4` 4915bde); PR 7 author `thr_vwfuw9z46v` (`merge/pr-7` 690923d). Both run now. |
| 1e Images + green suite | K2 | no source files | `thr_9csjsxzqis`, branch `fix/green-suite` (also K6) |
| 1f Review of the base commit | K1 | read-only | done: NOT READY, see section L |
| 1g Console auth repair | L1–L4 | `app/server/runs-http.mjs` (opened for this), `settings.mjs`, `vite.config.ts`, `src/lib/api.ts` | `thr_fm47pnz5hm`, branch `fix/console-auth` |
| 1h Reach + stores repair | L5–L8 | `spike/lib/reach.mjs`, eligibility in `targets.mjs`, Domains / Surface / Phishing capture, the two stores | `thr_wusej9fdjz`, branch `fix/reach-stores` |

**Wave 2. Consumers. Starts after 1a, 1b and PR 7.**

| Thread | Items | Depends on |
|--------|-------|-----------|
| 2a Settings redesign + Daytona settings | E1, E2, E3, E4 | 1b |
| 2b Modules page redesign | E5 | 1b |
| 2c Run Info pills + sidebar rule | B7, B4 | 1b, PR 7 |
| 2d Scope brief | D2 | 1a, 1b |
| 2e One multi-module run (code + tests) | D3 | 1a |
| 2f Cloud PR 6 | H3 | PR 7 |
| 2g Toolkit branches, three at a time | G1 to G7 | 1e |

**Wave 3. New surface and old debts.**

| Thread | Items | Depends on |
|--------|-------|-----------|
| 3a Findings page | F1, F2 | 1b, PR 7 |
| 3b Old test debts | G10 (tests only), K5 | 1e |
| 3c Worktree clean-up | K4 | all merges of waves 1 and 2 |

**Wave 4. Browser and free-roam agents. Needs the owner's yes for Daytona use.**

I1 to I6 in the order of the plan page. I6 needs G5. I7 needs the protected files. J1 and J2 run beside it.

**Wave 5. Live proof. Needs a paid-run budget.**

One multi-module run (D3). One follow-up on a finished run (A2, A3). Live batch 2. The best ENS leads offline. Then a full pass through the app by hand with `bb-browser`, and the final progress page.

---

## Needs the owner

| Need | Unblocks | Without it |
|------|----------|-----------|
| Yes or no on the protected fleet files | A5, I7 | Both stay blocked |
| ~~Daytona API key~~ **received 2026-11-13** (`DAYTONA_API_KEY` in `spike/.env.local`). The key in the form counts as the yes for wave 4 use. | J1, I1 to I6 | Waves 1 to 3 are not affected |
| ~~A classic GitHub token, read-only~~ **received 2026-11-13** (`GITHUB_TOKEN`) | G3 live path (Scorecard API, Legitify), G9 | no longer blocked |
| A read-only cloud credential (AWS) | G8, 5 tool rows | Stays blocked |
| ~~A fork RPC URL~~ **received 2026-11-13** (`MAINNET_RPC_URL`; local fork only, no transaction) | Stader fork work | no longer blocked |
| Yes to close PR 3 on GitHub | H1 tidy-up | PR 3 stays open |
| An eye on the UI work | B, C, D, E, F | Merges on review + screenshots; the owner checks the morning page |

---

## A. Runs: durability and follow-ups (bugs)

| ID | State | Item |
|----|-------|------|
| A1 | doing | **"The run stopped unexpectedly" (code `no-settle`).** The ENS metadata-service run died before it settled ($0.60 spent). Find the real cause in that run's stderr and events. Fix the cause, not only the card. Source: `app/server/runs.mjs:898`. |
| A2 | doing | **Sources are gone after Run again or a follow-up.** The agent said "Sandbox is fresh: sources are gone". Reopening rebuilds the workspace (`prepareWorkspace`) but code fetched into `vendor/` at run time is not restored. Chat history, sources and leads must all survive. Same root as old tester MAJOR 5 (live follow-up fails after a sandbox rebuild). |
| A3 | doing | **Follow-up is refused on runs with a generated lab** ("this run's lab was generated for that run only…", `runs.mjs:1076`). A finished run must accept a follow-up. Keep or rebuild the same lab. Never tell the user the run "marked itself done". |
| A4 | doing | **Run again must keep context.** Checked in code: "Run again" already continues the same run and the same chat (it sends a follow-up). The loss came from A2 (the reopen rebuilt the workspace). So A4 is a test inside thread 1a: after Run again, sources and history are still there. No owner decision is needed. |
| A5 | todo | Fleet runs do not survive a server restart. Needs a change in `coordinator.ts`, which is inside the boundary. **blocked** on the owner. |

## B. Run view polish

| ID | State | Item |
|----|-------|------|
| B1 | doing | Run header: drop the status word ("Failed", "Running", "Proven"). The dot says it. Keep the word for screen readers and in the dot's tooltip. |
| B2 | doing | Chat start jitter: the first box turns into an indented "tool scan" dropdown. Make the start of a run one calm, stable layout with no jump and no odd indent. |
| B3 | doing | The side panel changes width when it opens and closes. Same width in both states. |
| B4 | todo | Top-left "Touchstone" header is sticky at the same height as the run header but has no bottom rule. Add the rule so both line up as one bar. |
| B5 | doing | Finding pills show two status words ("Critical" + "Waiting"). Use icons and one indicator. Easier to scan. |
| B6 | doing | Error states: use the assistant-ui error-state and tool-error patterns (https://www.assistant-ui.com/elements/error-state, https://www.assistant-ui.com/elements/tool-error). Sentence case, proper copy, in the theme. No flash or jitter when the user presses Enter. |
| B7 | todo | Run Info panel: modules and model are a plain text list. Modules become colored pills (see C1). Model reads cleanly. |

## C. One design language

| ID | State | Item |
|----|-------|------|
| C1 | doing | **Module pills with one fixed color per module.** The same module has the same color on every screen: run Info, Scopes, Modules, Settings, New run, Findings. One map in code. Restraint rules still hold: red and green stay reserved for proof. |
| C2 | doing | Tooltips are bright white and off-theme. Fix the tooltip component once for the whole app. |
| C3 | doing | One list pattern for Scopes, Modules and Settings: the bb Settings list (title, one muted line, "+ Add" at the top right, one bordered card, rows with icon, name, badges, muted meta, "…" menu, no per-row expand toggle). |

## D. Scopes

| ID | State | Item |
|----|-------|------|
| D1 | doing | Redesign the Scopes page in the C3 pattern. No layout shift on open. Modules as C1 pills. No row has a dropdown that others lack: every row behaves the same. |
| D2 | todo | **Scope brief in the scope, not in the repo.** Today Touchstone writes a `BRIEF.md` into the run workspace (the repo does not need one). The owner wants a brief field on each scope, edited in the scope's settings, and applied to every run of that scope. The run view should not show "Read BRIEF.md" as if it were a repo file. |
| D3 | todo | One multi-module run: ticking several modules builds one run, not one run per module. Needs one paid run to prove it (owner's yes). |

## E. Settings

| ID | State | Item |
|----|-------|------|
| E1 | todo | Daytona row: a much shorter description. No region in it (`us-west-3` is hard-coded as a default in `spike/lib/daytona.mjs:58`). Move the access notes into an info icon next to the word "Daytona". No tooltip plus small text at once. |
| E2 | todo | Daytona needs its server URL and region (target) as settings next to the key. Not every account uses the default server or `us-west-3`. |
| E3 | todo | Add provider dialog: remove the box inside the box. |
| E4 | todo | Provider rows and the provider edit form look broken: off layout, the base URL is cut off. Redesign in the C3 pattern. |
| E5 | todo | Modules page redesign (no "Pipeline", no tool lists, C1 pills, C3 list). Settings page in the same language. |

## F. Findings page (new)

| ID | State | Item |
|----|-------|------|
| F1 | todo | A "Findings" item in the left sidebar. One table of findings across all runs: title, severity, proof state, scope, module, run, date and time. Sortable. Filterable by scope, module, severity, state and date. |
| F2 | todo | Each row opens the full finding. Copy buttons: the report as markdown, and a short "for an agent" copy. Copies go through the report redaction (cloud PR 7), so F waits for PR 7 or uses its rules. |

## G. Toolkits (paused branches; tool rows 69 of 86)

| ID | State | Item |
|----|-------|------|
| G1 | todo | Domains: checkdmarc, testssl.sh, DNSViz (`pack/domains` 523778a). Delta review only. +3 rows. |
| G2 | todo | Web: Schemathesis re-review; jwt_tool needs a JWT surface in the lab (`cov/web-tools` ea9b50c). +2 rows. |
| G3 | todo | Supply-chain: Scorecard + capture mode + Legitify re-review, 3 minors (`cov/supply-networked` 52ac84d). |
| G4 | todo | Contracts: Halmos + Chimera. Timeout tests must fail when clean-up is removed; THIRD_PARTY.md conflict (`cov/contracts-symbolic` a2573ad). +2 rows. |
| G5 | todo | Candidate tier: Major A part 3 and 3 minors (`feat/candidate-tier` eec42f1). |
| G6 | todo | Contracts vacuity gate: Major 2 and 4 minors (`pack/contracts-vacuity` 2320d53). Kill-rate bar is an owner decision. |
| G7 | todo | Small: spend cap Minors B and C (`fix/wave-spend-cap` f169e19); Heimdall image comment (`cov/bytecode-brotli-note` bf21080). |
| G8 | blocked | Infra-cloud live path, 5 rows: needs a read-only cloud credential. |
| G9 | todo | chain-bench and raven: both take the GitHub token only as a command-line flag. Plan: a small entrypoint inside each image reads the token from the environment and passes the flag inside the container, so the token never shows in the `docker run` line. Live proof needs the GitHub token. |
| G10 | todo | Old queue: 3 missing tests + 1 legacy-run gap (large-repo review); a test that the lab network is internal; 2 PR 1 minors; live batch 2; prove the best ENS leads offline; test the 12 assumed overlap skips. |

## H. Cloud PRs

| ID | State | Item |
|----|-------|------|
| H1 | review | PR 4 (harm gate), `merge/pr-4` 2c9824b: re-review. PR 3 is its twin; merge only one. |
| H2 | doing | PR 7 (report redaction), `merge/pr-7` 5b75dfb: open redaction rules. Blocks F2. |
| H3 | todo | PR 6 (replay bundle), `merge/pr-6` 2e51648: Major 7 and leak classes. After PR 7. |
| H4 | parked | PR 8: parked until the owner decides. |

## I. Browser and free-roam agents (plan page v5)

| ID | State | Item |
|----|-------|------|
| I1 | todo | Persistent root sandbox per free-roam agent (Daytona). |
| I2 | todo | Egress request log. |
| I3 | todo | Playwright browser tool with HAR capture. |
| I4 | todo | Ask-the-human flow in the fleet, with manual takeover through the sandbox desktop view. |
| I5 | todo | Wallet and email loadout options. |
| I6 | todo | Session capture (HAR, shell transcript, screenshots) in the candidate record. Needs G5. |
| I7 | blocked | Per-agent loadouts. Lives in the protected fleet files: needs the owner's yes. |

## J. Daytona baked snapshot (plan page v2, path A)

| ID | State | Item |
|----|-------|------|
| J1 | blocked | Step 0: one real snapshot test on the owner's Daytona account. |
| J2 | todo | Steps 1 to 7 after J1. |

## K. Cleanup and housekeeping

| ID | State | Item |
|----|-------|------|
| K1 | done | The app work (scope model, console token, page edits, New run dialog, setup script) is on `main` as the new base. It still needs its independent review (thread 1f). **Review result: NOT READY** (`thr_xikyvziytr`, 9 findings, checked by the coordinator). The repairs are section L. |
| K2 | done | Rebuild the tool images with `spike/scripts/setup.mjs` and get a green full suite at the tip. Toolkit reviews need the images. Result (thread 1e): all 45 manifest images were present; nothing to pull or build. Full spike suite on the candidate: 940 tests, 936 pass, 0 fail, 4 skipped (2 need live Daytona, 2 need the optional garak image). |
| K3 | blocked | The 22 old run files are removed from the tree at the base commit. They stay in git history and in a local trash folder (ignored by git). Open: rewrite history to drop them, or leave it. |
| K4 | todo | Remove old worktrees after their branches merge. |
| K6 | review | One spike test fails on `main` (also before the base commit): `oz-monitor.test.mjs`, "a monitor run that times out…". The monitor now finishes inside the 1.5 s limit, so the timeout never fires. Fix the test so it does not depend on speed. Goes to thread 1e. Fix `1c378a1` on `fix/green-suite` (the test pauses the lab chain). Reviewer `thr_ry8aamkj9q`. |
| K5 | todo | Re-check old tester MINOR M1: the proof drawer hides harm numbers. |

## L. Base security repair (from the K1 review)

The review of the base commit found real defects. Most are older than the base commit, but the base makes them matter more. Report: coordinator thread storage, `thr_xikyvziytr/review.md`.

| # | State | Item |
|---|-------|------|
| L1 | doing | **Every console write needs the token.** Today run create, steer, stop, archive, rename, delete and scope delete take no token. A web page on another site can start a run with a plain form post. Thread 1g `thr_fm47pnz5hm`, branch `fix/console-auth`. |
| L2 | doing | **The token in the page can be read from another `localhost` port.** Vite's default CORS allows it. Also keep the token out of a build output. Thread 1g. |
| L3 | doing | **The token is written to the server log** on the first grants read. Remove it. Thread 1g. |
| L4 | doing | Token compare in constant time. Thread 1g. |
| L5 | doing | **Domains, Surface and Phishing can leave the scope.** They are on for every website scope, and their capture tools use the open Docker network, not the scope proxy. They can probe a private address or a host with no grant. Thread 1h `thr_wusej9fdjz`, branch `fix/reach-stores`. |
| L6 | doing | **A run can get a wider grant.** The gate takes any grant that covers the host, and allows every host of that grant. Bind a scope to its own grant. Thread 1h. |
| L7 | doing | **A broken store file loses data silently.** Scopes and grants: atomic write; refuse to change a file that cannot be read. Thread 1h. |
| L8 | doing | **A tool run can build an image** (Domains). It must fail with "run setup" instead. Thread 1h. |
| L9 | todo | Setup pins: Foundry uses `latest`, eth-security-toolbox uses `nightly`, other images have a tag but no digest. Pin by digest in the setup script and at run time. Wave 3. |

## Owner decisions (open)

chain-bench and raven · classic GitHub token for Scorecard API and Legitify · PR 3 close · PR 8 · safe-hash-rs licence · GPL-3.0 package in the Mythril image · vacuity kill-rate bar · candidates for packs with no proof model · Stader fork exception + RPC URL · fleet restart (coordinator.ts) · free-roam loadouts (fleet files) · infra-cloud credential · Daytona step 0 · a paid run for D3 · the 22 run files.
