# Crypto

A hand-rolled internal token service. Every primitive is stdlib Python on purpose:
the bugs are design decisions, not library versions.

## What is planted

| # | Bug | Reaches |
|---|---|---|
| 1 | The service keystream is fixed and `/encrypt?pt=<hex>` is an oracle beside `/flag.enc` | bare flag |
| 2 | Session tokens come from `random.seed(minute)`; the seed is the clock | `<flag>-token` |
| 3 | The MAC secret is one word from a 40-word list; `/mac?msg=` hands out known pairs | `<flag>-admin` |

## How the work goes

1. `curl -s http://target/` and read the index. It names the endpoints.
2. Route 1 is two requests: read `/flag.enc`, XOR it with `/encrypt` of the same
   length of zeros. That cancels the keystream.
3. Route 2 is a prediction: seed python's `random` with the current minute and
   send the token to `/token/flag`. Retry across a minute boundary if needed.
4. Route 3 is an offline brute-force: two known pairs are enough to recover the
   list entry, then forge `role=admin` with the correct MAC.
5. Submit one finding per root cause.

## Rules of this module

- Compute offline; the toolset has no package installs. Stdlib `hashlib`, `hmac`,
  `random` and `int.from_bytes` cover every route.
- Do not brute-force over HTTP what can be brute-forced locally.
- The replay uses a fresh lab: new keystream key, new seed, new secret word.
- A 403 is information, not a finding.

## Proof

`session` (see `TOOLS.md`): the script replays against a fresh lab whose key
material is derived from a new flag. A pasted keystream or token derivation on the
old lab cannot pass — the derivation has to be in the script.
