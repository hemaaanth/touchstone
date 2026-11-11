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
  `@/components/assistant-ui/elements/*` (`ShimmerLabel`, the reasoning/tool
  `surfaces`, `agent-handoff`, `file-tree`, `artifact-pane`, etc.) — extend
  those rather than re-styling a leaf from scratch. Do not pull in the full
  assistant-ui thread template or registry wholesale; it drags in a second
  component kit that fights base-nova.
- The backend is a vite middleware (`server/api.mjs`) over the pi-durable
  engine. `bun run dev` serves the app and `/api/` from one process.
- **Information architecture.** Left sidebar = runs list + Scopes / Modules /
  Playbooks / Settings. Center = the agent run chat; findings are scoped to
  their run. There is no global findings rail. Dark by default. Every run has
  one layout, fleet or solo (the operator picks the mode at start):
  - The top bar: title, "Running · 6m · Fleet", spend, and the ⋯ menu.
  - The main chat: the coordinator's thread (a solo run's one agent).
  - The run panel floats in the chat's top-right corner. It folds to one line
    ("4 agents · 3 notes · 11 files"). Open, it is an accordion: Agents,
    Bulletin (fleet runs, or any run with notes), Files. One section is open
    at a time and scrolls inside the panel.
  - The drawer: a child's thread or a file (PoC code, the replay proof) opens
    over the chat from the right. It never pushes the chat; the chat dims, and
    a click on it or Escape closes the drawer. It is a stack: a file opened
    from a child's thread goes on top, and "‹ Name" goes back. While it is
    open, the panel sits to its left. Clicking a proven finding's proof card
    opens its replay proof there. Each chat saves its open file; the drawer
    never opens by itself. On desktop an open file follows the coordinator's
    new writes. On a phone the drawer is full-screen, so it only opens on a
    tap.
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
