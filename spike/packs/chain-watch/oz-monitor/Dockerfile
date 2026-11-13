# OpenZeppelin Monitor 1.7.0 (AGPL-3.0) for the chain-watch pack.
# Run as a separate program through lib/wrap.mjs runTool(), --pull=never, on an
# owned `--internal` Docker network whose only other member is the lab Anvil.
# Build (no network needed once the base image is local):
#   spike/tools/build-oz-monitor-image.sh
#
# The base image is the upstream release, pinned by digest. We add two small
# scripts and change nothing else: run.sh runs the monitor once per block, and
# record.sh is the script trigger that saves each match, which run.sh then prints.
FROM openzeppelin/openzeppelin-monitor:v1.7.0@sha256:0d5ac20151328d691cfcb90eeec77d9ce4d9f2f962ddbbb90988c8e0e7c2d616
COPY run.sh record.sh /opt/touchstone/
ENV NO_COLOR=1
WORKDIR /work
ENTRYPOINT []
