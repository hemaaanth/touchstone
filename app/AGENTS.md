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
  Build structure from the headless primitives (`ThreadPrimitive`,
  `MessagePrimitive`, `ComposerPrimitive`). For styled leaves, use the
  assistant-ui **Elements** we vendored and restyled base-nova in
  `@/components/assistant-ui/elements/*` (`AgentStatus`, `ShimmerLabel`, the
  reasoning/tool `surfaces`, `agent-handoff`, `subagent-list`, etc.) — extend
  those rather than re-styling a leaf from scratch. Do not pull in the full
  assistant-ui thread template or registry wholesale; it drags in a second
  component kit that fights base-nova.
- The backend is a vite middleware (`server/api.mjs`) over the pi-durable
  engine. `bun run dev` serves the app and `/api/` from one process.
- **Information architecture.** Left sidebar = runs list + Projects / Modules /
  Playbooks / Settings. Center = the agent run chat; findings are scoped to
  their run. Files the agent writes (PoC code, the replay proof) are artifacts
  in a closable right pane, tabbed. Clicking a proven finding's proof card opens
  its replay-proof artifact there. On desktop a new artifact auto-opens the
  pane; on a phone the pane is a full-screen overlay, so it only opens on a tap
  and the file drafts inside its chat card instead. There is no global findings
  rail. Dark by default.
- Do not upgrade existing dependencies (additive is fine). Use bun.
- Competitor and reference repos are for reading only. Learn their patterns,
  then write our own code. Never copy-paste their code, even when the license
  allows it. Never run code from a cloned competitor repo.
