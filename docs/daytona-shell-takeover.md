# Daytona shell takeover

The clean starting point is `f8aa7b6`. The primary checkout's `main` and
`origin/main` matched exactly before this work. The primary checkout was clean.
At that starting point, port 5188 was stopped and unshared. The immutable
5190 release used that commit and its existing private state. The verified
runtime release is now `abca2b4`, as recorded below.

The previous coordinator's historical handoff is at
`b2d391e:docs/HANDOFF-2026-11-14.md`. Its Frozen and owner-repair status is
superseded by this thread's verified deployments. Do not merge the overlapping
owner-repair backups wholesale. All supported product model families remain
available; DeepSeek-only applies to agent-initiated live inference tests.

## Delivery order

1. Daytona free-roam shell readiness and repeated-create prevention.
2. Strix provisioning and honest tool availability.
3. Reconcile the approved APP repair and finish the preserved capacity, inline
   Ask and UI changes. Browser/capture extras and removed wallet/email work must
   not delay the shell repair.

Use one running product instance. Temporary isolated test servers are allowed
only for verification and must be removed afterward. Do not restart 5190 during
an active run. Keep credentials, targets and runtime state out of fixtures.

## Verified milestone — 2026-11-14

Runtime release: `abca2b4030ecafa42a498947e152d4ec92ae1731`.
The implementation is committed and was pushed to `origin/main`. Both the
primary main checkout and the takeover checkout were clean at verification.
The documentation update containing this section does not change runtime code.

- Daytona: selected an available built-in container snapshot in `us`; fixed
  startup handling and the root shell entry. A real disposable test passed
  prerequisites, the managed supervisor and loopback egress checks. Deletion
  was confirmed before readiness became true. Readiness survived app restart.
- New run: fixed the terminal setup polling race. The production browser showed
  free-roam checked and Start enabled. The delayed-Settings synthetic browser
  flow also completed without a page reload.
- Strix: installed its separate CLI and sandbox images. Setup, readiness and
  runtime now use the same pinned sandbox reference. The real adapter and
  sandbox executed a harmless command with exit 0 using a synthetic local model.
  The run completed and its owned containers were removed.
- Final focused checks: 92 passed. Independent review cleared the final source
  candidate, including 26 setup/Vite checks and the polling cleanup check.
- Owner state: 12 runs preserved, zero active at cutover. Only product port 5190
  remained running; 5188 and temporary test servers were stopped.

Limits: no paid-model assessment or external target was used for this proof.
The current Daytona account rejected custom snapshot creation with HTTP 403;
that optional path has synthetic lifecycle proof, not a successful live build.
The available built-in snapshot is the verified working path.

## Remaining delivery slices

This reuses the historical handoff at `b2d391e:docs/HANDOFF-2026-11-14.md`,
the existing Ask UX and capacity maps, and the preserved candidate branches.
Prepared code is not treated as a shipped feature. Review each reconciled
candidate against current main before publication.

### 1. Run setup and navigation

- **Recognize a demo.** Group Your scopes and Demo scopes, with an explicit Demo
  badge. Preserve saved scope names and selection behavior.
- **Fill out a stable New run form.** Keep the fields in place when changing
  Fleet/Solo or module selection. Explain an empty module selection beside Start.
- **Edit the active execution backend.** Show consistent Local Docker/Daytona
  controls and keep the Daytona editor available when Daytona is already selected.

Existing candidate: `725be18`. It has author tests and browser evidence. It still
needs reconciliation with the new readiness controls and independent review.

### 2. Fleet capacity

- **Cover a larger scope.** Allow up to 50 lifetime child identities across both
  loadouts. This is a ceiling, not a target or an increased run budget.
- **Use more than one free-roam child.** Assign independent angles to separate
  machines when needed. Allocate machines lazily and retain the fallback child.
- **Continue an existing child at the cap.** Reuse its identity without consuming
  another slot; keep its history and shared Bulletin behavior.

Existing candidate: `95ee58f`. Focused cap/concurrency validation and independent
review remain. This does not establish a 50-machine quota or burst guarantee.

### 3. Ask Human inside the conversation

- **See the question where it belongs.** Put an Ask in its originating agent's
  chat, in event order, using the existing assistant-ui components.
- **See that an answer is sending.** Disable duplicate controls immediately.
  Keep the draft visible until the worker acknowledges the answer.
- **Keep accepted Q&A in history.** Show a bounded, sanitized receipt after a
  matched acknowledgement. Old history must not invent missing reply text.
- **Recover an uncertain answer safely.** Preserve the first possibly-sent
  answer; a late acknowledgement must never accept a different edited reply.

Existing candidate: `d5aef0f`, built on the earlier APP repair. Reconcile it with
`42a267a` first. Its stopped initial test run had dependency import failures and
no passing tests; combined acceptance and independent review remain.

### 4. Browser and human takeover

- **Use the built-in browser.** Finish the headed runtime/image integration and
  prove it on the actual free-roam machine.
- **Watch the agent.** Open a read-only desktop tied to the current worker and
  machine. Expired or retired sessions must stop working.
- **Take control for a human step.** Pause managed automation before enabling
  input. Ask Reply remains model-visible and is not a secret-entry form.
- **Release control and resume.** Close the viewer, revoke its preview and match
  the worker acknowledgement before resuming automation. Handle stop/restart and
  failed cleanup without opening access to a replacement worker.

Existing APP candidate: `42a267a`, independently approved in its original scope
but not integrated. Desktop image work is preserved at `b62300a`. The assembled
runtime and browser flow still need proof. These are later deliveries; the
current release explicitly keeps desktop routes disabled.

### 5. Reviewable session evidence

- **Keep the session evidence.** Collect transcript, HAR and screenshots before
  the machine is deleted. Mark failed transfers as partial.
- **Inspect the exact saved image.** Show the captured bytes and hash in a
  read-only viewer, rather than a replacement page or a new capture.
- **Release only the reviewed image.** Bind approval to the exact hash and
  current review session; reject stale machine or viewer identities.

Existing image transport candidate: `b656922f`, plus the capture contract in the
historical full-scope plan. Resolve the saved-image review/machine-deletion
lifecycle before implementation. These paths are not independently accepted as
an assembled feature. Session evidence must not bypass the proven-finding gate.

### 6. Final real-run acceptance

- **Exercise the whole free-roam run.** Follow an authorized run through child
  creation, useful work, follow-up, stop and cleanup. Live shell proof alone does
  not cover every end-to-end worker path.
- **Exercise Strix on an owned test target.** Use an explicitly bounded model
  and target run. Current proof covers real runtime execution with fake inference,
  not the quality or completion of a paid assessment.
- **Verify the assembled release.** Run focused checks and independent review,
  cut over only while idle, then verify the owner-facing flow on 5190.

Wallet/email remain removed from scope. Snapshot baking as a performance
optimization remains paused. Do not resume old agents or automation just because
their branches are preserved.

## Daytona implementation contract

The reported selection was `daytona-medium` in `us-west-3`. Do not guess a
replacement region or snapshot. Discover the account's regions and snapshots,
require complete bounded responses, and resolve names to exact identities.
Saving configuration remains local and never provisions.

Free-roam snapshot precedence is `TOUCHSTONE_ROAM_SNAPSHOT`, then saved
`execution.roamSnapshot`. The old default is a discovery suggestion, never a
verified selection. Confined `touchstone-exec-dind-v1` remains separate.

Metadata check and shell test are different operations. An active container
snapshot in the selected region passes metadata checks. Only an explicit
disposable test of the actual shell supervisor and local egress logger, followed
by confirmed deletion, makes it ready. No real target or model call is needed.

Prefer an existing compatible snapshot. When none exists, the explicit build
button must submit a fixed shell recipe through Daytona's remote
`buildInfo.dockerfileContent` API. No host Docker build, arbitrary command input,
local COPY/ADD context or CLI prerequisite. A recipe hash is not an image digest.

Keep paid-operation records separate from Settings. Reuse the existing store
lock, atomic replacement and fsync implementation, with mode 0600. Missing state
is empty; malformed existing state blocks new creates and remains untouched.
Persist intent before POST. Updates compare the expected phase. Preserve
unresolved records when the account, region or snapshot changes.

Bind readiness to API base, credential identity, region, snapshot metadata and
probe version. Store only hashes of credential bindings, never keys. Preserve
original captured clients for in-flight cleanup. A changed account cannot adopt
or delete an earlier account's machine. Legacy unbound records remain unresolved
unless their ownership can be established; never silently assign today's key.

A confirmed unavailable selection blocks all subsequent new creates with that
binding, including after restart. Generic rejection has a distinct status and
fixed error. Timeout is uncertain and never permission to POST again. Reconcile
by the persisted nonce; an empty eventually-consistent listing is not proof that
no resource exists. A runtime operation is scoped to run and child. One unknown
child must not consume a global machine slot.

Keep sidecar, retirement, closeRun, pending cleanup and existing control readers
compatible. The journal must retain ID-less intent even if the workspace is
removed. Preserve normal 60/240 minute runtime intervals and per-child isolation.

## Focused proof

- Known unavailable selection: 15 attempts, zero POSTs.
- First conclusive unavailable create: 15 attempts and a restart, one POST total.
- Save, status reads and new child/run IDs cannot clear invalid readiness.
- Timeout plus empty reconciliation cannot repeat the same create.
- Four and ten healthy children get distinct machines and reuse their own slots.
- Corrupt records, competing writers, stale results and changed credentials
  cannot lose intent or use the wrong account for cleanup.
- App admission rejects known unready free-roam before workspace/target/model
  work, after the spend gate. Cover restart, follow-up and direct callers.
- Full fake UI flow: save, discovery, selection/build, test, cleanup, ready.
- Independent review of the assembled candidate, then a controlled live shell
  test and confirmed cleanup before claiming Daytona works.

The full final suite is not the gate. Use focused isolated checks. Do not upgrade
dependencies or silently resume old agents or the paused delivery automation.
