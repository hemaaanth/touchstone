# Candidates, agent-evidenced findings, and deterministic proofs

Status: implemented in source; deployment is separate.

## Result hierarchy

Candidates are investigation ideas and observations. They have no count limit.
An open endpoint, an outdated version, existing spam, a scanner warning, or a
missing check does not by itself establish a vulnerability. Record the hypothesis
and the next test. Old candidates remain candidates; there is no automatic upgrade.

Findings & Proofs contains two verification methods:

- **Agent-evidenced · unverified:** the agent reports a demonstrated attacker
  capability and harm with captured evidence and reproduction steps. The framework
  has not independently verified the report. At most three per run, shared across
  all children and modules and retained across restarts/follow-up turns.
- **Deterministic:** the existing oracle, harm execution, or replay checks. These
  findings remain uncapped. Only the existing harm proof gate can mark one proven.
  A repeated configuration measurement still does not prove attacker harm.

Agent reports remain neutral in the UI. They cannot acquire a proven badge, an
oracle verdict, or a replay bundle by setting flags. Severity and verification
are separate. Completing a run with agent reports is `reported`, not `no-finding`.

## Agent tools

`record_candidate({title, hypothesis, next_test})` is a shared tool for the
coordinator, confined children, free-roam children, and solo runs. It needs no
machine or exploit evidence and records an investigation candidate.

The existing `submit_candidate` tools still attach captured attempt evidence to
investigation candidates. For compatibility the tool name stays the same. They
now have a finding-report mode: include `report` to submit an agent-evidenced
finding. The free-roam equivalent is `submit_session_candidate` with `report`.
Joined modules retain their existing tool suffixes.

The report requires:

- `reproduction_steps`: 2–12 concrete steps.
- `attacker_capability`: what an attacker demonstrated they can do.
- `observed_result`: what actually happened in the captured attempt.
- `harm`: actual harm and the limits on any potential harm claim.
- `limitations`: what remains untested or requires independent confirmation.

The submission still requires a real recorded attempt, 1–6 exact evidence lines,
severity, and the existing write-up ending with `Fix:`. Reports without those
fields or whose citations are absent from the captured evidence are refused.
Report completeness and citations are enforced in code. Whether the evidence
establishes the claimed vulnerability is the agent's judgment, clearly labeled
as unverified; these structural checks are not another oracle.

`candidate_poc` can link a report to an investigation candidate it promotes.
The `poc` must still identify the current recorded test. A successfully recorded
report removes that idea from the candidate queue. A deterministic finding for
the same attempt or root cause supersedes the agent report after its proof gate.
An attempt already recognized by an oracle must use `submit_finding` instead.

For example, existing spam posts remain an investigation candidate. Reproducing
an authorization bypass that lets an unauthenticated caller publish arbitrary
content can support a finding report, with the test steps, captured request and
response, demonstrated capability, harm, and limits.

## Persistence and compatibility

Agent reports use `agentFindings`, separate from `candidates` and the deterministic
`findings` replay queue. `agent-finding-submitted` and `agent-finding-superseded`
events preserve the live and reloaded view. Follow-up workers inherit the reports
and their shared cap. The Findings page includes agent reports as unverified
findings and opens their evidence in the run.

The sidebar places Candidates before Findings & Proofs. Agent reports contribute
to finding counts; investigation candidates contribute only to candidate counts.
Measured observations stay candidates. Existing stored runs and demo proof paths
retain their evidence and verification semantics.
