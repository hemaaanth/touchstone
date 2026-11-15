# Run Touchstone locally

The [sponsored demo](https://touchstone.hem.so) needs no setup. This guide runs the
full operator console on your own machine, using your own inference account.

## Prerequisites

- Linux x86-64, Git, Node 24 or newer, and Bun 1.4.4.
- A running Docker daemon that your application user can access.
- A NEAR AI Cloud API key and inference credits, or another configured provider.

The pinned Foundry image runs as UID 1000. These local instructions assume the
application user also has UID 1000 so private workspaces remain writable inside
the container. Other UID arrangements need a matching workspace/cache setup;
they are not established by this guide. The hosted demo was verified with that
UID on Ubuntu 24.04, Node 26.12.0, and Bun 1.4.4.

```sh
node --version
bun --version
id -u
docker info
```

Resolve prerequisite failures before continuing. Tool setup does not change
Docker socket permissions or the host's firewall policy.

## Install locked dependencies

```sh
git clone https://github.com/hemaaanth/touchstone.git
cd touchstone
```

```sh
(cd spike && bun install --frozen-lockfile --ignore-scripts)
(cd app && bun install --frozen-lockfile --ignore-scripts)
```

Do not run with a developer's copied dotenv file. The normal first-run setup is
through the app's Settings page.

## Prepare the Contracts tools

This pulls pinned images and builds the Contracts tools. The first setup needs
network access and can take time. Other modules have their own image groups in
the [manifest](../spike/lib/images.mjs).

```sh
node spike/scripts/setup.mjs --only base,contracts
```

Expected result: a setup summary with no failed required images. To inspect the
full catalog without changing Docker, use `--list` or `--dry-run`.

The machine-layer modules need one extra group. `base` holds
`touchstone/toolset`, the attacker container every command of theirs runs from,
and each module adds one small lab image:

```sh
node spike/scripts/setup.mjs --only base,host,crypto,forensics,binary
```

Prepare the compiler cache once. This uses the same pinned image as the replay
engine; it does not install Foundry or Solidity on the host.

```sh
FOUNDRY_IMAGE="$(node --input-type=module -e 'import { MANIFEST } from "./spike/lib/images.mjs"; process.stdout.write(MANIFEST.find(x => x.tag === "ghcr.io/foundry-rs/foundry:latest").ref)')"

docker volume create foundry-svm
docker run --rm --pull=never --user 0 --entrypoint sh \
  -v foundry-svm:/svm "$FOUNDRY_IMAGE" -c 'chown 1000:1000 /svm'

node --input-type=module -e 'import { warmSolc } from "./spike/lib/sandbox.mjs"; console.log(await warmSolc("0.8.38"))'
```

The cache is a shared Docker volume. Do not change its ownership on a machine
where another user manages it. Later proof runs use the prepared compiler with
`--offline` and `--network none`.

## Start the console

```sh
cd app
bun run dev
```

Open **http://localhost:5173**. Keep this operator console private; its console
token is a write guard, not a visitor login.

1. Open **Settings → NEAR AI Cloud**. Add your key and select a model. The key is
   stored server-side in a gitignored private settings file.
2. Keep **Local Docker** selected for this first run.
3. Open **New run**, choose **Vault**, and select **Solo**. Start with a small
   budget you are comfortable spending.
4. Follow the agent's source reads and generated PoC. If the verifier accepts a
   finding, open its proof card and inspect the replay details.

A successful run demonstrates a specific result on the vulnerable lab. An empty
result is not a certificate that a target is safe. Missing tools, setup errors,
and budget stops appear as gaps or interruptions in the run.

Fleet mode uses a coordinator and child agents. Free-roam execution additionally
needs a configured and successfully tested Daytona shell. Leave free-roam off
when exploring the confined fleet without that setup.

## Verify without inference credits

From the repository root:

```sh
node --test app/tests/demo-policy.test.mjs app/tests/demo-backend.test.mjs
node --test spike/test/agent-run-startup.test.mjs spike/test/tool-schemas.test.mjs
bun --no-env-file test app/tests/demo.test.ts app/tests/demo-client.test.ts app/tests/demo-ui.test.tsx
```

These focused checks use private temporary stores and controlled external seams.
They do not call the live model provider. Read each test's setup before extending
the command to tests that exercise Docker or provision external resources.

For a hosted public deployment, follow [Sponsored public demo](public-demo.md).
For a fixed private operator installation, see [Fixed owner-test release](owner-release.md).
