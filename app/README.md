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

## First-run setup

Open Settings before starting a run. Add an inference provider key and keep at least
one model selected. NEAR AI Cloud is the recommended preset and the default on a
fresh installation. The first configured provider becomes the saved default;
a saved default is used only while it is configured. Otherwise another configured
provider is selected. A server `PROVIDER` override is preserved and still must
pass setup checks. All model families remain available.

The console shows a setup action and disables Start until the selected provider
has a key and model. The server checks again before creating a run, workspace,
or scanners. This is a local configuration check, not a claim that the key is
valid or the provider has credit. Use Fetch models to check the provider's catalog.

NEAR AI Cloud has its own Private inference section and Recommended badge.
Other providers and their configured models remain available.

Website scans and local EVM labs do not require a production RPC key. Configurable
live-network RPC endpoints are not supported by the current chain modules.
Do not collect an unused RPC key during onboarding. A live-chain design must bind
each endpoint to a network, scope, read/fork policy, and credential boundary first.

Docker creates network interfaces when a live scope starts. On the same host,
Chromium can abort an in-flight browser request with `ERR_NETWORK_CHANGED`, even
when the server sent a valid response. Each submission therefore has a durable
request ID. After a lost response, the client confirms that exact ID with read-only
requests and opens the accepted run. It never automatically repeats the POST.
An explicit retry of an unconfirmed submission reuses its ID, so it cannot create
a duplicate. The ID survives server reloads in the run checkpoint and event stream.

## Run history and scan progress

Run files live under `TOUCHSTONE_RESULTS_DIR`: the `.stream.jsonl` file records
server events, `.events` records engine events, `.sqlite` keeps the agent session,
and `.json` holds the final result and transcript. A `.state.json` checkpoint
exists while recovery is needed. These are private files, not safe raw exports.
They do not form a complete HTTP wire trace. Browser response failures and every
scanner's internal operation are not automatically captured.

Joined scans report each module separately. Early tool counts are marked as
reports so far. A later module's leads cannot turn a failed web scan into success.
Module lead totals replace their earlier partial totals, rather than being
counted twice. Final totals include tools beyond the bounded detail list; the
detail says when rows are omitted. Leads are candidates to investigate, not
proven vulnerabilities.

Domain capture collects a pinned DNS and front-end snapshot: DNS answers, HTTP
responses, TLS checks, scripts, and (for Surface) a scoped crawl. It is not just a
homepage visit. Each tool's scope and recorded coverage still govern what was
actually checked; unavailable tools do not count as a clean scan.

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

These controls are development source with isolated fixture coverage, not proof
of a deployed desktop image or real streaming. Exact-image review and screenshot
release remain disabled. No post-run machine retention is implied.

Private routes use authenticated same-origin JSON POSTs, except desktop close:

- `/api/runs/:id/ask`: `{ask,done}` or `{ask,reply}`.
- `/api/runs/:id/desktop` POST: `{agent,viewOnly}`; DELETE: `{agent}`.
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
