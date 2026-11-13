# Aderyn (Cyfrin) in a container, for lib/aderyn.mjs through lib/wrap.mjs runTool().
#
# The image holds a pinned Aderyn binary and the solc versions it may need, so a
# scan runs with --network none. Without the baked solc, Aderyn downloads one
# from binaries.soliditylang.org at run time. A pragma outside SOLC_VERSIONS then
# fails with "no report", and the static engine degrades to Slither only.
#
# Build once (needs network): tools/build-aderyn-image.sh
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq xz-utils \
  && rm -rf /var/lib/apt/lists/*
ARG ADERYN_TAG=aderyn-v0.6.8
ARG ADERYN_SHA256=ffd6ca658962e211a3ac821c646f69c8e14bf1b1001cbfe091bcd4535a691e46
ARG SOLC_VERSIONS="0.8.19 0.8.20 0.8.24 0.8.26 0.8.28 0.8.33 0.8.38"
RUN set -eu; cd /tmp \
  && curl -fsSL "https://github.com/Cyfrin/aderyn/releases/download/${ADERYN_TAG}/aderyn-x86_64-unknown-linux-gnu.tar.xz" -o aderyn.tar.xz \
  && echo "${ADERYN_SHA256}  aderyn.tar.xz" | sha256sum -c - \
  && tar -xJf aderyn.tar.xz \
  && install -m 0755 aderyn-x86_64-unknown-linux-gnu/aderyn /usr/local/bin/aderyn \
  && curl -fsSL https://binaries.soliditylang.org/linux-amd64/list.json -o list.json \
  && for v in ${SOLC_VERSIONS}; do \
       path="$(jq -r --arg v "$v" '.releases[$v]' list.json)"; \
       sha="$(jq -r --arg v "$v" '.builds[] | select(.version == $v) | .sha256' list.json | sed 's/^0x//')"; \
       mkdir -p "/opt/data/svm/$v"; \
       curl -fsSL "https://binaries.soliditylang.org/linux-amd64/$path" -o "/opt/data/svm/$v/solc-$v"; \
       echo "$sha  /opt/data/svm/$v/solc-$v" | sha256sum -c -; \
       chmod 0755 "/opt/data/svm/$v/solc-$v"; \
     done

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
COPY --from=fetch /usr/local/bin/aderyn /usr/local/bin/aderyn
COPY --from=fetch /opt/data /opt/data
# Aderyn finds solc in $XDG_DATA_HOME/svm. HOME is writable for any user.
ENV XDG_DATA_HOME=/opt/data HOME=/tmp
