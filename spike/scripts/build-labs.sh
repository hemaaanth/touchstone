#!/usr/bin/env bash
# Build the Docker images the Web and AI/MCP packs need. These two packs have no
# source to read, so without their lab image they cannot run at all.
#
#   spike/scripts/build-labs.sh            # build web-lab, ai-mcp-lab, mcp-inspector, mcp-shield
#   spike/scripts/build-labs.sh web        # build one: web | ffuf | arjun | schemathesis | jwt_tool | ai-mcp | inspector | shield | garak
#   spike/scripts/build-labs.sh ffuf       # the Web pack's content-discovery image (not in the default list)
#   spike/scripts/build-labs.sh arjun      # the Web pack's hidden-parameter image (not in the default list)
#   spike/scripts/build-labs.sh schemathesis  # the Web pack's API schema-fuzz image (not in the default list)
#   spike/scripts/build-labs.sh jwt_tool   # the Web pack's JWT crack/analysis image (not in the default list)
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
build_ffuf()      { docker build -f packs/web/Dockerfile.ffuf -t touchstone/web-ffuf:2.3.0 packs/web; }
build_arjun()     { docker build -f packs/web/Dockerfile.arjun -t touchstone/web-arjun:2.2.7 packs/web; }
build_schemathesis() { docker build -f packs/web/Dockerfile.schemathesis -t touchstone/web-schemathesis:4.33.4 packs/web; }
build_jwt_tool()  { docker build -f packs/web/Dockerfile.jwt_tool -t touchstone/web-jwt-tool:2.3.0 packs/web; }
build_ai_mcp()    { docker build -t touchstone/ai-mcp-lab:dev packs/ai-mcp/lab/mcp/oracle; }
build_inspector() { docker build -f packs/ai-mcp/Dockerfile.inspector -t touchstone/mcp-inspector:0.17.2 packs/ai-mcp; }
build_shield()    { docker build -f packs/ai-mcp/Dockerfile.shield -t touchstone/mcp-shield:1.0.4 packs/ai-mcp; }
build_garak()     { docker build -f packs/ai-mcp/Dockerfile.garak -t touchstone/garak:0.17.1 packs/ai-mcp; }
build_strix()     { bash tools/build-strix-image.sh; }
build_toolset()   { docker build -f packs/_toolset/Dockerfile -t touchstone/toolset:1 packs/_toolset; }
build_host()      { docker build -t touchstone/host-lab:1 packs/host/lab; }
build_crypto()    { docker build -t touchstone/crypto-lab:1 packs/crypto/lab; }
build_forensics() { docker build -t touchstone/forensics-lab:1 packs/forensics/lab; }
build_binary()    { docker build -t touchstone/binary-lab:1 packs/binary/lab; }

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(web ai-mcp inspector shield)
for t in "${targets[@]}"; do
  case "$t" in
    web) build_web ;;
    ffuf) build_ffuf ;;
    arjun) build_arjun ;;
    schemathesis) build_schemathesis ;;
    jwt_tool|jwt-tool|jwt) build_jwt_tool ;;
    ai-mcp) build_ai_mcp ;;
    inspector) build_inspector ;;
    shield) build_shield ;;
    garak) build_garak ;;
    strix) build_strix ;;
    toolset) build_toolset ;;
    host) build_host ;;
    crypto) build_crypto ;;
    forensics) build_forensics ;;
    binary) build_binary ;;
    *) echo "unknown target: $t (use web, ffuf, arjun, schemathesis, jwt_tool, ai-mcp, inspector, shield, garak, strix, toolset, host, crypto, forensics or binary)" >&2; exit 2 ;;
  esac
done
echo "built: ${targets[*]}"
