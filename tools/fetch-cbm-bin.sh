#!/usr/bin/env bash
# Fetch and install the pinned codebase-memory-mcp engine binary.
#
# This is a BUILD-TIME step and the ONLY step in the source-nav pack that needs
# the network. The engine is RUN, never vendored into the repo: the 330 MB
# binary is NOT committed. At run time the pack resolves this install path (or
# $PI_CBM_BIN / $PATH) and runs it fully offline — no account, no network, no
# API key. See spike/packs/source-nav/TOOLS.md.
#
# Usage:  tools/fetch-cbm-bin.sh
# Idempotent: re-running verifies the installed binary's sha256 and reinstalls
# only if it is missing or fails the checksum.
set -euo pipefail

# --- Pin ----------------------------------------------------------------------
REPO="DeusData/codebase-memory-mcp"
VERSION="0.12.1"
ASSET="codebase-memory-mcp-linux-amd64-portable.tar.gz"
# sha256 of the release ARCHIVE above (from the release's checksums.txt), and of
# the EXTRACTED binary it contains. We verify BOTH: the archive after download,
# and the installed/extracted binary itself — so "already installed" never means
# "trusted without checking". BINARY_SHA256 must match spike/lib/cbm.mjs's
# PINNED_CBM_SHA256 (the runtime gate hashes the binary before every exec).
ARCHIVE_SHA256="8c3d0341064301e78ecc84cf7348d4e2c6562a0f57448243ea560aaa34de36c1"
BINARY_SHA256="77745491f0a9c346d6da23eed4d92b5feaa31a27a883c9faa4fa9f47c8183705"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"

# --- Install location ---------------------------------------------------------
DEST="${HOME}/.local/share/touchstone/codebase-memory-mcp/${VERSION}"
BIN="${DEST}/codebase-memory-mcp"

echo "codebase-memory-mcp ${VERSION} -> ${BIN}"

# Already installed? Trust it only if its sha256 matches the pin — not its
# self-reported --version (a planted binary can print anything).
if [ -x "${BIN}" ]; then
  if echo "${BINARY_SHA256}  ${BIN}" | sha256sum -c - >/dev/null 2>&1; then
    echo "already installed and sha256-verified (${BIN}); nothing to do."
    exit 0
  fi
  echo "installed binary at ${BIN} failed checksum; reinstalling." >&2
fi

# --- Download + verify + extract (build-time network) -------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "downloading ${URL}"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${URL}" -o "${TMP}/${ASSET}"
else
  wget -qO "${TMP}/${ASSET}" "${URL}"
fi

echo "verifying sha256"
echo "${ARCHIVE_SHA256}  ${TMP}/${ASSET}" | sha256sum -c -

echo "extracting"
tar -xzf "${TMP}/${ASSET}" -C "${TMP}"

# The portable archive is flat: codebase-memory-mcp, install.sh, LICENSE,
# THIRD_PARTY_NOTICES.md. Find the binary wherever it lands.
SRC_BIN="$(find "${TMP}" -maxdepth 2 -type f -name codebase-memory-mcp | head -n1)"
if [ -z "${SRC_BIN}" ]; then
  echo "error: codebase-memory-mcp binary not found in archive" >&2
  exit 1
fi
SRC_DIR="$(dirname "${SRC_BIN}")"

# Verify the extracted binary itself before trusting it on disk.
echo "verifying extracted binary sha256"
echo "${BINARY_SHA256}  ${SRC_BIN}" | sha256sum -c -

# --- Install (binary + provenance) --------------------------------------------
mkdir -p "${DEST}"
install -m 0755 "${SRC_BIN}" "${BIN}"
# Keep the upstream MIT LICENSE and third-party notices beside the binary we run.
for f in LICENSE THIRD_PARTY_NOTICES.md; do
  [ -f "${SRC_DIR}/${f}" ] && install -m 0644 "${SRC_DIR}/${f}" "${DEST}/${f}"
done

echo "installed:"
"${BIN}" --version
echo "done. Point the pack at it with: export PI_CBM_BIN=${BIN}"
