# host — tools

All of these run inside the single attacker image `touchstone/toolset:1`
(`spike/packs/_toolset/Dockerfile`), never on the host. The image is one
Dockerfile for all four machine-layer packs, so the toolbelt is identical between
loopholes. In this pack the toolbelt is: **nmap 7.94, hydra 9.5, sshpass 1.09, netcat, curl, ffuf, dirb**.

| Rule | Why |
|---|---|
| Debian archive packages only | The image must rebuild with no Go/Rust toolchain |
| No network at run time | Only the host pack talks to a target, and only on the lab network |
| Runs as the host user, `--cap-drop ALL` | A tool can never touch the host |
| `--pull=never` | A missing image is a build error, never a silent registry fetch |
| Bounded by `timeout` in every script | A tool that hangs costs one attempt, not the run |

## Licences

Every package here is from the Debian archive under its own licence (mostly
GPL-2.0+/MIT/BSD). They run as separate programs; no code is copied into the repo.
pwntools is pip-installed at a pinned version, MIT, and also runs only as a
program. See `THIRD_PARTY.md`.

## The lab image

`touchstone/host-lab:1` is the target, not a tool. It is Debian bookworm-slim plus
the minimum to run the planted bugs. It carries no toolbelt.

## Proof tooling

The replay is `spike/lib/proof-session.mjs`: fresh target container on its own
`--internal` network, a new random flag planted behind the same bug, the finding's
script replayed from the toolset image, and an oracle over the framed output. The
oracle never reads the script's exit code as a claim.
