# Shared context for all UI/UX benchmark workers

## What our app is

`Touchstone` — a red-team / pentest harness at
`/home/hemanth/Projects/near/redteam-harness-ui/app` (React 19 + Vite + Tailwind v4 +
shadcn `base-nova` on Base UI).

The product: a security web app that runs continuously and attacks the user's own code and
infrastructure. The AI proposes a vulnerability hypothesis; a **deterministic Foundry replay
inside a sandbox** must reproduce it. A finding is real **only** when the replay passes. The
model never adjudicates.

Current shell (just rebuilt, for reference): rail | list | canvas; the canvas has Report,
Evidence and Activity tabs; the transcript collapses routine reads but never collapses a
replay attempt, an operator steer, or a gate decision.

## What we are borrowing

Generalized agent harnesses solved long-running transcripts, tool-call activity, streaming
status, approval prompts, multi-pane workspaces, command palettes and session lists. Those
patterns map onto our domain: swap "file edit" for "exploit replay", "test run" for
"proven finding".

## Hard rules

1. **Read, never run.** These are competitor hashes. Do not execute their code, install
   deps, build, or run tests.
2. **Never copy-paste code.** Learn the pattern, then we write our own.
3. **Pointers, not prose.** Every claim carries a `path:line` pointer into the clone and
   says what the pattern *does* for the user.
4. **No invented facts.** If the repo does not show it, write "not found".
5. **Simple Technical English.** Short sentences, one idea each, the domain words that
   already exist in the code.

## Required output

Write one markdown file to the exact path given in your task. Structure:

```
# <Harness> — UI/UX patterns worth stealing
Repo: <url> @ <commit>
Scope read: <dirs/files, and what you did NOT read>

## 1. Information architecture
## 2. The one screen that matters most
## 3. Streaming and status
## 4. Approval / interrupt / human-in-the-loop
## 5. Component inventory
## 6. Design tokens and visual language
## 7. What NOT to take
## 8. Best 5 patterns for Touchstone
```

Section 8 entries are: pattern name → reference pointer → the exact place in our app it
would replace → why it helps a security operator.

Keep it 250–450 lines. Density over length.

## Clone locations

Clones live in the **other** checkout, not the one you are writing into:
`/home/hemanth/Projects/near/redteam-harness/reference/`
with subdirectories `t3code`, `codex`, `superset`, `paseo`, `0sec-current`, `ARTEX`.

Read-only. Paths in your output are relative to that `reference/` directory.
