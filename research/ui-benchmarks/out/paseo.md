# Paseo — UI/UX patterns worth stealing
Repo: https://github.com/getpaseo/paseo @ d46ee65 (full HEAD: d46ee6558c043f9fb377d20f05ff662ce27a31f6)
Scope read: all of `docs/design.md`, `docs/agent-stream-disclosure.md`, `docs/agent-stream-performance.md`, `docs/explorer-sidebar.md`, and `docs/coding-standards.md`; selected client/server sections of `docs/architecture.md`.
Scope read: selected source in `timeline/`, `agent-stream/`, `tool-calls/`, `agent-controls/`, `agent-presentation/`, `composer/`, `command-center/`, `styles/`, message components, status components, settings storage, protocol state/mode definitions, and the server stream coalescer.
Scope not read: the complete provider adapters, daemon security implementation, native scroll patches, desktop shell, every plugin, or the complete test suite. No app execution, installs, tests, screenshots, or runtime performance measurements.
Pointer convention: `docs/` and `packages/` paths resolve under `/home/hemanth/Projects/near/redteam-harness/reference/paseo/`. `app/` pointers refer to the Touchstone source inspected under `/home/hemanth/Projects/near/redteam-harness/` before the output-path change.
Evidence labels: **Docs** = stated intent; **Code** = static implementation evidence; **Recommendation** / **Inference** = proposed transfer, not observed runtime behavior.

## 1. Information architecture

### Shell and hierarchy

- **Docs:** The daemon owns agent processes. Clients monitor and control them through WebSocket. The workspace is an operating surface, not just a saved chat.
  Pointer: `docs/architecture.md:3`, `docs/architecture.md:39-43`, `docs/architecture.md:49-56`.

- **Docs:** There are two canonical shell shapes. Settings use list plus detail. Workspaces use tabs on compact layouts and split panes on desktop; the left sidebar overlays or docks.
  Pointer: `docs/design.md:161-178`.

- **Docs:** Explorer is a separate Files/Changes dock. A side pane is ordinary workspace content. Compact sheets are temporary look-ups. These are not interchangeable containers.
  Pointer: `docs/explorer-sidebar.md:6-10`, `docs/explorer-sidebar.md:19-27`.

- **Docs:** Explorer sits outside the split canvas and has its own saved width. Cmd+E changes visibility without changing its selected view. This preserves where the reader left the supporting evidence.
  Pointer: `docs/explorer-sidebar.md:75-82`, `docs/explorer-sidebar.md:112-119`.

- **Docs:** Main workspace content remains primary. Explorer cannot replace the final ordinary pane. An empty workspace shows a launcher rather than creating an agent draft automatically.
  Pointer: `docs/explorer-sidebar.md:139-149`.

- **Code:** The agent directory adds a shallow hierarchy: date section, session row, then workspace/agent identity and metadata. It has five date sections, not five urgency sections.
  Pointer: `packages/app/src/components/agent-list.tsx:41-55`, `packages/app/src/components/agent-list.tsx:418-438`.

- **Code:** Wide rows put workspace, chevron, provider icon, and agent title on the main rail. Compact rows move the agent title and project/branch/time metadata below it.
  Pointer: `packages/app/src/components/agent-list.tsx:224-297`.

- **Inference:** “Always visible” depends on layout. The docs explicitly let navigation yield when three columns become too narrow; do not describe Paseo as a fixed three-pane application.
  Pointer: `docs/design.md:170`, `docs/explorer-sidebar.md:117-129`.

### Command center: actions as well as destinations

- **Code:** The command center combines workspace and agent navigation, workspace file search, and registered commands. Its result union distinguishes these four kinds.
  Pointer: `packages/app/src/command-center/results.ts:53-99`, `packages/app/src/command-center/command-center.tsx:295-339`.

- **Code:** Root actions include adding a project, creating a workspace, importing a session, history, schedules, and settings. Some appear without a query; quieter actions require search.
  Pointer: `packages/app/src/command-center/root-registration.tsx:135-268`.

- **Code:** Workspace contributions include panel opens, tab operations, pane operations, workspace management, and Git actions. Panel commands are gated by Git and split-pane capabilities.
  Pointer: `packages/app/src/command-center/workspace-contributions.ts:18-59`, `packages/app/src/command-center/workspace-contributions.ts:139-160`, `packages/app/src/command-center/workspace-contributions.ts:202-255`.

- **Code:** Agent contributions expose model/provider choices, thinking choices, modes, and option controls. They register only for the active composer, so commands target the current agent rather than every retained pane.
  Pointer: `packages/app/src/command-center/agent-control-contributions.ts:86-109`, `packages/app/src/composer/agent-controls/index.tsx:182-197`.

- **Code:** Search prefers matches in visible labels over hidden keywords. Multi-word queries match tokens across fields. This makes the result order explainable from what the user can read.
  Pointer: `packages/app/src/command-center/results.ts:26-44`, `packages/app/src/command-center/results.ts:141-162`.

- **Code:** Arrow keys move selection, Enter runs it, and Escape closes the surface. An empty-query Backspace leaves a scoped search. Manual scrolling cancels automatic selection reveal.
  Pointer: `packages/app/src/command-center/command-center.tsx:353-372`, `packages/app/src/command-center/interaction.ts:118-127`.

- **Inference:** The argument over static nav is direct access to context-specific verbs without adding permanent chrome. The code explicitly avoids globally registering workspace actions that would do nothing off-route. A broader design-doc argument against static nav was **not found** in the inspected docs.
  Pointer: `packages/app/src/command-center/root-registration.tsx:270-273`, `packages/app/src/command-center/root-contributions.ts:18-36`.

## 2. The one screen that matters most

### What one timeline item means

- **Code:** The rendered unit is a discriminated `StreamItem`, not an arbitrary text log line. There are nine variants: user message, assistant message, thought, tool call, todo list, notification, compaction, plugin item, and turn summary.
  Pointer: `packages/app/src/types/stream.ts:82-91`.

- **Code:** A user message carries stable identity, text, timestamp, optional turn/cursor identity, and attachments. A turn summary is a derived display row with its own ID, host ID, expanded flag, and work counts.
  Pointer: `packages/app/src/types/stream.ts:95-108`, `packages/app/src/agent-stream/turn-collapse/model.ts:74-99`.

- **Docs + code:** One source assistant message remains one display row. The view sends its text to `AssistantMessage`; Markdown blocks are not promoted into separate timeline history items.
  Pointer: `docs/agent-stream-performance.md:32-34`, `packages/app/src/agent-stream/view.tsx:736-758`.

- **Code:** The view dispatches every variant to a specialized renderer. Plans are a tool-detail specialization, and `speak` can become a speech message; neither adds a tenth `StreamItem` variant.
  Pointer: `packages/app/src/agent-stream/view.tsx:905-941`, `packages/app/src/agent-stream/view.tsx:794-803`, `packages/app/src/components/message.tsx:2432-2439`.

### What is collapsed by default

- **Code:** Fresh settings use `chatDisplay: "collapseTurns"` and `autoExpandReasoning: false`. Existing settings can migrate to full or tool-group display, so this is not a universal description of every installed user's screen.
  Pointer: `packages/app/src/hooks/use-settings/storage.ts:161-164`, `packages/app/src/hooks/use-settings/storage.ts:317-320`.

- **Code:** In turn-collapse mode, completed work before the final assistant reply folds beneath a summary. The prompt and final reply remain. The live turn stays unfolded.
  Pointer: `packages/app/src/agent-stream/turn-collapse/model.ts:129-163`, `packages/app/src/agent-stream/turn-collapse/model.ts:184-188`.

- **Code:** Folding requires a loaded prompt/trigger, a completed turn, and meaningful work or an earlier reply. A reasoning-only prelude does not itself meet the work-count condition.
  Pointer: `packages/app/src/agent-stream/turn-collapse/model.ts:54-56`, `packages/app/src/agent-stream/turn-collapse/model.ts:145-161`.

- **Code:** Compaction markers and turn triggers survive collapse. Opening a turn reveals its raw calls rather than nesting a second tool-group summary around them.
  Pointer: `packages/app/src/agent-stream/turn-collapse/model.ts:102-104`, `packages/app/src/agent-stream/presentation.ts:145-158`.

- **Code:** Outside full display, consecutive groupable tools and thoughts form an overview row. Plans, speech calls, and turn-triggering tools stay out. A group starts only when at least two calls exist.
  Pointer: `packages/app/src/agent-stream/presentation.ts:162-163`, `packages/app/src/tool-calls/detail-level/grouping.ts:68-77`, `packages/app/src/tool-calls/detail-level/grouping.ts:102-115`.

- **Code:** Group labels describe work: distinct files edited/read, commands, searches, other tools, and Paseo actions. Reasoning stays out of mixed work summaries; an all-reasoning group still gets a label.
  Pointer: `packages/app/src/tool-calls/detail-level/overview/model.ts:29-70`, `packages/app/src/tool-calls/detail-level/overview/label.ts:29-50`.

- **Code:** Individual tool details and todo cards start closed. Group state starts empty. Opening a standalone call also marks its future group open, so arrival of the next call does not discard the user's choice.
  Pointer: `packages/app/src/components/message.tsx:2307-2312`, `packages/app/src/components/message.tsx:1500-1522`, `packages/app/src/tool-calls/expansion.ts:16-20`, `packages/app/src/tool-calls/expansion.ts:47-50`.

- **Code:** Plans are an important exception. Pending, proposed, and approved plans start open; rejected and canceled plans start closed. The decision footer stays outside the collapsible body.
  Pointer: `packages/app/src/components/plan-card.tsx:26-41`, `packages/app/src/components/plan-card.tsx:80-86`.

### Disclosure without losing the reading position

- **Docs:** A tapped disclosure trigger should keep the same screen Y in the first painted frame, without animation. This is the disclosure doc's central contract; it does not define the default folding policy.
  Pointer: `docs/agent-stream-disclosure.md:3-18`; default policy: `packages/app/src/hooks/use-settings/storage.ts:162-163`.

- **Code:** `TurnSummaryLine` wraps its toggle in `useDisclosureHold`. `DisclosureRow` routes that request to the viewport's `holdRow`, with the trigger's top edge as the default anchor.
  Pointer: `packages/app/src/agent-stream/turn-collapse/summary-line.tsx:20-36`, `packages/app/src/agent-stream/disclosure.tsx:18-38`.

- **Docs/code location drift:** The doc says `view.tsx` wraps each row in `DisclosureRow`. At this commit, `StreamRow` owns that wrapper; `view.tsx` uses the row renderer. The contract remains, but the named implementation location moved.
  Pointer: `docs/agent-stream-disclosure.md:16-18`, `packages/app/src/agent-stream/stream-row.tsx:22-36`, `packages/app/src/agent-stream/view.tsx:77`.

- **Code:** Web disclosure cancels pending bottom-follow work, disables following, records the row/edge/scroll offset, then applies the state change. Reading-anchor reconciliation owns correction rather than the virtualizer.
  Pointer: `packages/app/src/agent-stream/strategy-web.tsx:1176-1183`, `packages/app/src/agent-stream/strategy-web.tsx:478-480`.

- **Docs:** Bottom following resumes only when the list is actually at the end and user scrolling does not own the viewport. Expansion at the bottom can leave a return-to-bottom pill instead of dragging the reader.
  Pointer: `docs/agent-stream-disclosure.md:27-40`.

- **Code:** Wide tool groups expand into a bounded, 400px nested scroll area with an indent rail. Compact groups open a sheet instead; the timeline itself does not expand.
  Pointer: `packages/app/src/tool-calls/detail-level/overview/view.tsx:21-57`, `packages/app/src/tool-calls/detail-level/overview/view.tsx:62-99`.

- **Recommendation:** Borrow the stable trigger, not every nested scroll. A security reader should expand the attempted command or failing assertion without losing its place in the attempt.
  Pointer: `docs/agent-stream-disclosure.md:3-5`, `packages/app/src/agent-stream/turn-collapse/summary-line.tsx:22-25`; target: `app/src/components/RunTimeline.tsx:29-73`.

## 3. Streaming and status

### Long-timeline performance: concrete techniques

- **Docs + code:** The server coalesces bursts on a 60ms default window, with immediate leading delivery after idle and trailing delivery during a burst. Terminal tool updates force a flush; the diagram's rate statement is not an absolute cap for every event.
  Pointer: `docs/agent-stream-performance.md:10-16`, `packages/server/src/server/agent/agent-stream-coalescer.ts:4`, `packages/server/src/server/agent/agent-stream-coalescer.ts:115-131`.

- **Docs + code:** The app batches reducer commits on animation frames and races them against a timer. Background tabs still advance their store when frame callbacks stop.
  Pointer: `docs/agent-stream-performance.md:36`, `packages/app/src/timeline/session-stream-reducers.ts:1855-1876`.

- **Docs + code:** A turn boundary flushes the agent's queued stream updates before changing turn liveness. This avoids rendering “finished” before the last reply has entered the store.
  Pointer: `docs/agent-stream-performance.md:37`, `packages/app/src/timeline/viewed-timeline-sync.ts:529-535`.

- **Code:** Paced reveal drains a text backlog over a 150ms horizon, at most once per 60Hz frame. A burst increases the reveal step rather than appearing as one large jump.
  Pointer: `packages/app/src/agent-stream/text-reveal.ts:19-60`, `packages/app/src/agent-stream/text-reveal.ts:104-120`.

- **Code:** First sight reveals the whole text. Only later growth is paced. Leaving streaming settles the remaining text. History hydration and virtualized remounts therefore do not replay a typewriter effect.
  Pointer: `packages/app/src/agent-stream/text-reveal.ts:130-137`, `packages/app/src/hooks/use-revealed-text.ts:24-45`.

- **Docs + code:** Reuse unchanged history work. Presentation caches history transforms/grouping, the model reuses the rendered tail, and obsolete history-window slices are replaced rather than accumulated.
  Pointer: `docs/agent-stream-performance.md:47-50`, `packages/app/src/agent-stream/presentation.ts:162-188`, `packages/app/src/agent-stream/model.ts:56-76`.

- **Docs + code:** `StreamRow` is a memo boundary around item, layout item, renderer, and viewport props. Unchanged history does not need a React render for every live text tick.
  Pointer: `docs/agent-stream-performance.md:38-46`, `packages/app/src/agent-stream/stream-row.tsx:14-38`.

- **Code:** Wide web splits old virtualized history from mounted recent history and the live head. The recent budget is at least 20 items, extended backward to a turn boundary. This is not “virtualize everything.”
  Pointer: `packages/app/src/agent-stream/model.ts:100-145`, `packages/app/src/agent-stream/history-window.ts:4-39`.

- **Code:** Older web rows use TanStack Virtual, stable item IDs, width-specific measured heights, estimates, and eight-row overscan. The viewport disables the library's own size-change scroll correction.
  Pointer: `packages/app/src/agent-stream/strategy-web.tsx:457-480`.

- **Docs + code:** Native uses forward-order LegendList with 2000px draw distance. The native end pin and held-row anchoring are platform solutions, not requirements for a browser implementation.
  Pointer: `docs/agent-stream-disclosure.md:55-78`, `packages/app/src/agent-stream/strategy-native.tsx:78`, `packages/app/src/agent-stream/strategy-native.tsx:737-767`.

- **Docs:** Native Markdown holds closed blocks in a stable head and reparses a paced tail. A single long block can still cost a full parse. This renderer-internal technique was documented, not independently traced through all renderer files here.
  Pointer: `docs/agent-stream-performance.md:32`, `docs/agent-stream-performance.md:52-56`.

- **Code:** Web assistant rendering caps the displayed string at 32,000 code units, using a grapheme-safe cut where supported. The full source remains available to the component; a completed capped message gets a notice.
  Pointer: `packages/app/src/components/assistant-message-render-limit.web.ts:12-29`, `packages/app/src/components/message.tsx:1190-1199`, `packages/app/src/components/message.tsx:1242-1248`.

- **Docs, not a new measurement:** The performance doc reports p95 visible-update gaps of 383ms on arrival versus 17ms paced in one recorded setup. These are reference measurements, not verified Touchstone targets.
  Pointer: `docs/agent-stream-performance.md:65-76`.

### State vocabulary and visual encoding

- **Code:** There are five lifecycle statuses: initializing, idle, running, error, closed. Separately, there are five display buckets: needs_input, failed, running, attention, done. Do not conflate the two sets.
  Pointer: `packages/protocol/src/agent-lifecycle.ts:1-9`, `packages/app/src/utils/sidebar-agent-state.ts:7`.

- **Code:** Bucket precedence is pending permission, unread error, running/background work, unread attention, then done. A read error can stop looking failed while its lifecycle still says error.
  Pointer: `packages/protocol/src/agent-state-bucket.ts:23-42`.

- **Code:** `AgentStatusDot` is a static 6px filled circle. Needs input is amber, failed is red, running is blue, and attention is green. Done has no dot unless `showInactive` requests the border color.
  Pointer: `packages/app/src/components/agent-status-dot.tsx:34-62`, `packages/app/src/utils/status-dot-color.ts:18-31`, `packages/app/src/utils/status-indicator-geometry.ts:1`.

- **Docs/code mismatch:** The design doc says the running dot pulses. The named `AgentStatusDot` component contains no animation. A separate `StatusIcon` uses a running ring and an amber alert glyph for needs-input.
  Pointer: `docs/design.md:248`, `packages/app/src/components/agent-status-dot.tsx:49-63`, `packages/app/src/components/status-icon.tsx:59-75`.

- **Code:** `agent-list.tsx` does not render those five dots. Its row badges encode archived, pending-permission count, and attention. Pending uses warning tone; attention uses danger tone; archived is neutral.
  Pointer: `packages/app/src/components/agent-list.tsx:100-142`, `packages/app/src/components/agent-list.tsx:239-267`.

- **Code:** The directory separates selection from status: selected/pressed rows use `surface2`; hover uses `surface1`. Time and project metadata remain muted, while the workspace title uses foreground.
  Pointer: `packages/app/src/components/agent-list.tsx:619-649`.

- **Code:** Agent presentation can treat an active turn as running before the lifecycle snapshot catches up. It also exposes a background-work subtitle when work continues without an active foreground turn.
  Pointer: `packages/app/src/agent-presentation/index.ts:73-92`.

- **Code:** A running turn has a loader and optional elapsed time even between text updates. Running and completed footer variants reserve the same 24px content height to avoid a completion jump.
  Pointer: `packages/app/src/agent-stream/turn-footer.tsx:25-29`, `packages/app/src/agent-stream/turn-footer.tsx:119-141`.

## 4. Approval / interrupt / human-in-the-loop

- **Code:** Pending permission requests render after the turn footer as live auxiliary content, separate from the timeline's nine item variants. They are decision surfaces, not just another logged tool row.
  Pointer: `packages/app/src/agent-stream/view.tsx:117-157`, `packages/app/src/types/stream.ts:82-91`.

- **Code:** Requests use provider-supplied actions when available. Otherwise the fallback is Deny and Accept, or Deny and Implement for a plan. Responses preserve the selected action ID.
  Pointer: `packages/app/src/agent-stream/view.tsx:1501-1525`, `packages/app/src/agent-stream/view.tsx:1584-1599`.

- **Code:** A permission card exposes title, description, and the proposed tool detail before its actions. Ordinary details are height-bounded; plan permissions use an open `PlanCard` with the action footer attached.
  Pointer: `packages/app/src/agent-stream/view.tsx:1661-1695`, `packages/app/src/components/plan-card.tsx:41`, `packages/app/src/components/plan-card.tsx:80-86`.

- **Code:** Responses wait for daemon acknowledgement with a 15-second timeout. The mutation tracks pending state and the selected action, so action rendering can distinguish the in-flight choice.
  Pointer: `packages/app/src/agent-stream/view.tsx:1543-1566`, `packages/app/src/agent-stream/view.tsx:1633-1653`.

- **Code:** Questions use a separate form with single-select, multi-select, and custom text. Submit requires all questions answered; navigation presents one current question and preserves the other answers.
  Pointer: `packages/app/src/components/question-form-card.tsx:370-438`, `packages/app/src/components/question-form-card.tsx:568-615`.

- **Code:** Question submission failures appear as an inline error alert. The ordinary permission branch does not render its mutation error; its rejection handler only logs it.
  Pointer: `packages/app/src/agent-stream/view.tsx:1572-1580`, `packages/app/src/agent-stream/view.tsx:1611-1623`, `packages/app/src/agent-stream/view.tsx:1675-1695`, `packages/app/src/components/question-form-card.tsx:619`.

- **Docs/code mismatch:** The coding standard requires pending, success, and failure UI for every fallible user action. The ordinary permission error path above falls short of the failure part of that rule.
  Pointer: `docs/coding-standards.md:48-55`, `packages/app/src/agent-stream/view.tsx:1578-1579`, `packages/app/src/agent-stream/view.tsx:1675-1695`.

- **Code:** Composer cancellation is a separate operation from denying permission. It checks running, already-canceling, connection, and client state before calling `cancelAgent`.
  Pointer: `packages/app/src/composer/actions.ts:170-185`.

- **Recommendation:** Keep “requires a decision” distinct from “still working” in Touchstone. Its current awaiting-approval label says “Proving,” which is not the same operator instruction as Paseo's needs-input bucket.
  Pointer: `packages/protocol/src/agent-state-bucket.ts:29-37`; target: `app/src/components/ActivityList.tsx:25-32`, `app/src/components/RunView.tsx:14-18`.

## 5. Component inventory

### Reusable pieces and their jobs

| Primitive | What it does for the user | Pointer |
| --- | --- | --- |
| `StreamRow` | Keeps unchanged rows stable and supplies the disclosure anchor | `packages/app/src/agent-stream/stream-row.tsx:22-36` |
| `TurnSummaryLine` | Opens the work hidden beneath one completed turn | `packages/app/src/agent-stream/turn-collapse/summary-line.tsx:20-36` |
| `OverviewToolCallGroupView` | Replaces a stretch of calls with a readable work summary | `packages/app/src/tool-calls/detail-level/overview/view.tsx:62-92` |
| `ExpandableBadge` | One shared header, optional disclosure, and optional detail body | `packages/app/src/components/message.tsx:2186-2237` |
| `ToolCall` | Adapts tool state and payload into the shared row | `packages/app/src/components/message.tsx:2285-2458` |
| `ToolCallDetailsContent` | Selects command output, source, diff, search, fetch, or generic detail | `packages/app/src/components/tool-call-details.tsx:448-568` |
| `TodoListCard` | Shows task activity first and the full task list on demand | `packages/app/src/components/message.tsx:1500-1547` |
| `PlanCard` | Keeps a plan and its decision footer together | `packages/app/src/components/plan-card.tsx:65-87` |
| `QuestionFormCard` | Collects structured human answers without a prose-only reply | `packages/app/src/components/question-form-card.tsx:568-657` |
| `AgentStatusDot` / `StatusIcon` | Encodes urgency as a dot, ring, or alert overlay | `packages/app/src/components/agent-status-dot.tsx:34-63`, `packages/app/src/components/status-icon.tsx:59-75` |
| `AgentModeControl` | Offers the current agent's runtime modes beside the input | `packages/app/src/composer/agent-controls/mode-control.tsx:191-230` |
| `CombinedModelSelector` / `CompactModelSheet` | Combines provider/model choice, then folds secondary controls when space is tight | `packages/app/src/composer/agent-controls/index.tsx:800-824`, `packages/app/src/composer/agent-controls/index.tsx:930-978` |

### Tool-call row anatomy: before, during, after

- **Code:** Header anatomy is a leading tool/error icon, primary display name, optional secondary summary, and an optional open-file action. Hover or expansion replaces the icon slot with a disclosure chevron.
  Pointer: `packages/app/src/components/message.tsx:1764-1810`, `packages/app/src/components/message.tsx:2169-2225`.

- **Code:** Before useful details arrive, a running call remains openable. Its expanded body shows a three-line skeleton if no meaningful detail exists. A separate queued/not-started tool-row state was **not found** in this component's status union.
  Pointer: `packages/app/src/tool-calls/presentation.ts:14`, `packages/app/src/tool-calls/presentation.ts:74-89`, `packages/app/src/components/tool-call-details.tsx:531-564`.

- **Code:** During execution, running/executing drives the loading shimmer. Available command/input text can already render; the details do not have to wait for final output.
  Pointer: `packages/app/src/components/message.tsx:1972-1986`, `packages/app/src/components/message.tsx:2443-2454`, `packages/app/src/components/tool-call-details.tsx:156-180`.

- **Code:** Completion removes the loading treatment. Failure passes `isError` and displays a destructive alert icon; error text is appended inside details. Completed calls do not all gain a success check.
  Pointer: `packages/app/src/components/message.tsx:1773-1787`, `packages/app/src/components/message.tsx:2453-2454`, `packages/app/src/components/tool-call-details.tsx:554-564`.

- **Code:** Canceled exists in the presentation status vocabulary but has no distinct canceled badge branch here. Plans do have a canceled outcome and start folded in that state.
  Pointer: `packages/app/src/tool-calls/presentation.ts:14`, `packages/app/src/components/message.tsx:2443-2458`, `packages/app/src/components/plan-card.tsx:41-46`.

- **Code:** Shell detail keeps command and output in one selectable code region. Edit detail uses `DiffViewer`; generic tools use Input/Output sections only when those values are meaningful.
  Pointer: `packages/app/src/components/tool-call-details.tsx:156-205`, `packages/app/src/components/tool-call-details.tsx:365-409`.

- **Code:** Desktop details expand inline; compact details open a sheet. The wide inline body defaults to 400px maximum height. Calls with neither useful nor pending details have no disclosure action.
  Pointer: `packages/app/src/components/message.tsx:2301-2316`, `packages/app/src/components/message.tsx:2356-2369`, `packages/app/src/components/message.tsx:2411-2452`.

### Composer: controls without a settings form

- **Code:** The wide toolbar offers one combined provider/model selector, thinking control, mode control, and feature controls. It opens pickers instead of placing labeled form fields above the input.
  Pointer: `packages/app/src/composer/agent-controls/index.tsx:798-883`.

- **Code:** A draft can select provider and model together. A live agent is one provider's process: its model catalog and profiles are limited to that provider. Do not claim provider switching is available mid-run.
  Pointer: `packages/app/src/composer/agent-controls/index.tsx:138-151`, `packages/app/src/composer/agent-controls/index.tsx:1035-1043`, `packages/app/src/composer/agent-controls/index.tsx:1093-1107`.

- **Code:** Permissions appear through provider modes, not a universal checkbox set. Examples include Always Ask, Accept File Edits, Auto mode, Bypass, and Codex Full Access. These are permission policies, not proof verdicts.
  Pointer: `packages/protocol/src/provider-manifest.ts:38-100`, `packages/app/src/composer/agent-controls/mode-control.tsx:98-108`.

- **Code:** Live mode choices come from the agent's `availableModes`. Selecting one calls `setAgentMode`; errors produce a toast. The control disappears when no modes are available and is disabled without a client.
  Pointer: `packages/app/src/composer/agent-controls/mode-control.tsx:256-305`.

- **Code:** Five density tiers progressively remove carets, labels, and separate controls. Compact folds thinking, mode, and features into the model sheet; iconOnly also removes the model label.
  Pointer: `packages/app/src/composer/agent-controls/layout.ts:10-23`, `packages/app/src/composer/agent-controls/index.tsx:930-978`.

- **Code:** Density follows measured available width and uses 12px hysteresis to avoid oscillation near a boundary. A narrow pane changes which labels show, not the underlying control hit size.
  Pointer: `packages/app/src/composer/agent-controls/layout.ts:74`, `packages/app/src/composer/agent-controls/layout.ts:195-217`, `packages/app/src/composer/agent-controls/index.tsx:451-460`.

- **Code:** Feature controls are supplied as toggle/select descriptors and rendered through shared components. Overflow features become one settings glyph and a focused sheet, not another permanent toolbar row.
  Pointer: `packages/app/src/composer/agent-controls/control-items.tsx:33-63`, `packages/app/src/composer/agent-controls/index.tsx:841-875`.

- **Docs + recommendation:** The send/stop slot has stable geometry. Keep that stability in Touchstone, but retain its static model label while it has one active model instead of importing a multi-provider picker prematurely.
  Pointer: `docs/design.md:73-75`; target: `app/src/components/RunLauncher.tsx:21-35`, `app/src/components/Composer.tsx:13-16`.

## 6. Design tokens and visual language

### Visual rules that transfer to web

- **Docs:** The visual goal is quiet, spacious work. Weight and color establish hierarchy before size. Foreground means the thing being acted on; muted text supplies context.
  Pointer: `docs/design.md:9-13`, `docs/design.md:29-45`.

- **Code:** The authored scale is 14px base, 12px small/code, and 15px content. UI and monospace font stacks are separate. These are tokens, not a recommendation to copy exact sizes.
  Pointer: `packages/app/src/styles/theme.ts:579-589`, `packages/app/src/styles/theme.ts:634-647`.

- **Docs:** Structural labels use medium weight; ordinary row and badge content use normal weight. At most one accent-filled CTA belongs on a surface, and many surfaces have none.
  Pointer: `docs/design.md:35-47`.

- **Code:** Neutral surfaces are stepped independently of text. Light uses white through zinc; the default Paseo dark surface has a subtle green tint. Status dots have separate light/dark color sets.
  Pointer: `packages/app/src/styles/theme.ts:323-345`, `packages/app/src/styles/theme.ts:459-470`, `packages/app/src/styles/theme.ts:204-218`.

- **Docs:** Border policy is semantic: one border around related settings rows, a single divider between them, spacing/surfaces for page lists, and one bottom border for pane chrome. No shadow is needed for every pane.
  Pointer: `docs/design.md:85-97`.

- **Code:** The spacing scale includes 4, 8, 12, 16, 24, and 32px steps. Radius tokens run from none through 16px to full. The design doc reserves pill shapes for buttons rather than making every surface a pill.
  Pointer: `packages/app/src/styles/theme.ts:560-577`, `packages/app/src/styles/theme.ts:611-620`, `docs/design.md:79`.

- **Docs:** Settings reading columns max out at 720px. Workspace surfaces use available width. Code gives chat content its own default 820px maximum, so the workspace can expand without stretching prose indefinitely.
  Pointer: `docs/design.md:123-125`, `packages/app/src/styles/theme.ts:649-650`, `packages/app/src/agent-stream/view.tsx:1725-1729`.

- **Docs:** Pick controls by task: small fixed choices use a dropdown; large searchable choices use a combobox; focused tasks use a modal/sheet; destructive decisions use confirmation.
  Pointer: `docs/design.md:101-117`.

- **Docs:** Errors belong at the smallest affected scope. Partial failure leaves the rest of a list usable. State changes should preserve layout rather than making rows jump.
  Pointer: `docs/design.md:206-224`.

- **Docs/code qualification:** The doc says every font size lives in the theme. Message metadata still has a local 13px constant explicitly marked “no token.” Treat the standards as intent, not proof of universal compliance.
  Pointer: `docs/design.md:3`, `packages/app/src/components/message.tsx:165-167`.

### Coding standards that transfer to web

- **Docs:** Prefer current needs over speculative abstractions. Reuse semantic primitives instead of duplicating their appearance. Import source modules rather than re-export-only barrels.
  Pointer: `docs/coding-standards.md:7-15`, `docs/design.md:17-25`.

- **Docs:** Validate at network, input, and file boundaries. Use discriminated unions for distinct states, infer types from existing schemas, and keep one canonical type per concept.
  Pointer: `docs/coding-standards.md:30-46`.

- **Docs:** Errors must remain structured. Catch only what the caller can handle; rethrow the rest. A claimed capability must reflect what the current runtime can actually perform.
  Pointer: `docs/coding-standards.md:48-55`.

- **Docs:** Effects synchronize external systems, not derived React state. Use reducers for interacting transitions, query ownership for server data, and narrow store subscriptions for rendering.
  Pointer: `docs/coding-standards.md:84-94`.

- **Docs:** Collections should derive shared row models once, not attach every row to a hot global store. Stable IDs and memo-boundary references keep unrelated updates from reaching the whole list.
  Pointer: `docs/coding-standards.md:92-99`.

- **Docs:** Hidden retained panels report zero geometry. Suspend geometry-derived updates until dimensions are positive; test the actual hide/reveal path instead of trusting a settled snapshot.
  Pointer: `docs/coding-standards.md:101-107`.

- **Docs:** Keep comments about why, remove dead/debug code, keep changes focused, and migrate callers while deleting old paths in a refactor. These are general engineering constraints, not Expo-specific rules.
  Pointer: `docs/coding-standards.md:21-28`, `docs/coding-standards.md:77-82`.

## 7. What NOT to take

- Do not let green attention mean exploit proof. Paseo's attention bucket is unread work; Touchstone's proof requires a passing replay of the submitted contract, not a completed agent message.
  Pointer: `packages/protocol/src/agent-state-bucket.ts:39-42`, `packages/app/src/utils/status-dot-color.ts:27-28`; target: `app/server/findings.mjs:110-119`.

- Do not hide the replay behind a generic completed-turn summary. Paseo optimizes for the final assistant reply; a security operator needs the deterministic outcome to outrank that prose.
  Pointer: `packages/app/src/agent-stream/turn-collapse/model.ts:129-133`; target: `app/src/lib/types.ts:59-76`, `app/src/components/RunTimeline.tsx:4-5`.

- Do not copy provider permission bypass as a security-product convenience. Paseo explicitly includes modes without tool prompts; that is unrelated to authorizing targets or deciding whether a finding is real.
  Pointer: `packages/protocol/src/provider-manifest.ts:68-99`; target: `app/src/lib/types.ts:179-198`, `app/server/findings.mjs:110-119`.

- Do not transfer the native scroll patches, end pin, keyboard translation, or 2000px draw distance blindly. Copy the reading-position invariant, then implement it for Touchstone's browser scroll surface.
  Pointer: `docs/agent-stream-disclosure.md:74-88`, `docs/agent-stream-disclosure.md:149-170`; target: `app/src/components/RunView.tsx:214-226`.

- Do not use nested auto-scrolling groups for evidence that the operator is actively comparing. Paseo's open group scrolls to its latest content on size change; that can work against deliberate review inside the group.
  Pointer: `packages/app/src/tool-calls/detail-level/overview/view.tsx:33-55`; target: `app/src/lib/types.ts:65-75`.

- Do not copy the permission error omission or treat the design docs as a compliance audit. Keep a visible retryable failure next to a failed operator decision.
  Pointer: `docs/coding-standards.md:54`, `packages/app/src/agent-stream/view.tsx:1578-1579`, `packages/app/src/agent-stream/view.tsx:1675-1695`.

- Do not build a full coding IDE shell merely because Paseo has one. Touchstone already keeps the queue and detail side by side; its useful transfer is hierarchy and evidence access, not arbitrary terminal/browser tabs.
  Pointer: `docs/explorer-sidebar.md:19-27`, `docs/explorer-sidebar.md:139-149`; target: `app/src/components/ActivityList.tsx:109-112`, `app/src/components/FindingDrawer.tsx:10-14`.

## 8. Best 5 patterns for Touchstone

1. **Attempt summary with an exposed replay result — the single highest-value idea.**
   Reference: completed-turn work summary, `packages/app/src/agent-stream/turn-collapse/model.ts:129-188`; stable toggle, `packages/app/src/agent-stream/turn-collapse/summary-line.tsx:22-35`.
   Replace: the flat `StepRow` sequence in `app/src/components/RunTimeline.tsx:29-82`, shared by live Conversation at `app/src/components/RunView.tsx:214-220` and recorded Conversation at `app/src/components/FindingDrawer.tsx:61-68`.
   Proposed shape: one attempt header with contract/test identity and explicit running, failed, or passed replay outcome; routine reads and raw output open beneath it. Keep the result visible when folded.
   Why: the operator can distinguish attempts and compare outcomes without reading all tool chatter. Bind proof to the submitted contract, as `app/server/findings.mjs:110-119` already does; never substitute the assistant's final answer.

2. **Held disclosure plus reader-owned scrolling.**
   Reference: `docs/agent-stream-disclosure.md:3-5`, `packages/app/src/agent-stream/disclosure.tsx:18-38`, `packages/app/src/agent-stream/strategy-web.tsx:1176-1183`.
   Replace: expansion/scroll behavior within `app/src/components/RunView.tsx:214-226` and recorded transcript review at `app/src/components/FindingDrawer.tsx:63-75`.
   Proposed shape: opening a replay command, assertion, or source excerpt keeps its trigger in place; arriving events do not pull a reader away from older evidence.
   Why: exploit review is comparison work. The relevant command remains under the eye instead of being displaced by new activity; this is the explicit reading invariant in `docs/agent-stream-disclosure.md:27-40`.

3. **Shared tool-row header with domain-specific evidence details.**
   Reference: `packages/app/src/components/message.tsx:2443-2458`, `packages/app/src/components/tool-call-details.tsx:448-568`.
   Replace: the label/detail-only ordinary step body at `app/src/components/RunTimeline.tsx:57-70`.
   Proposed shape: action icon, action name, target/contract summary, and a disclosure. Render source reads, replay stdout, and errors as distinct detail bodies; retain the replay-only success mark.
   Why: operators see what ran and where before opening payloads. Reuse actual `PocRun.raw`, contract, test, and pass fields rather than synthesizing proof from tool completion; `app/src/lib/types.ts:29-41`.

4. **Separate needs-input urgency from running and proven state.**
   Reference: `packages/protocol/src/agent-state-bucket.ts:29-42`, `packages/app/src/utils/sidebar-agent-state.ts:31-42`, `packages/app/src/utils/status-dot-color.ts:15-31`.
   Replace: the shared live treatment in `app/src/components/ActivityList.tsx:25-49` and ambiguous awaiting-approval label in `app/src/components/RunView.tsx:14-18`.
   Proposed shape: label operator decisions explicitly; use a distinct warning cue for needs-input and a quiet working cue for active runs. Keep proven/dismissed evidence state separate.
   Why: the queue answers “what needs me?” without implying a successful exploit. Touchstone already separates accepted state, proven, and dismissed in `app/src/lib/types.ts:6-25`.

5. **Contextual command center instead of growing static navigation.**
   Reference: `packages/app/src/command-center/command-center.tsx:295-339`, `packages/app/src/command-center/results.ts:26-44`, `packages/app/src/command-center/root-registration.tsx:270-273`.
   Replace: the inert inventory destinations in `app/src/components/Sidebar.tsx:6-13` with a search entry for real scopes, runs, findings, and actions; preserve useful persistent scope navigation.
   Proposed shape: search by visible target/run/finding names, then show only actions supported by the selected run. Keep model identity static while `app/src/components/RunLauncher.tsx:21-35` chooses one model.
   Why: the operator reaches evidence and valid actions without scanning more navigation. This borrows context gating, not Paseo's coding-specific command catalog; `packages/app/src/command-center/workspace-contributions.ts:219-237`.
