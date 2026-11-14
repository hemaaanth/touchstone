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

This first release does not enable built-in browser streaming, takeover, or
exact-image review. Their routes refuse requests. There are no active desktop
or screenshot-release controls. Passwords and codes must never go in Reply.
The frozen desktop checkpoint remains separate from first-release readiness.

Private routes use authenticated same-origin JSON POSTs, except desktop close:

- `/api/runs/:id/ask`: `{ask,done}` or `{ask,reply}`.
- `/api/runs/:id/desktop` (POST/DELETE): disabled in this release.
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
