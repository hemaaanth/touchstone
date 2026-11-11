# ARTEX — UI/UX patterns worth stealing
Repo: https://github.com/Autumn-27/ARTEX @ f9642c1
Scope read: `web/` routes, navigation, session rendering, finding/evidence components, status tokens; all table declarations in `db/schema.sql` and the separate record/usage schemas; selected `report/`, `evidence/`, `traffic/`, `guard/`, `intercept/`; evidence docs; README; UI-related CHANGELOG entries; findings and sessions screenshots.
Not read: every backend handler, every component, dependency source, or the full changelog. No server, build, dependency install, test, or live demo was run. Screenshot observations are not runtime verification.
Pointers below are relative to `reference/ARTEX/`. `app/...` pointers are relative to the Touchstone repository root instead. Screenshot pointers use their README embedding lines because PNG files have no source lines.

## 1. Information architecture

### Correct the starting assumptions
- This is a Go backend with a Next.js frontend, not a Go-template UI. The README names both stacks. (`README.md:3`)
- Next 16, React 19, Tailwind 4, shadcn/Base UI, Radix, and Zustand are declared dependencies. Do not describe this checkout as Alpine or htmx. (`web/package.json:22-79`)
- Release UI can be a static Next export embedded in Go. Development proxies `/api` to Go. Static HTML delivery is not server-rendered Go application state. (`web/next.config.mjs:21-37`; `README.md:100-108`)
- The public demo uses mocks. Its pixels can illustrate layout, but not prove live security operations. (`web/next.config.mjs:6-7,28-31`)
- The schema does not name an `engagement` or `target` table. The closest work container is `tasks`; targets are typed `assets`, with separate scope rules. (`db/schema.sql:40-81,505-535,738-749`)
- Assessment: the model is the strongest reference, but the UI is not merely thin. It has paged sessions, evidence binding, retests, approval audit, and task archives. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:90-101`; `db/schema.sql:571-601,1112-1172`)

### Full persisted object model
`1--*` means one-to-many; `1--0..1` means optional one-to-one; `..>` means a logical reference, not a declared foreign key. Nullable FKs allow an absent parent. Diagram annotations cite each branch.

```text
companies 1--* company_scope                         [db/schema.sql:27,115-131]
companies 1--* assets                               [db/schema.sql:40-81]
companies 1--* tasks                                [db/schema.sql:505-523]
task_categories 1--* tasks                           [db/schema.sql:493-512]
task_categories 1--* task_templates                  [db/schema.sql:613-624]
task_templates ..> new task description/goal/rules   [db/schema.sql:611-622]
tasks --> exactly one exploration (unique FK)       [db/schema.sql:505-514]
tasks 1--0..1 task_archives                          [db/schema.sql:571-601]
tasks *--* tasks via task_relations                  [db/schema.sql:634-643]
tasks *--* assets via task_asset_links               [db/schema.sql:645-657]
assets.task_ids ..> tasks (legacy association array) [db/schema.sql:51,645-647]
task_asset_links *--0..1 exploration_nodes           [db/schema.sql:648-654]
tasks 1--* task_scope *--0..1 companies              [db/schema.sql:738-749]
tasks 1--* task_intercept_rules                      [db/schema.sql:1267-1279]
explorations 1--* task_constraints                   [db/schema.sql:283-295]
explorations 1--* exploration_nodes                  [db/schema.sql:153-194]
  node kinds: begin | goal | intent | fact | finding | hint | digest [db/schema.sql:184]
  nodes *--* nodes via exploration_edges            [db/schema.sql:248-257]
  edge rel: spawns | derived_from | yields | proves | covers [db/schema.sql:256]
  nodes *--* assets via exploration_anchors          [db/schema.sql:276-280]
explorations 1--* activity *--0..1 nodes              [db/schema.sql:298-315]
explorations 1--* main_sessions                      [db/schema.sql:341-351]
  activity.main_seg ..> main_sessions.seq            [db/schema.sql:317-321]
tasks/nodes 1--* findings (nullable source links)     [db/schema.sql:1081-1100]
  findings.asset_ids ..> assets (JSON, not FK)       [db/schema.sql:1093]
  findings.report = Markdown field, not report row  [db/schema.sql:1098-1099]
findings 1--* finding_retests                        [db/schema.sql:1112-1129]
finding_retests 0..1--0..1 conversations             [db/schema.sql:1115]
findings 1--* finding_traffic_bindings               [db/schema.sql:1163-1172]
traffic_evidence_snapshots 1--* bindings             [db/schema.sql:1146-1172]
  snapshots.req_hash/resp_hash ..> evidence blobs    [evidence/store.go:33-55]
  snapshots.source_traffic_id ..> captured traffic  [db/schema.sql:1148]
llm_profiles 1--0..1 llm_profile_health              [db/schema.sql:362,479-486]
llm_profiles 1--* tasks (preferred + active profile) [db/schema.sql:519-521]
llm_profiles *--* tasks via task_llm_profiles        [db/schema.sql:696-708]
llm_profiles 1--* agents/conversations               [db/schema.sql:774,958]
agents 1--* agent_prompts / agent_prompt_vars        [db/schema.sql:804-827]
agents.current_prompt_id --> agent_prompts          [db/schema.sql:814-817]
agents 1--* agent_visibility ..> mcp_servers/tools   [db/schema.sql:877-885]
agents 1--* agent_skill_visibility ..> skill folders [db/schema.sql:888-899]
mcp_servers 1--* mcp_tools_cache                     [db/schema.sql:833-871]
tools.agents ..> agents (JSON membership)            [db/schema.sql:935-945]
agent_triggers.agent_key ..> agents                 [db/schema.sql:993-1012]
conversations.agent_key ..> agents                  [db/schema.sql:954-962]
conversations 1--* conversation_activities           [db/schema.sql:970-985]
intercept_rules 1--* intercept_pending               [db/schema.sql:1033-1074]
conversations 1--* intercept_pending                [db/schema.sql:1056]
intercept_pending.task_id ..> tasks (TEXT)           [db/schema.sql:1057]
asset_intercept_rules = independent global policy   [db/schema.sql:1241-1253]
conversation OR task/exploration/intent --> side_question_sessions [db/schema.sql:1189-1200]
  sessions 1--* side_question_requests              [db/schema.sql:1189-1224]
notification_events.finding_id ..> findings          [db/schema.sql:1336-1350]
notification_events 1--* notification_deliveries     [db/schema.sql:1359-1378]
notification_channels 1--* notification_deliveries   [db/schema.sql:1303-1331,1362]
llm_records ..> task/session/worker debug dimensions [db/commands.go:157-176]
llm_usage ..> task/exploration/worker usage          [db/llm_usage.go:29-48]
skill_usage / tool_usage ..> task/agent/session      [db/schema.sql:897-930]
settings / scheduler_state = independent key/value  [db/schema.sql:356-360,1025-1028]
server_logs = independent level/tag/text history    [db/schema.sql:1179-1186]
```

- Every `db/` table declaration is represented above. Captured traffic is an additional store outside that schema: reads join SQLite `exchanges` with `exchange_bodies`, with optional blob files. (`traffic/evidence.go:46-104`)
- Assets are `root_domain`, `ip`, `subdomain`, `app`, `service`, and `endpoint`. This is not a generic target-name string. (`db/schema.sql:40-78`)
- Company ownership can be explicit or derived from scope. Task association has its own source, summary, and source-node pointer. This helps answer why an asset belongs to the work. (`db/schema.sql:45-50,648-655`)
- Scope and evidence are different relations. `task_scope` defines the tested set; anchors connect graph nodes to concrete assets. (`db/schema.sql:276-280,738-749`)
- A conversation reset does not reset the task. Main-session segments share the goal, assets, and exploration graph. (`db/schema.sql:341-350`)
- Findings can survive deletion of their task or graph node because both source FKs use `SET NULL`. This is a durable finding ledger, not just a transcript projection. (`db/schema.sql:1081-1084`)
- Retest execution status and retest verdict are separate from finding disposition. One active retest per finding is enforced by a partial unique index. (`db/schema.sql:1094-1099,1112-1129`)
- There is no separate report table in this model. Finding Markdown is persisted; task-summary Markdown is rendered from graph findings. (`db/schema.sql:1098-1099`; `report/report.go:15-43,48-91`)

### Screens, landing, and table-to-screen map
- `/` redirects to `/function/tasks`; successful login and initial setup also land on tasks. Dashboard is not the first work screen. (`web/src/app/(external)/page.tsx:1-5`; `web/src/app/(auth)/login/page.tsx:69-73`; `web/src/app/(auth)/setup/page.tsx:44-45`)
- Global Features navigation: Dashboard, Conversation, Task, Discover, Traffic, Tool execution, LLM Record, Asset, Asset Sync, Workspace. (`web/src/navigation/sidebar/sidebar-items.ts:64-79`)
- System navigation: LLM, Agent, MCP, Skill, Tool, Notification push, Intercept rule, Asset Interception, Approval Records, Logs, System settings. (`web/src/navigation/sidebar/sidebar-items.ts:81-95`)
- `tasks`, categories, and archives map to the task list: status/category filters, sorting, pinning, bulk actions, Current/Archived tabs. (`web/src/app/(main)/function/tasks/page.tsx:279-400,780-907,999-1013`)
- `companies`, `company_scope`, and typed `assets` map to Asset management. Enterprise is its default tab; the page imports the shared scope parser. (`web/src/app/(main)/function/assets/page.tsx:62-63,100-115`)
- Task detail maps the same task to Session, Overview, Explore chain, Broadcast board, Discover, Retest, Test assets, Asset coverage map, Block approval, and Report. (`web/src/app/(main)/function/tasks/detail/page.tsx:53-64,418-449`)
- `activity`, `main_sessions`, and worker intent nodes map to the Session tab; graph nodes and edges have separate graph/broadcast tabs rather than becoming chat messages only. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:90-101,1659-1688`; `web/src/app/(main)/function/tasks/detail/page.tsx:426-430`)
- `findings`, retests, and evidence bindings map to the global finding ledger and finding detail. The ledger has flat/grouped row reuse; the detail owns proof and retest panels. (`web/src/app/(main)/function/findings/_components/findings-table.tsx:113-115`; `web/src/app/(main)/function/findings/detail/page.tsx:167-215`)
- Intercept policy and pending/audit records have separate rule and approval destinations. The same approval component accepts an optional task scope. (`web/src/navigation/sidebar/sidebar-items.ts:91-94`; `web/src/components/approval-records.tsx:650-685`)
- Agent/prompt/visibility, LLM/profile health, MCP/tools, and skill data belong to System configuration rather than task transcript navigation. These are destination-level mappings, not a claim that every backing table has its own screen. (`db/schema.sql:766-945`; `web/src/navigation/sidebar/sidebar-items.ts:85-89`)
- `notification_channels` and delivery history map to Channel and Delivery records tabs. Server logs have a separate System Log viewer. (`web/src/app/(main)/system/notify/page.tsx:343-345`; `web/src/app/(main)/system/logs/page.tsx:142-178`)
- `llm_records` has a global debug screen; lightweight `llm_usage` is a separate ledger without prompt bodies. Do not confuse debug capture with spend accounting. (`web/src/navigation/sidebar/sidebar-items.ts:75`; `db/llm_usage.go:9-14`)

### Navigation at scale
- Hierarchy is global destination → task → tab → session/detail. The sidebar does not grow one item per task. (`web/src/navigation/sidebar/sidebar-items.ts:64-98`; `web/src/app/(main)/function/tasks/detail/page.tsx:53-64`)
- Task list search matches name, category, description, goal, and ID. Filters and sort preferences persist; pinned tasks sort first. (`web/src/app/(main)/function/tasks/page.tsx:279-397`)
- Pagination is client-side over the fetched task array. It reduces visible density, but is not evidence of server-paged scalability. (`web/src/app/(main)/function/tasks/page.tsx:356-400,459-463`)
- Cold archives preserve compact metadata in PostgreSQL and move full payloads to versioned packages. Current/Archived separation keeps historical work out of the active queue. (`db/schema.sql:568-601`; `web/src/app/(main)/function/tasks/page.tsx:780-784`)
- Ctrl/Cmd+J opens navigation search. It indexes sidebar destinations, not task names or evidence text. (`web/src/app/(main)/_components/sidebar/search-dialog.tsx:39-64,85-94`)
- Ordinary pages retain global search/theme/account controls. Task detail replaces that header with task-specific controls, so search is not always visible. (`web/src/app/(main)/_components/main-content.tsx:20-48,59-76`)

## 2. The one screen that matters most

### Task Session: follow the investigation without opening every tool result
- Task detail defaults to Session, not its summary or graph. Operators first see the work that is happening. (`web/src/app/(main)/function/tasks/detail/page.tsx:212`)
- The sticky header keeps task name, ID, model control, execution state, pause/resume, goal, and tab navigation together. (`web/src/app/(main)/function/tasks/detail/page.tsx:353-415`)
- Desktop uses an 18rem session list beside the transcript. Mobile stacks them and allows collapsing the list. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1569-1602`)
- Main Agent, Planner, and Workers are separate session groups. This makes concurrent work selectable instead of interleaving all output in one stream. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1659-1688`)
- Session summaries load first; older history is fetched when scrolling up. A per-session cache and one task-level SSE feed avoid loading every transcript eagerly. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:90-101,748-772,971-977`)
- Incoming history is merged by sequence. The 4,000-event cap does not trim the active session while the operator is reading older content. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1020-1029`)
- Scroll-up loads preserve the viewport by adding the height delta. New output follows the bottom only when the reader is already there. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:753-772,1433-1466`)
- Lazy expansion also respects bottom-follow through a ResizeObserver. This addresses content growth after the event array has already arrived. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1467-1485`)
- One tool call and its result share a collapsed row. Expanding loads both input and output. The operator does not have to pair two distant log entries. (`web/src/components/transcript.tsx:351-386,473-476`)
- Agent fragments coalesce into message groups. Thinking folds; final answers and main-agent text remain readable as full Markdown. (`web/src/components/transcript.tsx:87-109,482-496,636-641`)
- Bodies near the viewport load lazily. This is deferred detail loading, not proof of full list virtualization. (`web/src/components/transcript.tsx:46-65`)
- The bundled session screenshot shows a light admin shell, a narrow role list, a large conversation pane, and a bottom composer. Its bubbles contain demo text, not real execution evidence. (`README.md:17-19`, image `screenshots/sessions.png`; `web/next.config.mjs:6-7`)

### Finding detail: exact field order and first-view priority
- The current ledger columns are selection, expansion, Severity, Vulnerability Name, Asset, Status, Associated Task, Time, Actions. (`web/src/app/(main)/function/findings/_components/findings-table.tsx:145-162`)
- Name cells include a one-line summary and traffic-evidence count. Asset cells show up to three labels, then a remainder count. (`web/src/app/(main)/function/findings/_components/findings-table.tsx:201-232`)
- Finding detail starts with a sticky title, ID, severity, disposition, and inherited/read-only marker. Overview and Link diagram sit directly below. (`web/src/app/(main)/function/findings/detail/page.tsx:129-157`)
- Left-column order is Summary → Vulnerability retest → Evidence / PoC → Associated traffic → Detailed report. Retest comes before the original proof. (`web/src/app/(main)/function/findings/detail/page.tsx:167-215`)
- Right-column order is Vulnerability ID → Severity Level → Processing status → Vulnerability Type → Related assets → Associated Task → Discovery time. (`web/src/app/(main)/function/findings/detail/page.tsx:219-321`)
- The right status panel is sticky on large screens. Severity and disposition are editable unless this is an inherited finding. (`web/src/app/(main)/function/findings/detail/page.tsx:219-273`)
- [INFERENCE] Above the fold: title/status and Summary get priority, with the status panel alongside on desktop. Exact fold position is not verified; summary length, retest history, and viewport size can push proof down. (`web/src/app/(main)/function/findings/detail/page.tsx:134-175,219`)
- Evidence text has its own 46vh maximum and scroll. The report follows later, with a stale-evidence warning and copy action. (`web/src/app/(main)/function/findings/detail/page.tsx:178-213`)
- Link diagram is secondary to Overview. It exposes the path to the finding without forcing every operator into a graph first. (`web/src/app/(main)/function/findings/detail/page.tsx:155-156,328-330`)
- The bundled findings screenshot is a list, not a detail-screen screenshot. It shows white statistic cards, severity pills, filters, table rows, and a left sidebar. (`README.md:21-23`, image `screenshots/findings.png`)
- Screenshot columns differ from current source. Use the current table declaration for field order; do not treat screenshot pixels as the exact current contract. (`README.md:21-23`, image `screenshots/findings.png`; `web/src/app/(main)/function/findings/_components/findings-table.tsx:145-162`)

### Evidence becomes a deliverable
- Separate the evidence index from raw packets. Each binding row leads with order, role, method/status, evidence ID, URL, note, and capture time. (`web/src/components/finding-traffic-panel.tsx:135-156`)
- Roles are Normal reference, Vulnerability proof, Supplemental verification, and Supporting evidence. They explain what a packet contributes, not just that it exists. (`web/src/components/finding-traffic-panel.tsx:30-35`)
- Operators can bind, annotate, reorder, and unbind evidence. Inherited findings expose it read-only. (`web/src/components/finding-traffic-panel.tsx:103-112,158-203`)
- Packet bodies open on demand in a dialog with Request/Response tabs, byte totals, truncation labels, Load More Content, and full-body downloads. (`web/src/components/traffic-evidence-viewer.tsx:30-62,72-114`)
- SHA-256 and body lengths live in snapshot metadata; verified bodies live in a separate content-addressed store. The ordinary evidence row does not lead with hash strings. (`db/schema.sql:1146-1161`; `evidence/store.go:33-55`; `web/src/components/finding-traffic-panel.tsx:135-156`)
- Clearing raw traffic must not destroy bound proof. The panel states this explicitly; the evidence design documents separate storage and retention. (`web/src/components/finding-traffic-panel.tsx:112`; `docs/漏洞流量证据.md:58-66`)
- Logs and commands can remain textual evidence when HTTP capture is absent. Traffic binding is optional, not a fake requirement that encourages invented packets. (`docs/漏洞流量证据.md:7-9`)
- Evidence changes increment the report contract: report generation must use the current evidence version, and stale reports are visibly marked. (`docs/漏洞流量证据.md:30-32`; `web/src/app/(main)/function/findings/detail/page.tsx:204-207`)
- Findings exports include Markdown, per-finding Markdown, CSV, and JSON via the server. CSV intentionally omits long proof/report bodies. (`report/findings.go:16-17,93-119,143-164`)
- Markdown exports sort by severity and then recency, retain task attribution and proof, and append an ordered traffic-evidence list. (`report/findings.go:19-26,65-88,178-197`)
- The documented ZIP package includes a manifest, HTTP packets, and binary bodies with relative links. Export staging freezes versions and makes private body copies before the response begins. (`docs/漏洞流量证据.md:68-81`; `evidence/store.go:118-120`)
- Task Report is a simpler surface: a Markdown pane capped at 60vh and a Copy button. Do not imply that this tab is the full packaged-export workflow. (`web/src/app/(main)/function/tasks/detail/_tabs/report-tab.tsx:58-87`)

## 3. Streaming and status

- Task vocabulary distinguishes Created, Queued, In progress, Paused, Completed, Failed, and Timed out. Queued is not presented as actively executing. (`web/src/lib/status.ts:49-57`)
- Worker intent vocabulary also distinguishes Pending claim, Execution error, Budget exhausted, Stopped, and Deleted. A budget stop is not success. (`web/src/lib/status.ts:34-46`)
- Engine mode separately says Exploring, Paused, Stalled, or Idle. The task header uses terminal task state only after completion/failure/timeout. (`web/src/lib/status.ts:78-83`; `web/src/app/(main)/function/tasks/detail/page.tsx:369`)
- Persistent queue fields include `queued`, `queued_at`, and `queue_mode`; FIFO admission is not inferred from task creation time. (`db/schema.sql:516-518,549-553`)
- A task Session has a transport indicator: Real-time or Reconnecting. Reconnection keeps history visible rather than replacing it with an empty loading screen. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1604-1621`)
- SSE opens from the history snapshot cursor and uses sequence merging. Connection state changes on `onopen`/`onerror`; it is separate from worker state. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:872-877,971-977,1020`)
- Recent activity uses a five-second window, but main-agent liveness is gated by actual running state so its badge does not linger after completion. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:101,1194-1213`)
- Task metadata polls every five seconds. An in-flight guard prevents overlapping loads, and failed polls keep the last task state. (`web/src/app/(main)/function/tasks/detail/page.tsx:243-274`)
- Task-list updates compare serialized results before replacing state. This avoids unnecessary rerenders when a poll returns unchanged rows. (`web/src/app/(main)/function/tasks/page.tsx:459-463`)
- Dashboard polls findings, stats, settings, pending approvals, recent activity, and token summaries every five seconds. It shows a running-task count. (`web/src/app/(main)/dashboard/page.tsx:190-214,512-514`)
- Global activity indicator: a persistent running-job counter was not found in the inspected shell. The global actionable indicator is the Approval Records badge, polled every five seconds and capped at `99+`. (`web/src/app/(main)/_components/main-content.tsx:59-76`; `web/src/app/(main)/_components/sidebar/nav-main.tsx:164-202`)
- Task-specific pending approval counts also appear on Block approval; session rows check whether an approval belongs to that agent. (`web/src/app/(main)/function/tasks/detail/page.tsx:407-410`; `web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1177-1189`)
- Traffic refreshes only the newest page every five seconds. Older pages remain stable while the operator reads. (`web/src/app/(main)/function/traffic/page.tsx:229-238`)
- Broadcast-board release notes describe a separate unread count when the reader leaves the live position. This is documented behavior, not an exercised interaction. (`CHANGELOG.md:149-152`)
- System logs use SSE, deduplicate sequence IDs, and cap the live buffer at 3,000 rows. Pause and level filtering are local inspection controls. (`web/src/app/(main)/system/logs/page.tsx:42-49,67-77,128-175`)
- Archive jobs persist phase, progress, error, warnings, and distinct archive/restore/delete failure states. That is useful job-state modeling beyond a spinner. (`db/schema.sql:571-582`)

## 4. Approval / interrupt / human-in-the-loop

- Tool interception supports allow, deny, or ask. Ask creates a pending record and blocks until a decision or configured timeout. (`intercept/intercept.go:5-11`; `db/schema.sql:1033-1066`)
- Approval is shown in three contexts: global records, the task tab, and inline transcript cards. The user can act where the blocked call is visible. (`README.md:43-45`; `web/src/components/transcript.tsx:184-197,299-324`)
- Inline cards use a warm border/background and explicit allow/deny controls. Details fold beneath the decision instead of dominating the conversation. (`web/src/components/transcript.tsx:261-262,299-327`)
- Pending approvals are loaded independently from paged history and filters. An unresolved call cannot disappear merely because newer history filled page one. (`web/src/components/approval-records.tsx:679-699,859-865`)
- Expanded approval details separate the review decision from execution outcome. “Allowed, awaiting execution result” is not “Execution Successful.” (`web/src/components/approval-records.tsx:167-174,330-334`)
- Source navigation locates the original call. The changelog describes loading history to the target and expanding/highlighting it without dropping adjacent messages. (`web/src/components/approval-records.tsx:62-80`; `CHANGELOG.md:220`)
- Audit detail exposes input, rule/model provenance, decision time, execution output, tool invocation ID, and SHA-256 fingerprints behind disclosure. (`web/src/components/approval-records.tsx:365-398,420-507`)
- Missing legacy snapshots and ambiguous call correlation are explicit. The UI refuses to invent execution output for an uncertain match. (`web/src/components/approval-records.tsx:415-417,494-499`)
- Pause/resume is a task-header action with terminal-state guards. Archiving requires confirmation and explains the cold-storage effect. (`web/src/app/(main)/function/tasks/detail/page.tsx:278-286,371-398`)
- Finding severity/disposition edits are separate human decisions. They update optimistically and roll back on API failure. (`web/src/app/(main)/function/findings/detail/page.tsx:80-109`)
- Start retest launches a separate session and preserves each result. The panel links to the ongoing conversation rather than pretending the original finding is being overwritten. (`web/src/components/finding-retest-panel.tsx:86-101`; `db/schema.sql:1111-1125`)
- Evidence binding, role notes, order, and removal are review actions with an explicit read-only inherited mode. (`web/src/components/finding-traffic-panel.tsx:103-112,158-203,237-275`)
- Raw traffic deletion uses confirmation state and retains the dialog after failure. This is separate from proof retention. (`web/src/app/(main)/function/traffic/page.tsx:253-260,294-297`; `docs/漏洞流量证据.md:66`)
- Task allow/deny constraints and asset interception rules are separate policy objects, not merely words in a chat transcript. (`db/schema.sql:283-295,1260-1279`)
- Safety limit: the guard permits unmatched calls when its fallback judge is off/unwired; the judge's default failure action is allow. Borrow the review UI, not this policy default. (`guard/guard.go:83-99`; `intercept/intercept.go:313-318`)
- Touchstone must retain deterministic replay as the proof gate. ARTEX's editable disposition and model-based tool judge are not substitutes for that gate. (`guard/guard.go:91-108`; `app/server/findings.mjs:110-119,195-214`)

## 5. Component inventory

- `Transcript`: groups tool calls/results, answers, and messages; folds heavy bodies. Reuse the interaction, not its code. (`web/src/components/transcript.tsx:87-109,351-354,636-641,733`)
- `SessionItem`: compact selectable session row with execution-state icons and per-session approval checks. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:168-177,371-377,1177-1189`)
- `StatusBadge` plus `statusMeta`: a shared domain-specific state vocabulary; the same word/color can be reused across tables and headers. (`web/src/components/status-badge.tsx:10-33`; `web/src/lib/status.ts:1-16,112-127`)
- `FindingsTable`: one table body for flat and task-grouped views; supports selection, inline expansion, edit, retest, deeper investigation, and delete callbacks. (`web/src/app/(main)/function/findings/_components/findings-table.tsx:91-115`)
- `FindingTrafficPanel`: ordered evidence index and editing affordances; keeps bytes out of the summary. (`web/src/components/finding-traffic-panel.tsx:97-112,135-203`)
- `TrafficEvidenceViewer`: lazy packet dialog with tabs, byte counts, incremental loading, and download. (`web/src/components/traffic-evidence-viewer.tsx:30-62,72-114`)
- `FindingRetestPanel`: finding-level history of independent verification sessions. (`web/src/components/finding-retest-panel.tsx:21-31,86-101`)
- `ApprovalRecords` / `ApprovalDetail`: independent pending queue, paged history, and audit disclosure. (`web/src/components/approval-records.tsx:283-317,650-685,859-865`)
- `SearchDialog`: keyboard destination switcher backed by the sidebar item registry. It is not universal object search. (`web/src/app/(main)/_components/sidebar/search-dialog.tsx:39-64,85-94`)
- `TaskLLMProfileChain`: task-specific model-chain editor inside a popover, with exhausted-chain warning and reset action. This is configuration UI, not the core investigation view. (`web/src/app/(main)/function/tasks/detail/page.tsx:164-197`)
- `SideQuestionWorkspace`: wraps the active transcript; a side-question button sits in its header. Backing requests have independent status and history. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1733-1758`; `db/schema.sql:1189-1224`)
- `TablePagination`: reused at the task list boundary. Its role is compact page control, not a guarantee of backend pagination. (`web/src/app/(main)/function/tasks/page.tsx:999-1007,399-401`)

## 6. Design tokens and visual language

- Default palette is neutral: white background/cards, near-black primary, pale muted surfaces, gray borders. The main accent is not a bright brand color. (`web/src/app/globals.css:57-93`)
- Semantic colors carry activity and risk: blue running, emerald complete, amber waiting, red failure, violet budget exhaustion, solid rose critical severity. (`web/src/lib/status.ts:6-15,34-64`)
- This is not strict one-accent design. It uses multiple semantic tones, but centralizes their mapping instead of inventing a new palette per screen. (`web/src/lib/status.ts:1-27`)
- Base radius is 0.625rem; smaller/larger radii derive from it. Cards and popovers have explicit surface tokens. (`web/src/app/globals.css:12-25,57-62`)
- Geist and Geist Mono are the default font tokens. Task titles use small semibold type; IDs and packet content use monospace. (`web/src/app/globals.css:89-91`; `web/src/app/(main)/function/tasks/detail/page.tsx:361-365`; `web/src/components/finding-traffic-panel.tsx:151`)
- Transcript detail can fall to 11px and connection badges to 10px. That preserves density but is a readability risk on an operator's long session. (`web/src/components/transcript.tsx:474`; `web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1607`)
- Dark mode changes background, cards, input borders, text, and sidebar tokens. It is a real token set, not an inverted screenshot. (`web/src/app/globals.css:96-127`)
- Additional brutalist, soft-pop, and tangerine presets are imported. They are options, not evidence of the default appearance. (`web/src/app/globals.css:5-8`)
- The inspected screenshots show conventional light admin UI: large left navigation, rounded white workspace, inset bordered panels, small icons, and severity pills. (`README.md:17-23`, images `screenshots/sessions.png`, `screenshots/findings.png`)
- Current source repeats separate rounded bordered containers for session list and transcript. This conflicts with Touchstone's desired continuous workspace. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1577,1738`)

## 7. What NOT to take

- Do not reproduce the sidebar's 21 equal-weight destinations. Configuration and evidence browsing compete with the primary task workflow. This is a hierarchy critique, not a claim of measured usability failure. (`web/src/navigation/sidebar/sidebar-items.ts:69-95`)
- Do not reproduce ten task tabs in one horizontal strip with a hidden scrollbar. Important actions become off-screen on narrow displays. (`web/src/app/(main)/function/tasks/detail/page.tsx:53-64,402-414`)
- Do not copy card-inside-card styling into Touchstone. Separate rounded session panes and stacked finding cards add borders without adding task meaning. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1577,1738`; `web/src/app/(main)/function/findings/detail/page.tsx:167-219`)
- Do not put retest history ahead of the original proof by default. ARTEX's order can make the operator scroll before seeing why the finding exists. (`web/src/app/(main)/function/findings/detail/page.tsx:175-190`)
- Do not lead with nine finding dispositions without clear definitions. `resolved` displays “Processed” while `fixed` displays “Resolved”; the difference is hard to infer. (`web/src/lib/status.ts:66-75`)
- Do not repeat mixed or duplicated English labels: “Discover,” “Block approval,” “Request Request,” and “Response Response.” Use stable domain words in Touchstone. (`web/src/app/(main)/function/tasks/detail/page.tsx:58-62`; `web/src/components/traffic-evidence-viewer.tsx:85-87`)
- Do not hide essential worker intent inside hover-only JSON or rely on 10–11px text to make the screen fit. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1743-1751`; `web/src/components/transcript.tsx:474`)
- Do not imply global search searches work objects. Its placeholder suggests more than the sidebar-derived index implements. (`web/src/app/(main)/_components/sidebar/search-dialog.tsx:39-64,148`)
- Do not equate a model judgment, a confirmed graph node, an operator disposition, and reproducible proof. ARTEX has separate fields; Touchstone must make the separation explicit. (`db/schema.sql:184-192,1094-1099,1116-1117`; `app/server/findings.mjs:195-214`)
- Do not copy its dual finding-ID semantics into a new API. Evidence reads use persisted finding IDs while one report update API still uses graph-node IDs. (`docs/漏洞流量证据.md:28-36`)
- Do not copy every network-security asset type into a contract-focused product. Borrow explicit identity, scope, provenance, and evidence relations; specialize target fields to replayable code. (`db/schema.sql:40-78,648-655`; `app/src/lib/types.ts:179-203`)
- Do not call this “battle-tested” from source alone. Schema and release fixes show handled cases, not independently verified production reliability. (`CHANGELOG.md:172,220`; `db/schema.sql:1112-1174`)

## 8. Best 5 patterns for Touchstone

1. **Separate the work container, run, target, finding, and evidence.**
   - Reference: tasks own an exploration; findings keep nullable source links; assets and evidence have their own identities. (`db/schema.sql:505-535,648-657,1081-1084,1146-1172`)
   - Replace: the merged run/finding identity in `ActivityList`, where the run ID looks up the finding and supplies the row identity. (`app/src/components/ActivityList.tsx:116-148`; `app/server/runs.mjs:115-131`)
   - Proposed place: add an engagement-level work container around runs and target scope; keep findings as a distinct review ledger within it. This is a recommendation, not an existing ARTEX entity. (`db/schema.sql:505-535`; `app/src/lib/types.ts:187-203,226-239`)
   - Operator benefit: reruns and new conversations remain part of one investigation, while a finding keeps its proof and source history. (`db/schema.sql:341-350,1081-1084`)
   - **The one lesson to adopt:** an investigation is not a chat session, and a finding is not a completed run. Evidence and reports need their own lifecycle. (`db/schema.sql:341-350,1081-1129,1143-1172`)

2. **Make proof an ordered evidence index with drill-down bytes.**
   - Reference: role, note, order, packet summary, then lazy Request/Response detail. (`web/src/components/finding-traffic-panel.tsx:30-35,135-203`; `web/src/components/traffic-evidence-viewer.tsx:84-114`)
   - Replace: the single `ReplayProof` body inside the FindingDrawer Report tab with a compact proof summary and inspectable evidence sections. (`app/src/components/FindingDrawer.tsx:86-95`)
   - Proposed mapping: replay result, submitted test source, assertions, transfer deltas, and raw logs become named evidence entries; do not force them into HTTP packets. (`app/src/lib/types.ts:59-76`)
   - Operator benefit: answer “what proves this?” before opening raw output; preserve the exact submitted-contract replay requirement. (`app/server/findings.mjs:100-119`)

3. **Track report freshness against evidence, not run completion.**
   - Reference: evidence/report versions and a visible stale-report warning; exports preserve ordered proof references. (`db/schema.sql:1143-1144`; `report/findings.go:178-197`)
   - Replace: the assumption that a recorded finding's Report tab is always the final deliverable. Extend the existing Report surface rather than adding another top-level destination. (`app/src/components/FindingDrawer.tsx:24-26,86-95`)
   - Proposed behavior: a retest creates a new evidence result; a report states which evidence version it summarizes. A human disposition must not rewrite replay truth. (`db/schema.sql:1112-1125`; `docs/漏洞流量证据.md:30-32`; `app/server/findings.mjs:191-205`)
   - Operator benefit: exported conclusions cannot silently refer to evidence that has since changed. (`web/src/app/(main)/function/findings/detail/page.tsx:204-207`)

4. **Keep long sessions readable while new work arrives.**
   - Reference: sequence-based history/SSE merge, paired tool rows, preserved scroll anchors, and no forced bottom-follow while reading. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:748-772,971-977,1433-1466`; `web/src/components/transcript.tsx:351-354`)
   - Replace: the Conversation rendering boundary in RunView/FindingDrawer, not the proof gate or the underlying replay engine. (`app/src/components/RunView.tsx:87-112`; `app/src/components/FindingDrawer.tsx:61-80`)
   - Proposed behavior: page older events, fold tool input/output together, and keep final answers readable. Only add session lanes when multiple actual workers exist. (`web/src/components/transcript.tsx:106-109,351-354`; `web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1659-1688`)
   - Operator benefit: reviewing an earlier failure does not lose the reading position when a scan emits more output. (`web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1433-1466`)

5. **Separate attention needed, execution state, and connection health.**
   - Reference: global pending-approval badge, independent pending queue, per-task state, and a separate SSE connection indicator. (`web/src/app/(main)/_components/sidebar/nav-main.tsx:164-202`; `web/src/components/approval-records.tsx:679-699`; `web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1604-1621`)
   - Replace: generic spinning “Agent working”/“Proving” rows as the only visible live distinction. Add a small global needs-attention count and explicit task/transport labels. (`app/src/components/ActivityList.tsx:25-47`; `app/src/components/RunView.tsx:12-46`)
   - Proposed behavior: count only real operator decisions or actionable failures. Do not turn automatic proof recording into a manual acceptance gate. (`app/server/findings.mjs:191-203`; `app/src/lib/types.ts:219-238`)
   - Operator benefit: the user can tell “working,” “waiting for me,” and “connection lost” apart without opening every run. (`web/src/lib/status.ts:49-57`; `web/src/components/approval-records.tsx:103-108`; `web/src/app/(main)/function/tasks/detail/_tabs/sessions-tab.tsx:1610-1620`)
