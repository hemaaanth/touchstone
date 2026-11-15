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

## Sessions

A site behind a login needs a session. In **Scopes → Add scope**, paste the
request headers your own browser sends, one `Name: value` per line (a `Cookie`,
an `Authorization`, an API key). The live request harness adds them to
same-origin calls only, so a redirect or a cross-origin call does not carry your
cookie. A script can still send its own header to override one.

Values are stored as plain text in the scope file, like the AI/MCP bearer token.
They are scrubbed from the workspace when a run ends and restored for a
follow-up. Expiry is yours to watch: nothing refreshes a session.

A live **capture** (`capture_traffic`) adds mitmproxy but not a second route.
mitm joins the same client network and forward-proxies to the gate
(`--mode upstream`), so the client's only peer is still the gate side: granted
hosts are decided by the same allow-list, and a raw address is still refused in
strict mode. mitm records the HAR; the gate still decides.

A streamed session can hand the browser to the operator (`viewOnly: false`).
While a human has control, capture tools stand down and NEW MODEL CALLS are held
before they reach the provider, so a turn cannot start under the operator's hands.
A call already in flight is cut at the provider. Focus on the frame renews a
five-minute idle window; when it lapses, or on stop, control returns and the cut
turn continues. The card's **Resume agent** button releases the hold without
handing the browser back. The switch is a control line on the
worker's stdin, not a second HTTP path into the session.

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
