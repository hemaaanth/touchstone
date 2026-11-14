# Fixed owner-test release

This package runs the existing Vite console and backend from one fixed source export.
It is not `vite preview` or a second HTTP server. There is no `app/dist` requirement.
The launcher is `app/server/start.mjs`. It disables HMR, file watching and browser opening.
It binds loopback and refuses to switch ports when the chosen port is busy.
The reviewed launcher must also use a non-writing config loader, not Vite's default `bundle` loader. The installed Vite source writes bundled config into `node_modules/.vite-temp`, or beside the config file on access failure. `cacheDir` alone does not relocate that write. The launcher owner must supply the separately reviewed correction before using this read-only package.

## Permission boundaries

1. A coordinator selects a full reviewed Git commit SHA that includes the launcher and packaging files.
2. Source export is local. It runs Git and runtime version queries only.
3. `--install` explicitly authorizes private dependency installation. It may use the network. It is **off by default**.
4. Installing/enabling/starting a service and opening a tunnel are separate owner decisions. This script does none of them.

Do not run `spike/scripts/setup.mjs` to install application dependencies. It can pull/build Docker images.
This packager never runs setup, image operations, migrations, or a build script.
It does not select or authorize a Daytona snapshot. Shell-only free-roam still needs an available compatible snapshot and fresh owner configuration.

## Prepare a source package

Run the script with Node, not Bun. Use Node 24 or newer; workers use `node:sqlite`.
Pass the real absolute paths of the selected Node and Bun binaries, without symlink components.
The manifest records their paths and exact reported versions. Pin those binary installations separately; an OS upgrade can replace a binary at the same path.

Create private parent directories outside every checkout first. They must belong to the packaging/service account and must not be group/world writable.
Release and state destinations must both be absent. Paths must be canonical absolute paths with only letters, digits, `_`, `.`, `/` and `-`.
The release directory's final component must be the full SHA. Never use `current` or a mutable checkout as the release path.

Example below uses placeholders. Replace them with actual approved paths and the full SHA before execution:

```sh
/absolute/pinned/node /absolute/checkout/scripts/package-owner-release.mjs \
  --repo /absolute/checkout \
  --revision FULL_REVIEWED_40_CHARACTER_SHA \
  --output /absolute/private/releases/FULL_REVIEWED_40_CHARACTER_SHA \
  --state /absolute/private/owner-state \
  --node /absolute/pinned/node \
  --bun /absolute/pinned/bun \
  --port 5190
```

Default output is a **source-only** package, not a runnable dependency installation.
For an approved runnable preparation, use the same command with `--install`, choosing still-absent destinations.
Do not modify or add dependencies to a completed source-only package. Prepare a new sibling parent containing the same SHA instead.

`--install` runs exactly two installs: `spike`, then `app`. Both use Bun with `--frozen-lockfile`, `--ignore-scripts`, `--no-env-file`, and `--backend=copyfile`.
They use a new private HOME and cache, not the shell's credential environment or dependency links.
Application dev dependencies remain installed because Vite is the runtime launcher.
No lockfile or reviewed source may change. The app uses its checked-in `bun.lock`; spike currently uses `package-lock.json`.
Bun's frozen migration compatibility with that npm lock remains a real-install validation gate. If it refuses, stop. Do not remove `--frozen-lockfile` or regenerate pins to force success.
Lifecycle scripts are disabled. A package that needs a postinstall step may need a separately reviewed preparation change; do not silently enable all scripts.

## What is exported

Only regular tracked blobs from the selected commit are read. Dirty files, ignored files and untracked files are never exported.
Included roots are `app`, `spike`, `lab`, `tools`, `scripts`, and `docs`, plus root license/notice/readme files.
The relative app/spike/lab layout is preserved. The engine imports sibling spike code and uses the bundled lab assets.

The filter excludes dotenv files, package-manager credential/config files, `node_modules`, runtime results/logs/tmp/cache/workspace folders, app/spike state/data folders, provider/scope/grant/token stores, spend and pending-cleanup ledgers, key files, databases, event logs and JSONL records.
Excluded Git blobs are not fetched. There is no credential copy or migration.
Source symlinks and submodules are refused. Dependency symlinks are allowed only within the new release; shared hardlinks are refused.
This is a path filter, not a content-based secret scanner. A reviewed source file must not contain embedded credentials under an unrelated filename.

The release contains:

- `release-manifest.json`: selected commit, source file SHA-256 hashes, original Git modes, absolute paths, runtime versions, and dependency-install status.
- `release-manifest.sha256`: SHA-256 of the manifest itself.
- `touchstone-owner.service`: generated unit pinned to this absolute release and state path.

The manifest inventories exported source and the generated service, not every installed dependency byte. Locks govern dependency resolution; this is not a signed provenance claim.
Files and directories are made read-only before the completed manifest is written. This prevents accidental edits, not changes by the file owner or root.
The service also mounts the release read-only. No update watcher or automatic checkout switch exists.
A failed preparation leaves only its new destinations for inspection and writes no completed manifest. It never deletes or retries into those destinations.

## State path audit

Every state directory is new and mode 0700. `env/owner.env` is mode 0600 and initially contains paths only, not credentials.
Provider, scope, grant, token and spend files are initially absent. The app creates its own token and stores after explicit startup/configuration.
Do not copy development settings, tokens, providers, scopes, grants, dotenv files, or run records.

| State | Existing source behavior | Packaged setting |
| --- | --- | --- |
| Run DBs, events, charges, workspaces index, sessions and replay | `app/server/runs.mjs`, `findings.mjs`, `spike/agent-run.mjs`, `lib/replay-bundle.mjs` default into source results | `TOUCHSTONE_RESULTS_DIR` and `AGENT_RESULTS_DIR` → state/results; per-run log/charge paths derive there |
| Spend ledger | `spike/lib/inference.mjs` defaults to spike/spend.json | `SPEND_LEDGER` → state/spend.json |
| Mutable workspaces and normal scratch | `spike/lib/sandbox.mjs`, `fetch.mjs`, `targets.mjs` use `os.tmpdir()` | `TMPDIR`, `TMP`, `TEMP` → state/tmp |
| Strix scratch | `spike/lib/strix.mjs` tries STRIX_TMPDIR, os.tmpdir(), then /tmp | `STRIX_TMPDIR` → state/tmp; systemd `PrivateTmp` isolates hardcoded /tmp fallback |
| Settings and credentials | `spike/lib/providers.mjs` defaults to spike/data/providers.json | `TOUCHSTONE_PROVIDERS_FILE` → state/providers.json |
| Scope and grant stores | `scopes-store.mjs`, `grant-store.mjs` default to spike/data | `TOUCHSTONE_SCOPES_FILE`, `TOUCHSTONE_GRANTS_FILE`, `TOUCHSTONE_GRANT_TOKEN_FILE` → state files |
| Pending Daytona cleanup | `spike/lib/daytona.mjs` defaults to spike/data | `DAYTONA_PENDING` → state/daytona-pending.json |
| Vite generated cache | Packaged launcher requires an absolute override | `TOUCHSTONE_VITE_CACHE_DIR` → state/cache/vite |
| Codebase-memory cache | `spike/lib/cbm.mjs` and source-nav use private override or home cache | `CBM_CACHE_DIR`, `PI_CBM_CACHE_DIR` → state/cache/cbm |
| Other home/XDG caches and configuration | Optional tools can use home defaults | `HOME` → state/home; `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` → private state directories |
| Install cache | Bun/npm may use home defaults | `BUN_INSTALL_CACHE_DIR`, `npm_config_cache` → state/cache subdirectories |
| Server stdout/stderr | Service file descriptors | state/logs/server.log and server-error.log; no stdout token printing by this packager |
| Dotenv fallbacks | runs.mjs automatically checks spike/.env.local; Vite can load app dotenv files | All dotenv files are excluded; install uses `--no-env-file`. Never add dotenv files inside a completed release |

These settings isolate the managed service's normal files. They do not isolate host Docker volumes, external services, operator-selected source paths, or hostile root processes.
The source-nav binary is not downloaded by this package. Its default home lookup changes to the private HOME, so optional tooling may remain unavailable until separately provisioned.
Host tooling, images and compiler caches are not provisioned. Free-roam must not silently fall back to host execution.

## Start and access — separate authorization

After independent source review, validate the selected Node/Bun versions, actual frozen installs, and launcher startup in the isolated environment.
The generated system service uses the packaging account, absolute paths, `Restart=no`, `KillMode=control-group`, a private temp namespace, and a read-only release.
It has no automatic install/enable/start action. An authorized operator must install and start that exact generated unit using the machine's service procedure.
The unit refuses to start without a completed manifest and expected app/spike dependencies.

Port 5190 is only a default. Availability was not checked. Port 5188 is refused by the packager.
Keep loopback binding. Remote owner access requires a separately approved authenticated tunnel. The console token is a write guard, not owner authentication.
The packager never opens or configures a tunnel.

Enter fresh inference and Daytona settings through the isolated UI. Use only reviewed provider/model/host/target/snapshot values.
Do not inherit a developer shell or rewrite the isolation path variables to point at development data.
Log rotation is an operator responsibility. Logs can contain run details and stay private.

## Updates

Upgrade only after an owner request. Select a new reviewed full SHA and prepare new absent destinations beside the current release.
Drain active runs before an explicitly authorized service stop/path change/start. `KillMode=control-group` is not a graceful run drain.
The packager refuses existing state. State reuse or migration requires a separate reviewed operator step; no credentials are migrated automatically.
A developer edit, build, restart or branch switch cannot switch this service's source path.

## Focused tests and limits

```sh
bun x --no-install node --test scripts/tests/package-owner-release.test.mjs
```

Tests use tiny local Git fixtures, fake executable paths and stub install runners. No real install, build, HTTP listener, Docker action, deployment, credential access or external network is exercised.
Source-only packaging is not a claim that the full integrated app runs. The actual private install, Vite cache behavior, systemd hardening, remote access, snapshot compatibility and first owner run remain explicit release gates.
