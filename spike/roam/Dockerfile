# Build context: spike/roam. Adapted from BB sandboxes docker/Dockerfile.
# MIT source notice: desktop/LICENSE.bb. Codec notices: desktop/THIRD-PARTY-NOTICES.
# These pins match the locally inspected sandboxes source, not a registry query.
FROM rust:1.99-bookworm AS voxl
ARG VOXL_VERSION=0.3.3
ARG ESBUILD_VERSION=0.28.2
RUN apt-get update \
  && apt-get install --yes --no-install-recommends clang libclang-dev pkg-config npm \
    libx264-dev libyuv-dev libopus-dev libpulse-dev \
  && npm install --global "esbuild@${ESBUILD_VERSION}" \
  && cargo install voxl-server --version "${VOXL_VERSION}" --locked --root /opt/voxl \
  && mkdir -p /opt/voxl/share/doc/voxl \
  && cp /usr/local/cargo/registry/src/*/"voxl-server-${VOXL_VERSION}"/LICENSE \
    /usr/local/cargo/registry/src/*/"voxl-server-${VOXL_VERSION}"/Cargo.lock /opt/voxl/share/doc/voxl/

FROM node:22-bookworm-slim
ENV DISPLAY=:99 \
    TOUCHSTONE_ROAM_RUNTIME=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates xvfb openbox x11-utils util-linux \
    libx264-164 libyuv0 libopus0 libpulse0 \
  && mkdir -p /opt/touchstone/roam /run/touchstone \
  && chmod 700 /run/touchstone \
  && npm install --prefix /opt/touchstone/roam --save-exact playwright@1.65.1 \
  && node /opt/touchstone/roam/node_modules/playwright/cli.js install --with-deps chromium \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=voxl /opt/voxl/bin/voxl /usr/local/bin/voxl
COPY --from=voxl /opt/voxl/share/doc/voxl /usr/share/doc/voxl
# Includes I2 egress-log.mjs and I3 browser-driver.mjs after lane integration.
# Local node_modules in this directory must never be included in the build context.
COPY . /opt/touchstone/roam/
COPY Dockerfile /usr/share/doc/voxl/Dockerfile
RUN chmod 755 /opt/touchstone/roam/desktop/*.sh /opt/touchstone/roam/desktop/entry.mjs
WORKDIR /opt/touchstone/roam
ENTRYPOINT ["/opt/touchstone/roam/desktop/image-start.sh"]
