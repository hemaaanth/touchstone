Read `research/ui-benchmarks/prompts/00-shared-context.md` from
`/home/hemanth/Projects/near/redteam-harness-ui`. It defines the product, the rules, and the
output shape. Follow it exactly.

# Your harness: bb (this very IDE)

Output (write here): `/home/hemanth/Projects/near/redteam-harness-ui/research/ui-benchmarks/out/bb.md`

bb is the IDE you are running inside: a mature agentic IDE with a thread list, a timeline, a
right-hand panel of tabs, a composer with per-thread controls, a command palette, and
plugin-contributed UI. Our app is going to feel like a smaller bb for security work, so its
interaction model is the most transferable one here.

bb is closed source. Three legitimate evidence sources, all readable:

1. **Shipped web bundle.** The Electron `app.asar` is extracted at `/tmp/bb-asar/x`. The web
   app is at
   `/home/hemanth/.cache/tmp/.mount_bb-0.4FbckDA/resources/app.asar.unpacked/node_modules/bb-app/app/dist/`
   - `index.html` — pre-paint theme logic and prefetch lists. Read it; it names the real
     module vocabulary.
   - `assets/index-*.css` (281KB of Tailwind v4 output) — **the token layer**. Grep for
     `--canvas:`, `--card:`, `--border-hairline`, `--border-seam`, `--attention`,
     `--bb-sidebar-`, `--bb-panel-chrome-padding`, `--bb-chrome-control-gap`. Report the
     numeric values for light and dark. These names encode their layout grid.
   - `assets/*.js` chunk names (580 files) — a module map. Note the interesting ones:
     `ChatTimeline*`, `Composer*`, `CommandPalette*`, `ThreadSecondaryPanel*`,
     `bottom-anchored-scroll-body`, `scroll-position-keeper`, `title-bar-scroll-fade`,
     `fixed-panel-tabs-state`. Chunk names alone prove the component inventory.
2. **Plugin UI source** (open, local): `/home/hemanth/Projects/bb-plugins/plugins/` and the
   installed copies under `/home/hemanth/.bb/plugins/`. Best: `agent-profiles/components/ui/`
   (button, dialog, overlay, empty-state, select, switch, textarea, icon,
   responsive-overlay) plus `agent-profiles/styles.css`. This shows the primitive set and
   token names a BB surface actually uses.
3. The guide: read `/home/hemanth/.bb/AGENTS.md` and any `bb guide` output you can obtain
   from files. **Do not run shell commands** — approvals block the work.

## Answer

1. Shell anatomy: the regions, their sizes, which are resizable or collapsible.
2. The thread list: row anatomy, grouping, sticky headers, status marks, selected vs hovered
   vs unread. Cite the `--bb-sidebar-*` and sticky-stack variables and explain the grouping
   algorithm they imply.
3. The timeline: turn structure, tool-call rows, streaming anchoring.
4. The right panel: how tabs are modeled, how many panes, and how a file/diff/browser tab
   coexists. This is the pattern our detail pane needs.
5. The composer: what controls ride in it and how it avoids becoming a form.
6. The command palette and keyboard model.
7. Plugin UI contract: a table of primitive → file → what it is for.
8. What we should NOT copy — things that only make sense for a multi-agent coding IDE.

No shell commands: use `read`, `glob`, `grep`, `write`. Read-only. For each claim give a file
path, a CSS variable with its value, or a chunk name. Label anything inferred from minified
code as inference. The token table is the most valuable part — make it complete.
