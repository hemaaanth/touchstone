# Vendored: pi-cbm

Upstream source of record for the Touchstone source-navigation toolkit.

- Project: `pi-cbm` — a Pi extension that wraps the `codebase-memory-mcp`
  code-intelligence engine and exposes symbol-navigation tools.
- Repo: https://github.com/alexykn/pi-cbm
- Version: `v2.0.0`
- Commit: `a8bc6e2f286f0b99bb2044f67c0d6c20faa88c1a` (tag `v2.0.0`)
- License: MIT (see `LICENSE`).

## What we vendored

`src/`, `LICENSE`, `README.md`, `package.json`, `tsconfig.json`. The upstream
`test/` fixtures, lockfile and CI config are not vendored — they are not needed
to reconstruct the wire contract.

## Why it is here, not imported

pi-cbm is written for Pi's `pi-coding-agent` / `pi-ai` tool API. Touchstone's
spike runs on `@earendil-works/pi-durable`, a different tool API, and installs
packages on demand (no committed `node_modules`). So pi-cbm cannot be loaded
verbatim as an extension here.

Instead, `spike/lib/cbm.mjs` is a spike-native re-expression of pi-cbm's **query
path only**: the binary resolution, the `cli --json <tool>` + `{format:"json",…}`
stdin contract, the MCP envelope parse, the cbm-0.12 `{cols,groups,rows}`
normalization, and the `SymbolService` composition for the five read-only query
tools. It is a derivative work of the files in this directory; the licensing row
for it is in `THIRD_PARTY.md`. The ports are annotated with the upstream file and
symbol they come from, so this vendored tree stays the reference.

## What we deliberately did NOT port

The destructive / admin / write tools pi-cbm also exposes (`index_repository` as
an agent tool, `manage_adr`, project deletion, refresh/watch controls, the UI
server). The wrapper performs indexing itself, out of band, and registers only
the five read-only query tools. See `spike/lib/cbm.mjs` and the pack.
