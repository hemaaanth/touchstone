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
one model selected. NEAR AI Cloud is the recommended preset. With no configured
provider there is no runnable default. A configured saved default wins; otherwise
NEAR is preferred when configured, then another configured provider is selected.
An explicit server `PROVIDER` override is preserved and blocks starts if unusable.
Only DeepSeek models are enabled. Other stored model families are left on disk,
but are not offered or used. Model discovery and manual saves enforce the same
rule. A key alone is not enough when the provider has no known DeepSeek model.

The console shows a setup action and disables Start until the selected provider
has a key and model. The server checks again before creating a run, workspace,
or scanners. This is a local configuration check, not a claim that the key is
valid or the provider has credit. Use Fetch models to check the provider's catalog.

NEAR AI Cloud has its own Private inference section. Its Private TEE service is
a provider feature; Touchstone does not verify attestation. The label does not
cover scanner traffic, other providers, or remote sandboxes.

Website scans and local EVM labs do not require a production RPC key. Configurable
live-network RPC endpoints are not supported by the current chain modules.
Do not collect an unused RPC key during onboarding. A live-chain design must bind
each endpoint to a network, scope, read/fork policy, and credential boundary first.

Each browser submission has a unique request ID. Acceptance stores that ID and a
fingerprint in the recovery state, run stream, and final record. Repeating the same
ID and inputs returns the original run; different inputs with that ID are refused.
If the POST response is lost or truncated, the client makes one read-only request
to confirm that exact ID. It never automatically submits another run. When the
confirmation also fails, acceptance is explicitly unknown: reload the run list
before starting another run. This does not diagnose or repair an underlying tunnel
or browser connection failure.

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
