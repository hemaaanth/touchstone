#!/bin/sh
# Start the loopback model shim, then become strix. The shim drops one parameter
# our gateway rejects; it exists because the gateway is the outlier, not because
# Strix is wrong. See lib/llm-shim.mjs.
set -eu
rm -f "$SHIM_URL_FILE"
node /opt/shim/shim.mjs &
i=0
while [ ! -s "$SHIM_URL_FILE" ]; do
  i=$((i + 1))
  [ "$i" -gt 100 ] && { echo "shim did not start" >&2; exit 1; }
  sleep 0.1
done
LLM_API_BASE=$(cat "$SHIM_URL_FILE")
export LLM_API_BASE
# The shim adds the real key; Strix only needs to see that it has one.
export LLM_API_KEY="${LLM_API_KEY:-shim}"
exec strix "$@"
