# Source navigation: tool selection and licensing

This pack gives a hunter read-only symbol navigation over the run's workspace:
resolve a symbol, read its source, pull snippets, walk callers and callees. It
wraps one code-intelligence engine (`codebase-memory-mcp`) through one Pi
extension's query logic (`pi-cbm`), re-expressed for this spike.

**Offline by construction.** At run time nothing here touches the network, an
account, or an API key. The engine indexes the workspace into a **private,
per-run cache** (a fresh `mktemp` dir set as `CBM_CACHE_DIR`, never the
operator's shared `~/.cache/codebase-memory-mcp`) and answers every query from
it. The only network step is the one-time binary fetch
(`tools/fetch-cbm-bin.sh`), which is build-time and documented as such.

**No listener, no watcher.** A *fresh* engine cache comes up with its loopback
UI/admin HTTP server enabled on `127.0.0.1:9749` and an auto-reindex watcher
thread — despite the `--help` text claiming `ui_enabled` defaults to false. So
before any index or query the pack runs `config set ui_enabled=false` (plus
`watcher_enabled`/`auto_watch`/`auto_index` off) in its private cache
(`Cbm.hardenCache()`). A query-only hunter opens no port and writes nothing in
the background. The smoke asserts no listener answers on `127.0.0.1:9749`.

**The engine is RUN, not vendored.** The 330 MB binary is not committed. It is
installed out of band to `~/.local/share/touchstone/codebase-memory-mcp/0.12.1/`
and resolved at run time (via `$PI_CBM_BIN`, `$PATH`, `~/.local/bin`, or that
install path). So it earns a licensing row here as a tool we run, not a
`THIRD_PARTY.md` source row. `pi-cbm`, whose query logic we re-expressed from
vendored source, is a `THIRD_PARTY.md` source row (see that file and
`spike/vendor/pi-cbm/VENDOR.md`).

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) v0.12.1 | [MIT](./LICENSE.codebase-memory-mcp) (binary's own `LICENSE` + `THIRD_PARTY_NOTICES.md` installed beside it) | Pinned release binary RUN out of band via `spike/lib/cbm.mjs` (`cli --json <tool>`). NOT committed; installed by `tools/fetch-cbm-bin.sh` (archive sha256 `8c3d0341…c4463`). Statically linked, pure engine | Yes. Indexes to a private per-run `CBM_CACHE_DIR` (hardened: UI server + watcher off); no account, no network, no key at run time | A workspace path to index; then graph queries (`search_graph`, `get_code_snippet`, `trace_path`, …) | Symbol graph: nodes, locations, snippets, caller/callee edges | Where a symbol lives and what calls it — a navigation lead, never a vulnerability | none (navigation is not a finding; `prove` returns `[]`) | ripgrep/ctags do flat text/tag search; this resolves symbols and call edges across files | Cross-file symbol resolution and caller/callee tracing a grep pass cannot give | wrap (engine); run-only, offline |
| [pi-cbm](https://github.com/alexykn/pi-cbm) v2.0.0 (`a8bc6e2`) | [MIT](../../vendor/pi-cbm/LICENSE) | Not loaded as a Pi extension (it targets a different tool API). Its **query path** is re-expressed in `spike/lib/cbm.mjs`: binary resolution, the `{format:"json",…}` stdin contract, MCP-envelope parse, cbm-0.12 `{cols,groups,rows}` normalization, and the five-tool `SymbolService` composition | Yes (same engine) | The five query tools' parameters | Resolved symbols + source + neighbors | The composed symbol lead | none | — | The high-level resolve/read/ambiguity/neighbor logic the raw engine does not expose | The destructive/admin/write tools (index-as-agent-tool, `manage_adr`, deletion, UI server) are deliberately NOT ported | wrap (query path only), derivative work; source vendored under `spike/vendor/pi-cbm/`, row in `THIRD_PARTY.md` |
| `spike/lib/cbm.mjs` (ours) | Ours (derivative of pi-cbm, MIT) | Node built-ins only; spawns the engine binary and normalizes its output | Yes | Query-tool params | `{ok,data,…}` normalized results | The five query tools below | none | — | Adapts pi-cbm to `@earendil-works/pi-durable` + on-demand installs (no committed `node_modules`) | — | own (the glue + the faithful re-expression) |

## The five tools registered (read-only)

Only the QUERY tools are exposed, behind the `local-source` scope:

| Tool | Does | Fails closed |
|---|---|---|
| `resolve_symbol` | Name/qualified_name → candidate locations (no source) | — |
| `read_symbol` | One symbol's source + optional callers/callees | **Yes** — >1 match returns candidates and no source; narrow with `file_path`, `parent_class`, `label`, or `qualified_name` |
| `get_code_snippets` | Source for a batch of known qualified_names (≤50) | per-entry errors |
| `read_symbols` | Resolve + read a batch by name (≤30) | per-entry `ambiguous`/`not_found` |
| `search_and_read_symbols` | Search (query/regex) + read top matches | — |

Indexing is done out of band by the pack (once per workspace, memoized), NOT as
an agent tool. If the binary is missing the whole pack degrades cleanly to
`unavailable` (the `spike/lib/aderyn.mjs` pattern) instead of failing the run.

## Deliberately not wrapped

The engine and pi-cbm also expose **destructive / admin / write** surface we do
NOT register: `index_repository` as an agent tool, ADR management (`manage_adr`),
project deletion, and refresh/watch controls. A hunter gets read and navigation
only.

The **UI/admin HTTP server** is a special case: it is not a tool we choose to
register or skip — a fresh engine cache turns it ON by default (see "No listener,
no watcher" above). Omitting it is not enough; the pack must *actively disable*
it in its private cache before the engine ever runs, which `Cbm.hardenCache()`
does and the smoke verifies by confirming nothing answers on `127.0.0.1:9749`.

## Known limits

- **Overloads collapse to one node.** The engine stores a single graph node for
  two same-name, same-scope overloads (e.g. a Solidity `transfer(to,amount)` and
  `transfer(from,to,amount)` on the same contract). `read_symbol` therefore
  resolves such a name as a *single, non-ambiguous* match and shows one body — it
  cannot surface the second overload, and the fail-closed ambiguity gate does not
  trip here because the engine reports only one candidate. This is an upstream
  engine limit, not a wrapper choice. The smoke pins it with a Solidity overload
  fixture; if a future engine splits overloads into distinct nodes that assertion
  trips and forces us to revisit the fail-closed story for overloads.

- **Candidate breadth is fixed, never caller-controlled.** The resolve/read path
  searches with a fixed internal breadth (`RESOLVE_SEARCH_BREADTH`) and judges
  ambiguity on the *full* filtered set. There is deliberately no caller `limit`
  on that path (the schemas are closed, so a smuggled `limit` is rejected), so a
  caller cannot shrink the candidate set to slip a multi-match past the gate. The
  smoke proves a smuggled `limit:1` still reports `ambiguous` with no source.

- **Bounded engine concurrency.** Every engine exec passes through one global
  slot queue capped at `MAX_ENGINE_PROCS` (default 3, override `PI_CBM_MAX_PROCS`).
  The engine is a ~330 MB one-shot process and a batch tool fans out many spawns;
  without the cap a single `read_symbols` cold-starts a dozen processes at once,
  storming the host and the one private cache's lock until some die by the
  per-call timeout. The cap keeps the engine reliable and bounds resource use so
  a crafted batch cannot fork-bomb the host.

## Proof

Navigation produces no findings: `prove: async () => []`. Finding a symbol is a
lead, never a vulnerability — the same stance as the `surface` pack. A later
finding-producing pack can consume these leads; this pack never submits one.

## Smoke

`spike/test/cbm-smoke.mjs` indexes a tiny repo and runs all five tools end to
end under a network namespace with no interfaces, proving the offline
constraint. It also asserts the security-relevant properties: the private cache
reports `ui_enabled=false` and **no listener answers on `127.0.0.1:9749`** after
the engine has run; the fail-closed ambiguity case and its disambiguation; that
a smuggled `limit:1` **cannot** collapse an ambiguous match (bypass closed); and
the overload-collapse limit above.

```
PI_CBM_BIN=~/.local/share/touchstone/codebase-memory-mcp/0.12.1/codebase-memory-mcp \
  PI_CBM_SKIP_VERSION_CHECK=1 \
  unshare -rn node spike/test/cbm-smoke.mjs
```
