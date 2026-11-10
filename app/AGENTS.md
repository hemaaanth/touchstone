# Agent instructions

The console is built on **shadcn (base-nova style)** + **assistant-ui**. Follow
`docs/restraint.md` for every screen.

- **Restraint plus progressive disclosure.** Show the fewest things that let the
  operator act; fold the rest behind a `Collapsible` (closed by default). One
  accent meaning: red only on a proven finding or a destructive control; green
  only after a deterministic Foundry replay proved the finding. Our renderers
  read `step.state` / `finding.proven` directly, so green never shows early.
- **Import UI from `@/components/ui/*`** (the shadcn base-nova components, built
  on `@base-ui/react`). Compose with Tailwind utility classes and the shadcn CSS
  variables (`bg-background`, `text-muted-foreground`, `border`, `bg-primary`).
- **The run chat is assistant-ui.** `run-chat.tsx` drives an
  `ExternalStoreRuntime`: we own the state (the SSE step stream reduced into
  `RunState`) and the look (base-nova classes + our own tool-part renderer).
  Keep using the headless primitives (`ThreadPrimitive`, `MessagePrimitive`,
  `ComposerPrimitive`); do not pull in the pre-styled assistant-ui registry
  components — they drag in a second component kit.
- The backend is a vite middleware (`server/api.mjs`) over the pi-durable
  engine. `bun run dev` serves the app and `/api/` from one process.
- **Information architecture.** Left sidebar = runs list + Projects / Modules /
  Playbooks / Settings. Center = the agent run chat. Right = findings as
  artifact cards. Dark by default.
- Do not upgrade existing dependencies (additive is fine). Use bun.
- Competitor and reference repos are for reading only. Learn their patterns,
  then write our own code. Never copy-paste their code, even when the license
  allows it. Never run code from a cloned competitor repo.
