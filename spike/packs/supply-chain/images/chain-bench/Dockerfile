# chain-bench v0.1.10, pinned, with the GitHub token read from the environment.
# Built locally; a capture runs it with --pull=never.
#
# Upstream takes the token only as the flag -t, and a flag is in the process's
# argv, which the host `ps` shows to every local user (a container's processes
# are host processes). So this image builds chain-bench from its source with one
# added main (envtoken/main.go, ours): it reads SCM_TOKEN and appends the flag to
# os.Args inside the program, which never changes the process's argv. No
# upstream file is changed.
#
# Build: docker build -t touchstone/chain-bench:0.1.10-env spike/packs/supply-chain/images/chain-bench
# The source tarball is checked against its SHA-256. Bases are pinned by digest.
# Building needs network (the tarball, Go modules); the run has only the
# capture's GitHub-only egress.
FROM golang:1.22-alpine@sha256:1699c10032ca2582ec89a24a1312d986a3f094aed3d5c1147b19880afe40e052 AS build
ADD --checksum=sha256:5bfeaacd9cf7d272e88597135bff7f329d455a810aaf2b6a763ac55e18d383c1 https://github.com/aquasecurity/chain-bench/archive/refs/tags/v0.1.10.tar.gz /tmp/src.tar.gz
RUN mkdir /src && tar -xzf /tmp/src.tar.gz -C /src --strip-components=1
COPY envtoken/main.go /src/cmd/touchstone-chain-bench/main.go
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/chain-bench ./cmd/touchstone-chain-bench && test -x /out/chain-bench

# Base: alpine 3.20 by digest (it carries the CA bundle a Go TLS client needs).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
COPY --from=build /out/chain-bench /usr/local/bin/chain-bench
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/chain-bench"]
