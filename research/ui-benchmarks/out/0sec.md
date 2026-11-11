# 0sec ("0") — UI/UX patterns worth stealing
Repo: https://github.com/0sec-labs/0 @ a891ba1cbf95a74e29f1e9789ebf1000ebad91a3
Revision pointers: `.git/config:7`; `.git/packed-refs:2`.
Scope read: requested UI primitives; their CSS; dashboard shell, console, approvals, findings, persistence, and command-palette sections.
Scope read: dashboard `DESIGN.md`; selected `docs/design/` documents; roadmap sections; negative-results headings, baseline, selected campaign records, and machine-log schema.
Scope not read: every campaign disassembly record, the whole engine, the whole design-doc set, or every component implementation.
Method: source inspection only. No reference code, dependency install, test suite, or browser was run. Runtime and visual quality remain unverified.
Paths below are relative to `reference/0sec-current/`, except `app/` and `design-study-0sec.md`, which are relative to the Touchstone repo root.
Prior art: `design-study-0sec.md:14-31`; this report extends its restraint argument, not its implementation plan.
License correction: this revision offers MIT **OR Apache-2.0**, including the UI package; it is not MIT-only. `README.md:208`; `packages/ui/package.json:6`.
Touchstone changed during inspection: the former Fold/run/detail files were replaced by `system/` components. Replacement pointers below use the final observed source, including `app/src/components/system/read.tsx:14-43` and `app/src/components/system/run-canvas.tsx:149-201`.

## 1. Information architecture

### Shell and primary work

- Agreement with the earlier study: retain a quiet persistent rail around the work surface.
  The rail stays mounted across routes; onboarding is the exception. `design-study-0sec.md:106-110`; `packages/dashboard/src/components/app-shell.tsx:23-30`.
- The main hierarchy is shell → destination → selected resource → local detail.
  Findings illustrates this with a list route, a fingerprint route, then Overview/History/Steps. `packages/dashboard/src/pages/findings-page.tsx:368-387,765-770`.
- Chat history remains available outside the console through a portal into the same rail slot.
  This preserves orientation when an operator leaves a conversation to inspect a finding. `packages/dashboard/src/components/app-shell.tsx:25-30`.
- The rail separates Chats from six destinations: Findings, Automations, Skills, Hosts, Plugins, Memory.
  Settings and the optional team account follow at the bottom. `packages/dashboard/src/console/navigation-rail.tsx:58-65,80-94`.
- Search is an explicit rail action with Meta/Ctrl+K metadata; pinning has Meta/Ctrl+Shift+S.
  These are discoverable controls, not just undocumented shortcuts. `packages/dashboard/src/console/navigation-rail.tsx:23-28,74-76`.
- Collapsed navigation expands on mouse hover or keyboard focus; the pinned state is persisted.
  A 160ms close delay waits for anchored menus, reducing accidental movement during selection. `packages/dashboard/src/console/navigation-rail.tsx:22-45`.
- Collapsed chat history remains mounted but becomes `aria-hidden` and `inert`.
  The hidden history should not enter keyboard navigation. `packages/dashboard/src/console/navigation-rail.tsx:79-82`.
- Shared pages use one 1600px maximum width; `wide` and `readable` do not select different widths.
  Borrow the shared gutter/width contract, not old prop names as evidence of separate layouts. `packages/dashboard/src/components/page-header.tsx:31-33`.
- General non-console panels use a right Sheet with a two-column-width cap.
  This is separate from the full-page finding route described below. `packages/dashboard/src/components/app-shell.tsx:30-36`.

### Findings: queue, review, board, and table

- **Correction:** the fresh default is `viewMode: "inbox"`, labelled **All findings**; Review is not default.
  A saved preference can override it. `packages/dashboard/src/pages/findings-page.tsx:109-119,218-221,407-412`.
- The default sort is severity descending, then newest; the only offered alternative is Newest.
  The type still names business-impact/attention sorts, but execution normalizes them to severity. `packages/dashboard/src/pages/findings-page.tsx:96,118,232,255-261,415`.
- All findings is a `CardList`, not a findings table.
  Each linked row shows title, category, occurrence count, recorded status, severity, workflow, and time. `packages/dashboard/src/pages/findings-page.tsx:852-883,990-1009`.
- Review selects findings whose `reviewGate` is not `none`, then separates Agent review and Your review.
  It is not a queue defined by deterministic replay success. `packages/dashboard/src/pages/findings-page.tsx:265-275,904-920,938-953`.
- Board groups by workflow phase: Backlog, Todo, In Progress, Blocked, Done, Cancelled.
  These are work-management states, not proof states. `packages/dashboard/src/components/finding-workflow-board.tsx:26-60,81-88`.
- Each board column is 20rem wide inside horizontal scrolling; dragging changes phase, not same-column order.
  The handler calls `onMove` only when the target phase differs. `packages/dashboard/src/components/finding-workflow-board.tsx:99-120,127-139,178`.
- Board cards show category, two-line title, impact rationale, business priority, and technical severity.
  A short summary prioritizes Saving, human review, agent review, Running, then Blocked. `packages/dashboard/src/components/finding-workflow-board.tsx:248-259,278-294`.
- Selecting a finding replaces the list with a detail page and an All findings back link.
  It does not retain the queue beside the selected item. `packages/dashboard/src/pages/findings-page.tsx:368-387`.
- The detail page has main evidence plus a 360px review column at XL width.
  Overview is default; the actual table is occurrence History with Scan, Time, and Status. `packages/dashboard/src/pages/findings-page.tsx:637-646,765-770,822-838`.

### Exact filter model

- One persisted object contains search, workflow phase, review gate, severity, consensus, assignee, active-only, view, and sort.
  Its logical key is `0:threads:console-state`. `packages/dashboard/src/pages/findings-page.tsx:95-119,218-221`.
- Storage is browser-local and scoped by backend plus account when applicable.
  This prevents one host/account's preferences from automatically becoming another's. `packages/dashboard/src/lib/use-persistent-state.ts:9-20,29-39,62-67`.
- Search is deferred, trimmed, lowercased, and matched as one substring against concatenated fields.
  Fields include title, impact rationale, category, status, review reason, assignee, active roles, and fingerprint. `packages/dashboard/src/pages/findings-page.tsx:121-143,234,241-245`.
- Filters combine with AND: workflow phase, review gate, severity, consensus, and active-agent presence.
  `assigneeFilter` exists in state but is not applied in this predicate. `packages/dashboard/src/pages/findings-page.tsx:103,244-253`.
- The right Sheet exposes Status, Review, Severity, and Verdict; Verdict means verifier-vote consensus.
  Its wording explicitly distinguishes positive, negative, mixed, and absent votes. `packages/dashboard/src/pages/findings-page.tsx:80-86,480-539`.
- Selecting a filter writes live state immediately; Apply merely closes the Sheet.
  Active badges are labels, not individually removable controls; Clear filters resets the set. `packages/dashboard/src/pages/findings-page.tsx:423-435,491-498,549-553`.

## 2. The one screen that matters most

### Conversation and chronological batches

- A turn is an article with a stable chat anchor, user message, timeline, resolved decisions, workers, and notices.
  This keeps the human request beside its work and interruptions. `packages/dashboard/src/console/transcript-turns.tsx:46-55`.
- The reducer stores assistant, reasoning, and tools as chronological segments.
  Consecutive text of the same kind merges; consecutive tool starts share one tools segment. `packages/dashboard/src/console/transcript.ts:26-29,67-80`.
- A tool ID already present in any tools segment is not appended again.
  Repeated event delivery should not create a second visible entry for the same ID. `packages/dashboard/src/console/transcript.ts:75-80`.
- `TurnTimeline` renders each tool batch beside the commentary that introduced it.
  Only snapshots without segments fall back to reasoning → all tools → assistant text. `packages/dashboard/src/console/turn-timeline.tsx:20-37`.
- **Do not call this semantic phase grouping.** It groups adjacent event types, not Reading/Writing/Proving phases.
  Touchstone would need its own grouping rules for its typed run events. `packages/dashboard/src/console/transcript.ts:67-80`; `app/src/lib/types.ts:212-216`.

### Anatomy of one activity row

- `ActivityRow` accepts icon, title, status, running, failed, and children.
  The whole heading is the shared Disclosure trigger. `packages/dashboard/src/console/activity-row.tsx:8-21`.
- Heading order is icon → title → optional status → chevron; status is a polite atomic live region.
  Running adds a shimmer class to the title; failed changes only the status treatment. `packages/dashboard/src/console/activity-row.tsx:16-20`.
- A standalone row is a bordered muted surface with a 48px minimum trigger and 13px title.
  This remains relevant to resolved approvals outside tool groups. `packages/dashboard/src/console/activity-row.css:1-18`; `packages/dashboard/src/console/transcript-turns.tsx:49`.
- Inside tool activity, later CSS removes the border, fill, icon circle, and detail divider.
  Final trigger geometry is 28px minimum height, 4px vertical padding, and 8px gap—not the earlier 36px rule. `packages/dashboard/src/console/tool-activity.css:1-3,19-22`.
- Tool-row titles truncate; their native title attribute retains the full text.
  The chevron appears on hover, focus, expansion, or non-hover devices. `packages/dashboard/src/console/activity-row.tsx:18`; `packages/dashboard/src/console/activity-row.css:49-55`.

### Anatomy and exact folding rule of a tool group

- `ToolActivity` accepts calls, optional reasoning, working, and showLatest; it starts locally collapsed.
  `startedAt` and `endedAt` appear in the prop type but are not consumed here. `packages/dashboard/src/console/tool-activity.tsx:71-73`.
- No calls and no reasoning means no group, even if `working` is true.
  A separate turn status carries that empty working state. `packages/dashboard/src/console/tool-activity.tsx:73`; `packages/dashboard/src/console/turn-timeline.tsx:8-17`.
- Active means at least one running call OR `working`; failure count comes from structured tool status.
  The summary shows a live mark or tool-kind icon, current wording, counts, sources, and failures. `packages/dashboard/src/console/tool-activity.tsx:74-90`.
- Latest is present when `showLatest || active`; it selects the last running call, else the last call.
  History is every call except that selected object. `packages/dashboard/src/console/tool-activity.tsx:78-80`.
- The newest tool segment gets `showLatest` even after completion; older completed segments show counts.
  “Completed” does not mean every group loses its operation title. `packages/dashboard/src/console/turn-timeline.tsx:27,36`; `packages/dashboard/src/console/tool-activity.tsx:85-86`.
- **The group never automatically opens or closes when work starts or ends.** Only the disclosure callback changes `expanded`.
  The design doc's “then folds” describes compact presentation, not an effect that resets user state. `packages/dashboard/src/console/tool-activity.tsx:72,82`; `packages/dashboard/DESIGN.md:38-39`.
- Opening shows recorded source chips, bounded reasoning, latest tool details, then Earlier calls.
  Each historical call is another closed ActivityRow; Raw details is a third disclosure level. `packages/dashboard/src/console/tool-activity.tsx:59-67,92-98`.
- Tool details separate shell command, source, output, metadata, and raw arguments/results.
  Output is capped at 20rem; input/raw blocks at 16rem; reasoning at 12rem. `packages/dashboard/src/console/tool-activity.tsx:48-60,94`.
- Tool-produced images are rendered after the group, outside its Disclosure.
  A collapsed batch therefore does not hide every kind of result. `packages/dashboard/src/console/turn-timeline.tsx:35-38`.

### Scroll and reading position

- A ResizeObserver follows new content only while the reader is near the bottom.
  Otherwise it reveals Latest instead of forcing the reader back to live output. `packages/dashboard/src/console/conversation.tsx:94-107`.
- Near-bottom means less than 100px away; edge fades use separate 8px thresholds.
  The composer is outside the scrolling transcript, so it remains available while reading history. `packages/dashboard/src/console/conversation.tsx:132-160`.
- Latest scrolls to the end and respects both app and OS reduced motion.
  With more than two turns, a desktop marker rail also jumps to specific turns. `packages/dashboard/src/console/conversation.tsx:150-159`.
- The top/bottom masks fade 48px when content exists beyond the visible edge.
  These are dashboard transcript rules, not behavior built into the ScrollArea primitive. `packages/dashboard/src/styles.css:320-328`; `packages/ui/src/components/scroll-area.tsx:12-25`.

## 3. Streaming and status

- Tool status has four outputs: Running, Done, Stopped, Error.
  A missing terminal result means Stopped, not successful completion. `packages/dashboard/src/console/tool-call-status.ts:8-12`.
- Errors come from structured `success: false` or `is_error: true` receipts, including bounded nested wrappers.
  Arbitrary output text containing “error” is not enough. `packages/dashboard/src/console/tool-call-status.ts:13-27`.
- Exact cancellation-before-dispatch messages become Stopped rather than Error.
  This avoids making an operator stop look like a failed security test. `packages/dashboard/src/console/tool-call-status.ts:3-6,19-21`.
- Tool titles use Running, Failed, Stopped, Ran, or Used, with past-tense handling for common actions.
  Successful historical rows omit the redundant Done status label. `packages/dashboard/src/console/tool-activity.tsx:36-42,65-67`.
- Turn status says Thinking, Working, Worked, or Stopped and includes elapsed time when timestamps permit.
  Its one-second timer only runs during work; completion freezes the duration. `packages/dashboard/src/console/turn-timeline.tsx:8-17`.
- Run feedback lets terminal turn events outrank a session status that is still catching up.
  This is an explicit stale-stream defense, not proof of flicker-free runtime behavior. `packages/dashboard/src/console/run-feedback.ts:20-29`.
- Waiting for your decision, Starting workspace, Running tools, and automatic continuation have distinct labels.
  The operator can distinguish blocked work from continuing inference. `packages/dashboard/src/console/run-feedback.ts:30-38`.
- Cancellation distinguishes requested stop, delayed cleanup, force stop, and unconfirmed stop.
  “Stop requested” is not presented as confirmed termination. `packages/dashboard/src/console/run-feedback.ts:23-27`.
- Tool/token caps stay attached to the completed turn; they do not become a permanent composer warning.
  This keeps an old limit from looking like a blocker on a new request. `packages/dashboard/src/console/run-feedback.ts:13-18`; `packages/dashboard/src/console/transcript-turns.tsx:51-52`.
- The composer shows Stop only while active with no draft or attachments.
  With a draft, sending becomes Queue message or Interrupt and send. `packages/dashboard/src/console/conversation.tsx:257-259`.
- Live text shimmers every 2.5 seconds; completed rows do not receive the live class.
  Both OS and app reduced-motion settings suppress this motion. `packages/ui/src/styles/motion.css:18-30`; `packages/dashboard/src/console/activity-row.tsx:18`.
- Source chips use only Done calls and deduplicate extracted URL origins.
  They are recorded domains, not a count of verified documents or citations to exact pages. `packages/dashboard/src/console/tool-activity.tsx:77,93,102-113`.
- Touchstone already suppresses a reopening flash by retaining the list's known status during initial SSE replay.
  Keep that behavior when borrowing the reference's richer status wording. `app/src/components/system/run-canvas.tsx:41-45`.

## 4. Approval / interrupt / human-in-the-loop

### Card shape and permission meaning

- Pending decisions render after the transcript and queued messages, before the composer.
  They are inline cards, not modal dialogs or a card fixed above the scroll area. `packages/dashboard/src/console/conversation.tsx:141-160`.
- The card is a rounded panel, `bg-card`, 20px padding, and 16px vertical spacing.
  Its heading contains a semantic icon, wrapping title, and a resolved badge when applicable. `packages/dashboard/src/console/approvals.tsx:242-257`.
- Tool use means one tool action; network targets and folder access are conversation-scoped.
  Audit escalation allows tools beyond local code review while retaining other limits. `packages/dashboard/src/console/approvals.tsx:26-49`.
- Operator questions explicitly say answering grants no permissions.
  Do not conflate an answer to “what next?” with authorization to attack a new target. `packages/dashboard/src/console/approvals.tsx:51-55`.
- Why, tool name/input, requested targets, unknown destinations, and requested folder are visible when present.
  Only Current permissions is folded; the earlier “one question + two buttons” summary understates the actual density. `packages/dashboard/src/console/approvals.tsx:260-285`; `design-study-0sec.md:45-51`.
- Current permissions contains target, role, mode, existing target scope, and folder scope.
  The operator can inspect existing authority without losing the requested change. `packages/dashboard/src/console/approvals.tsx:270-285`.

### States and submission

- Busy or resolved disables the form's controls; unresolved busy forms expose `aria-busy`.
  The screen-reader status is Waiting for you, Please wait, or the resolution label. `packages/dashboard/src/console/approvals.tsx:193,249,304-305`.
- Pending actions are Decline plus a kind-specific Allow/Allow targets/Allow folder/Send answers.
  Busy replaces the primary text with loading dots and Please wait. `packages/dashboard/src/console/approvals.tsx:26-55,307-312`.
- Questions use fieldsets, legends, native radios or checkboxes, descriptions, and optional custom text.
  Errors are linked with ARIA and announced; custom input is capped at 8,000 characters. `packages/dashboard/src/console/approvals.tsx:109-178`.
- Multiple unresolved operator questions advance one at a time, with Back and Next.
  Validation prevents advancing an invalid question and focuses the relevant control. `packages/dashboard/src/console/approvals.tsx:196-225,287-311`.
- Final submission validates all questions, trims custom text, and sends structured answers with `approve: true`.
  Decline sends `approve: false`; it does not require completing the questionnaire. `packages/dashboard/src/console/approvals.tsx:221-239,310`.

### What remains after resolution

- Resolution stores `resolved: true` plus an optional approval boolean on the turn decision.
  Absence of that boolean is a distinct Closed state, not implied approval. `packages/dashboard/src/console/transcript.ts:295-303`; `packages/dashboard/src/console/approvals.tsx:204`.
- Resolved decisions appear in their turn as a closed ActivityRow with title plus approved/declined/answered/closed.
  Expanding it reveals the disabled ApprovalPanel; the action footer is removed. `packages/dashboard/src/console/transcript-turns.tsx:49`; `packages/dashboard/src/console/approvals.tsx:193,307-313`.
- **Source-level gap:** the resolved question form initializes an empty local answer draft and does not hydrate submitted answers.
  The reducer's resolution branch only stores the approval boolean; this path is not a readable answer receipt. `packages/dashboard/src/console/approvals.tsx:185,296`; `packages/dashboard/src/console/transcript.ts:300-303`.
- Touchstone's server still auto-approves after the worker exits, while the concurrently migrated UI now renders a pending ApprovalCard.
  Reconcile that permission contract before adopting either presentation as authoritative. `app/server/runs.mjs:340-348`; `app/src/components/system/run-canvas.tsx:162-168`.
- Borrow explicit permission scope for real interrupts and compact receipts for history, without changing proof semantics.
  Keep the separate “Don't count it” ledger action distinct from permission to execute. `packages/dashboard/src/console/approvals.tsx:26-55`; `app/src/components/system/report.tsx:308-320`.

## 5. Component inventory

### Disclosure, in full behavioral detail

- It is a custom React primitive: section + button + two nested reveal wrappers, not Radix, Base UI, or native details.
  Dashboard imports re-export this same package implementation. `packages/ui/src/components/disclosure.tsx:1-27`; `packages/dashboard/src/components/ui/disclosure.tsx:1`.
- It accepts section props except children/onChange, plus required ReactNode summary and children.
  Optional props are actions, open, defaultOpen, onOpenChange, triggerClassName, and contentClassName. `packages/ui/src/components/disclosure.tsx:5-14`.
- `defaultOpen` is false; `open ?? localOpen` chooses controlled or local state.
  Clicks update local state only when uncontrolled, then call `onOpenChange(next)`. `packages/ui/src/components/disclosure.tsx:15-22`.
- `useId` connects button and content; the button has type, expanded state, and controls linkage.
  Content has labelled-by, hidden state, and `inert` while closed. `packages/ui/src/components/disclosure.tsx:17-24`.
- Children always remain mounted, preserving their component state while folded.
  This saves drafts but does not avoid hidden render work. `packages/ui/src/components/disclosure.tsx:4,23-24`.
- Optional actions are siblings of the trigger, not controls nested inside its button.
  They become visible on hover, focus-within, expanded child actions, or non-hover devices. `packages/ui/src/components/disclosure.tsx:19-21`.
- Animation is grid rows 0fr→1fr over 200ms with cubic-bezier(.16,1,.3,1), plus opacity over 120ms ease.
  The inner min-height zero/overflow hidden makes the grid shrink; reduced motion disables transitions. `packages/ui/src/styles/controls.css:3-10`; `packages/ui/src/styles/motion.css:2-6`.
- The primitive provides no built-in chevron, header spacing, content padding, or persistence.
  Callers supply these; ActivityRow adds a 90-degree chevron, while ControlDisclosure adds its own heading treatment. `packages/ui/src/components/disclosure.tsx:18-25`; `packages/dashboard/src/console/activity-row.tsx:20`; `packages/dashboard/src/components/console-control/control-disclosure.tsx:7-14`.
- Confirmed uses include tool groups/raw payloads, activity rows, current permissions, settings, and finding handoff/details.
  One behavior spans small tool logs and larger forms. `packages/dashboard/src/console/tool-activity.tsx:59,82`; `packages/dashboard/src/console/approvals.tsx:271`; `packages/dashboard/src/components/console-control/control-disclosure.tsx:7`; `packages/dashboard/src/pages/findings-page.tsx:705,724`.
- More uses include host chat groups with sibling actions, plan/token breakdown, and source-backed learning details.
  These show why controlled open state and mounted children matter beyond transcripts. `packages/dashboard/src/components/host-sidebar-chat-history.tsx:189`; `packages/dashboard/src/console/inspector.tsx:25-34`; `packages/dashboard/src/components/learning-panel.tsx:86`.

### Honest comparison with Touchstone Fold

- The requested Fold was replaced during this review; its current counterpart is `system/read.tsx` Disclosure.
  It retains default-closed behavior, a rotating chevron, metadata, and an indent; label/meta now accept ReactNode. `app/src/components/system/read.tsx:14-43`.
- Our current implementation still delegates accessibility and state machinery to Base UI.
  The thin wrapper forwards Root, Trigger, and Panel props; rebuilding it is unnecessary. `app/src/components/ui/collapsible.tsx:1-19`.
- The former Graphical wrapper defines measured-height plus opacity transitions with 300ms fallback tokens.
  That is historical comparison evidence, not the current wrapper's animation contract; the new wrapper adds no animation classes. `app/components/graphical/styles.css:1898-1926`; `app/src/components/ui/collapsible.tsx:13-16`.
- Our current Disclosure does not request keepMounted, expose controlled state, or provide sibling actions.
  Keep Base UI; add only the state/action interface required for live batches. The reference keeps children mounted and animates grid tracks. `app/src/components/system/read.tsx:14-42`; `packages/ui/src/components/disclosure.tsx:5-24`; `packages/ui/src/styles/controls.css:3-5`.
- The current app suppresses motion globally for the OS preference; the reference also handles its app preference attribute.
  Neither source alone proves smoother runtime motion or better accessibility. `app/src/index.css:269-275`; `packages/ui/src/styles/controls.css:8-10`.

### Other requested primitives

- `Command`: cmdk wrappers plus a Dialog with screen-reader title/description, grouped results, shortcuts, and checked marks.
  Search stays outside the bounded result scroller; it is not a custom keyboard engine. `packages/ui/src/components/command.tsx:4,32-60,64-98,115-176`.
- The app palette indexes pages, findings, runs, settings, automations, skills, plugins, and memory.
  The useful pattern is searchable real resources, not merely a nicer popup. `packages/dashboard/src/components/command-palette.tsx:144-194,285-347`.
- `ChoiceCard`: a large native toggle button with `aria-pressed`, selected surface, visible check, and focus ring.
  It is not a radio group by itself; callers must supply exclusive-choice behavior. `packages/ui/src/components/choice-card.tsx:6-12`.
- `SegmentedControl`: controlled exclusive values displayed as pressed buttons inside a labelled group.
  It shares tab styling without claiming tab-panel navigation semantics. `packages/ui/src/components/segmented-control.tsx:6-14`.
- `ActivityIcon`, `ActivityChip`, and `SourceChip` separate decoration, button action, and link navigation.
  `ActivityStack` keeps the last three keyed items and a +N count. `packages/ui/src/components/activity-chip.tsx:4-21`.
- `ContextRing`: neutral currentColor SVG, clamped 0–100; undefined percent renders only the track.
  The SVG is aria-hidden, so a caller must provide the readable usage value. `packages/ui/src/components/context-ring.tsx:3-9`.
- `OverflowText`: measures overflow after resize/font readiness and sets distance-based pan duration.
  Hover or keyboard focus can reveal text; reduced motion restores ellipsis. `packages/ui/src/components/overflow-text.tsx:9-23`; `packages/ui/src/styles/primitives.css:10-19`.
- `SelectionHighlight`: one absolute surface follows the selected row with a 200ms transform animation.
  Rows/text do not translate; resize updates placement without animation. `packages/ui/src/components/selection-highlight.tsx:5-31`; `packages/ui/src/motion.ts:3-5`.
- `ScrollArea`: Radix root/viewport with both scrollbars, a corner, and focus feedback.
  It does not implement transcript following, virtualization, or the dashboard's edge fades. `packages/ui/src/components/scroll-area.tsx:1-25`; `packages/dashboard/src/console/conversation.tsx:94-107`.
- `EvidenceTabs` defaults to Request, then Response and Analysis, with preformatted content inside cards.
  No consumer was found in dashboard source; current findings renders those fields inline instead. `packages/dashboard/src/components/evidence-tabs.tsx:14-43`; `packages/dashboard/src/pages/findings-page.tsx:810-819`.

## 6. Design tokens and visual language

- The package token file owns geometry and shared control aliases; the dashboard owns the application palette.
  It imports motion, tokens, primitives, controls, and skeleton styles in one place. `packages/ui/src/styles/tokens.css:1-35`; `packages/dashboard/src/styles.css:4-8`.
- Surface roles: background/foreground, card/card-foreground, popover/popover-foreground, workspace-canvas/workspace-panel.
  Selected and hover surfaces are derived mixes, so selection need not introduce another hue. `packages/dashboard/src/styles.css:73-83`.
- Action roles: primary/foreground/hover/border/text, secondary/foreground, accent/foreground, switch-on/thumb-on.
  `accent` itself is a neutral interaction surface, not the orange brand color. `packages/dashboard/src/styles.css:84-100,196-209`.
- Support roles: muted/foreground, border, input, ring, field-surface, and field-border.
  They separate low-emphasis text, field fill, outline, and keyboard focus. `packages/dashboard/src/styles.css:94-99`; `packages/ui/src/styles/tokens.css:10-11`.
- Destructive roles separate text, filled background, and foreground; dark error text is lighter than the filled red.
  This is more precise than one danger hex applied everywhere. `packages/dashboard/src/styles.css:101-104,210`.
- Sidebar roles include surface/foreground, primary pair, accent pair, border, and ring; charts have five derived stops.
  User-message surface/foreground is a separate light/dark pair. `packages/dashboard/src/styles.css:113-122,214-226`; `packages/ui/src/styles/tokens.css:12-17`.
- There is **one named chromatic brand accent**, orange `#fd802e`, but not one total UI color.
  Primary buttons are white; enabled switches use orange; chart stops derive from orange. `packages/dashboard/src/styles.css:84-91,113-117`; `packages/dashboard/DESIGN.md:41-55`.
- Badge semantics add green success, amber warning, red danger, and sky info.
  These are Tailwind palette values rather than a fully centralized success/warning/info CSS-token layer. `packages/ui/src/components/badge.tsx:20-27`.
- Red means critical/high severity, failed/error, blocked/cancelled, or declined; it is not reserved for proven vulnerabilities.
  Green can mean accepted/completed/done or approved, not deterministic reproduction. `packages/dashboard/src/components/status-badges.tsx:11-36,69-72`; `packages/dashboard/src/console/approvals.tsx:256`.
- Their reusable ConsensusBadge maps verified votes to success, but current findings uses neutral RecordedFindingStatus.
  That component explicitly warns that lifecycle labels are not reproduction receipts. `packages/dashboard/src/components/status-badges.tsx:99-106`; `packages/dashboard/src/components/recorded-finding-status.tsx:3-5`; `packages/dashboard/src/pages/findings-page.tsx:1003`.
- Keep Touchstone's stricter proof color contract instead of importing those meanings.
  Its replay report requires stages.proven AND proof.pass; severity danger also requires proven. `app/src/components/system/report.tsx:76-77`; `app/src/components/system/status.tsx:141-157`.
- Geometry roles are control 8px, menu 12px, panel 16px, composer 22px; control heights are 28/32/40px.
  The semantic role names matter more than copying each number. `packages/ui/src/styles/tokens.css:3-9`.
- Type is Geist for interface text and IBM Plex Mono for code; base sizes are 12/14/16px.
  Tool history uses 12px while standalone activity rows use 13px. `packages/dashboard/src/styles.css:18-23,53-54,165-167`; `packages/dashboard/src/console/tool-activity.css:2`; `packages/dashboard/src/console/activity-row.css:17`.
- Dark surfaces step from #101011 canvas to #19191b panel to #222225 raised surface.
  Light mode retains dark navigation through local sidebar tokens, while portals use the root theme. `packages/dashboard/src/styles.css:184-207`; `packages/dashboard/DESIGN.md:72-79`.
- The restraint rule is tone/spacing before outlines, not “never borders.”
  Tool history removes borders, but findings filters and evidence still use bordered containers. `packages/dashboard/src/styles.css:258-280`; `packages/dashboard/src/console/tool-activity.css:19-22`; `packages/dashboard/src/pages/findings-page.tsx:406,818`.

## 7. What NOT to take

### NEGATIVE-RESULTS: answer the premise honestly

- **Abandoned UI approaches in `NEGATIVE-RESULTS.md`: not found.** It identifies itself as a human-curated PoV failure record.
  Its sections cover fidelity, benchmarks, harness artifacts, campaign negatives, and a machine log—not UI experiments. `0verse/NEGATIVE-RESULTS.md:1-11,28,63,76,94,769`.
- Do not attribute the prior study's no-canvas or no-monospace advice to that log.
  Workflow docs describe a Steps editor and JSON Definition, not evidence of a tried-and-rejected canvas. `design-study-0sec.md:199-210`; `docs/design/security-workflows.md:3-5,74-78`.
- An actual documented UI reversal exists elsewhere: generated coordinator prose and its formatter/tests were removed.
  The replacement shows original task/progress and per-worker context; the doc still calls overview acceptance unresolved. `docs/design/open-issue-status.md:44-45`.
- The record does not establish why users rejected generated prose or provide a usability experiment.
  It asks whether a compact deterministic summary should replace the old requirement; do not invent a stronger causal story. `docs/design/open-issue-status.md:45`.

### Negative results that should change our UI

- A missing execution host leaves Mach-O or PE findings as hypotheses; logic/auth bypass has no generic binary confirmer.
  **Recommendation:** show the blocked confirmation step and capability, not an undifferentiated “finished” badge. `0verse/NEGATIVE-RESULTS.md:33-55`.
- A poisoned start seed made AFL++ abort and falsely resemble “no crash”; they fixed the comparison corpus.
  **Recommendation:** distinguish did-not-run from ran-without-confirmation in the operator's result. `0verse/NEGATIVE-RESULTS.md:80-86`.
- Stack OOB found by ASAN did not replay reliably under a heap-shaped guard allocator.
  **Recommendation:** retain the original diagnostic and failed confirmation separately; never turn one into the other. `0verse/NEGATIVE-RESULTS.md:87-92`.
- The mqueue lane was retired after throughput improved but corpus admission still failed.
  **Recommendation:** show coverage/admission health; a busy counter is not proof of useful execution. `0verse/NEGATIVE-RESULTS.md:105-120`.
- The short-checksum candidate was falsified by a dominating caller guard; prepared triggers were never invoked.
  **Recommendation:** make “ruled out by static evidence” distinct from “replay passed safely.” `0verse/NEGATIVE-RESULTS.md:123-133`.
- Whole-engine Mozilla decompilation hit a deadline and left no result artifact; they rejected the monolithic approach.
  **Recommendation:** display incomplete analysis with its missing artifact, never a clean result. `0verse/NEGATIVE-RESULTS.md:157-163`.
- Noisy AF_ALG campaign reports were quarantined; an actual reproduced race still lacked demonstrated security impact.
  **Recommendation:** separate observed diagnostic, reproducibility, impact, and disclosure eligibility. `0verse/NEGATIVE-RESULTS.md:170-189`.
- The seccomp-notify pilot stopped with zero crash buckets but dormant target operations and zero retained coverage.
  **Recommendation:** count exercised operations before presenting zero findings as useful coverage. `0verse/NEGATIVE-RESULTS.md:761-767`.
- Machine negatives have six reasons: unsupported-format, no-backend, no-candidates, static-only-degrade, all-pruned, unconfirmed-hypotheses.
  **Recommendation:** use reason-specific empty states; these are meaningfully different outcomes. `0verse/NEGATIVE-RESULTS.md:771-782`.
- Negative logging is opt-in via `ZEROVERSE_NEGATIVE_LOG`, append-only, and operator-local.
  This file alone does not prove those negative records are surfaced in the dashboard. `0verse/NEGATIVE-RESULTS.md:771-790`.
- The roadmap says its benchmark numbers are historical and condition-specific, not operational maturity claims.
  **Recommendation:** attach scope and replay conditions to any success metric shown to an operator. `0verse/ROADMAP.md:267-274`.

### Current weaknesses to fix rather than copy

- The default list is severity-first, not operator-action-first; Review gives agent work and human work separate peer columns.
  **Recommendation:** put genuine human interrupts first without making model consensus a proof gate. `packages/dashboard/src/pages/findings-page.tsx:117-118,265-275,904-941`.
- The filter Sheet says Apply while changes are already live; badges cannot remove one filter.
  **Recommendation:** use Done for live filtering, or real draft/apply state, plus individually removable chips. `packages/dashboard/src/pages/findings-page.tsx:428-435,491-498,552-553`.
- Board drag uses only PointerSensor, and selecting a card navigates away from the queue.
  **Recommendation:** add explicit keyboard-accessible move controls and keep our adjacent detail pane. `packages/dashboard/src/components/finding-workflow-board.tsx:77-79,262-268`; `packages/dashboard/src/pages/findings-page.tsx:368-387`.
- Nested group → historical row → Raw details requires several reveals to inspect one old call.
  **Recommendation:** keep failed replay summaries visible and link directly to their exact output. `packages/dashboard/src/console/tool-activity.tsx:59-67,92-98`.
- Source chips collapse full URLs into origins and also scan arguments; “source” does not prove retrieval of a document.
  **Recommendation:** show exact artifact or evidence URLs with provenance, not a domain count as proof strength. `packages/dashboard/src/console/tool-activity.tsx:102-113`.
- Resolved approvals use a ShieldCheck icon even when declined or closed; question answers are not hydrated in the history form.
  **Recommendation:** render a persisted decision receipt with answer, scope, and explicit outcome. `packages/dashboard/src/console/transcript-turns.tsx:49`; `packages/dashboard/src/console/approvals.tsx:185,204,296`.
- All turns are mapped, and folded children remain mounted; folding is not virtualization.
  **Risk, not measured:** long sessions can retain substantial hidden render work. `packages/dashboard/src/console/transcript-turns.tsx:46`; `packages/ui/src/components/disclosure.tsx:23-24`.
- The finding Overview still stacks potentially large Evidence, Response, and Analysis blocks.
  **Recommendation:** make deterministic proof primary and put secondary raw material in a separate view or disclosure. `packages/dashboard/src/pages/findings-page.tsx:810-819`; `app/src/components/system/report.tsx:81-126`.

## 8. Best 5 patterns for Touchstone

1. **Chronological tool batches with one compact live summary.**
   Reference: adjacent tools form a batch; the heading retains latest operation, counts, and failures. `packages/dashboard/src/console/transcript.ts:75-80`; `packages/dashboard/src/console/tool-activity.tsx:74-96`.
   Replace: refine the new read/list batching in `app/src/components/system/run-transcript.tsx:41-60`, shared by `app/src/components/system/run-canvas.tsx:160` and `app/src/components/system/finding-canvas.tsx:117`.
   Adapt: the migration already groups reads; add accessible batch history rather than only a three-file summary. Keep attempts and operator messages separate. `app/src/components/system/run-transcript.tsx:75-95,132-134`.
   Benefit: operators can follow current work while retaining each attempt's evidence, instead of scanning every routine row. `packages/dashboard/src/console/tool-activity.tsx:85-96`.

2. **Reader-controlled follow mode and Latest.**
   Reference: follow resize only near the bottom; otherwise expose a jump action. `packages/dashboard/src/console/conversation.tsx:94-107,132-159`.
   Replace: enrich the plain ScrollBody used for Activity in `app/src/components/system/run-canvas.tsx:158-161`; its current wrapper only supplies overflow. `app/src/components/system/shell.tsx:99-116`.
   Adapt: preserve the reader's position during SSE growth and honor reduced motion explicitly for scripted scrolling. `packages/dashboard/src/console/conversation.tsx:138,159`; `app/src/index.css:269-275`.
   Benefit: an operator reading an earlier failed replay does not lose it when the next tool produces output. `packages/dashboard/src/console/conversation.tsx:100-103`.

3. **One consistent disclosure API, retaining our Base UI primitive.**
   Reference: controlled state and sibling actions extend a default-closed primitive without nesting buttons. `packages/ui/src/components/disclosure.tsx:5-24`.
   Replace: no primitive replacement; extend Fold's current counterpart in `app/src/components/system/read.tsx:14-43` only where batches need controlled state or actions.
   Adapt: retain Base UI and keep Report/Evidence separation; use disclosures within long Evidence sections where needed. `app/src/components/ui/collapsible.tsx:1-19`; `app/src/components/system/report.tsx:81-126`.
   Benefit: operators learn one reveal pattern, while editable content can preserve drafts without mounting every large log forever. `packages/ui/src/components/disclosure.tsx:4,23-24`.

4. **Persisted search and quiet filters over the current activity list.**
   Reference: deferred substring search, shared filter state, count feedback, and scoped persistence. `packages/dashboard/src/pages/findings-page.tsx:218-253,416-419`; `packages/dashboard/src/lib/use-persistent-state.ts:29-39`.
   Replace: extend the migration's existing local query in `app/src/components/system/activity-list.tsx:33-53`, rather than adding a second search control.
   Adapt: filter on our real run/proof/dismissed states, not their verifier-vote consensus; use removable chips and honest live-filter wording. `app/src/lib/types.ts:10-26,158-166`; `packages/dashboard/src/pages/findings-page.tsx:80-86,552-553`.
   Benefit: operators can find a target or unresolved run without losing the continuous list/detail workspace. `app/src/components/system/activity-list.tsx:59-89`; `app/src/components/system/shell.tsx:15-20,34-53`.

5. **Reason-specific negative results beside proof status.**
   Reference: classified negatives distinguish absent backend, no candidates, static-only limits, pruning, and unconfirmed hypotheses. `0verse/NEGATIVE-RESULTS.md:771-782`.
   Replace: enrich Nothing proven/Failed in `app/src/components/system/status.tsx:83-91` and the generic report empty state in `app/src/components/system/report.tsx:36-55`, not the deterministic proof gate.
   Adapt: preserve the server's answered/unanswered distinction and exact submitted-contract replay check. `app/server/runs.mjs:352-368,460-467`.
   Benefit: zero findings cannot look reassuring when execution or coverage failed; model prose remains separate from proof. `0verse/NEGATIVE-RESULTS.md:157-163,761-767`; `app/src/lib/types.ts:85-95`.
