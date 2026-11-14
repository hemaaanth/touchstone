# Sponsored public demo

Demo mode is separate from the normal operator console. It uses the same agent,
fleet, evidence, and proof code. It does not turn an owner console into a shared
public workspace.

## Visitor experience

Visitors choose Vault or YieldVault, start an assessment, watch the agents, and
inspect their evidence and replay results. NEAR AI inference is paid for by the
demo operator. Visitors do not enter an API key.

Each run uses the fixed DeepSeek model, a $1 inference budget, a fleet of at most
three confined children, and a ten-minute work limit. Optional static and fuzz
prepasses are off in these short demos. The agent and the existing proof gate
remain on. No free-roam machines or custom targets are available.

The ten-minute limit stops new work and the agent process. An already-running
bounded proof and cleanup can finish after that limit. Capacity remains reserved
until they finish. There is one active assessment at a time; busy requests are
refused rather than queued.

Signed, host-only session cookies keep each visitor's run list, streams, results,
and controls separate. Keep the session secret and run ownership records across
restarts. Unknown or missing ownership grants no access. Interrupted demos do
not automatically restart and spend more inference credits.

The public API refuses provider settings, custom scopes, grants, arbitrary chat,
human answers, desktop controls, and destructive mutations. The UI hides those
controls too. The server serves built assets; Vite source-serving endpoints are
not part of the public deployment.

## Host requirements

- A Linux x86-64 host with Docker and persistent local storage.
- Node 24 or newer and the pinned Bun installation used for frozen installs.
- The pinned Foundry image and warmed Solidity 0.8.38 cache from
  `spike/lib/images.mjs` and `spike/lib/sandbox.mjs`.
- A non-root service account whose private workspaces are writable by the
  Foundry image's user. Verify this with an actual offline compile before launch.
- HTTPS in front of the loopback backend. Do not expose the operator console.

Start with one active run on 4 CPUs and 16 GB RAM. This is the initial deployment
size, not a benchmark or a promise of assessment duration.

## Build and release

Select a reviewed full commit SHA. Build the frontend from that exact source,
with isolated test state and no developer credentials. Deploy `app/dist` to a
separate, read-only assets directory named after the same SHA.

Use the existing [fixed-release packager](owner-release.md) for the backend and
locked dependencies. Release directories stay immutable. Runtime state and
credentials live outside every checkout and release.

For a private repository, `scripts/export-release-source.mjs` transfers the
packager's selected input without Git history or excluded credential/state files:

```sh
node scripts/export-release-source.mjs \
  --repo /absolute/checkout \
  --revision FULL_COMMIT_SHA \
  --output /absolute/private/source.pack
```

Import it with `git init` and `git index-pack --stdin` in a new private directory.
The input retains the exact selected commit, tree objects, and permitted source
blobs. Parent commits and excluded state blobs are absent. Excluded filenames
can remain in tree metadata. This is a sparse input for the release packager,
not a sanitized public Git clone. It does not support ordinary history traversal
or checking out excluded files.
The filter checks paths, not arbitrary source contents. Review source for
embedded credentials before exporting or publishing it.

Render `scripts/touchstone-demo.service` with the fixed release, assets, runtime,
state, and service-account paths. Its environment file belongs in the private
state directory, mode 0600. Configure these values there:

```dotenv
TOUCHSTONE_DEMO=1
TOUCHSTONE_DEMO_ORIGIN=https://touchstone.hem.so
TOUCHSTONE_DEMO_STATE_DIR=/absolute/private/demo-state
TOUCHSTONE_DEMO_ASSETS_DIR=/absolute/assets/FULL_COMMIT_SHA
HOST=127.0.0.1
PORT=5190
PROVIDER=near
TOUCHSTONE_EXEC=local
FLEET_MAX=3
SPEND_CAP_USD=20
```

Supply `NEARAI_API_KEY` through secure credential entry. Never copy SSH passwords,
developer dotenv files, or owner provider stores into the demo environment.
Keep the packager's HOME, temporary-directory, and cache overrides in the service
environment. They keep writes outside the sealed release.

Set `TOUCHSTONE_DEMO_PROXY_IP` only when the immediate proxy peer is controlled.
It trusts that peer's valid `X-Real-IP` for rate limits. It does not trust arbitrary
forwarded headers from the public internet. In the initial Coolify deployment,
Traefik reaches a bridge-bound `systemd-socket-proxyd`, which forwards to loopback.
The trusted peer is `127.0.0.1`.

Preserve an existing proxy and firewall. Open only its public HTTP/HTTPS ports
and the required private backend connection. If Docker traffic passes through
`DOCKER-USER` and UFW forwarding rules, allow the specific proxy endpoint there.
Do not switch the host's forwarding policy to ACCEPT, disable UFW, expose the
Docker socket, or prune unrelated containers. Update endpoint-specific rules if
the proxy container's IP changes.

## Sponsor budget and maintenance

Run and total caps use the existing spend ledger. They are checked between
calls; in-flight responses can exceed the amount remaining when they start.
The ledger estimates inference spend using configured prices. It is not the
provider's account balance and does not include hosting costs.

Fund the NEAR AI account and set an explicit total cap. A new API key may share
an account balance with other keys. Provider credit limits must be checked in
the provider account, not inferred from the app's dollar display.

Topping up the provider does not reset the lifetime spend ledger or raise the
application cap. If the total cap is exhausted, raise it deliberately, then
restart only after the active assessment and cleanup have ended. Keep existing
results and the session secret. Never delete the ledger to reset spending.

## Acceptance before opening the demo

Run the focused demo server, ownership, client, and UI tests with private stores.
Check two independent sessions: the second must not list, recover, read, stream,
stop, or export the first session's run or findings. Also check a saved session
after restart, lost-response recovery, rate limits, invalid requests, and denial
of settings and Vite/source routes.

On the actual host, complete one bounded NEAR AI assessment through the existing
proof gate. Confirm that the browser shows the real result, that its report is
readable, and that the global slot is released only after cleanup. Synthetic
route tests alone do not establish that the model, compiler, and proof pipeline
work together.
