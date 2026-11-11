Read `research/ui-benchmarks/prompts/00-shared-context.md` from
`/home/hemanth/Projects/near/redteam-harness-ui`. It defines the product, the rules, and the
output shape. Follow it exactly.

# Your harness: Paseo

Repo: https://github.com/getpaseo/paseo @ `d46ee65` (shallow clone).
Clone: `/home/hemanth/Projects/near/redteam-harness/reference/paseo`
Output (write here): `/home/hemanth/Projects/near/redteam-harness-ui/research/ui-benchmarks/out/paseo.md`

Paseo is a React Native / Expo app (web + desktop + mobile) that orchestrates coding agents.
It has the most deliberate **agent timeline** work of the group, and it wrote design docs
explaining *why* — rarer than code.

## Read these

- The docs first: `docs/design.md`, `docs/agent-stream-disclosure.md`,
  `docs/agent-stream-performance.md`, `docs/explorer-sidebar.md`, `docs/coding-standards.md`.
- `packages/app/src/timeline/`, `tool-calls/`, `agent-stream/`, `agent-controls/`,
  `agent-presentation/`, `composer/`, `command-center/`.
- `packages/app/src/components/agent-status-dot.tsx`, `agent-list.tsx`.
- `packages/app/src/styles/` — token/theme layer.

## Answer

1. What one timeline item is, what variants exist, and what is collapsed by default. Cite the
   disclosure doc's *intent* and the component that implements it.
2. How the streaming timeline stays performant. Name the concrete technique and file.
3. A tool call before / during / after — the row anatomy.
4. How agent status dots and the agent list encode state. How many states, what they look like.
5. The command center: what it offers and the argument for it over static nav.
6. How the composer carries per-run controls (model, provider, permissions) without becoming
   a settings form.
7. Their coding/design standards that apply to a web app generally, not RN-specific.
8. The single idea here that would most improve a security operator's read of an attempt.

Read-only; do not run pnpm or expo. Distinguish what the docs *say* from what the code
*does* — if they disagree, cite both. `path:line` on every claim.
