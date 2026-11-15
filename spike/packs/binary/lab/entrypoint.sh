#!/bin/sh
# Build this instance's binaries, then serve the vulnerable one on 9001.
set -e
/lab/build.sh
exec socat TCP-LISTEN:9001,reuseaddr,fork EXEC:/work/bin/vuln
