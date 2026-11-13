# Slither (crytic/slither, AGPL-3.0) for the chain-watch and keys packs.
# Run as a separate program through lib/wrap.mjs runTool(), --network none.
# Build (needs network once): spike/tools/build-slither-image.sh
#
# Everything is pinned: the base images by digest, every Python package by exact
# version, and solc 0.8.38 by sha256. solc lives inside the image, so a run never
# downloads a compiler. forge is here only because crytic-compile drives a
# Foundry project through `forge build`; FOUNDRY_SOLC points it at the offline solc.
FROM ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39 AS foundry

FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check --root-user-action=ignore -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
ADD https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/solc-linux-amd64-v0.8.38+commit.1835d247 /opt/solc/solc-0.8.38
RUN echo '65c3180a336eabb6bdc4bbd49cc405aeb233976964ae6c11fba2a6c8be8f3243  /opt/solc/solc-0.8.38' | sha256sum -c - \
 && chmod 755 /opt/solc/solc-0.8.38
ENV FOUNDRY_SOLC=/opt/solc/solc-0.8.38 \
    FOUNDRY_OFFLINE=true \
    HOME=/tmp \
    RAYON_NUM_THREADS=2
ENTRYPOINT []
