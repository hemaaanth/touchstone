# Browser capture and takeover: handoff

State of the browser work on `dev` at `23e6650`. Written so a different machine
can pick it up without this thread.

## What exists

| Path | What it is |
|---|---|
| `spike/lib/intercept.mjs` | mitmproxy capture. Starts `mitmdump` as alias `mitm` and forwards it UPSTREAM: to the run's recorder on a lab, to the scope gate on live. HAR to transcript, same shape a request script yields. |
| `spike/lib/browser-client.mjs` | Playwright client: declarative steps, `storageState` in and out, JSON step log, `browserProof` replay on a fresh lab. |
| `spike/lib/browser-stream.mjs` | Voxl stream for the human step: Xvfb, openbox, headed Chromium, one container on the client network, viewer over a loopback pipe. Watch/control switch, idle resume. |
| `spike/lib/pause.mjs` | Model-call gate. A takeover cuts an in-flight call; a resume continues the turn. |
| `spike/packs/web/pack.mjs` | Tools `capture_traffic`, `capture_browser`, `browser_session` (start/state/takeover/view/handoff/stop). Capture tools refuse while a human has control. |
| `spike/packs/web/Dockerfile.browser` | Chromium + Playwright 1.65.1, Chromium only, uid 1000. |
| `spike/packs/web/Dockerfile.stream` | The line above plus Xvfb, openbox and the Voxl 0.3.3 binary in `spike/roam/desktop/voxl`. |
| `app/src/components/run-thread.tsx` | `SessionCard`: assistant-ui `WebPreview`, near-full-screen dialog, takeover and `Resume agent`. |
| `app/server/runs.mjs`, `runs-http.mjs` | `POST /api/runs/:id/session-mode` — one control line on the worker's stdin. |
| `spike/lib/scopes-store.mjs`, `lib/targets.mjs`, `lib/live.mjs` | Scope `session.headers` and `session.storageState`, scrubbed from a kept workspace and restored for a follow-up. |
| `research/packs/intercept.md`, `client.md` | The surveys, licences, seams, limits and what is deliberately not wrapped. |

## Fresh machine

```sh
git checkout dev
bun install                      # in the repo root app/ and spike/ as needed
npm ci                           # in spike/ if bun is not used there
bash spike/scripts/build-labs.sh browser stream   # ~2 GB, network
node spike/scripts/setup.mjs     # pulls mitmproxy and the rest of the manifest
```

`touchstone/web-browser:stream` builds ON TOP of `touchstone/web-browser:1.65.1`,
so build `browser` first. Neither image is in git.

## Verify

```sh
node --test spike/test/pause.test.mjs spike/test/intercept.test.mjs \
  spike/test/browser-capture.test.mjs spike/test/browser-stream.test.mjs \
  spike/test/live-capture.test.mjs spike/test/live-scope.test.mjs
bun test app/tests/session-card.test.tsx app/tests/session-mode-route.test.mjs \
  app/src/components/thread-model.test.ts
```

These need Docker and the two images. They skip with a reason rather than passing
vacuously when an image is missing.

A browser smoke against a real host, without the app:

```sh
node -e '...' # see the "staging" run in the thread, or use captureBrowser directly
```

Capture against `https://touchstone.hem.so` returned 6 recorded calls, a 2.1 MB
HAR and a rendered 1280x800 screenshot. Real DNS, real TLS, real gate.

## Known failing app tests (pre-existing)

`bun test app/tests/` has 5 failures on this machine that were there before this
work and unchanged by it: run-checkpoint records, IP quota, demo producers,
console-token rotate, redact linearity. One more was found and fixed during the
merge — a `store-errors` sentence that `dev`'s own message had moved past.

## Honest limits

- The streamed form is `http://127.0.0.1` + a loopback pipe. A published Docker
  port on an `--internal` network is not reachable from the host here. The Daytona
  signed-preview form is not wired.
- The idle resume is a five-minute timer renewed by iframe focus, not keystroke
  detection.
- Pinning: `ignoreHTTPSErrors` is deliberate for capture; a client with a baked CA
  still fails.
- Session values are plain text in the scope store. Nothing refreshes an expiry.
- HAR has no WebSocket frames; that addon is not written.
- The Voxl binary is a 25 MB committed blob (0.3.3, MIT, links x264 so
  GPL-2.0-or-later; notices in `spike/roam/desktop/THIRD-PARTY-NOTICES` and
  `THIRD_PARTY.md`).
