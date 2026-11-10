# Agent instructions

For UI work, follow GUI.md and use graphical-ui, graphical-convert, or graphical-audit as appropriate.

- **Follow `docs/restraint.md` for every screen.** Restraint plus progressive disclosure: show the fewest things that let the operator act, and fold the rest behind a `Disclosure` or `DetailAccordion` (closed by default). One accent meaning; red only on a proven finding or destructive control; green only after a deterministic replay.
- Import UI from `@graphical` (components/graphical/index.ts). Do not import Graphical internals.
- Style with theme variables only: `bg-(--neutral-2)`, `p-(--space-m)`, `type-s`, `weight-medium`, `font-data`, `divide-bottom`, `focus-ring`. Tailwind's default scales are reset on purpose.
- Shared app blocks live in `src/components/app/blocks.tsx`. Mock data lives in `src/data/fixtures.ts`.
- `src/screens/Kit.tsx` shows every Graphical component as it is meant to be composed. Copy from it.
- Do not rename `document.theme.name` ("Atlas") or the `--theme-name` value ("Felt").
- Do not upgrade existing dependencies. Use bun.
- Competitor and reference repos are for reading only. Learn their patterns, then write our own code. Never copy-paste their code, even when the license allows it. Never run code from a cloned competitor repo.
