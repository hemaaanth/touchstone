# safe-hash-rs (Cyfrin) has no official image. Use the official release binary, pinned by sha256.
# Network is used here, at build time only. The pack runs the image with --network none.
# No Cyfrin source is copied into this repo. The upstream repo publishes no licence: see THIRD_PARTY.md.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS fetch
ADD --checksum=sha256:ce9703ee5aa837aee4b601c72840302067a24111959cb3a2e8ebd598b000a965 \
  https://github.com/Cyfrin/safe-hash-rs/releases/download/safe-hash-v0.0.19/safe-hash-x86_64-unknown-linux-gnu.tar.xz /tmp/safe-hash.tar.xz
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils \
  && tar -xJf /tmp/safe-hash.tar.xz -C /tmp \
  && install -m 0755 /tmp/safe-hash-x86_64-unknown-linux-gnu/safe-hash /usr/local/bin/safe-hash

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
COPY --from=fetch /usr/local/bin/safe-hash /usr/local/bin/safe-hash
# No entrypoint: the pack runs `sh -c` to hash a batch of transactions in one container.
CMD ["safe-hash", "--version"]
