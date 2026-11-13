#!/usr/bin/env bash
# Build the Docker images the Web and AI/MCP packs need. These two packs have no
# source to read, so without their lab image they cannot run at all.
#
#   spike/scripts/build-labs.sh            # build web-lab, ai-mcp-lab, mcp-inspector, mcp-shield
#   spike/scripts/build-labs.sh web        # build one: web | ai-mcp | inspector | shield | garak
#
# garak (about 3 GB, CPU torch) is not in the default list. Build it only if
# you will run the AI/MCP pack live with an assistant budget.
#
# Needs network access (npm ci). The lab itself later runs with no network.
# Lab dependencies come from each oracle/package-lock.json, so a rebuild is the
# same image. The scanner images (zaproxy, nuclei, dalfox) are pulled by tag on
# first use and are not built here.
set -euo pipefail
cd "$(dirname "$0")/.."

build_web()       { docker build -t touchstone/web-lab:dev packs/web/lab/dapp/oracle; }
build_ai_mcp()    { docker build -t touchstone/ai-mcp-lab:dev packs/ai-mcp/lab/mcp/oracle; }
build_inspector() { docker build -f packs/ai-mcp/Dockerfile.inspector -t touchstone/mcp-inspector:0.17.2 packs/ai-mcp; }
build_shield()    { docker build -f packs/ai-mcp/Dockerfile.shield -t touchstone/mcp-shield:1.0.4 packs/ai-mcp; }
build_garak()     { docker build -f packs/ai-mcp/Dockerfile.garak -t touchstone/garak:0.17.1 packs/ai-mcp; }
build_strix()     { bash tools/build-strix-image.sh; }

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(web ai-mcp inspector shield)
for t in "${targets[@]}"; do
  case "$t" in
    web) build_web ;;
    ai-mcp) build_ai_mcp ;;
    inspector) build_inspector ;;
    shield) build_shield ;;
    garak) build_garak ;;
    strix) build_strix ;;
    *) echo "unknown target: $t (use web, ai-mcp, inspector, shield, garak or strix)" >&2; exit 2 ;;
  esac
done
echo "built: ${targets[*]}"
