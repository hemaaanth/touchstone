#!/bin/sh
set -eu
/opt/touchstone/roam/desktop/display-start.sh start
if [ "$#" -gt 0 ]; then exec "$@"; fi
# The image and display survive toolbox exec sessions.
exec sleep infinity
