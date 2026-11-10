# UI direction (owner notes, for the next design pass)

Status: direction only. This is not built yet. It was written down on
2026-11-10 so a later design pass can make the whole app consistent with it.
The current 2b work (scope-first sidebar and module strip) was designed
independently and has not seen these notes yet.

## Left sidebar

- **Scopes.** This is where the operator configures assets. A scope is a
  pointer to something:
  - a demo scope (the labs that ship in this repo),
  - a local folder on this machine,
  - a simple markdown brief with links.
- **Runs.** This is the list of agent chats. Each run chooses:
  - a scope (one of the configured scopes),
  - a model and an effort level. Today the only model is the abliterated
    DeepSeek v4.1 flash. The same model can come from different gateways:
    NEAR, Boundless, Lyber, OpenRouter, and others. So the picker is
    "model + gateway + effort".
  - the modules for this run. The operator can turn modules on and off.
    When a scope has no local source code, the modules that need source code
    turn off automatically, and the UI says why.
  - an environment:
    - **local** runs on this machine,
    - **sandbox** runs on a Daytona sandbox that is set up in Settings.
- **Settings / configuration** sits at the bottom of the sidebar. Later it
  may also hold skills, automations, and peer reviews.

## Main window: the run is a real AI chat

- A started run fills most of the main window.
- It is a proper chat. It is not over-structured. It does not hide the
  agent's work. The operator sees:
  - the agent's thinking,
  - each turn,
  - each tool call and its result,
  - each subagent it starts.
- Subagents show as small attachments on the input. Clicking one opens it.
- The model may start subagents in fresh sandboxes on the same machine or in
  cloud sandboxes.
- Writing an artifact shows up in the chat as a tool call.

## Right sidebar: artifacts

- Artifacts are the reports the agent writes about its successes and its
  failures. The current right pane is a good start.

## Rules that still hold

- See `restraint.md`. Green only after a replay. Red only for a proven
  finding or a destructive action. Never show "clean" unless every stage
  provably ran.
- No live harm. A proof runs only against local test contracts and accounts
  that hold nothing of value.
