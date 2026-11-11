Read `research/ui-benchmarks/prompts/00-shared-context.md` from
`/home/hemanth/Projects/near/redteam-harness-ui`. It defines the product, the rules, and the
output shape. Follow it exactly.

# Your harness: OpenAI Codex

Repo: https://github.com/openai/codex @ `c875667` (shallow clone).
Clone: `/home/hemanth/Projects/near/redteam-harness/reference/codex`
Output (write here): `/home/hemanth/Projects/near/redteam-harness-ui/research/ui-benchmarks/out/codex.md`

Codex is a Rust `ratatui` TUI plus an app-server protocol. It is the reference for
**transcript grammar**: how agent work is summarized into a handful of readable line types,
how approvals interrupt, and how a status line carries live state without noise. TUI
constraints force the hierarchy to be honest, so the lessons transfer to a browser.

## Read these

- `codex-rs/tui/src/` — find `chatwidget*`, `history_cell*`, `exec_cell/*`,
  `status_indicator_widget.rs`, `bottom_pane/approval_overlay.rs`, `diff_render.rs`,
  `chatwidget/streaming.rs`.
- `history_cell.rs` (or the split directory) — each variant is one row type. Enumerate them.
- `styles.rs` / palette — role mapping.
- `codex-rs/app-server-protocol/` (or `protocol`) — the event vocabulary. Compare it to ours:
  `app/src/lib/types.ts` (`RunEvent`).
- `docs/`.

## Answer

1. Enumerate the transcript cell types. For each: what it collapses, what stays visible,
   what expands. This list is the core deliverable.
2. An in-progress command vs the same command finished — the exact before/after difference.
3. How live status is conveyed (status line, spinner, counters) and what is deliberately
   *not* shown.
4. The approval request: what it occupies, what the keys are, what remains afterwards.
5. Failing step vs completed step, and how that differs from a security-relevant "proven".
6. Diff rendering in the transcript vs the pager.
7. Their hard-won rules about density, truncation, and not re-printing what the user saw.

Read-only; do not build the Rust code. `path:line` on every claim. No large code blocks.
