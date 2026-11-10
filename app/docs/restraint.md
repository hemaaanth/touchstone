# Restraint — the interface rulebook

Our screens read as calm and trustworthy only through **restraint plus progressive
disclosure**, never decoration. One short inventory first; every heavy detail one quiet
click away. This file is the contract. `AGENTS.md` points here for all UI work.

Studied from `0sec-labs/0` (our domain twin) and adapted to our `@graphical` library.

## The one rule

Show the fewest things that let the operator act. Push everything else behind a
`Disclosure` or a `DetailAccordion`, closed by default. A screen that shows nine things at
once shows nothing. If a block is not needed to decide the next action, fold it.

## Color

- **One accent.** `--cte-accent` means exactly one thing: the active attack / the primary
  action. Never use it for decoration or for a second meaning.
- **Red is reserved.** `--error` / `--cte-danger` appears only on a *confirmed, proven*
  finding and on destructive controls (Stop, Deny). A lead that is not yet proven is never
  red and never green.
- **Green means proven.** A success tone appears only when a deterministic replay has
  confirmed the result. Model output alone is neutral, never green.
- Everything else is neutral: the `--neutral-1..10` surface steps carry the whole UI.

## Separation without borders

The theme draws **no native borders** (`border` tokens are 0). Separate blocks three ways,
in this order of preference:

1. **Space** — `gap-(--space-*)` between groups.
2. **Surface step** — `bg-(--cte-surface)` / `bg-(--cte-surface-muted)` to lift or recess.
3. **Inset divider** — the `divide-top/bottom/left/right` utilities (a one-sided inset
   shadow), only when space and surface are not enough.

Never stack a ring, a border, and a shadow on the same box. One edge treatment per element.

## Focus and motion

- One focus treatment: the `focus-ring` utility. Put it on every interactive row and link.
- Animate only what is changing. A live step may pulse; a finished step is frozen. Respect
  `prefers-reduced-motion` (the themed parts already do).

## Type and the data role

- Sizes travel as a set: use the `type-*` utilities, never raw `font-size`.
- `font-data` (the mono-ish role) is reserved for **addresses, hashes, amounts, ids,
  commands, and raw machine output**. Prose and labels stay in the UI font. Do not mono the
  chrome.
- Add `tabular-nums` only where digits line up in a column (counts, ledgers). Note: in this
  font `tnum` also widens `-`, so `--` reads as `- -`; keep it off dashed placeholders.

## Progressive disclosure — the primitives

Use these from `@graphical` via the shared blocks in `src/components/app/blocks.tsx`:

- **`Disclosure`** — one quiet row that expands. Default closed. For a single hidden detail:
  a raw payload, a command, a full stdout, a hash list. This is the workhorse. Reach for it
  before adding any second always-on block.
- **`DetailAccordion`** — a stack of folds, all closed by default. For a group of optional
  sections (a run's plan / agents / sandbox / trace / cleanup). Only the inventory and the
  one actionable card stay open above it.
- **`Tabs`** — for *peer* views of the same thing (Proof / Files / Models). Not for hiding
  detail — every tab is equal weight. Pick the default tab to be the one the operator needs.

## Pipeline honesty (the "silent zero")

Never render a reassuring "clean / no findings / safe" unless every stage provably ran
(sandbox booted, model answered, Foundry compiled, exploit executed). A degraded stage reads
as **"inconclusive — sandbox did not run"**, never as "safe". A broken engine that returns a
clean-looking result is the single worst failure for a security tool.

## Checklist before you ship a screen

- [ ] Can the operator see the one thing they must act on without scrolling or opening a fold?
- [ ] Is every non-essential block behind a `Disclosure` / `DetailAccordion`, closed?
- [ ] Is accent used once, for one meaning? Is red only on a proven finding or a destructive control?
- [ ] Are blocks separated by space/surface first, inset divider last, with no stacked edges?
- [ ] Is `font-data` only on machine values, not on labels or prose?
- [ ] Does any "clean" state prove the pipeline ran?
