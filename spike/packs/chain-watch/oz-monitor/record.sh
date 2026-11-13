#!/bin/bash
# OpenZeppelin Monitor script trigger. The monitor writes one match as JSON on
# stdin. Keep it in a fresh file; run.sh prints it after the run.
set -eu
f=$(mktemp /tmp/oz/matches/m.XXXXXX)
cat > "$f"
