# Daytona shell takeover

The clean starting point is `f8aa7b6`. The primary checkout's `main` and
`origin/main` matched exactly before this work. The primary checkout was clean.
Port 5188 was stopped and unshared. The only running app is the immutable
5190 release at that same commit, using its existing private state.

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
