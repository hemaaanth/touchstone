#!/usr/bin/env bash
# Build the OpenZeppelin Monitor image that lib/oz-monitor.mjs runs through
# runTool(). The base is pinned by digest. Pull it once with network:
#   docker pull openzeppelin/openzeppelin-monitor:v1.7.0@sha256:0d5ac20151328d691cfcb90eeec77d9ce4d9f2f962ddbbb90988c8e0e7c2d616
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../packs/chain-watch/oz-monitor"
docker build --pull=false -t touchstone/oz-monitor:1.7.0 .
docker run --rm --network none touchstone/oz-monitor:1.7.0 /app/openzeppelin-monitor --version
