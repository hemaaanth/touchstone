---
name: source-nav
description: Navigate a workspace's symbols read-only — resolve, read, and walk callers/callees offline.
tier: P
proof: evidence
tools: [resolve_symbol, read_symbol, get_code_snippets, read_symbols, search_and_read_symbols]
scope: local-source
---

# Source navigation

Read-only symbol navigation over the run's workspace, behind the `local-source`
scope. Five tools: `resolve_symbol` (name → candidate locations, no source),
`read_symbol` (one symbol's source + optional callers/callees), `get_code_snippets`
(batch of known qualified_names), `read_symbols` (batch by name), and
`search_and_read_symbols` (query/regex → read the top matches).

`read_symbol` FAILS CLOSED: if more than one symbol matches, it returns the
candidates and no source. Narrow with `file_path`, `parent_class`, `label`, or
`qualified_name`. Every result is a navigation lead, never a vulnerability.
This pack has no `submit_finding` tool and its `prove` hook returns no findings.

## Engine

The tools are backed by the `codebase-memory-mcp` engine (MIT, DeusData),
driven through the query logic of `pi-cbm` (MIT, alexykn), re-expressed for this
spike in `spike/lib/cbm.mjs`. See `TOOLS.md` for the full licensing table and
`../../vendor/pi-cbm/VENDOR.md` for the vendored source.

The engine is RUN, not committed: install the pinned v0.12.1 binary with
`tools/fetch-cbm-bin.sh` (the one build-time network step), then point the pack
at it with `PI_CBM_BIN` or let it resolve `~/.local/share/touchstone/…`. If the
binary is missing the pack degrades to `unavailable` instead of failing a run.

## Offline

Nothing here touches the network, an account, or an API key at run time. The
engine indexes the workspace into `~/.cache/codebase-memory-mcp` and answers
every query from that local cache. Indexing is out of band, once per workspace,
memoized — never an agent tool. Only the pinned binary fetch needs the network,
and that is build-time.

## Smoke

```
PI_CBM_BIN=~/.local/share/touchstone/codebase-memory-mcp/0.12.1/codebase-memory-mcp \
  PI_CBM_SKIP_VERSION_CHECK=1 \
  unshare -rn node spike/test/cbm-smoke.mjs
```

Indexes a tiny repo and exercises all five tools, the fail-closed ambiguity
case, and its disambiguation — under a network namespace with no interfaces, so
the offline constraint is proven, not asserted.
