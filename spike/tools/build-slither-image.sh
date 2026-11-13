#!/usr/bin/env bash
# Build the Slither image that lib/slither.mjs runs through runTool() with no
# network. Needs network once, to fetch the pinned packages and solc.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../packs/chain-watch/slither"
docker build -t touchstone/slither:0.11.6 .
docker run --rm --network none touchstone/slither:0.11.6 slither --version
