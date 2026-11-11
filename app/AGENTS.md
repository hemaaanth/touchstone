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
- **Information architecture.** Left sidebar = runs list + Scopes / Modules /
  Playbooks / Settings. Center = the agent run chat; findings are scoped to
  their run. Files the agent writes (PoC code, the replay proof) are artifacts
  in a closable right pane, tabbed. Clicking a proven finding's proof card opens
  its replay-proof artifact there. On desktop a new artifact auto-opens the
  pane; on a phone the pane is a full-screen overlay, so it only opens on a tap
  and the file drafts inside its chat card instead. There is no global findings
  rail. Dark by default.
- Do not upgrade existing dependencies (additive is fine). Use bun.
- Open-source code is ours to use when its license allows it. Touchstone is
  open source too. Do not rebuild what a good open-source tool already does.
  - Permissive (MIT, Apache-2.0, BSD, ISC, MPL file by file): copy or adapt
    code, rules, prompts and workflows. Keep the license notice and add a line
    to `THIRD_PARTY.md`.
  - Copyleft (GPL, AGPL): run it as a separate program. Do not paste it into
    our code.
  - Non-commercial or no license: read it and run it as a separate program.
    Do not paste it into our code. Flag it in the pack's TOOLS.md.
  - Run third-party code in Docker, never on the host.
