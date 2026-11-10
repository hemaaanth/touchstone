#!/usr/bin/env bash
# Fetch the Aderyn static-analysis binary into tools/bin/aderyn.
#
# Aderyn is the second static engine (lib/aderyn.mjs drives it as a black box).
# The binary is a build artifact, not our source, so it is not committed — this
# script pulls a pinned release from Cyfrin's GitHub and drops it where the
# adapter looks for it. Re-run it on a fresh checkout or to change the version.
#
# Override the version with ADERYN_VERSION=v0.6.8 ./tools/install-aderyn.sh
set -euo pipefail

VERSION="${ADERYN_VERSION:-v0.6.8}"
REPO="Cyfrin/aderyn"

# Where the adapter expects the binary (lib/aderyn.mjs: tools/bin/aderyn).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
DEST="$BIN_DIR/aderyn"

# Map host to the release asset triple. Aderyn publishes gnu and apple builds.
os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Linux-x86_64)   TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64)  TRIPLE="aarch64-unknown-linux-gnu" ;;
  Darwin-x86_64)  TRIPLE="x86_64-apple-darwin" ;;
  Darwin-arm64)   TRIPLE="aarch64-apple-darwin" ;;
  *) echo "Unsupported host: $os-$arch" >&2; exit 1 ;;
esac

ASSET="aderyn-${TRIPLE}.tar.xz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"

# Extract into a throwaway dir so an untrusted archive never lands next to our
# scripts, then move only the binary we want into place.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching aderyn ${VERSION} for ${TRIPLE} ..."
curl -fsSL "$URL" -o "$WORK/$ASSET"
tar -xJf "$WORK/$ASSET" -C "$WORK"

# The binary sits either at the archive root or inside a per-triple subdir.
FOUND="$(find "$WORK" -type f -name aderyn -perm -u+x | head -1)"
if [ -z "$FOUND" ]; then
  echo "Could not find the aderyn binary in $ASSET" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
install -m 0755 "$FOUND" "$DEST"
echo "Installed: $DEST"
"$DEST" --version
