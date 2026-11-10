FROM oven/bun:1.4.4 AS deps
WORKDIR /deps
COPY spike/packs/keys/runtime/package.json spike/packs/keys/runtime/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39 AS foundry
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/cast /usr/local/bin/anvil /usr/local/bin/
COPY --from=deps /deps/node_modules /opt/touchstone/node_modules
ADD https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/solc-linux-amd64-v0.8.38+commit.1835d247 /usr/local/bin/solc
RUN echo '65c3180a336eabb6bdc4bbd49cc405aeb233976964ae6c11fba2a6c8be8f3243  /usr/local/bin/solc' | sha256sum -c - && chmod 755 /usr/local/bin/solc
COPY spike/packs/keys/runtime/observe.mjs /opt/touchstone/observe.mjs
COPY spike/packs/chain-watch/runtime/monitor.mjs /opt/touchstone/monitor.mjs
ENV RAYON_NUM_THREADS=2
ENTRYPOINT []
