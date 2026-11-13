#!/bin/bash
# Run OpenZeppelin Monitor once per monitor and block, over /work/config.
#   run.sh FROM TO MONITOR...
# Prints, per run:
#   RUN <monitor> <block> <exit code> <match total from the monitor log, or ->
#   ERR <last error line>                  (only when the exit code is not 0)
#   MATCH <monitor> <block> <match JSON>   (one line per match the trigger kept)
# lib/oz-monitor.mjs checks that every run exited 0 and that the trigger kept as
# many matches as the monitor says it found. Anything else is a failure.
set -u
from=$1; to=$2; shift 2
mkdir -p /tmp/oz
for m in "$@"; do
  for ((b = from; b <= to; b++)); do
    rm -rf /tmp/oz/matches && mkdir -p /tmp/oz/matches
    /app/openzeppelin-monitor --monitor-path "config/monitors/$m.json" --network lab --block "$b" --log-level info >/tmp/oz/log 2>&1
    code=$?
    # The image's sed is not GNU sed and does not know \x1b. Drop ESC with tr, then the codes.
    tr -d '\033' </tmp/oz/log | sed 's/\[[0-9;]*m//g' >/tmp/oz/log.txt && mv /tmp/oz/log.txt /tmp/oz/log
    total=$(grep -o 'Found matches, total: [0-9]*' /tmp/oz/log | tail -1 | grep -o '[0-9]*$')
    echo "RUN $m $b $code ${total:--}"
    [ "$code" -eq 0 ] || echo "ERR $(grep -i 'error' /tmp/oz/log | tail -1 | cut -c1-300)"
    for f in /tmp/oz/matches/m.*; do
      [ -e "$f" ] || continue
      printf 'MATCH %s %s %s\n' "$m" "$b" "$(jq -c . "$f" 2>/dev/null || echo '{unreadable')"
    done
  done
done
