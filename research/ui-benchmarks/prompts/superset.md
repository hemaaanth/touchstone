Read `research/ui-benchmarks/prompts/00-shared-context.md` from
`/home/hemanth/Projects/near/redteam-harness-ui`. It defines the product, the rules, and the
output shape. Follow it exactly.

# Your harness: Superset

Repo: https://github.com/superset-sh/superset @ `d456e511` (shallow clone).
Clone: `/home/hemanth/Projects/near/redteam-harness/reference/superset`
Output (write here): `/home/hemanth/Projects/near/redteam-harness-ui/research/ui-benchmarks/out/superset.md`

Superset is a multi-agent orchestrator: many parallel agents across workspaces, a Next.js
web app plus a desktop shell. It solved the **fleet view** — seeing many concurrent runs at
different stages without a wall of noise. Our harness runs continuously and will produce
many runs; we have one list.

## Read these

- `packages/ui/src/` — the shared design system. This is the most reusable layer for us.
- `apps/web/src/app/(app)/` — the authenticated shell and its route grouping.
- `packages/chat-ui/` and `packages/chat/` — the chat surface, separated from the app.
- `packages/panes/`, `packages/ui/src/components/ui/resizable.tsx`.
- The workspaces list components and the transcript rows under `apps/desktop/.../v2-workspaces/`.
- `globals.css` token block: count the colour roles, note radius and spacing scales.

## Answer

1. The fleet/list view: what is one row, what columns, what status marks, and how do you spot
   the one run that needs you?
2. How a row encodes running / waiting-on-me / failed / done. Which roles are reserved?
3. How the chat surface is split into packages, and what that says about reuse.
4. Pane layout: how many panes, resizable, tabs, nesting limit.
5. The semantic roles in `globals.css`. Note which are used and which are dead.
6. The automation/task surface — the closest analogue to scheduled continuous scanning.
7. One pattern to take for our run list, and one to avoid.

Read-only. `path:line` on every claim. Prefer the shared `packages/ui`; say when something
is an app-local one-off.
