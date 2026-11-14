# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Free-roam operator controls

Fleet starts default to `freeRoam: true`. Solo starts opt out. The start body
accepts only `options: []`; wallet and email capabilities are not offered.
Every worker receives explicit `FREE_ROAM`, an empty `ROAM_OPTIONS`,
`ROAM_CONTROL_EPOCH`, and the server-owned `SESSION_ARTIFACT_DIR`.

The run workspace combines every agent's human requests in one queue.
Done approves only that exact request. Reply and Cancel do not approve it.
An answer succeeds only after the current worker acknowledges it.
Passwords and codes belong in the browser, never in Reply.

Live free-roam agents expose Watch, then explicit Take control, within the human
queue even when no Ask is pending. Watch uses an existing machine only; it does
not create, restart or pause one. Desktop access requires the console's exact
HTTPS origin and a private signed preview.

Take control waits for the current worker's matched pause acknowledgment for
managed shell and browser automation. It is not isolation from shared root
processes: other sandbox processes may observe input. Release removes the viewer,
closes the runtime and revokes the preview before a matched resume. Cancellation,
expiry, worker replacement and setup failures cannot return a late viewer URL.
Unknown pause/resume state stays latched; stop the run. Incomplete revocation
also refuses a new worker. A child turn ending does not imply lost membership;
the current worker gate is authoritative.

Each desktop starts with a client request ID before its POST is sent. The server
binds it to the existing worker epoch and returns that binding privately.
Take control and Release reuse it. Unmount and late-response cleanup name only
that original request, never whichever desktop is current for the agent.
Cancelled IDs stay retired in this process, including cancellation before POST;
old worker responses and expiry callbacks cannot release a newer session.

These controls are development source with isolated fixture coverage, not proof
of a deployed desktop image or real streaming. Exact-image review and screenshot
release remain disabled. No post-run machine retention is implied.

Private routes use authenticated same-origin JSON POSTs, except desktop close:

- `/api/runs/:id/ask`: `{ask,done}` or `{ask,reply}`.
- `/api/runs/:id/desktop` POST: `{agent,viewOnly,desktop}`; DELETE: `{agent,desktop}`.
- `desktop`: `{id,epoch?}`. Create one ID for Watch; reuse the returned worker
  epoch for control and release. Missing or malformed identities are refused.
- `/api/runs/:id/session-artifacts`: `{candidate}`.
- `/api/runs/:id/session-artifacts/:artifact/read`: `{candidate}`.
- `/api/runs/:id/session-artifacts/:artifact/release`: disabled in this release.

Session files are bound to the run, agent, candidate sequence, and artifact ID.
Downloads are bounded attachments with `no-store` and `nosniff`.
Transcript manifests and downloads use `text/plain; charset=utf-8`; the read
response MIME must match its manifest exactly.
Screenshots stay withheld in this release. There is no pending-image read exception.
Exact-image review and release require separate proof before they can be enabled.
Session evidence remains unproven. Secret masking is not complete.
Preview URLs, preview tokens, control acknowledgements, and raw ask replies
are never sent through the run event stream or stored in run records.

Desktop and session adapters require the reviewed Wave 4 engine and Daytona
exports. An unavailable adapter refuses the operation; it is not a live-ready
fallback. Focused fake-based coverage is in `tests/roam-control.test.mjs` and
`tests/roam-ui.test.tsx`.
