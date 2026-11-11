---
name: review
description: Read an operator scope in any language and report ranked leads. Never proves a finding.
tier: P
proof: none
tools: [list_sources, read_source, search_source, fetch_source]
labs: []
---

# Code review

The pack for operator scopes whose code has no replay oracle that fits it. A
scope runs here when it has no Solidity: Rust, Go, TypeScript, Python, and so on.

## Proof surface: none

No finding from this pack is ever `proven`. Two things make this structural, not
a rule the model could break:

- The pack has no `submit_finding` tool. The agent cannot submit a finding.
- `prove()` returns `[]`. The engine and the app record nothing from this pack.

The run ends with a ranked lead list in its final text. A lead says what would
prove it. Proving it needs an oracle that fits the code. None ships today.

Why the other packs do not fit operator code:

- Contracts proves Solidity with an offline Foundry test. It does not compile
  other languages, so it can never prove them.
- Web replays its oracles against its own lab image, `touchstone/web-lab:dev`.
  On operator code it would prove a bug in the lab, not in that code.
- Supply chain, Domains, Surface, People and brand, and Infra and cloud replay
  against a pinned lab snapshot. Operator code is not that snapshot.

## Tools

- `list_sources`: allowlisted files under `src/` (local folders) and `vendor/`
  (fetched repos). Symlinks, hidden, secret, dependency, build, and binary files
  are never listed.
- `read_source`: one file, 512 KB cap. The real path (symlinks resolved) must
  stay inside the workspace and pass the same allowlist.
- `search_source`: a literal string across readable files, 100 hits.
- `fetch_source`: on only when the scope has repos. Fetches only a URL the scope
  lists, on the host, into `vendor/<repo>/`. The clone loses `.git`, symlinks,
  hidden files, and secret-named files before any tool sees it.
