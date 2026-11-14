# Live run network policy

Live request containers use strict host confinement by default. Existing scopes
without a network policy remain strict. Public network access is an explicit
per-scope option, not a global setting or a per-run override.

In **Scopes → Add scope**, add a website and select **Allow public network
access** to opt in. It is off initially. Open a saved live scope to change the
same option under **Network access**. Changes apply to new runs; running gates
keep their original policy. Private labs require strict access.

The API accepts `networkPolicy: "strict"` or `"public"` when creating a scope,
and `POST /api/scopes/:id/network-policy` changes a saved live scope. Both writes
require the console guard. Invalid values are refused.

The scope proxy remains the container's only route out. It checks DNS answers
and connects to the checked address for both HTTP and HTTPS CONNECT. Public
mode refuses private, loopback, link-local, metadata, and reserved destinations.
Private labs keep their explicit opt-in and strict host confinement.

Host-local proxy callers also stay strict. Public mode through openReach requires
container confinement. The setting does not expand permission to test unrelated targets.

`request()` follows up to 10 redirects by default. Every hop goes through the
proxy and is written to the transcript. Cross-origin redirects drop Authorization,
Proxy-Authorization, Cookie, and Host headers. Standard POST-to-GET redirect
rules apply. Pass `{ followRedirects: false }` to inspect a redirect itself, or
`{ maxRedirects: 5 }` to use a lower limit (maximum 20).

This setting concerns live request containers, not the agent engine. Coordinator
and child conversations execute in the app worker. Selecting Daytona routes
eligible tools to remote machines; live request containers still use local
Docker. Free-roam shell machines already have open network access and are
unchanged. The native browser seam runs outside the request containers and keeps
its existing strict guard. Module-specific capture and crawler limits also remain.

When free-roam is enabled, the coordinator is instructed to delegate useful
investigations blocked by a gate to a free-roam child. The child must file an
evidence-backed session candidate rather than relying on its final report alone.
A candidate stays unproven unless a separate pack proof succeeds.
