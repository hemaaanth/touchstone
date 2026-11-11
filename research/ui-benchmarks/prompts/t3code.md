Read `research/ui-benchmarks/prompts/00-shared-context.md` from
`/home/hemanth/Projects/near/redteam-harness-ui`. It defines the product, the rules, and the
output shape. Follow it exactly.

# Your harness: T3 Code

Repo: https://github.com/pingdotgg/t3code @ `4c361199` (shallow clone).
Clone: `/home/hemanth/Projects/near/redteam-harness/reference/t3code`
Output (write here): `/home/hemanth/Projects/near/redteam-harness-ui/research/ui-benchmarks/out/t3code.md`

T3 Code is the closest thing to a web-native coding-agent harness that is also a real
product. Its web app is a real shadcn/Base UI app, not a terminal. It solved the
chat-plus-diff-plus-panel problem for long agent sessions.

## Read these

- `apps/web/src/components/chat/` — ~100 files. Start with `ChatCanvas.tsx`,
  `MessagesTimeline.logic.ts`, `TimelineWorkGroupRows.tsx`, `ChatHeader.tsx`,
  `ChatComposer.tsx`, `ChatRightPanel.tsx`, `BackgroundWorkDetails.tsx`.
- `apps/web/src/components/sidebar/` — `SidebarThreadRow.tsx`, `SidebarListMarkers.tsx`.
- `apps/web/src/components/ui/` — `collapsible-section-header.tsx`, `discovery-list.tsx`.
- `apps/web/src/routes/` — the route tree is the information architecture.
- `apps/web/src/index.css` — tokens. `components.json` — shadcn config.
- `docs/user/activity-log.md`, `docs/user/thread-sidebar.md`.

## Answer

1. The shell: how many panes, resizable, how the right panel differs from the chat canvas.
2. How a long transcript is segmented. Name the folding rule and the file that decides it,
   and the row anatomy (icon, label, meta, expand).
3. How "still working" is shown without layout jitter — elapsed timers, spinner labels.
4. How approvals are presented, and what remains after they are answered.
5. Scrollback handling: windowing, capping, "show more", follow-vs-reader-control.
6. Visual discipline: accent count, borders vs surfaces, radius and type scales. Be numeric.
7. The single best idea here for a security operator watching an exploit attempt.

Read-only. Every claim gets a `path:line`. If a file does not say what you expected, say so.
