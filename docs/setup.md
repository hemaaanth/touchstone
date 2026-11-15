# Local setup: restoring the tool images

Every third-party tool in Touchstone runs in a Docker container. The packs expect
those images to be present on the host. A fresh clone, a new sandbox, or a machine
whose images were pruned has none of them. One command restores the full set.

```bash
node spike/scripts/setup.mjs
```

That is the whole setup step. It is safe to re-run: an image already present is
skipped, so a second run only fills gaps.

## What it does

`spike/scripts/setup.mjs` holds the single manifest of every tool image: the
public ones it **pulls** (pinned by digest where the pack code pins them) and our
own ones it **builds** from their Dockerfiles. For each image it runs
`docker image inspect`; if the image is missing it pulls or builds it. Each image
is independent, so one broken recipe does not stop the rest. The run ends with a
summary of built / pulled / skipped / failed, and exits non-zero if any required
image failed.

Pulls run a few at a time (network-bound). Builds run one at a time (CPU and IO
heavy). The full set is 45 images; a from-scratch run takes a while and needs
network and free disk.

## Build needs network; runs do not

Building an image fetches packages (npm, pip, binaries), so this setup step
reaches the network. That is the sanctioned provisioning moment. The tool **runs**
stay offline: every tool container runs with `--network none` and `--pull=never`.
Restoring images does not weaken that.

## Flags

```
--list              Print the manifest and exit (builds nothing)
--dry-run           Print each action that would run, do nothing
--force             Rebuild / repull even if the image is already present
--only a,b          Only these pack groups (e.g. --only web,contracts)
--include-optional  Include heavy / rarely used images (garak, observatory, strix)
--daytona           Only the images that reach a Daytona sandbox
--pull-only         Skip builds
--build-only        Skip pulls
--jobs N            Concurrent pulls (default 4); builds always run serially
```

Groups: `base`, `contracts`, `keys`, `chain-watch`, `host`, `crypto`, `forensics`,
`binary`, `web`, `ai-mcp`, `surface`, `domains`, `phishing`, `supply-chain`,
`infra-cloud`, `strix`. The `base` group holds `touchstone/toolset`, the attacker
container the four machine-layer modules run every command from; it is also the
package set baked into the machine snapshot (`spike/roam/shell.Dockerfile`).

Optional images are **off by default**: `touchstone/garak` (~3 GB, only for live
AI/MCP runs), `touchstone-observatory` (domains smoke test only), and
`touchstone/strix` (its own sandbox). Add `--include-optional` when you need them.

## This is the source of truth

The older per-image shell scripts still work and build the same tags:
`spike/scripts/build-labs.sh`, `spike/tools/build-*.sh`,
`tools/build-aderyn-image.sh`. But `setup.mjs` is the canonical list — the same
manifest concept the Daytona bake plan reuses (see
`daytona-baked-snapshot-plan.md`). When a tool version changes, update the
manifest in `setup.mjs`.
