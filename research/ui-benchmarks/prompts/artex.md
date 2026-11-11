Read `research/ui-benchmarks/prompts/00-shared-context.md` from
`/home/hemanth/Projects/near/redteam-harness-ui`. It defines the product, the rules, and the
output shape. Follow it exactly.

# Your harness: ARTEX

Repo: local clone at `/home/hemanth/Projects/near/redteam-harness/reference/ARTEX` @ `f9642c1`.
Output (write here): `/home/hemanth/Projects/near/redteam-harness-ui/research/ui-benchmarks/out/artex.md`

ARTEX is an autonomous red-team platform with a self-hosted web UI. It is the closest thing
in the reference set to our product: real engagements, real findings, real traffic. Its UI
is not beautiful, but its **information model** — engagement → target → finding → evidence
→ report — is battle-tested. Our app has runs and findings and little else.

## Read these

- `web/` — determine the actual stack (do not assume; report what it is) and how screens are
  composed.
- `db/` — the schema. This reveals the real object model. Map tables to screens.
- `report/`, `evidence/` — how a finding becomes a deliverable.
- `intercept/`, `traffic/`, `guard/` — live operator surfaces.
- `docs/`, `README.md`, `screenshots/`.

## Answer

1. The full object model as revealed by `db/`, as a text diagram, with the relations.
2. The primary screens and where the operator lands first.
3. How a finding is presented: which fields, in what order, what is above the fold.
4. How evidence (raw request/response, logs, hashes) is shown without drowning the operator.
5. How ongoing/background activity is conveyed. Is there a global activity indicator?
6. The navigation structure, and how it scales to many engagements.
7. What is dated or ugly here — which choices should we not repeat.
8. The one information-model lesson we must adopt.

Read-only; do not run the server or any build. Do not inflate this UI: if the honest answer
is "the model is the value, the UI is thin", say that. `path:line` on every claim.
