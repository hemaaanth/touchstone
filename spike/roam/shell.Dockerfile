# Shell-only setup recipe. No host files, credentials, browser or Docker daemon.
# Official Node 22 bookworm-slim linux/amd64 manifest, inspected 2026-11-14.
#
# The machine carries the attacker toolbelt (spike/packs/_toolset/Dockerfile, the
# same package set) because a machine child is where host, capture and binary work
# happens: without it every tool call would have to run in another container, which
# defeats the point of a machine. daytona-probe.mjs checks the belt and refuses a
# snapshot that lacks it.
FROM --platform=linux/amd64 node:22-bookworm-slim@sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl procps \
      nmap netcat-openbsd socat wget dnsutils whois openssh-client \
      ffuf dirb hydra sshpass \
      file binutils xxd zlib1g-dev unzip p7zip-full \
      foremost sleuthkit exiftool steghide \
      tshark tcpdump \
      gdb gcc g++ make python3 python3-pip python3-dev \
      jq ripgrep less vim-tiny \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages "pwntools==4.13.1" \
    && mkdir -p /var/log/touchstone /workspace
USER root
WORKDIR /workspace
CMD ["sleep", "infinity"]
