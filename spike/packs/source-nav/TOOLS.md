# Source navigation: tool selection and licensing

This pack gives a hunter read-only symbol navigation over the run's workspace:
resolve a symbol, read its source, pull snippets, walk callers and callees. It
wraps one code-intelligence engine (`codebase-memory-mcp`) through one Pi
extension's query logic (`pi-cbm`), re-expressed for this spike.

**Offline by construction.** At run time nothing here touches the network, an
account, or an API key. The engine indexes the workspace into its own local
cache (`~/.cache/codebase-memory-mcp`) and answers every query from it. The
only network step is the one-time binary fetch (`tools/fetch-cbm-bin.sh`),
which is build-time and documented as such.

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
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) v0.12.1 | [MIT](./LICENSE.codebase-memory-mcp) (binary's own `LICENSE` + `THIRD_PARTY_NOTICES.md` installed beside it) | Pinned release binary RUN out of band via `spike/lib/cbm.mjs` (`cli --json <tool>`). NOT committed; installed by `tools/fetch-cbm-bin.sh` (archive sha256 `8c3d0341…c4463`). Statically linked, pure engine | Yes. Indexes to `~/.cache/codebase-memory-mcp`; no account, no network, no key at run time | A workspace path to index; then graph queries (`search_graph`, `get_code_snippet`, `trace_path`, …) | Symbol graph: nodes, locations, snippets, caller/callee edges | Where a symbol lives and what calls it — a navigation lead, never a vulnerability | none (navigation is not a finding; `prove` returns `[]`) | ripgrep/ctags do flat text/tag search; this resolves symbols and call edges across files | Cross-file symbol resolution and caller/callee tracing a grep pass cannot give | wrap (engine); run-only, offline |
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
project deletion, refresh/watch controls, and the UI server. A hunter gets read
and navigation only.

## Proof

Navigation produces no findings: `prove: async () => []`. Finding a symbol is a
lead, never a vulnerability — the same stance as the `surface` pack. A later
finding-producing pack can consume these leads; this pack never submits one.

## Smoke

`spike/test/cbm-smoke.mjs` indexes a tiny repo and runs all five tools end to
end — including the fail-closed ambiguity case and its disambiguation — under a
network namespace with no interfaces, proving the offline constraint:

```
PI_CBM_BIN=~/.local/share/touchstone/codebase-memory-mcp/0.12.1/codebase-memory-mcp \
  PI_CBM_SKIP_VERSION_CHECK=1 \
  unshare -rn node spike/test/cbm-smoke.mjs
```
