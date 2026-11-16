# Handoff: machine-layer modules and machines as a default

Status: 2026-11-15. Branch `feat/machine-modules-and-roam`, pushed, three commits on
top of the latest `dev`. Nothing merged to `dev` or `main`.

Read [TASKS.md](TASKS.md) O1–O5 first: they record the owner's decisions and the UI
check that followed them. This file carries what a fresh checkout cannot know.

## What the branch adds

- Modules `host`, `crypto`, `forensics`, `binary`. Three planted bugs each, one
  oracle each, a lab image each, and a `SKILL.md` / `TOOLS.md`. Read one pack's
  `pack.mjs` before touching another: they share a contract.
- Proof kind `session` (`spike/lib/proof-session.mjs`, `spike/lib/session-tool.mjs`).
  It replays the finding's shell script on a fresh target on its own `--internal`
  network, with a NEW random flag planted behind the same bug, and an oracle reads
  that flag out of the replay. A pasted flag cannot pass. Register a new
  machine-layer oracle in `proof-class.mjs` (`HARM_ORACLES`) and give it a title in
  `check-titles.mjs`, or `session-proof.test.mjs` and `check-titles.test.mjs` fail.
- One attacker toolset image, `spike/packs/_toolset/Dockerfile`, also baked into the
  machine snapshot (`spike/roam/shell.Dockerfile`). `daytona-probe.mjs` refuses a
  snapshot without it.
- Machines are the default place a fleet's children run. A machine child keeps the
  pack tools and may submit a finding; the replay still happens on the host, so the
  untrusted tier decides the bulletin lane and never the proof.

## Run it locally

```sh
node spike/scripts/setup.mjs --only base,host,crypto,forensics,binary
(cd spike && bun install --frozen-lockfile --ignore-scripts)
(cd app && bun install --frozen-lockfile --ignore-scripts)
(cd app && bun run dev)          # then open the printed URL
```

The host lab MUST run with the default capability set. `startTarget({ caps: true })`
drops `no-new-privileges`, which would otherwise block the SUID escalation the
module tests. The other three labs need no network and run with `--cap-drop ALL`.

## What is verified

- Twelve lab exploits replay green through `sessionProof`, and a pasted flag fails.
  Reproduce with the throwaway harness described in "Fast checks" below.
- One exploit driven through the real tool path (`run_lab_command` → `MATCH` →
  `submit_finding` → duplicate refused).
- Live host lane driven against a published container: live prompt, port sweep,
  command, replay.
- The snapshot recipe builds and the exact probe command passes on it.
- Screenshot-level check of the New Run execution choice, both ready and not-ready.
- App suite 963 pass / 5 fail; typecheck clean; production build clean.

## What is NOT verified

- **No run on a real NEAR model.** The five failing app tests below are unrelated.
- **No run on a real Daytona machine.** The snapshot has never been built on
  Daytona; only the Dockerfile and the probe command were checked locally.
- Live host findings are not proven (no planted flag exists on a real box). They are
  candidates with a saved script, by design. Do not "fix" that into a pass.

## Local fakes to replace

Both files are gitignored, so a fresh checkout does not have them:

- `spike/data/providers.json` holds a fake NEAR key plus a fake Daytona execution
  block (`roamSnapshot: "daytona-medium"`).
- `spike/data/providers.json.daytona.json` holds a hand-made "verified" selection
  row. Its `binding` is a hash of the config, so changing the key or snapshot
  invalidates it; rebuild it or verify the snapshot properly in Settings.

## Fast checks

```sh
cd spike && node scripts/smoke-session.mjs    # 12 real exploits + a pasted flag; Docker only
cd spike && node --experimental-test-module-mocks --import ./test/helpers/isolated-env.mjs \
  --test test/session-proof.test.mjs test/proof-class.test.mjs test/check-titles.test.mjs \
  test/fleet-loadout.test.mjs test/platform-modules.test.mjs
```

The smoke harness is a floor, not a test suite: it proves the labs, the oracles and
the replay still agree. Run it after touching `proof-session.mjs`, `session-tool.mjs`,
an oracle, or a lab image.

## Known noise in this sandbox

The app suite's five failures are environmental and fail identically on a clean
`origin/dev`: `chmod 0500` under root, the bun-vs-node module mock split, and two
CPU-timed cases. Many `spike/test/*.test.mjs` files also fail in a bulk run for the
same mock reason. To tell mine from a regression, `git checkout origin/dev` and run
the same files; the sets should match.

Running the app server here needs `TOUCHSTONE_VITE_CACHE_DIR` set to an absolute path,
and the agent browser needs `direct` written into
`/root/.bb/trusted-browser/egress` (the Tailscale egress was down) — otherwise it
fails with `ERR_SOCKS_CONNECTION_FAILED`.

## Decisions worth not relitigating

- Snapshot: pre-baked, no split (O4).
- Machine children keep the pack tools; no reserved slot; default loadout follows the
  execution choice.
- `binwalk` is out: the bookworm package crashes against its own `python3-capstone`.
  `spike/packs/_toolset/carve` prints magic offsets instead.
- Only `host` and `binary` are marked `roam: true` besides `web` and `phishing`;
  `crypto` and `forensics` are lab-only (`offline: true`, no live lane).
