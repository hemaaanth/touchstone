# Superset — UI/UX patterns worth stealing
Repo: https://github.com/superset-sh/superset @ d456e511
Scope read: shared UI tokens, motion, selected primitives, chat package boundaries, desktop transcript, pane engine, v2 workspace fleet, cloud row, tasks, and automations.
Also read: Next.js shell/navigation and the automation creation design review. Inspected the docs/design directory, but not its project-import documents.
Not read: the entire backend, mobile app, all legacy workspace screens, all design plans, or every shared component. No app, build, install, or test was run.
Evidence: static source, not a visual or usability test. “Helps” statements below are design interpretations, not measured outcomes.
Pointers are relative to `reference/superset/`. Pointers beginning `app/` refer to Touchstone under `redteam-harness/` instead.

## 1. Information architecture

### Correct the starting map

- The Next.js shell is a sidebar beside one scrolling main area. It is not the fleet workspace examined below.
  Pointers: `apps/web/src/app/(app)/components/DashboardShell/DashboardShell.tsx:3-10` — keeps account navigation separate from page content.

- Its navigation is Home, Integrations, Account, and Billing. Workspaces, Tasks, Automations, Environments, and Design were not found in this web navigation definition.
  Pointers: `apps/web/src/app/(app)/components/DashboardShell/components/AppSidebar/components/SidebarBody/components/SidebarNav/constants.ts:11-28` — prevents borrowing a route map from the wrong shell.

- The desktop dashboard selects a v2 `DashboardSidebar` or the older `WorkspaceSidebar`. Routed content sits behind `ContentBoundary`.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/layout.tsx:210-244` — fleet navigation remains outside the selected workspace content.

- The newer shell branch adds `NavigationRail`, a sliding sidebar, and a rounded content container. This is app-local shell treatment, not a shared UI requirement.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/layout.tsx:294-305` — global navigation and workspace navigation are separate levels.

### The fleet: one row is one workspace

- `V2WorkspaceRow` receives one `AccessibleV2Workspace`, not one message or one tool call. A workspace can contain multiple agents.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:36-39`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarWorkspaceItem/components/DashboardSidebarExpandedWorkspaceRow/components/DashboardSidebarWorkspaceChips/components/DashboardSidebarAgentsChip/DashboardSidebarAgentsChip.tsx:16-25` — aggregates concurrent work before exposing its details.

- The v2 list row is a flex row, not a table with labelled column headers. It has a fixed status slot, flexible name/owner/place area, then optional metadata.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:229-303` — gives names a stable starting position.

- Visible fields are status glyph, workspace name, owner avatar, cloud/remote-device mark, PR/checks chip, additions/deletions, project, and activity age.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:259-387` — answers what, where, result context, and recency on one line.

- Branch details live in the row tooltip instead of a permanent column. The activity tooltip adds creation and last-agent-event times.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:126-163` — removes secondary text from every row.

- Narrow containers hide project text, diff statistics, and the PR number at different breakpoints. The name and leading status remain.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:329-374` — sheds metadata before shrinking the primary identity.

- Hover or keyboard focus replaces age with pin/delete/archive controls in the same 3.25rem slot. No extra action column appears.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:376-391` — prevents width changes during inspection.

- The initial view is List / no grouping / activity order / All. Urgency-first grouping exists, but is not the initial default.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/stores/v2WorkspacesFilterStore/v2WorkspacesFilterStore.ts:230-235` — distinguish available behavior from default behavior.

- Built-in views are All, Needs me, Working, and Cloud. Needs me selects both `attention` and `finished`.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/stores/v2WorkspacesFilterStore/v2WorkspacesFilterStore.ts:60-87` — the operator can isolate interruptions and unread completions.

- Status-grouped lists order Needs attention, Working, Finished, In review, Idle, Merged, Deleted. Board columns instead follow workflow order.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/groupWorkspaces/groupWorkspaces.ts:16-26`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/deriveBoardColumn/deriveBoardColumn.ts:17-26` — a vertical queue can lead with urgency without changing board semantics.

- Other grouping choices are project, place, creator, and none. Rows within groups can sort by activity, creation, or name.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/groupWorkspaces/groupWorkspaces.ts:53-70`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/sortWorkspaces/sortWorkspaces.ts:21-33` — supports either triage or ownership browsing.

- The list virtualizes headers and rows, estimates rows at 45px, and overscans eight items. The current section header sticks at the top.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/V2WorkspacesList.tsx:56-58,178-188,253-278` — keeps large fleets navigable without mounting every row.

- Collapsed groups contain only their header. A group containing the current workspace stays expanded; status collapse state persists, other group collapse state is session-local.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/V2WorkspacesList.tsx:97-143` — avoids hiding the selected workspace.

- A separate cloud-only row has three table cells: name/creator/repo/PR, sidebar membership action, and status/age. Do not combine its fields with the v2 row as if they were one component.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/CloudWorkspacesList/components/CloudWorkspaceListRow/CloudWorkspaceListRow.tsx:58-171` — a narrower alternate list exists alongside the unified fleet.

### Pane hierarchy

- The shared hierarchy is workspace → tabs → split tree → pane. Each tab owns a flat pane map and one active pane ID.
  Pointers: `packages/panes/src/types.ts:9-40` — separates navigation context from pane contents.

- Current splits are binary: `first`, `second`, direction, and optional percentage. The README's n-ary weighted model is stale against this source.
  Pointers: `packages/panes/src/types.ts:9-17`; `packages/panes/README.md:113-125` — use the implementation, not the documented tree shape.

- Pane count is not fixed at two or three. A split adds a new leaf; no explicit pane-count or depth cap was found in the inspected model, split action, and renderer.
  Pointers: `packages/panes/src/types.ts:9-17`; `packages/panes/src/core/store/store.ts:673-710`; `packages/panes/src/react/components/Workspace/components/Tab/Tab.tsx:120-135,217-232` — recursive layouts can grow beyond a simple detail pane.

- Splits resize in either direction and save the first panel's percentage. Double-clicking the divider equalizes the split.
  Pointers: `packages/panes/src/react/components/Workspace/components/Tab/Tab.tsx:105-118,194-207` — users can give a transcript or proof more room.

- Minimum pane dimensions are 260px wide and 160px high. Split containers allow overflow rather than promising arbitrary nesting will fit on screen.
  Pointers: `packages/panes/src/react/components/Workspace/components/Tab/constants.ts:1`; `packages/panes/src/react/components/Workspace/components/Tab/Tab.tsx:106-108,120-122` — practical limits come from space, not a documented nesting maximum.

- Tabs support selection, close/close-others/close-all, rename, reorder, and moving a pane into a new tab. Dragging a pane over a tab selects that tab.
  Pointers: `packages/panes/src/react/components/Workspace/components/TabBar/TabBar.tsx:41-62`; `packages/panes/src/react/components/Workspace/components/TabBar/components/TabItem/TabItem.tsx:95-118` — tabs contain layouts, not just chat sessions.

## 2. The one screen that matters most

### The fleet opens a transcript, not an endless tool-card stack

- The v2 transcript composes shared `MessageScroller`, `ScrollToBottomButton`, Button, and Spinner with app-local row renderers.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:12-49` — shared scrolling is reusable without sharing workspace-specific messages.

- Row kinds include working, item, outbox, tool run, turn status, reply footer, and changed files. Transcript structure is derived before rendering.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/utils/transcriptRows/transcriptRows.ts:27-94` — lets prose, progress, and output have different densities.

- Consecutive tool calls form a `tool_run`. Reasoning between calls stays inside that run. A single-call run unwraps into one item.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/utils/transcriptRows/transcriptRows.ts:184-198,243-250,285-296` — avoids a disclosure wrapper around every tiny step.

- Tool groups default closed unless they contain a pending approval target. User collapse choices are retained in an override map.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/utils/transcriptRows/transcriptRows.ts:233-250`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:178-188` — routine work compresses; actionable work stays visible.

- `ToolCallRow` is a low-height line with title, running time, status, and optional disclosure. Its output appears below a single left rule.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ToolCallRow/ToolCallRow.tsx:91-150` — provides detail on demand without a full bordered card per call.

- Calls without output cannot expand. Running calls get a dashed rotating ring and shimmer; settled calls recede to lower text contrast.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ToolCallRow/ToolCallRow.tsx:47-52,69-96,100-109` — progress is visible without keeping completed work loud.

- `AgentMessageRow` renders Markdown, attachments, and a final reply footer. It is not a shared bubble component exported from `chat-ui`.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/AgentMessageRow/AgentMessageRow.tsx:28-58` — the app owns message-specific actions.

- The transcript tracks wheel, touch, keyboard, and scrollbar interaction. It uses a carried reader position and a scroll anchor rather than blindly jumping on each update.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:151-175,265-280,412-416` — lets the operator read older evidence during activity.

- Older turns load through a sentinel. Failure gets an explicit “Couldn't load earlier messages. Retry” control rather than an empty transcript.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:422-437` — keeps incomplete history distinguishable from no history.

- Search pages in the whole conversation. Windowing pins search results, reveal targets, the reader position, and the scroll anchor.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:282-327` — long-session search is not limited to currently mounted rows.

- The newest 30 rows render fully; older rows can use `content-visibility:auto`. Removed leading rows retain a height spacer.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:64-66,349-381,439-444` — balances long histories with stable scroll geometry.

- The viewport reserves a stable scrollbar gutter. A bottom overlay offers `ScrollToBottomButton` outside the message flow.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:406-419,455-457` — returning to live work does not add another transcript row.

### A reusable history rail, with a domain limit

- Shared `ChatHistorySidebar` indexes user messages, pairs each with the next assistant preview, and stays hidden below four user entries.
  Pointers: `packages/ui/src/components/ChatHistorySidebar/ChatHistorySidebar.tsx:23-40,63-95` — gives a long dialogue a compact chapter index.

- Each rail mark is a labelled jump button. Hover or focus reveals a preview; active marks follow the visible message range.
  Pointers: `packages/ui/src/components/ChatHistorySidebar/ChatHistorySidebar.tsx:70-93,143-168,176-195` — helps revisit an earlier prompt without scrolling through tool output.

- For Touchstone, index scan/replay phases instead of user turns. Autonomous runs can have few operator messages despite long transcripts.
  Pointers: `packages/ui/src/components/ChatHistorySidebar/ChatHistorySidebar.tsx:30-40`; `app/src/components/RunTimeline.tsx:29-33,76-83` — recommendation: borrow navigation behavior, not its indexing rule.

## 3. Streaming and status

### Status is an attention signal, not a finding verdict

- Working: an amber `WaveSpinner` in the v2 row. Provisioning: the same spinner in muted grey with “Creating the sandbox”.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/WorkspaceStateGlyph/WorkspaceStateGlyph.tsx:27-35` — separates agent work from infrastructure startup.

- Waiting on me: `permission` uses a yellow pulsing dot and “Needs input”. Failure: the v2 row uses a red information icon with a specific agent/sandbox tooltip.
  Pointers: `apps/desktop/src/renderer/screens/main/components/StatusIndicator/StatusIndicator.tsx:8-19,50-69`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/WorkspaceStateGlyph/WorkspaceStateGlyph.tsx:27-41` — shape and text supplement color, although row text is tooltip-only.

- Finished unread: green review dot. The board label is “Finished · unread”; PR review and merged work are separate states.
  Pointers: `apps/desktop/src/renderer/screens/main/components/StatusIndicator/StatusIndicator.tsx:27-32`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/deriveBoardColumn/deriveBoardColumn.ts:28-47` — completion is a reason to inspect, not an assertion of correctness.

- Classification checks archived/merged before failures, then provisioning/working, then unread finish and PR review. A merged PR therefore wins over an agent failure in board grouping.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/deriveBoardColumn/deriveBoardColumn.ts:77-107` — precedence is explicit, but it is coding-workflow precedence.

- Session workspaces skip Finished · unread. The source says high-volume automation/chat sessions would bury real review candidates.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/deriveBoardColumn/deriveBoardColumn.ts:71-75,97-99` — a deliberate noise policy, not a universal rule for all completed work.

- The cloud-only row shows a success dot only while a review result is unread. Read or otherwise quiet rows fall back to an 11px age.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/CloudWorkspaceStatus/CloudWorkspaceStatus.tsx:83-98` — clearing attention removes the bright mark without deleting the workspace.

- Multiple agents collapse into one sidebar chip: highest-priority agent avatar plus count, with an agent list on hover/click. Ties choose the newest session.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarWorkspaceItem/components/DashboardSidebarExpandedWorkspaceRow/components/DashboardSidebarWorkspaceChips/components/DashboardSidebarAgentsChip/DashboardSidebarAgentsChip.tsx:21-47,99-130` — one blocked agent can represent a busy workspace.

### Smoothing and honest loading

- `WaveSpinner` is a CSS-driven 3×3 grid. It does not allocate a React timer for each fleet row.
  Pointers: `packages/ui/src/atoms/WaveSpinner/WaveSpinner.tsx:3-28` — shared animation is suitable for many simultaneous indicators.

- Agent text reveals whole words at a paced rate; existing text appears immediately at mount. The hook uses a 90-char/s floor, backlog catch-up, and a 150ms partial-word hold.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/AgentMessageRow/hooks/usePacedText/usePacedText.ts:4-19,31-48` — smooths bursty text without replaying old messages.

- A reply is final only after both generation and paced reveal finish. Final reply actions wait for generation to stop.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/AgentMessageRow/AgentMessageRow.tsx:28-30,40-57` — avoids showing a final-looking message while text still appears.

- Half-written Markdown links use text-only repair instead of a temporary “[blocked]” URL placeholder.
  Pointers: `packages/chat-ui/src/components/ChatMarkdown/ChatMarkdown.tsx:123-125` — reduces transient error-looking text during streaming.

- A workspace list with unanswered hosts does not claim “No workspaces yet”. Automation read errors retain page chrome and use a separate error state.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/V2WorkspacesList.tsx:200-218`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/page.tsx:621-627,855-875` — absence of data is not reported as success or emptiness.

## 4. Approval / interrupt / human-in-the-loop

- App-local `ApprovalRow` separates pending, answered, and stale states. Pending requests use warning tint; stale requests say Expired; answered requests retain a decision badge.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ApprovalRow/ApprovalRow.tsx:68-126` — leaves an audit trace after controls disappear.

- Command requests say “Run this command?” and show the exact command in a bounded monospace area. Other actions say “Allow this action?”.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ApprovalRow/ApprovalRow.tsx:71-99,129-142` — the decision is attached to an inspectable action.

- The default choices are Deny, Allow for session, and Allow. Supplied options use `OptionButtons`; structured questions use `QuestionForm`.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ApprovalRow/ApprovalRow.tsx:74-75,143-168` — permissions and information requests share placement, not identical controls.

- Pending approval targets force their tool group open. A new first pending approval can scroll into view even when the reader is away from the end.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/utils/transcriptRows/transcriptRows.ts:233-250`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:341-347` — actionable work is not buried inside a closed group.

- Interrupted turns have their own `turn_status` row and can carry a recorded user stop. They are not folded into the generic working row.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/utils/transcriptRows/transcriptRows.ts:65-75,255-268` — interruption remains part of the transcript history.

- Shared `Confirmation` provides request/accepted/rejected/action slots. Its action area renders only for `approval-requested`.
  Pointers: `packages/ui/src/components/ai-elements/confirmation.tsx:51-65,81-109,116-149` — a reusable state-shaped shell exists, separate from desktop-specific approval copy.

- Important Touchstone boundary: its current `awaiting-approval` transition auto-approves on worker exit. Do not label that transient state “Needs me” merely because its name contains approval.
  Pointers: `app/server/runs.mjs:324-347`; `app/src/components/ActivityList.tsx:25-33` — recommendations must follow the actual human decision boundary, not the enum spelling.

- For Touchstone, reuse explicit pending/answered presentation only where a human decision actually exists. Keep proof validity separate from operator acceptance or dismissal.
  Pointers: `packages/ui/src/components/ai-elements/confirmation.tsx:81-149`; `app/src/lib/types.ts:6-15,59-76`; `app/server/findings.mjs:110-119` — recommendation: a button never makes an exploit real.

## 5. Component inventory

### Shared first; app-local where the domain requires it

| Layer / component | Responsibility and pointer |
| --- | --- |
| Shared `Button` | Variant, size, disabled, invalid, and focus styles. `packages/ui/src/components/ui/button.tsx:7-37`. |
| Shared `Card` | Raised content shell, header, description, content, footer. `packages/ui/src/components/ui/card.tsx:5-78`. |
| Shared `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` | Panel geometry and a thin divider with a larger hit target. `packages/ui/src/components/ui/resizable.tsx:9-56`. |
| Shared `Conversation` | `role=log` plus stick-to-bottom behavior; tool disclosure can stop scroll pinning. `packages/ui/src/components/ai-elements/conversation.tsx:14-50`. |
| Shared `Tool`, `ToolHeader`, `ToolContent` | A bordered tool disclosure and state icon vocabulary. Not the v2 app-local tool row. `packages/ui/src/components/ai-elements/tool.tsx:24-45,62-75,121-130`. |
| Shared `Confirmation` | State-dependent approval content and actions. `packages/ui/src/components/ai-elements/confirmation.tsx:46-65,133-157`. |
| Shared `ChatHistorySidebar` | User-message jump rail with previews and active markers. `packages/ui/src/components/ChatHistorySidebar/ChatHistorySidebar.tsx:10-21,143-195`. |
| Shared `WaveSpinner` | Compact CSS activity indicator, inheriting the caller's color. `packages/ui/src/atoms/WaveSpinner/WaveSpinner.tsx:15-28`. |
| `chat-ui/MessageScroller` | Re-export of `@shadcn/react/message-scroller`, not a Superset-owned scroll algorithm. `packages/chat-ui/src/components/MessageScroller/index.ts:1-5`. |
| `chat-ui/ChatMarkdown` | Streamdown rendering, typography, link and table treatment, caller-supplied renderers. `packages/chat-ui/src/components/ChatMarkdown/ChatMarkdown.tsx:39-69,89-138`. |
| `chat-ui/MessageComposer` | Lexical root, Markdown import, mention chips, and composer body. `packages/chat-ui/src/components/MessageComposer/MessageComposer.tsx:30-67`. |
| App-local `Transcript` | Row derivation, history loading, search, windowing, and scroll coordination. `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:217-251,265-328`. |
| App-local `AgentMessageRow` | Paced assistant text, attachments, and final reply actions. `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/AgentMessageRow/AgentMessageRow.tsx:28-58`. |
| App-local `ToolCallRow` | One-line activity with expandable output. `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ToolCallRow/ToolCallRow.tsx:91-150`. |
| App-local `ApprovalRow` | Exact permission/question UI and decision history. `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ApprovalRow/ApprovalRow.tsx:55-168`. |
| Shared `panes` model and renderer | Tabs, recursive layouts, active pane, and resizing. `packages/panes/src/types.ts:9-40`; `packages/panes/src/react/components/Workspace/components/Tab/Tab.tsx:105-135`. |

- `@superset/chat` exports protocol, core, client, and React entry points. Core includes reducer, outbox, timeline, transcript, usage, subagents, and user-stop logic.
  Pointers: `packages/chat/package.json:6-22`; `packages/chat/src/core/index.ts:1-18` — session logic can exist without a particular visual transcript.

- `@superset/chat-ui` exports components by subpath and depends on both chat and UI. The desktop still owns the complete message list and tool/approval rows.
  Pointers: `packages/chat-ui/package.json:6-9,28-36`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:12-49` — reuse is layered, not a drop-in complete chat screen.

### Automation and tasks: the continuous-scanning analogue

- The automation page has creation, seven-day run statistics, Mine/Team/Archived scopes, and an All runs entry. Failed and missed statistics link to filtered history.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/page.tsx:708-754,765-817` — separates schedule management from individual executions.

- One automation row represents a definition: name/target, optional owner, schedule, Active/Paused with next-run age, last result/time, and actions.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/components/AutomationRow/AutomationRow.tsx:273-319,321-398,400-445` — shows what will run next and what happened last.

- Schedules can say a recurrence, Event triggered, or No triggers. Last-run status opens the run workspace; Run now is available on owned, unarchived rows.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/components/AutomationRow/AutomationRow.tsx:129-159,372-388,402-429` — moves from a schedule to its evidence without losing identity.

- Automation results are `created`, `creating`, `missed`, `failed`, `superseded`, and `blocked`. “Created” means dispatched, not that agent work succeeded.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/utils/runStatus/runStatus.ts:14-46` — the scheduler reports dispatch outcomes, not security outcomes.

- Missed means the scheduled host was offline and uses amber, not red. Result sorting ranks failed, missed, blocked, creating, superseded, created.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/utils/runStatus/runStatus.ts:14-46` — separates missed coverage from execution failure.

- Detail has an Active/Paused switch, Settings / Run History tabs, trigger scope controls, Instructions, and AgentPicker. Read-only ownership is explained inline.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/$automationId/components/AutomationBody/AutomationBody.tsx:227-244,289-367,369-405` — configuration is not mixed into every history row.

- Trigger scope reads as device → project/environment → workspace → session reuse, with tags and cloud size where relevant.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/$automationId/components/TriggersCard/TriggersCard.tsx:144-277` — exposes where recurring work will execute.

- History rows show result dot, title, scheduled age, and an inline error. Only runs with a workspace can open it; Load more pages the history.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/$automationId/components/PreviousRunsList/PreviousRunsList.tsx:56-121` — failed dispatches remain visible even without a workspace.

- Tasks are a different surface: source selection, filters, search, and board/table views for native tasks or Linear; GitHub issues use a separate content branch.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/tasks/components/TasksView/TasksView.tsx:333-416` — a work queue is not a schedule or a run log.

- The automation design review selected one “New automation” menu with manual creation first and AI creation second. Its sketches are illustrative, not runtime proof.
  Pointers: `design/automation-create-review/index.html:7-10,32` — name the creation method and state the extra-click tradeoff.

## 6. Design tokens and visual language

### Shared token inventory: 36 color roles

- `packages/ui/src/globals.css` exposes 36 `--color-*` aliases: 23 general roles, five chart roles, and eight sidebar roles. Foreground partners count separately.
  Pointers: `packages/ui/src/globals.css:12-47` — a finite vocabulary, not one color per component.

| Semantic roles | Observed use and evidence |
| --- | --- |
| `background`, `foreground` | Base page colors; applied to body. `packages/ui/src/globals.css:52-53,133-135`. |
| `card`, `card-foreground` | Raised card surface and text. `packages/ui/src/globals.css:54-55`; `packages/ui/src/components/ui/card.tsx:10`. |
| `popover`, `popover-foreground` | Floating surface and text. `packages/ui/src/globals.css:56-57`; `packages/ui/src/components/ui/popover.tsx:33`. |
| `primary`, `primary-foreground` | Filled primary action and contrasting text. `packages/ui/src/globals.css:58-59`; `packages/ui/src/components/ui/button.tsx:12`. |
| `secondary`, `secondary-foreground` | Quiet filled action and text. `packages/ui/src/globals.css:60-61`; `packages/ui/src/components/ui/button.tsx:17-18`. |
| `muted`, `muted-foreground` | Quiet surfaces and secondary text. `packages/ui/src/globals.css:62-63`; `packages/ui/src/components/ai-elements/tool.tsx:41,99`. |
| `accent`, `accent-foreground` | Hover/selection surface and text, not necessarily brand color. `packages/ui/src/globals.css:64-65`; `packages/ui/src/components/ui/button.tsx:15-20`. |
| `destructive` | Destructive action and invalid-input feedback. `packages/ui/src/globals.css:66`; `packages/ui/src/components/ui/button.tsx:13-14`; `packages/ui/src/components/ui/input.tsx:9`. |
| `warning` | Pending permission outline, wash, and icon. `packages/ui/src/globals.css:67`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ApprovalRow/ApprovalRow.tsx:80-91`. |
| `warning-foreground` | Defined, but no direct rendering consumer found in the searched apps/packages. Candidate unused role, not proven globally dead. `packages/ui/src/globals.css:68,107`. |
| `success` | Cloud row's unread completion dot. `packages/ui/src/globals.css:69`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/CloudWorkspaceStatus/CloudWorkspaceStatus.tsx:83-90`. |
| `border` | Dividers and container edges; also applied globally. `packages/ui/src/globals.css:70,129-132`; `packages/ui/src/components/ui/resizable.tsx:44`. |
| `input` | Input border and dark input wash. `packages/ui/src/globals.css:71`; `packages/ui/src/components/ui/input.tsx:7`. |
| `ring` | Focus and invalid-state distinction. `packages/ui/src/globals.css:72`; `packages/ui/src/components/ui/input.tsx:8-9`. |
| `link`, `link-hover` | Markdown links and hover color. `packages/ui/src/globals.css:73-74`; `packages/chat-ui/src/components/ChatMarkdown/ChatMarkdown.tsx:53-55`. |
| `chart-1` … `chart-5` | All five feed Mermaid series colors; not dead just because fleet rows do not use them. `packages/ui/src/globals.css:75-79`; `packages/chat-ui/src/components/MermaidDiagram/mermaid-diagram.css:12-19`. |
| `sidebar`, `sidebar-foreground` | Sidebar surface and text. `packages/ui/src/globals.css:80-81`; `packages/ui/src/components/ui/sidebar.tsx:192`. |
| `sidebar-primary`, `sidebar-primary-foreground` | Defined in both themes; no direct rendering consumer found in the searched apps/packages. Candidate unused pair. `packages/ui/src/globals.css:82-83,121-122`. |
| `sidebar-accent`, `sidebar-accent-foreground` | Active, hover, and open sidebar items. `packages/ui/src/globals.css:84-85`; `packages/ui/src/components/ui/sidebar.tsx:487-493`. |
| `sidebar-border` | Sidebar outline variant reads it. `packages/ui/src/globals.css:86`; `packages/ui/src/components/ui/sidebar.tsx:493`. |
| `sidebar-ring` | Keyboard focus on sidebar controls. `packages/ui/src/globals.css:87`; `packages/ui/src/components/ui/sidebar.tsx:418,487`. |

- Usage audit scope: direct utility classes and `var(...)` references in apps/packages, excluding globals declarations. No globally dead token is asserted from an absent direct match.
  Pointers: `packages/ui/src/globals.css:12-47` — the warning foreground and sidebar-primary pair are declared vocabulary with no located rendering use, not measured bundle waste.

- There is no `attention` color token in this shared block. `attention` is a workspace grouping key; actual permission/failure colors are hard-coded yellow/red utilities.
  Pointers: `packages/ui/src/globals.css:7-48`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/deriveBoardColumn/deriveBoardColumn.ts:8-15`; `apps/desktop/src/renderer/screens/main/components/StatusIndicator/StatusIndicator.tsx:8-19` — do not invent a shared attention palette.

### App-local extensions and discipline limits

- Desktop defines its own fallback palette and imports shared motion, not shared globals. JavaScript theme application may override those fallback values.
  Pointers: `apps/desktop/src/renderer/globals.css:1-4,24-34` — shared role names do not guarantee identical app colors.

- Desktop adds `tertiary`, `tertiary-active`, `destructive-foreground`, `highlight`, `highlight-foreground`, `highlight-match`, `highlight-active`, `fill-hover`, and `fill-selected`.
  Pointers: `apps/desktop/src/renderer/globals.css:48-80` — these nine additions are app-local, not part of the shared 36-role count.

- `fill-hover` and `fill-selected` are foreground mixes: 7%/10% in dark fallback, 4%/6% in light. A cloud fleet row consumes `fill-hover`.
  Pointers: `apps/desktop/src/renderer/globals.css:78-80,128-129`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/CloudWorkspacesList/components/CloudWorkspaceListRow/CloudWorkspaceListRow.tsx:60` — selection can be a surface step instead of another border.

- `tertiary-active` had no direct rendering consumer in the bounded token search. Treat it as another candidate unused extension, not a reason to import it.
  Pointers: `apps/desktop/src/renderer/globals.css:49,100,148` — declaration and alias alone do not demonstrate a useful role.

- Shared light primary is near-black; dark primary is near-white. Accent is neutral. Status colors and chart series provide separate chromatic roles.
  Pointers: `packages/ui/src/globals.css:58-79,97-118` — primary action need not compete with safety signals through saturated branding.

- This is not strict one-accent discipline. V2 status uses yellow/amber/red/green literals; diff statistics also use green/red, while approvals use semantic warning.
  Pointers: `apps/desktop/src/renderer/screens/main/components/StatusIndicator/StatusIndicator.tsx:8-32`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:352-356`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ApprovalRow/ApprovalRow.tsx:80-91` — color meanings are local, not globally reserved.

### Radius, spacing, type, and motion

- Shared radius is `0.625rem`; sm/md/lg/xl derive by −4px/−2px/0/+4px. At a 16px root this is 6/8/10/14px.
  Pointers: `packages/ui/src/globals.css:8-11,51` — four semantic sizes are enough for most controls and surfaces.

- No custom spacing or typography scale is declared in shared globals. Components use Tailwind scales plus local values; buttons span h-7/h-8/h-9/h-10.
  Pointers: `packages/ui/src/globals.css:7-48`; `packages/ui/src/components/ui/button.tsx:23-31` — do not report an invented named spacing system.

- Fleet text is mostly `text-sm`, with `text-xs` metadata and 11px monospace diff counts. Automation rows use h-10 and 12px secondary cells.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:251,344,362,381`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/components/AutomationRow/AutomationRow.tsx:248,305-322` — dense but deliberately tiered information.

- Shared Card adds border, shadow, rounded-xl, and generous padding. The fleet instead uses bottom separators and a hover wash; tool output uses a single left rule.
  Pointers: `packages/ui/src/components/ui/card.tsx:10,23`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:251-256`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ToolCallRow/ToolCallRow.tsx:139` — the most reusable component is not always the best container for every item.

- Shared motion defines shimmer, slow spin, block fade, thinking pulse, wave cells, and braille spin. Tool rotation explicitly disables itself for reduced motion.
  Pointers: `packages/ui/src/motion.css:1-7`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ToolCallRow/ToolCallRow.tsx:106-109` — motion communicates live work, but reduced-motion coverage was not audited globally.

## 7. What NOT to take

- Do not copy the PR/merge lifecycle into vulnerability results. Superset can classify a merged PR ahead of failure; Touchstone proves the submitted contract against its own passing replay.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/deriveBoardColumn/deriveBoardColumn.ts:80-89`; `app/server/findings.mjs:110-119` — operational completion must not override proof validity.

- Avoid the fleet's tooltip-only, tiny colored status as the sole run signal. Preserve the compact slot, but add visible status words for waiting, failed, and proven states.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/WorkspaceStateGlyph/WorkspaceStateGlyph.tsx:53-60`; `apps/desktop/src/renderer/screens/main/components/StatusIndicator/StatusIndicator.tsx:54-67` — recommendation: triage should not require hovering every ambiguous dot.

- Do not map all autonomous completions to quiet Idle as Superset does for session workspaces. A scheduled scan can still yield a new proven finding requiring review.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/deriveBoardColumn/deriveBoardColumn.ts:97-107`; `app/src/lib/types.ts:17-26` — volume control must not erase security significance.

- Do not treat green “created” in automation history as a successful scan. It is a dispatch state; keep scheduled, started, completed, and proven separate.
  Pointers: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/utils/runStatus/runStatus.ts:15-23`; `app/src/lib/types.ts:158-166` — a launched worker is not a validated exploit.

- Do not copy the shared Tool card around every transcript event. Its border, rounded shell, and bottom margin would recreate Touchstone's stacked-container problem.
  Pointers: `packages/ui/src/components/ai-elements/tool.tsx:38-45`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ToolCallRow/ToolCallRow.tsx:91-150` — prefer the app-local one-line disclosure pattern, implemented in our own components.

- Do not inherit pointer-only tab selection. `TabItem` explicitly suppresses the keyboard-interaction lint rule because keyboard navigation is out of scope there.
  Pointers: `packages/panes/src/react/components/Workspace/components/TabBar/components/TabItem/TabItem.tsx:129-155` — reuse the layout idea, not this accessibility compromise.

- Do not start with arbitrary nested panes or a rich composer. Touchstone already has Conversation and Report tabs; a readable two-surface workflow is the smaller change.
  Pointers: `packages/panes/src/types.ts:9-40`; `packages/chat-ui/src/components/MessageComposer/MessageComposer.tsx:36-65`; `app/src/components/RunView.tsx:202-234` — recommendation: solve operator priority before copying an IDE.

## 8. Best 5 patterns for Touchstone

1. **Needs-me view with urgency-first groups.**
   Reference: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/stores/v2WorkspacesFilterStore/v2WorkspacesFilterStore.ts:74-87`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/utils/groupWorkspaces/groupWorkspaces.ts:16-26`.
   Replace: the single live-then-history ordering in `app/src/components/ActivityList.tsx:119-149`.
   Proposal: views for All, Needs attention, and Running; prioritize genuine interruptions, errors, and unread proven results.
   Why: the operator can find the run requiring action without reading every row.
   Guardrail: current auto-recording is not a human approval request; use `app/server/runs.mjs:340-347` to avoid a false Needs-me item.

2. **Stable compact rows that shed secondary metadata.**
   Reference: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacesList/components/V2WorkspaceRow/V2WorkspaceRow.tsx:259-303,329-391`.
   Replace: the row layout and mark vocabulary in `app/src/components/ActivityList.tsx:43-105`.
   Proposal: retain one run identity; show status word, target, duration, and proof state in stable positions; move rare actions to a fixed trailing slot.
   Why: concurrent runs remain comparable while the detail pane changes width.
   Guardrail: do not copy PR/diff columns or make safety status hover-only; proof remains tied to `app/server/findings.mjs:110-119`.

3. **Grouped tool activity with proof always reachable.**
   Reference: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/utils/transcriptRows/transcriptRows.ts:228-250,285-296`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/components/ToolCallRow/ToolCallRow.tsx:91-150`.
   Replace: the flat step sequence in `app/src/components/RunTimeline.tsx:57-83`.
   Proposal: fold routine reads and scans into phase summaries; keep replay outcomes and real operator decisions visible; expand raw output on demand.
   Why: the operator can distinguish investigation from deterministic evidence without a wall of steps.
   Guardrail: only replay success earns the check already defined in `app/src/components/RunTimeline.tsx:4-20`.

4. **Schedule definition separate from run history.**
   Reference: `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/components/AutomationRow/AutomationRow.tsx:314-398`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/$automationId/components/AutomationBody/AutomationBody.tsx:303-367,417-422`.
   Replace: the launch-only top area at `app/src/components/ActivityList.tsx:151-154` when continuous scheduling is added; do not pretend a scheduler exists today.
   Proposal: a schedule row shows scope, cadence, enabled state, next run, and last dispatch result; its history opens the existing run detail.
   Why: missed coverage and failed execution become visible without mixing schedule settings into every run.
   Guardrail: “created” is only dispatch success, as shown by `apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/utils/runStatus/runStatus.ts:15-23`.

5. **One resizable workspace with reader-preserving transcript navigation.**
   Reference: `packages/ui/src/components/ui/resizable.tsx:31-56`; `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatSession/components/Transcript/Transcript.tsx:265-280,406-457`.
   Replace: the fixed list/detail relationship around `app/src/components/ActivityList.tsx:151-176` and the Conversation scroll area in `app/src/components/RunView.tsx:214-226`.
   Proposal: one divider between run list and detail; keep Conversation/Report tabs; preserve reader position and provide an explicit return-to-live control.
   Why: a security operator can compare a long command or replay trace while new events continue arriving.
   Guardrail: borrow the shared divider primitive, not the full recursive tab engine; the existing two-tab detail contract is `app/src/components/RunView.tsx:204-208`.
