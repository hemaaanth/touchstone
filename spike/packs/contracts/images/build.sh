#!/usr/bin/env bash
# Build the pinned Contracts tool images. Needs network once; runs never do.
#   build.sh halmos    -> touchstone/halmos:0.3.3
#   build.sh chimera   -> touchstone/chimera:e2.3.3-m1.5.1
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
case "${1:-}" in
  halmos) docker build -f Dockerfile.halmos -t touchstone/halmos:0.3.3 . ;;
  chimera) docker build -f Dockerfile.chimera -t touchstone/chimera:e2.3.3-m1.5.1 . ;;
  *) echo "usage: $0 halmos|chimera" >&2; exit 2 ;;
esac
