# The attacker toolset: one image for the machine-layer packs (host, crypto,
# forensics, binary) and for a free-roam machine's own toolbelt.
#
# It is the ATTACKER side, not a lab. A lab image is the target. Every pack's
# script container runs from this image with `--network none` (all but host) and
# `--cap-drop ALL`, so a tool here can never reach the host.
#
# Rules for this file:
#   - Debian packages only, from the pinned base's own archive. A tool that is not
#     in the archive is built by a pack's own Dockerfile, not here (ffuf, the
#     exact gobuster release) so this image keeps building without a Go toolchain.
#   - No network at run time: nothing here may fetch on first use.
#   - Nothing that needs a kernel capability (no tcpdump on the host NIC, no
#     docker-in-docker). A lab that needs root inside its own container says so.
#
# Bookworm-slim is the same base the roam machine already uses, so the two
# toolbelts stay the same generation.
FROM --platform=linux/amd64 node:22-bookworm-slim@sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    # network: discovery, connection, transfer
    nmap netcat-openbsd socat curl wget dnsutils whois openssh-client \
    # web: content discovery and request fuzzing
    ffuf dirb hydra sshpass \
    # files: identify, carve, extract, edit
    file binutils xxd zlib1g-dev unzip p7zip-full \
    foremost sleuthkit exiftool steghide \
    # captures
    tshark tcpdump \
    # binary work
    gdb gcc g++ make python3 python3-pip python3-dev \
    # shell hygiene
    jq ripgrep less vim-tiny procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pwntools is what a pwn/reversing script actually uses (tube, ELF, ROP, cyclic).
# Pinned so the image is rebuildable; installed system-wide for the non-root user.
RUN pip3 install --no-cache-dir --break-system-packages "pwntools==4.13.1"

# binwalk is left out on purpose: the bookworm package crashes against the
# bookworm python3-capstone ("no attribute CS_ARCH_ARM64"). `carve` below covers
# the one thing the packs need from it, and `foremost` covers bulk extraction.
COPY carve /usr/local/bin/carve
RUN chmod 0755 /usr/local/bin/carve

RUN useradd -m -s /bin/bash attacker \
    && mkdir -p /work && chown attacker:attacker /work
WORKDIR /work

# Scripts run with `--entrypoint sh`, so the default CMD is only a fallback.
CMD ["sleep", "infinity"]
