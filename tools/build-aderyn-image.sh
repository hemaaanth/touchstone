#!/usr/bin/env bash
# Build the pinned Aderyn image that lib/aderyn.mjs runs through runTool().
# Needs network once, to fetch Aderyn and solc. Scans then run with no network.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/aderyn"
docker build -t touchstone/aderyn:0.6.8 .
docker run --rm touchstone/aderyn:0.6.8 aderyn --version
