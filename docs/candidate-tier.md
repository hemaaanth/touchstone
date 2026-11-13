# The Candidate Tier — an app-wide result model

Status: proposal for review. Not yet built. Decision pending with the operator.
Scope: **every pack that proves** (web, ai-mcp, contracts, keys, chain-watch,
supply-chain, infra-cloud, domains). Not the honestly leads-only packs (surface,
source-nav, review) — those already make no proof claim.

## 1. The problem, stated plainly

Today a run has two visible outcomes that matter: a **proven finding** and an
unverified **lead**. There is no state in between, and that loses real work.

Each proving pack has a gate: the agent can only record a finding when the harm
is *proven* by that pack's proof model (see §3). If the agent discovers a
genuinely novel bug, runs a working proof-of-concept, and *sees the harm* — but
the pack's fixed proof model does not recognize that shape — the record is
**refused**. The bug is not a finding, not a lead, not saved at all. The run
reports success with that bug unmentioned.

This is safe (nothing false is ever called proven) but lossy (true things we
cannot formally prove are silently discarded). The lossy half understates real
risk and makes a successful hunt look empty. It is an app-wide problem, not a
web problem, because every proving pack has the same gate.

## 2. The fix: three tiers, not two

Add one tier between proven and lead, as a shared primitive across all packs.

| Tier | Meaning | Who decided | Trust | Ships as "proven"? |
|---|---|---|---|---|
| **Proven** | The pack's proof model confirmed the harm | Deterministic | Stake the product on it | Yes |
| **Candidate** *(new)* | Agent ran a real PoC, saw the harm, judges it serious — the proof model does not cover it | An LLM's judgment, backed by captured evidence | Strong signal, needs human/oracle confirmation | **Never** |
| **Lead** | A scanner hint nobody has exploited | A scanner heuristic | Weak, may be nothing | No |

The rule that must never bend: **a candidate can never be labeled `proven`.** It
carries the agent's assertion plus the raw evidence, marked `proven: false`,
`candidate: true`. The proven boundary stays exactly as sharp as it is now.

## 3. One concept, three proof models

The app does not have one proof mechanism — it has three, each fitted to its
domain. The candidate tier must attach to all three the same way: "the agent has
real captured evidence of harm, but *this* proof model did not fire."

| Proof model | Packs | What "proven" means | What a candidate is |
|---|---|---|---|
| **Oracle replay** | web, ai-mcp | A fixed oracle matched the recorded request/response transcript | A real PoC transcript shows harm, no oracle covers the class |
| **Harm execution** | contracts, keys, chain-watch | The agent's test actually executed a harmful transaction on a forked world; cross-engine AGREE corroborates | The agent executed something it judges harmful that no harm-check classifies |
| **Evidence replay** | supply-chain, infra-cloud, domains | A lead replayed against the pinned offline snapshot and the evidence verified | Captured evidence the agent judges serious that the replay rules do not confirm |

So "candidate" is one epistemic tier with three concrete capture shapes. The
record and UI are shared; the precondition ("has real evidence, proof model did
not fire") is evaluated per model.

## 4. The candidate record (shared shape)

```
{
  n,                       // sequence within the run, like a finding
  kind: "candidate",       // vs. "finding"
  pack,                    // which module produced it
  title, severity,         // agent's call
  poc,                     // the attempt id / label / tx that produced the evidence
  evidence,                // transcript | executed-tx trace | captured snapshot slice
  explanation,             // plain-language write-up, ending with "Fix:"
  assertedBy: "agent",     // provenance — never a proof model
  proven: false,           // STRUCTURAL. never true for a candidate.
  candidate: true,
  provedBy: null           // no oracle / harm-check / replay rule fired
}
```

The `evidence` field is the point: it is what a human reviews and the raw
material for extending the proof model later. For oracle packs it is the
transcript; for harm packs the executed-tx trace; for evidence packs the slice
of the pinned snapshot.

## 5. The agent-loop change (per proving pack)

1. **Keep the existing proof gate exactly as it is.** `submit_finding` stays
   hard-gated on the pack's proof model. Proven means proven. Do not touch the
   `verdict.proven === true` fleet-policy gate.
2. **Add `submit_candidate`.** Preconditions, enforced in code:
   - The label/tx must map to a real recorded attempt in this session (a
     candidate always has captured evidence — never a bare claim).
   - That attempt must **not** have satisfied the proof model. If it did, route
     the agent to `submit_finding` instead. (Prevents a real finding being
     quietly downgraded.)
   - Same duplicate-root-cause guards as findings.
3. **Update the "no proof" message.** After an attempt that captured evidence
   but did not prove, tell the agent: if it is confident this is a real, serious
   vulnerability the pack's checks do not cover, record it with
   `submit_candidate` — it will be marked unproven and queued for review, not
   dropped. This is what tells the agent the floor exists.
4. **Cap candidates per run** (suggest 3) and require the write-up to cite the
   exact evidence lines. A candidate costs human attention; it is the rare
   exception, not a routine exit.

## 6. What the operator sees

Every run view renders three unmistakably distinct groups:

- **Findings** — proven styling (green), shows the proof (verdict / tx / replay)
  and the PoC.
- **Candidates** — a "needs review" styling (amber), an *unproven /
  agent-asserted* badge, the write-up, the PoC, the captured evidence, and a
  one-line "Why this isn't proven: no check covers this class yet."
- **Leads** — the weakest tier, scanner hints.

The three must be unambiguous at a glance. The product's whole value is that
"proven" can be trusted; a candidate that looked like a finding would destroy
that. Different color, badge, and section header, in every pack's run view.

Later (not v1): a "promote to check" affordance on a candidate that opens its
evidence as the starting spec for a new oracle / harm-check / replay rule — the
flywheel that turns real candidates into permanent coverage.

## 7. What this is NOT

- Not a weakening of any proof gate. Every `submit_finding` and the fleet-policy
  gate are untouched.
- Not an AI judging proof. A candidate is explicitly the agent's opinion,
  labeled as such.
- Not a dumping ground. Capped, requires real captured evidence, for the rare
  novel-but-serious case.

## 8. Build order

1. Shared `candidate` record shape + `submit_candidate` in the common lib, with
   the three per-model precondition checks (§3, §5).
2. Wire it into the oracle packs first (web, ai-mcp — simplest, transcript is
   already captured), then the harm packs, then the evidence packs.
3. Update each pack's "no proof" message to point at it.
4. Thread candidates through the run record alongside findings and leads.
5. UI: the third group with its own styling and the "why unproven" line, shared
   across all run views.
6. Tests per model: a candidate can never carry `proven: true`; a
   proof-satisfying attempt is refused by `submit_candidate` and routed to
   `submit_finding`; the per-run cap holds; the evidence is persisted.
7. (Later) the "promote to check" affordance.
