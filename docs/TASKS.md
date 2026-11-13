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
| Author or reviewer, fallback when a Claude or codex route has trouble (refusal, provider block, limit) | `acp-omp` / DeepSeek V4.1 Flash abliterated ("DSF4.1-A"). Its commits end with `Authored-by: DSF4.1-A (omp)`. A reviewer is still never the author |
| Reviewer | `codex` / `gpt-6.1-sol`, reasoning high |
| Tiny follow-up fix (minors only) | `claude-code` / `claude-sonnet-5-5` |

If a route is down, the coordinator picks another subscription route and writes that in the report. Never a silent paid route.
If the codex reviewer keeps raising findings that are not real, the coordinator takes it out of the rotation and uses a Claude reviewer on a different model than the author.

**Every assignment states**: objective · acceptance criteria · owned paths · forbidden paths · base commit · checks to run · stop conditions · the form of the result.

**Gates, in order**

1. **Author check.** `bunx tsc -b --noEmit` (not `tsc --noEmit -p .`: `app/tsconfig.json` has no files, so that command checks nothing), `bunx oxlint src server vite.config.ts`, `bun test` in `app/`; the spike suite in `spike/`. New logic has a test. The result names one commit.
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

**hstack skills** (owner, 2026-11-13: use them when they help; optional)

- Every thread may use the hstack skills. They are a starting point, not a rule. A thread that finds one unhelpful works without it.
- Authors: `map` (callers and blast radius before a change), `investigate` and `trace` (unclear symptom, root cause), `plan`, `build`, `prove` (evidence before a claim in the report), `exercise` (hands-on UI check), `trim` (simplify own code), `handoff` (at a stop condition).
- Reviewers: `review` and `prove`.
- Coordinator: `delegate` (already the policy above), `babysit` for the open cloud PRs, `handoff` at wave ends.
- Children do not use `ship`, `land`, `yolo`, `babysit` or `delegate`: those push, open or merge PRs, or spawn threads. The rules above and the assignment file win over a skill's default steps.
- The short form for children is in the shared rules file (`wave/RULES.md` in the coordinator's thread storage).

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
| 1a Runs durability | A1, A2, A3, A4 | `app/server/runs.mjs`, workspace code in `spike/lib/targets.mjs`, tests | `thr_txmsg8rqzb`, branch `fix/run-continuity`; `6a95a1e` reviewed NOT READY (`thr_itmcnmnnku`): two Majors; repair round 1 done at `0fcb174`. The codex reviewer was blocked by its provider on the delta re-review; a Claude reviewer took over: `thr_e5hdgh5re9`, running. Delta re-review (`thr_e5hdgh5re9`): NOT READY, one Major: a server stop during a follow-up leaves the restored credential in the kept workspace, and the next follow-up says the opposite. Repair round 2 with the author. Repair round 2 done at `6639fac` (mark before restore, boot clean-up, rebuild when the scope lost its credential, 21 tests). Delta re-review 2 running (`thr_e5hdgh5re9`). Delta re-review 2 READY (`thr_e5hdgh5re9`). **Merged** into main `c57c2f1` at head `6639fac` (21 run-continuity tests). Minors: A7. |
| 1b Design language + Scopes | C1, C2, C3, D1 | `page-parts.tsx`, `ui/tooltip.tsx`, new module pill, `scopes-page.tsx` | `thr_bvswpfykz6`, branch `ui/design-language`; candidate `99229ec` in review (`thr_ahkvy8efbw`) **Merged** into main `3538912` (reviewed READY). |
| 1c Run view polish | B1, B2, B3, B5, B6 | run view components (not the sidebar file) | `thr_hvptu9ii6r`, branch `ui/run-view-polish`; candidate `984fc07` in review (`thr_vw5bjhk5kb`); `984fc07` reviewed NOT READY (`thr_vw5bjhk5kb`): two Majors; repair round 1 with the author Repair round 1 done at `d566037`: folded, the panel is one line in the top bar and covers no chat (48 measured cases); a slow refusal no longer changes the transcript; tooltips open on keyboard focus. Delta re-review running (`thr_vw5bjhk5kb`). Delta re-review at `d566037`: the three findings are fixed; NOT READY for one new Major: below `md` the folded panel takes the title's space (42 px at 375, 0 px at 320). Repair round 2 with the author: a compact control on narrow screens. Repair round 2 done at `981c70a` (below `md` the folded panel is one 56 px button; the title keeps 60% or more of the bar; desktop unchanged; 222 app tests). Delta re-review 2 running (`thr_vw5bjhk5kb`). Delta re-review 2 READY (`thr_vw5bjhk5kb`). **Merged** into main `b56fcd2` at head `981c70a` (222 app tests). Follow-ups B8, B9, B7 with the author on `ui/run-view-followups`. |
| 1d Cloud PR 4, then PR 7 | H1, H2 | the PR files | PR 4 review `thr_qxi2n9w6dn` (Claude; the codex reviewer was refused by its provider) (`merge/pr-4` 4915bde); PR 7 author `thr_vwfuw9z46v` (`merge/pr-7` 690923d). Both run now. PR 4 repair round 2 done at `0bc016f`; delta re-review running (`thr_qxi2n9w6dn`). PR 4: delta re-review READY (`thr_qxi2n9w6dn`). **Merged** into main `5462181` at head `0bc016f`; GitHub shows PR 4 merged; PR 3 closed. PR 7: final review NOT READY, repair with `thr_vwfuw9z46v`. |
| 1e Images + green suite | K2 | no source files | `thr_9csjsxzqis`, branch `fix/green-suite` (also K6). **merged** `afce9fc` |
| 1f Review of the base commit | K1 | read-only | done: NOT READY, see section L |
| 1g Console auth repair | L1–L4 | `app/server/runs-http.mjs` (opened for this), `settings.mjs`, `vite.config.ts`, `src/lib/api.ts` | `thr_fm47pnz5hm`, branch `fix/console-auth`; candidate `6b472f7` in review (`thr_ck6iq7pe6r`); reviewed READY (`thr_ck6iq7pe6r`); the author adds two test fixes, then merge **Merged** into main `9c68b3a` at head `93928f6`. |
| 1h Reach + stores repair | L5–L8 | `spike/lib/reach.mjs`, eligibility in `targets.mjs`, Domains / Surface / Phishing capture, the two stores | `thr_wusej9fdjz`, branch `fix/reach-stores` Candidate `a2c1c3e`; review running (`thr_eghjjuyhm4`, Claude). Review READY (`thr_eghjjuyhm4`). **Merged** into main `3eae9f8` at head `a2c1c3e`. Follow-ups: L17 to L20. |

**Wave 2. Consumers. Starts after 1a, 1b and PR 7.**

| Thread | Items | Depends on |
|--------|-------|-----------|
| 2a Settings redesign + Daytona settings | E1, E2, E3, E4 | 1b Running: `thr_hy9krv3ri8`, branch `ui/settings`, also L12. Author done at `2bab7ce` (E1 to E4, L12). Coordinator ruling: a change of the Daytona server host drops the saved key; the author adds it, then review. Done at `0f80793`: the key is saved with its host and is never sent to another host. Review running: `thr_8xurh9f9p3` (Claude). Review READY (`thr_8xurh9f9p3`). **Merged** into main `d286037` at head `0f80793`. Minors: L21. |
| 2b Modules page redesign | E5 | 1b Running: `thr_daurqy4zav`, branch `ui/modules-page`. Author done at `57bd755` (210 app tests). Coordinator ruling: the name showed twice per row; the pill becomes the row's name (one optional `ListRow` prop opened in `page-parts.tsx`). Author repairs before review. Repaired at `c7534e0` (the pill is the row's name; `ListRow` got one optional `name` prop; 213 app tests). Review running: `thr_efvd29q5fv` (codex). Review READY (`thr_efvd29q5fv`). **Merged** into main `a63c224` (213 app tests). |
| 2c Run Info pills + sidebar rule | B7, B4 | 1b, PR 7 |
| 2d Scope brief | D2 | 1a, 1b Running: `thr_4tciupwaac`, branch `feat/scope-brief` (worktree `redteam-w1b`, port 5227); also L13 and the `*.` hint from L18. Author done at `012bb32` (no run writes `BRIEF.md`; the brief goes into the agent's instructions; 229 app tests; L13 and the `*.` hint done). Review running: `thr_qf28qxbiw8` (Claude). Review at `0bcc032` (`thr_qf28qxbiw8`): NOT READY, one Major: the form encodes a `*.example.com` entry to `%2A.example.com` and the server drops it, so since 1h an operator cannot turn subdomain discovery on through the form. The brief itself is sound (28 hostile cases change no reach; no token at rest anywhere new). Repair round 1: the form keeps a valid wildcard entry and shows it as a wider permission; fleet children do not get the live token; four minors. |
| 2e One multi-module run (code + tests) | D3 | 1a Running: `thr_ydsrcwc7k8`, branch `feat/multi-module-run` (worktree `redteam-w1h`, port 5228). Author changed to omp DSF4.1-A `thr_f73xqn85xc` (engine done at `83c908c`, app part running); engine review `thr_2i3b5vurjf`. |
| 2f Cloud PR 6 | H3 | PR 7 |
| 2g Toolkit branches, three at a time | G1 to G7 | 1e. Started 2026-11-13: G4, G2, G7. G1 and G3 wait for 1h. G5 waits for 1a and 1c. |
| 2h Fleet runs survive a restart | A5 | 1a. Running: `thr_jpqvy79gea` (fable-5-2), branch `fix/fleet-restart` (worktree `redteam-fix-pr4`, port 5229). Own reviewer; the gate line is never touched. Author done at `d0787d4`: the three protected files have no diff (no running code imports `coordinator.ts`; the fleet that runs is `spike/lib/fleet.mjs` plus `runs.mjs`); 14 new restart tests; no worker starts at boot. Review running: `thr_a5efffbitn` (Claude, own reviewer). Review READY (`thr_a5efffbitn`). **Merged** into main `6ddfc7f` (fleet-restart 14, fleet-continue 1, fleet 8; 223 app tests). Follow-ups: A8. |

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
| ~~Yes or no on the protected fleet files~~ **yes, 2026-11-13, for A5 and I7 only.** Each gets its own reviewer. The gate line `if (verdict.proven === true)` is never touched. Every other thread keeps the boundary. | A5, I7 | no longer blocked |
| ~~Daytona API key~~ **received 2026-11-13** (`DAYTONA_API_KEY` in `spike/.env.local`). API URL: `https://app.daytona.io/api`. The owner said yes to Daytona use on their account (2026-11-13). | J1, I1 to I6 | Waves 1 to 3 are not affected |
| ~~A classic GitHub token, read-only~~ **received 2026-11-13** (`GITHUB_TOKEN`). The token has no scopes: it reads public repos only. `hemaaanth/touchstone` is private, so the live proof needs a public repo of the owner as its target (open question), and Legitify org checks will be thin. Second new token received 2026-11-13: it reads `hemaaanth/touchstone` (repo, contents, pull requests, Actions workflows: HTTP 200). Branch protection answers HTTP 403 with "Upgrade to GitHub Pro or make this repository public": a GitHub plan limit for private repos, not a token gap. The token is complete. Checked 2026-11-13: the RPC URL answers chain id 1, the Daytona key is accepted (HTTP 200), the GitHub token is accepted. | G3 live path (Scorecard API, Legitify), G9 | no longer blocked |
| A read-only cloud credential (AWS) | G8, 5 tool rows | Stays blocked |
| ~~A fork RPC URL~~ **received 2026-11-13** (`MAINNET_RPC_URL`; local fork only, no transaction). The same key works for other chains: change the chain id in the path (`…/standard/evm/<chain id>?key=…`). | Stader fork work | no longer blocked |
| ~~Yes to close PR 3 on GitHub~~ **yes, 2026-11-13: close PR 3 when PR 4 is merged** | H1 tidy-up | no longer blocked |
| An eye on the UI work | B, C, D, E, F | Merges on review + screenshots; the owner checks the morning page |

---

## A. Runs: durability and follow-ups (bugs)

| ID | State | Item |
|----|-------|------|
| A1 | done | **"The run stopped unexpectedly" (code `no-settle`).** The ENS metadata-service run died before it settled ($0.60 spent). Find the real cause in that run's stderr and events. Fix the cause, not only the card. Source: `app/server/runs.mjs:898`. Cause found: the worker called `process.exit` before the long `settled` line left the pipe. Candidate `fix/run-continuity` `6a95a1e`; reviewer `thr_itmcnmnnku`. Review of `6a95a1e`: A1, A3, A4 met, A2 partly met (as accepted). NOT READY for two Majors: (1) the kept-workspace delete and reuse trust the path in the record (`runs.mjs:1025`); (2) a kept live AI/MCP workspace keeps the credential after the run. Repair round 1 done at `0fcb174`; delta re-review by `thr_e5hdgh5re9`. Merged `c57c2f1`. The coordinator's live check is still to do. **Live check 2026-11-13 on main `d286037`** (solo Code review run on the ENS scope, $1 budget, $0.13 spent): the run settled as `no-finding` with no `no-settle`; the workspace record exists and `vendor/` is kept; a follow-up listed the kept sources (71 files) with no `workspace` event. Not done live: delete the folder and follow up (rebuild), Run again on a failed run, a follow-up on a generated lab run. Found in the chat: B8. |
| A2 | done | **Sources are gone after Run again or a follow-up.** The agent said "Sandbox is fresh: sources are gone". Reopening rebuilds the workspace (`prepareWorkspace`) but code fetched into `vendor/` at run time is not restored. Chat history, sources and leads must all survive. Same root as old tester MAJOR 5 (live follow-up fails after a sandbox rebuild). Partly met in the candidate: the workspace is kept; a lost one is rebuilt and said in one `workspace` event. Same-commit restore needs `fetch.mjs` to record commits (new task A6). |
| A3 | done | **Follow-up is refused on runs with a generated lab** ("this run's lab was generated for that run only…", `runs.mjs:1076`). A finished run must accept a follow-up. Keep or rebuild the same lab. Never tell the user the run "marked itself done". |
| A4 | done | **Run again must keep context.** Checked in code: "Run again" already continues the same run and the same chat (it sends a follow-up). The loss came from A2 (the reopen rebuilt the workspace). So A4 is a test inside thread 1a: after Run again, sources and history are still there. No owner decision is needed. |
| A6 | todo | Same-commit restore of a lost workspace: `spike/lib/fetch.mjs` records the commit of each fetch; a rebuild checks out the same commits. Also decide: reach on a follow-up of a live-target run (owner question). Wave 3. |
| A7 | done | 1a review minors: a damaged scope store reads as "scope gone" (`app/server/runs.mjs:1128`), so a kept workspace is deleted with a false reason; no test for the path check in the boot clean-up (`runs.mjs:1145`); the mark put-back follows a link (`runs.mjs:1052`, use `wx`). With the 1a author `thr_txmsg8rqzb`, branch `fix/run-continuity-minors`. Review READY (`thr_e5hdgh5re9`). Merged `a0c9330` (24 run-continuity tests). |
| A8 | todo | 2h review minors: a stream can relabel a proven finding at recovery (the check matches only the finding number; also compare `poc` or the title; `app/server/runs.mjs:1809-1812`); the cut-off card says the run keeps "its files" when the workspace is gone (`runs.mjs:1775-1777`); no run-level note for a cut-off fleet that had submitted findings; three test gaps (the owner-lock check in the follow-up branch `runs.mjs:2090`, an old-form record matching any finding id, a solo run skipping its agent restart). Wave 3. |
| A5 | done | Fleet runs do not survive a server restart. Needs a change in `coordinator.ts`, which is inside the boundary. The owner allowed it for this task (2026-11-13). Starts after thread 1a merges (wave 2, thread 2h). Own reviewer; the gate line is never touched. Merged `6ddfc7f`. No diff in the three protected files. Know: for a live scope the boot proof check sends the replay's real requests to the live target with nobody watching, as a solo run on main already does. |

## B. Run view polish

| ID | State | Item |
|----|-------|------|
| B1 | done | Run header: drop the status word ("Failed", "Running", "Proven"). The dot says it. Keep the word for screen readers and in the dot's tooltip. Candidate `ui/run-view-polish` `984fc07`; reviewer `thr_vw5bjhk5kb`. |
| B2 | done | Chat start jitter: the first box turns into an indented "tool scan" dropdown. Make the start of a run one calm, stable layout with no jump and no odd indent. |
| B3 | done | The side panel changes width when it opens and closes. Same width in both states. Review of `984fc07`: the 320px folded panel now covers chat content at 1184 (and at 1440 with the sidebar). Repair round 1. |
| B4 | todo | Top-left "Touchstone" header is sticky at the same height as the run header but has no bottom rule. Add the rule so both line up as one bar. |
| B5 | done | Finding pills show two status words ("Critical" + "Waiting"). Use icons and one indicator. Easier to scan. |
| B6 | done | Error states: use the assistant-ui error-state and tool-error patterns (https://www.assistant-ui.com/elements/error-state, https://www.assistant-ui.com/elements/tool-error). Sentence case, proper copy, in the theme. No flash or jitter when the user presses Enter. Review of `984fc07`: a refusal slower than 180 ms still flashes a message and a Thinking row. Repair round 1. |
| B7 | done | Run Info panel: modules and model are a plain text list. Modules become colored pills (see C1). Model reads cleanly. With the 1c author `thr_hvptu9ii6r` on `ui/run-view-followups` (B4, the sidebar rule, still waits for PR 7). Merged `2bd4d20`. B4 (sidebar rule) still waits for PR 7. |
| B8 | done | **The closing text shows twice, cut, and below later replies.** Found in the 1a live check. (1) `spike/agent-run.mjs:106` cuts each assistant text at 4000 characters, so the `final` of a `no-finding` run ends mid-word ("**medium — src/utils/abo"). (2) `app/src/components/thread-model.ts:244` adds `state.finalText` at the END of the thread whenever the status is `no-finding`: the full streamed text is already above it, so the summary shows twice, and after a follow-up the cut copy sits below the follow-up's answer. Fix: do not add the closing text when the stream already holds it (compare by prefix, as `repairFinalSay` in `app/src/lib/final-text.ts` does), place it where the run ended and not after later turns, and raise or remove the 4000 cut for the final text. After 1c merges (same files). Shots: thread storage `live-1a-06-followup-bottom.png`, `live-1a-07-followup-order.png`. With the 1c author on `ui/run-view-followups`. Done at `54340db`; review running (`thr_vw5bjhk5kb`). Review at `99d777d`: NOT READY, one Major: the closing-text check looks at all turns and agents (`app/src/lib/final-text.ts:28`), so a repeated follow-up answer can disappear and a child's text can suppress the coordinator's closing answer. B7 and B9 pass. Repair round 1 with the author. Repair done at `ddce940` (the check looks only at the turn that ended and the main agent's prose). Delta look running. Delta look READY. Merged `2bd4d20` (235 app tests). |
| B9 | done | 1c review minors: Escape also folds the Run Info panel when a finding tooltip is open (`run-panel.tsx:115`); Enter saves a rename but the input opens again (`run-chat.tsx:444`). With the 1c author on `ui/run-view-followups`. |
| B10 | doing | Run view: an agent that a server restart cut off shows "Failed" in red. Give it a neutral "Interrupted" look with the plain reason (red is for a proven finding or a destructive control). From the 2h report, section 9. With the run view owner after B7 to B9. With the run view author `thr_hvptu9ii6r`, branch `ui/interrupted-look`. |

## C. One design language

| ID | State | Item |
|----|-------|------|
| C1 | done | **Module pills with one fixed color per module.** The same module has the same color on every screen: run Info, Scopes, Modules, Settings, New run, Findings. One map in code. Restraint rules still hold: red and green stay reserved for proof. Candidate `99229ec`, reviewer `thr_ahkvy8efbw`. Merged `3538912`. The map, the pill and the Scopes use are done; Modules, Settings and run Info adopt it in 2a, 2b, 2c. |
| C2 | done | Tooltips are bright white and off-theme. Fix the tooltip component once for the whole app. |
| C3 | done | One list pattern for Scopes, Modules and Settings: the bb Settings list (title, one muted line, "+ Add" at the top right, one bordered card, rows with icon, name, badges, muted meta, "…" menu, no per-row expand toggle). Merged `3538912`. Usage note: `app/docs/restraint.md` and section 7 of the 1b report. |

## D. Scopes

| ID | State | Item |
|----|-------|------|
| D1 | done | Redesign the Scopes page in the C3 pattern. No layout shift on open. Modules as C1 pills. No row has a dropdown that others lack: every row behaves the same. |
| D2 | review | **Scope brief in the scope, not in the repo.** Today Touchstone writes a `BRIEF.md` into the run workspace (the repo does not need one). The owner wants a brief field on each scope, edited in the scope's settings, and applied to every run of that scope. The run view should not show "Read BRIEF.md" as if it were a repo file. |
| D3 | doing | One multi-module run: ticking several modules builds one run, not one run per module. Needs one paid run to prove it (owner's yes). The split per module is in `app/src/App.tsx:68-95` (`onStart` calls `startRun` once per module). Design: a joined pack `spike/packs/multi.mjs` with one sub-workspace per module. A safety filter stopped the author's edit of `packFor`; an omp DSF4.1-A helper made that one edit (`672ee3a`); the author continues. Engine part done by the omp author at `83c908c` (`prepareMultiWorkspace`, joined instructions, 11 tests); engine review running (`thr_2i3b5vurjf`, Claude); the first author (`thr_ydsrcwc7k8`) now does the app part, including the kept-workspace scrub for the `modules/<id>` layout. The safety filter stopped the first author a fourth time, after a read-only step; that thread is closed. The omp author `thr_f73xqn85xc` now also does the app part. Engine review (`thr_2i3b5vurjf`): NOT READY. Blocker: the engine does not check the scope's module list, so a joined run can include a module the scope does not allow (and a lab is copied for a second module). Majors: tool descriptions and results keep old tool names; one module's duplicate check refuses another module's finding; pre-pass leads leak across modules; the credential scrub advice for kept workspaces is incomplete. The one-module path is byte-identical to main. Repair with the omp author before the app part goes on. Engine repaired and app part written at `9ad56d8` (the engine refuses a module the scope does not allow; one request, one run, one budget; the kept-workspace scrub walks every sub-workspace; multi-pack 17, run-continuity 27, 229 app tests). Full review running (`thr_2i3b5vurjf`). No paid run before a READY verdict. |

## E. Settings

| ID | State | Item |
|----|-------|------|
| E1 | done | Daytona row: a much shorter description. No region in it (`us-west-3` is hard-coded as a default in `spike/lib/daytona.mjs:58`). Move the access notes into an info icon next to the word "Daytona". No tooltip plus small text at once. |
| E2 | done | Daytona needs its server URL and region (target) as settings next to the key. Not every account uses the default server or `us-west-3`. |
| E3 | done | Add provider dialog: remove the box inside the box. |
| E4 | done | Provider rows and the provider edit form look broken: off layout, the base URL is cut off. Redesign in the C3 pattern. |
| E5 | done | Modules page redesign (no "Pipeline", no tool lists, C1 pills, C3 list). Settings page in the same language. Modules page merged `a63c224` (2b). Settings page is 2a, in review. Settings merged `d286037` (2a). |

## F. Findings page (new)

| ID | State | Item |
|----|-------|------|
| F1 | todo | A "Findings" item in the left sidebar. One table of findings across all runs: title, severity, proof state, scope, module, run, date and time. Sortable. Filterable by scope, module, severity, state and date. |
| F2 | todo | Each row opens the full finding. Copy buttons: the report as markdown, and a short "for an agent" copy. Copies go through the report redaction (cloud PR 7), so F waits for PR 7 or uses its rules. |

## G. Toolkits (paused branches; tool rows 69 of 86)

| ID | State | Item |
|----|-------|------|
| G1 | doing | Domains: checkdmarc, testssl.sh, DNSViz (`pack/domains` 523778a). Delta review only. +3 rows. Started 2026-11-13 after 1h: author `thr_nna9n8xi6f` merges main (conflict in `live.mjs`), puts the three tools behind the 1h reach filter, and closes L17, L18 and the stale docs. Author done at `eafec6e`: merged main; the three tools sit behind the 1h filter; katana runs through the scope proxy (L17); the skipped subdomain discovery row (L18); stale docs fixed. The testssl.sh image is missing on this host: the coordinator granted the pull of that one pinned image through `setup.mjs`. Then a Claude review. The pinned testssl.sh image is pulled (`--only=domains --pull-only`, one image); `domains-live-tools` 3/3. Head `d966133`. Review running: `thr_yn5vstx85s` (Claude). Head now `f3b3929` (main merged). Review at `f3b3929` (`thr_yn5vstx85s`): NOT READY, one Major: testssl.sh's Winshock check runs `curl` on the host name, so `--ip` does not bind it and a hostile host can get a GET to an unchecked address (proved offline). checkdmarc, DNSViz and katana through the proxy are met. Repair round 1: pin the name with `--add-host`, list every such path in testssl.sh, and a lab test that proves the boundary. |
| G2 | done | Web: Schemathesis re-review; jwt_tool needs a JWT surface in the lab (`cov/web-tools` ea9b50c). +2 rows. Thread `thr_pfkgpt8m6n`. Head `406e63b`: jwt_tool wiring finished. Two images and the lab image were never built; the author now builds them and reruns the skipped tests. Head `c06344d`: images built, in `setup.mjs`, smoke shows `jwt-tool:ran` and `schemathesis:ran`, no skip. Reviewer `thr_9a9qf8rqq2` (Claude; the codex reviewer `thr_7jsxbcjdk7` was blocked by its provider). Review at `c06344d` NOT READY (`thr_9a9qf8rqq2`): Schemathesis calls a partly errored run a clean `ran`. Repair round 1. Repair round 1 done at `2981931`; delta re-review running (`thr_9a9qf8rqq2`). Delta re-review at `2981931`: NOT READY. The reason of a partly errored run is on disk but never on screen (`prepass-view.mjs:46`, `prepass.tsx:86`). Repair round 2 with the author: show the reason of a `ran` row, three minors, and the lab container leak (L15). Repair round 2 done at `e3dae16` (a `ran` row shows its reason on screen; minors A to C; lab teardown in four tests). Delta re-review 2 running (`thr_9a9qf8rqq2`). Delta re-review 2 READY at `e3dae16`. Main moved (G4, 1c): the author merges main and joins `prepass-view.mjs`, `setup-manifest.test.mjs`, `setup.mjs`, `prepass.tsx`; then a short look at the merge, then merge. Merged with main at `c721519` (four files joined; one ai-mcp test that the view change had broken is fixed; garak row text). A short look at the merge runs (`thr_9a9qf8rqq2`). Merge look READY at `c721519`. Merging next. **Merged** into main `ce66708` (14 view and web test files green on main; 223 app tests). |
| G3 | done | Supply-chain: Scorecard + capture mode + Legitify re-review, 3 minors (`cov/supply-networked` 52ac84d). Started 2026-11-13 after 1h: author `thr_izzpzxdwjc` merges main, checks the capture gate against the 1h grant binding, token handling and fail-closed rows. Then a Claude review. Author done at `7a148cb`: capture now reads the scope and its own grant from the stores (15 checks, each with a test); token leak tests; fail-closed rows; `wrap.mjs` equal to main. Trade-off: `codeload.github.com` is not in a scope's grant, so some Scorecard checks will be gaps. Review running: `thr_4ifzfj4hfd` (Claude). Review READY at `61a96bb` (`thr_4ifzfj4hfd`; 23 mutations, 21 fail a test). The author merges main (`THIRD_PARTY.md`) and fixes five minors (a Scorecard score below the maximum with no detail is a gap; hex token forms; true reasons for a damaged store; one test gap; help text); then a short delta look, then merge. Delta look READY at `28f86ff`. **Merged** into main `2f2e89f`. Known gaps: no real capture was run (forbidden in review; two images are not on this host); `codeload.github.com` is not in a scope's grant, so some Scorecard checks are honest gaps. |
| G4 | done | Contracts: Halmos + Chimera. Timeout tests must fail when clean-up is removed; THIRD_PARTY.md conflict (`cov/contracts-symbolic` a2573ad). +2 rows. Thread `thr_h5uneut59c`. Head `901db64`: timeout tests repaired, Halmos gap fix. The two images were never built on this host; the author now builds them, adds them to `setup.mjs`, and reruns the skipped tests. Head `067c51d`: images built, in `setup.mjs`, `declared()` fixed, no skip. Mutants T2 and T3 survive (reviewer decides if `wrap.test` covers them). Reviewer `thr_yni3ut72br`. Merge after G2: both add `spike/test/setup-manifest.test.mjs`. Review at `067c51d` NOT READY (`thr_yni3ut72br`): strings hide properties; a property imported from outside the suite folder loses its counterexample; a CLI record drops both tool rows. Repair round 1. Repair round 1 done at `528b00a` (one shared Solidity scanner; Chimera bound to the `CryticTester` inheritance graph; prepass view keeps both rows); delta re-review running (`thr_yni3ut72br`). Delta re-review at `528b00a`: NOT READY, two Majors: a CR-only source file loses its Halmos checks in silence (`solidity-source.mjs:25`); a struct literal in a base constructor argument makes Chimera drop every result (`chimera.mjs:120`). Finding 3 met. Repair round 2 with the author. Repair round 2 done at `9b8a1ae` (CR, LF and CRLF line ends; header brace found outside parentheses; engine results the scan did not bind are gaps). Delta re-review 2 running (`thr_yni3ut72br`). Delta re-review 2 at `9b8a1ae`: NOT READY for one Major (a `layout at` clause in the contract header drops every Chimera result). Repair round 3 done at `58ad508` (header read by its parts; when the binding is short, an unbound failed test stays a lead with a note). Delta re-review 3, the last, running (`thr_yni3ut72br`). Delta re-review 3 READY at `c6ec4cb`. **Merged** into main `80ed976` (halmos 21, chimera 30, prepass-view 9, setup-manifest 4 on main). Follow-up: `$` in source identifiers (the guard already keeps the lead). |
| G5 | todo | Candidate tier: Major A part 3 and 3 minors (`feat/candidate-tier` eec42f1). |
| G6 | todo | Contracts vacuity gate: Major 2 and 4 minors (`pack/contracts-vacuity` 2320d53). Kill-rate bar is an owner decision. |
| G7 | done | Part A merged `d1caa23` (Heimdall comment and licence note). Part B merged `f723d57` (`fix/wave-spend-cap` `51fce60`): Strix cap check reserves budget plus one worst turn; a model with no price is charged at the fallback prices. Review READY after one repair round (`thr_yzqyhqy2tj`). Known gap stays: up to six unrecorded attempts before a response header (comment in `provider.mjs`). |
| G8 | blocked | Infra-cloud live path, 5 rows: needs a read-only cloud credential. |
| G9 | todo | chain-bench and raven: both take the GitHub token only as a command-line flag. Plan: a small entrypoint inside each image reads the token from the environment and passes the flag inside the container, so the token never shows in the `docker run` line. Live proof needs the GitHub token. |
| G10 | todo | Old queue: 3 missing tests + 1 legacy-run gap (large-repo review); a test that the lab network is internal; 2 PR 1 minors; live batch 2; prove the best ENS leads offline; test the 12 assumed overlap skips. |

## H. Cloud PRs

| ID | State | Item |
|----|-------|------|
| H1 | done | PR 4 (harm gate), `merge/pr-4` `4915bde`: re-review NOT READY (`thr_qxi2n9w6dn`). Three bypasses inside the claim (cheatcode by STATICCALL, prank in a reverted frame, delegate prank as the token) and `mockFunction`. None is a regression: `main` proves all of them, and the candidate already stops 10 forged cases that `main` proves. Repair round 2 with author `thr_sfn46di74u`. PR 3 is its twin; close it when PR 4 merges. Repair round 2 done at `0bc016f` (81 harm-gate tests); delta re-review running. Merged `5462181` (81 harm-gate tests). Follow-ups H1b, H1c, H1d. |
| H1b | todo | Harm gate, tamper class: `vm.store` and `vm.mockCall` on a scope target forge a drain (also on `main`). Needs a rule that keeps real PoCs that use `vm.store` for fixture. Plus a backstop for unknown cheatcodes (a call whose caller is not its parent frame). Own reviewer. Wave 3. |
| H1c | todo | A PoC body that calls forge-std `deal(token, …)` makes more than 8 MiB of trace and can never be proven (`sandbox.mjs:237`). Fails closed, but costs true positives. Raise the cap or tell the agent to put `deal` in `setUp`. Wave 3. |
| H1d | todo | PR 4 review minors: (n1) no test for `cloneAccount` and `mockFunction` recorded when not kept (`spike/lib/control-trace.mjs:175`, `:182`); (n2) a plain `etch` is dropped when the trace says it was not kept: record every etch with a `kept` flag and let `judgeHarm` delete the target for every etch, so the gate does not depend on how forge journals an etch; (n3) `refuse()` replaces every reason with the impersonation reason: append the base reason. Wave 3. |
| H2 | review | PR 7 (report redaction), `merge/pr-7` 5265d20: author done (10 commits after the merge with main, 246 app tests pass). Final delta review (`thr_tjjx45bfz5`): NOT READY, three blockers confirmed by the coordinator: quadratic time on four paths, a 0x address masked in assignments, flags and queries, and a new leak for word-shaped secrets under `…secret`/`…password` names. Repair round sent to the author `thr_vwfuw9z46v`. Open by design: JSON escaped three or more times (see H2b). Blocks F2. Repair done at `67d853e` (all three blockers, M1, two minors; 326 app tests; 0 of 5121 real report strings change). The author found a fail-open: above about 400 KB in one value Bun's regex engine gives up in silence and the value is not masked. One more fix with the author (redact in pieces at line ends; a line over the cap is masked whole). Then a delta re-review by a new reviewer. Large values now fail closed at `2810e64`: a text over 64 KB is redacted in pieces cut at line ends, a longer single line is replaced whole, and a canary line per rule catches a rule that gave up (357 app tests; 0 real strings change). Review running: `thr_cm7y78af9r` (a new Claude reviewer; the earlier one wrote a patch). Review at `3b53521` (`thr_cm7y78af9r`): NOT READY, one blocker in the new large-value code: a secret that crosses a 64 KB cut comes out unmasked (`Bearer` + line end + token; a quoted value with a raw line end); 7 inputs and a fuzz prove it. All of rounds 1 and 2 holds. Repair round 3 (the last): a cut must be proven safe by redacting a joined window, and the fallback fails closed. Repair round 3 done at `a0efdd8` (a cut is used only when 4 KB on each side redact the same joined as apart; no safe cut means the run is held whole; 200-text seeded fuzz, 0 leaks; 380 app tests). Delta look running (`thr_cm7y78af9r`). |
| H2b | todo | Follow-up to PR 7: redact JSON at every escape level by decoding each level, instead of one regex per depth. Wave 3. |
| H3 | todo | PR 6 (replay bundle), `merge/pr-6` 2e51648: Major 7 and leak classes. After PR 7. |
| H4 | parked | PR 8: the owner decided 2026-11-13: it stays parked. No work. |

## I. Browser and free-roam agents (plan page v5)

| ID | State | Item |
|----|-------|------|
| I1 | todo | Persistent root sandbox per free-roam agent (Daytona). |
| I2 | todo | Egress request log. |
| I3 | todo | Playwright browser tool with HAR capture. |
| I4 | todo | Ask-the-human flow in the fleet, with manual takeover through the sandbox desktop view. |
| I5 | todo | Wallet and email loadout options. |
| I6 | todo | Session capture (HAR, shell transcript, screenshots) in the candidate record. Needs G5. |
| I7 | todo | Per-agent loadouts. Lives in the protected fleet files. The owner allowed it for this task (2026-11-13). Wave 4. Own reviewer; the gate line is never touched. |

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
| K4 | todo | Remove old worktrees after their branches merge. Also: a kept workspace with a missing or wrong mark file stays in the temp folder as an orphan (from 1a repair round 1); 193 old `redteam-run-*` / `touchstone-supply-*` folders are in the temp folder. |
| K6 | done | One spike test fails on `main` (also before the base commit): `oz-monitor.test.mjs`, "a monitor run that times out…". The monitor now finishes inside the 1.5 s limit, so the timeout never fires. Fix the test so it does not depend on speed. Goes to thread 1e. Fix `1c378a1` on `fix/green-suite` (the test pauses the lab chain). Reviewer `thr_ry8aamkj9q`. Reviewed READY (thread `thr_ry8aamkj9q`: two mutations fail the test, full suite 940 / 936 pass / 0 fail / 4 skipped). Merged as `afce9fc`. |
| K5 | todo | Re-check old tester MINOR M1: the proof drawer hides harm numbers. |

## L. Base security repair (from the K1 review)

The review of the base commit found real defects. Most are older than the base commit, but the base makes them matter more. Report: coordinator thread storage, `thr_xikyvziytr/review.md`.

| # | State | Item |
|---|-------|------|
| L1 | done | **Every console write needs the token.** Today run create, steer, stop, archive, rename, delete and scope delete take no token. A web page on another site can start a run with a plain form post. Thread 1g `thr_fm47pnz5hm`, branch `fix/console-auth`. Candidate `fix/console-auth` `6b472f7`; reviewer `thr_ck6iq7pe6r`. A non-JSON body gets 415 (accepted). Review: READY. No write reached a handler without the token; the tunnel gives 401 without a bb sign-in. Two test fixes go in before merge (a test fails where `app/dist` exists; a test to pin the `Host` rule). Merged `9c68b3a`. The owner's dev server on 5188 runs the guard now. Open check: one write by the owner through the tunnel link. |
| L2 | done | **The token in the page can be read from another `localhost` port.** Vite's default CORS allows it. Also keep the token out of a build output. Thread 1g. Limit that stays: a local process or an admitted tunnel client can read the token from the page; an operator login would close it (not built). |
| L3 | done | **The token is written to the server log** on the first grants read. Remove it. Thread 1g. |
| L4 | done | Token compare in constant time. Thread 1g. |
| L5 | done | **Domains, Surface and Phishing can leave the scope.** They are on for every website scope, and their capture tools use the open Docker network, not the scope proxy. They can probe a private address or a host with no grant. Thread 1h `thr_wusej9fdjz`, branch `fix/reach-stores`. Candidate `a2c1c3e` in review. Limits from the author: katana has no private-address stop of its own; subdomain discovery now needs a `*.` grant entry. Merged `3eae9f8`. The katana limit is L17 (with G1). |
| L6 | done | **A run can get a wider grant.** The gate takes any grant that covers the host, and allows every host of that grant. Bind a scope to its own grant. Thread 1h. Candidate `a2c1c3e` in review. |
| L7 | done | **A broken store file loses data silently.** Scopes and grants: atomic write; refuse to change a file that cannot be read. Thread 1h. Candidate `a2c1c3e` in review. |
| L8 | done | **A tool run can build an image** (Domains). It must fail with "run setup" instead. Thread 1h. Candidate `a2c1c3e` in review. |
| L9 | todo | Setup pins: Foundry uses `latest`, eth-security-toolbox uses `nightly`, other images have a tag but no digest. Pin by digest in the setup script and at run time. Wave 3. |
| L10 | todo | A refused rename or archive shows no message (`app/src/App.tsx:133`, `:144`): the title goes back and nothing explains it. Show the refusal text in the existing error slot. Can fire after a token change, now that these writes are guarded. Also: the Settings refusal line moves the page 36 px. From the 1g review. Wave 2 (with 2c). |
| L11 | todo | The console token in `spike/data/console-token` never changes. A leaked token stays valid until the file is removed. Add a rotate action or rotate on a schedule. From the 1g review. Wave 3. |
| L12 | done | `TruncatedText` (`app/src/components/page-parts.tsx:323`) cannot take keyboard focus, so a keyboard user cannot open the full-value tooltip. Make an overflowing value focusable; keep fitting text out of the Tab order. From the 1b review. Goes with 2a (Settings URL uses it). |
| L13 | doing | `AddScope` (`new-run-dialog.tsx`) has no `defaultOpen` / `onClose`; the Scopes page clicks it open and watches the DOM. Give it a controlled open API. From the 1b report and review. Wave 2 with 2d. |
| L14 | todo | `spike/scripts/setup.mjs`: `--only web,contracts` (space form) is not read, only `--only=a,b`; the `strix` entry points to a missing `tools/strix/Dockerfile`; `node:20-slim` is not in the manifest. From the G4 report and the G2 review. Wave 3. |
| L15 | done | **Lab containers leak.** 44 pairs of `touchstone-lab-*` / `touchstone-proxy-*` containers (and their `touchstone-inner-*` networks) were running on the host on 2026-11-13, the oldest 6 hours old. Name source: `spike/lib/proof-http.mjs:167` (a PR 8 file). Find which path does not tear the pair down (a killed test, a timeout, a thrown error) and fix it; add a test. Each pair uses about 5 MB, so it is not the memory problem, but the Docker address pool is finite. Removal of the old pairs needs the owner's yes. Wave 3 with K4. Cause found by the G2 reviewer: `prepass()` starts a lab (`spike/packs/web/pack.mjs:621`) and the web tests (`web-schemathesis`, `web-jwt`, `web-arjun`, `web-ffuf`) only call `cleanupWorkspace` in `finally`. The G2 author adds the teardown in all four (repair round 2). Fixed with G2 (`ce66708`): the four web tests tear their lab down; on main the count went from 48 to 46 during the web test run. The old pairs on the host stay until the owner says remove. |
| L16 | todo | Modules page: send each pack's own description through `packList` (`spike/packs/index.mjs`) and remove `MODULE_TESTS` from `app/src/lib/catalog.ts`. From the 2b report. Wave 3. |
| L17 | doing | **katana has no stop at connect time** (1h review F1, Major follow-up). A granted host with a short TTL can pass the dnsx check and then answer a private address when katana resolves it again (`spike/packs/domains/live.mjs:316`). Fix: send katana through the run's scope proxy; pass `reach.confine` from `domains/pack.mjs` and `surface/pack.mjs`. With G1 (`thr_nna9n8xi6f`). |
| L18 | doing | With an exact-host grant, subdomain discovery is skipped and nothing says so (1h review F2). Add a `skipped` coverage row that names the `*.` grant entry. Also the stale docs (F3). With G1. The New scope form should also explain `*.` entries (wave 2d). The form part is real work, not text: see the 2d repair (the form dropped every `*.` entry). |
| L19 | todo | Tests that import `grant-store` read or create `spike/data/console-token` at load (1h review F4). Set the token env vars before the import. Wave 3 with 3b. |
| L20 | todo | Stores, small gaps (1h review F5 to F8): no lock between two processes that write a store; the folder is not fsynced after the rename; a live target with no saved `permission` still uses any covering grant (`reach.mjs:108`); `scriptUrls` checks the host but not the port; a damaged store shows as an empty list in the app. Wave 3. |
| L21 | done | 2a review minors: an env Daytona key goes to any host saved in Settings (`spike/lib/daytona.mjs:82`); an `http://` env URL gets the key in clear text; three test gaps (the saved URL is really used); a key held for another host cannot be removed; the budget hint and spend-cap lines turned red (restraint); Save stays enabled after a host change with no new key. With the 2a author `thr_hy9krv3ri8`, branch `ui/settings-minors`. Author done at `6baa137` (14 daytona-config tests). Review running (`thr_8xurh9f9p3`). Review READY. Merged `4497373`. |
| L22 | done | `GET /api/settings` (no console token needed) returns `DAYTONA_API_URL` in full, also when it holds a user name and password; the page shows it. Return scheme, host, port and path only; check provider base URLs for the same shape. Plus one missing test (`saved` flag) and one Save edge case. From the L21 review. With `thr_hy9krv3ri8`, branch `ui/settings-envurl`. Review at `34a34a1`: NOT READY, one Major: the Fetch models error text returns the hidden URL parts (`app/server/settings.mjs:408`). Repair with the author; also added: a provider's saved API key goes only to that provider's saved base URL. Repair done at `53c18ff` (one scrub in `spike/lib/redact-url.mjs`, used by settings, Daytona, `inference.mjs` and `provider.mjs`; provider key bound to its saved base URL). Delta look running (`thr_8xurh9f9p3`). Delta look at `53c18ff`: NOT READY. Blocker: a state named `keyNote` shadows the function `keyNote()`, so opening any provider's edit sheet blanks the app (`settings-page.tsx:441`). The server side is met. Repair round 2 also closes a two-write bypass (a save that changes a provider's server drops its saved key). Repair round 2 done at `36b1f8e` (sheet fixed; a save to another server drops the saved key; an env key goes only to the built-in URL, bound in `providerKey()`; gentler scrub). Delta look running; the env-key binding is a run-path change and gets a hard look. Delta look READY at `36b1f8e`. Behaviour change to know: a built-in provider saved on another server with only an env key gets no key (the owner's three providers are not in that case: checked on the dev server, no values read). Merging next. Minor left: the run error for a held env key says "set NEARAI_API_KEY" though it is set (`spike/lib/inference.mjs:33`). **Merged** into main `585f63f`. Dev server restarted: all three providers still have their key, none held. |
| L23 | done | **The type check in the rules checked nothing.** `bunx tsc --noEmit -p .` passes always: `app/tsconfig.json` has `"files": []`. Found by the L22 reviewer (2026-11-13). The real check is `bunx tsc -b --noEmit`. Rules corrected; main has 0 errors with the real check on all three configs; the open branches of 2d, 2e, 2h, PR 7, G2 and the 1c follow-ups also have 0. Every thread was told. **Full spike suite on main, 2026-11-13:** 101 files, one at a time: 1190 pass, 0 fail, 7 skipped (files up to `nudge-ending` on `9e6729b`, the rest on `6ddfc7f` after the 2h merge). Log: thread storage `full-spike-main.log`. |
| L24 | todo | No tsconfig includes `app/tests/*.ts`: `bun test` runs those files but nothing type-checks them. Add `tests/**/*.ts` to `app/tsconfig.test.json` and fix what it finds. From the 2d author. Wave 3 with 3b. |

## Owner decisions (open)

safe-hash-rs licence · GPL-3.0 package in the Mythril image · vacuity kill-rate bar · candidates for packs with no proof model · Stader fork exception + RPC URL · fleet restart (coordinator.ts) · free-roam loadouts (fleet files) · infra-cloud credential · Daytona step 0 · a paid run for D3 · the 22 run files.
