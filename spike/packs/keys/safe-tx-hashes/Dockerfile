# safe-tx-hashes-util (pcaversaccio/safe-tx-hashes-util, AGPL-3.0) for the Keys pack.
#
# There is no official image. This image holds the upstream `safe_hashes.sh` unchanged, at
# a pinned commit, checked by sha256. It is run as a separate program; no code is copied
# into our repo. The script needs bash, cast and chisel (>= 1.3.5), jq and curl.
#
# Network is used at build time only. At run time the pack uses `--network none`: the
# script's curl calls to the Safe Transaction Service fail, and the script asks for the
# Safe version and the transaction fields on stdin (its `--interactive` mode).
#
#   docker build -f spike/packs/keys/safe-tx-hashes/Dockerfile \
#     -t touchstone/safe-tx-hashes:e295975 spike/packs/keys/safe-tx-hashes
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS fetch
# The script at upstream commit e295975 (main on 2026-11-09).
ADD --checksum=sha256:82991fdbb57d9751a448475833cbe65b47119778efc6efbe54338b7f98c345d0 \
  https://raw.githubusercontent.com/pcaversaccio/safe-tx-hashes-util/e295975cbad46f5643cb64857f4422656f16f83f/safe_hashes.sh /tmp/safe_hashes.sh
# jq 1.7.1 (MIT), official static release binary.
ADD --checksum=sha256:5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5 \
  https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64 /tmp/jq
# curl 8.23.0 (curl licence), static musl build from stunnel/static-curl (MIT build scripts).
ADD --checksum=sha256:2e0c54ba696afd0df1e899e4344fa63d53d73107f9ac08173314d9be85bc76fd \
  https://github.com/stunnel/static-curl/releases/download/8.23.0-1/curl-linux-x86_64-musl-8.23.0-1.tar.xz /tmp/curl.tar.xz
# solc 0.8.38 (GPL-3.0), official static build. chisel compiles each `chisel eval` with it.
# Without a local solc, chisel tries to download one, fails offline, and the script prints
# empty hashes with exit 0. The pack treats empty hashes as a failure.
ADD --checksum=sha256:65c3180a336eabb6bdc4bbd49cc405aeb233976964ae6c11fba2a6c8be8f3243 \
  https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.38+commit.1835d247 /tmp/solc
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils \
  && mkdir /tmp/curl && tar -xJf /tmp/curl.tar.xz -C /tmp/curl \
  && install -m 0755 /tmp/curl/curl /usr/local/bin/curl \
  && install -m 0755 /tmp/jq /usr/local/bin/jq \
  && install -m 0755 /tmp/solc /usr/local/bin/solc \
  && install -m 0755 /tmp/safe_hashes.sh /usr/local/bin/safe_hashes.sh

# Foundry 1.9.0 (cast, chisel), pinned by digest. MIT or Apache-2.0.
FROM ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39
COPY --from=fetch /usr/local/bin/curl /usr/local/bin/jq /usr/local/bin/solc /usr/local/bin/safe_hashes.sh /usr/local/bin/
# Foundry uses the local solc and never tries the network.
ENV NO_COLOR=true FOUNDRY_SOLC=/usr/local/bin/solc FOUNDRY_OFFLINE=true
# No entrypoint: the pack runs `bash -c` to hash a batch of transactions in one container.
ENTRYPOINT []
CMD ["safe_hashes.sh", "--help"]
