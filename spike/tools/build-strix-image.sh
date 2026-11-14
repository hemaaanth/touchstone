#!/usr/bin/env bash
# Build the image lib/strix.mjs runs through runDocker(). It carries the Strix
# CLI, the Docker client it needs for its own sandbox, and the loopback model
# shim. Needs network once, to install the pinned package.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node scripts/setup.mjs --only strix --include-optional --force
docker run --rm --entrypoint strix touchstone/strix:1.7.0 --version
