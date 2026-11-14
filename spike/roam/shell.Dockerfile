# Shell-only setup recipe. No host files, credentials, browser or Docker daemon.
# Official Node 22 bookworm-slim linux/amd64 manifest, inspected 2026-11-14.
FROM --platform=linux/amd64 node:22-bookworm-slim@sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/touchstone /workspace
USER root
WORKDIR /workspace
CMD ["sleep", "infinity"]
