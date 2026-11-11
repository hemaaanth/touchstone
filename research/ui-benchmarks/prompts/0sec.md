Read `research/ui-benchmarks/prompts/00-shared-context.md` from
`/home/hemanth/Projects/near/redteam-harness-ui`. It defines the product, the rules, and the
output shape. Follow it exactly.

# Your harness: 0sec ("0")

Repo: local clone at `/home/hemanth/Projects/near/redteam-harness/reference/0sec-current` @ `a891ba1`.
Output (write here): `/home/hemanth/Projects/near/redteam-harness-ui/research/ui-benchmarks/out/0sec.md`

This is our domain twin: an open-source AI security harness (MIT) with a real `packages/ui`
design system, a design doc set, a roadmap, and a NEGATIVE-RESULTS document. Go deep on the
actual component source, with line-level pointers.

## Read these

- `packages/ui/src/components/` — 27 components. Attention: `disclosure.tsx`, `command.tsx`,
  `choice-card.tsx`, `segmented-control.tsx`, `activity-chip.tsx`, `overflow-text.tsx`,
  `selection-highlight.tsx`.
- `packages/ui/src/styles/` — tokens.
- `packages/dashboard/src/console/` — `approvals.tsx`, `tool-activity.tsx`,
  `activity-row.tsx`, `transcript-turns.tsx`, `conversation.tsx`.
- `packages/dashboard/src/pages/findings-page.tsx`, `components/finding-workflow-board.tsx`.
- `packages/dashboard/src/components/status-badges.tsx`, `recorded-finding-status.tsx`.
- `0verse/NEGATIVE-RESULTS.md`, `0verse/ROADMAP.md`, `docs/design/`.

## Answer

1. `disclosure.tsx` in full: the primitive, its props, its animation, where it is used, and
   honestly where it falls short.
2. The console/tool-activity rows: anatomy of one activity row and one tool group, and the
   exact folding rule.
3. Approvals: card shape, states, what remains after resolution, and accessibility details.
4. The findings surface: queue vs board vs table — which is default, and the filter model.
5. Their token layer: semantic roles, and the discipline (how many accents, red/green
   meanings). Note where they are *less* strict than we should be.
6. `NEGATIVE-RESULTS.md`: what does it actually record, and what UI decisions does it imply?
   (Answer honestly even if the answer is "no abandoned UI experiments".)
7. What they still get wrong that we should fix.

Read-only. `path:line` on every claim. Do not restate a generic summary; go to source.
