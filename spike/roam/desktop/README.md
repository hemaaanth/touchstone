# Remote desktop runtime

Runs only in the free-roam container. No BB runtime imports. Never launch it on the operator's host. `TOUCHSTONE_ROAM_RUNTIME=1` is set by the image. It is an accident guard, not an isolation boundary.

## Control protocol

Run `node /opt/touchstone/roam/desktop/entry.mjs`. Send one JSON object on stdin and end stdin. Read one JSON result from stdout. No token or URL belongs in argv. The client starts a detached daemon under `flock`. It owns `/run/touchstone/desktop.sock` (0600) in a private directory (0700). The daemon survives the exec session. Do not invoke `daemon.mjs` directly: `entry.mjs` holds its lifetime lock.

1. Send `{"action":"configure"}`. Result: `{kind:"configured",port,expires}`. The port listens on `0.0.0.0`. All preview requests are refused until open. `expires` is an epoch millisecond timestamp, 15 minutes after configure.
2. Create a signed Daytona preview grant for **that port**, for no longer than the remaining time. Keep the standard preview token on the host. Derive `previewOrigin` with `new URL(grant.url).origin` on the trusted host.
3. Send `{action:"open",previewOrigin,appOrigins:[consoleOrigin],token,viewOnly:true}`. `token` is 32 random bytes encoded as base64url (43 characters). Origins must be exact HTTPS origins without a trailing slash, path, credentials or fragment. Result: `{kind:"open",port,expires,viewOnly}`. The preview origin is fixed for this session. It is never read from a client header. Open cannot extend expiry.
4. Return `grant.url + '/#' + token + '&parentOrigin=' + encodeURIComponent(consoleOrigin)` to the viewer. The fragment is removed by the viewer script. Do not log this URL. The copied viewer uses `bb-desktop-v1` postMessage controls and `/bb-desktop-start.js`; these are protocol names, not BB runtime dependencies.
5. Send `{"action":"close"}` on close, failure, run end or mode change. Result: `{kind:"closed"}`. This destroys stream sockets, revokes the viewer lease, stops Voxl and closes the preview port. Revoke the signed Daytona grant separately. To take control, pause agent interaction with this machine **before** opening again with `viewOnly:false`. Resume only after close. The host lane owns pause/resume.

`{"action":"status"}` returns `{kind:"closed"}` or the configured/open metadata above. It never returns a token, preview origin, password or URL. Configure and open refuse a second session. A failed open closes its configured port. Commands are serialized. Errors are fixed text with no request values.

The machine exec API has no stdin argument. Upload a private request file with a random name and mode 0600. Redirect that file into entry stdin. Remove it in a shell trap. Never put its JSON or token in the command string. Do not keep request files in artifacts or events. The root free-roam agent shares this machine; the runtime is not a security boundary against that root agent.

## Process and input lifetime

Voxl listens on loopback only. A small child guardian owns it. Guardian IPC disconnect kills Voxl when the daemon exits or crashes. Both daemon and guardian enforce the original expiry. No stream metadata is persisted or restored after restart. The kernel closes old daemon sockets; a restarted daemon reports closed.

One `ViewerLease` owns at most one pending or active WebSocket. Its transfer ticket supports pop-out without a second active viewer. Lease POSTs and WebSocket upgrades require the exact configured signed preview origin. No localhost or wildcard-origin exception. HTTP proxy credentials, cookies, Origin and Referer are stripped before forwarding. The local Voxl password replaces the outer token.

Watch uses Voxl `--read-only=true` and `--enable-clipboard=false`. In Voxl 0.3.3, the server rejects input and clipboard text commands and every binary input message in read-only mode (`src/server.rs`). Control uses source flag `--enable-clipboard=in`. Both modes disable files, audio, microphone and resize. The wrapper also denies file endpoints and non-GET forwarding. Clipboard suppression alone does not enforce watch; Voxl does.

## Image and licensing

Build context is `spike/roam`, after I2 and I3 merge. It must contain `egress-log.mjs`, `browser-driver.mjs`, `desktop/`, and this Dockerfile. Exclude local `node_modules` and secrets from the context. The image installs Playwright locally at `/opt/touchstone/roam/node_modules`; the adjacent browser driver resolves it normally. Chromium is at `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright`. Run it headed on `DISPLAY=:99`. The display is fixed at 1920x1080x24, with openbox. It is not stopped when a viewer closes; the browser must survive watch and takeover changes.

Pins inspected from local BB source commit `4d6ff33927c093ff1ae170620aae9735c9033a4f`: Node `22-bookworm-slim`, Rust `1.99-bookworm`, Voxl `0.3.3`, esbuild `0.28.2`. The local Cargo source also contains Voxl 0.3.3 and its read-only implementation. Playwright `1.65.1` is the required plan pin; registry freshness was not checked. Base tags are not immutable digests. This source has not been built or pulled.

Copied BB code is MIT (`LICENSE.bb`). Voxl is MIT and links x264, so the separate Voxl executable is GPL-2.0-or-later. See `THIRD-PARTY-NOTICES` for source links and Debian source package names. The image retains Voxl LICENSE/Cargo.lock and Debian copyright files. `/licenses` serves those files, the copied source notices, the Playwright licence and GPL-2 text. A distributor must satisfy corresponding-source obligations before distributing the image.

Not checked: image build, registry tags, real desktop, Daytona exec persistence, signed preview forwarding, WebSocket codec stream, Chromium pixels. Tests use fake children and local HTTP peers only.
