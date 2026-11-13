# chain-bench v0.1.10, pinned. Built locally; a capture runs it with --pull=never.
# The release tarball is checked against its published SHA-256.
# Base: alpine 3.20 by digest (it carries the CA bundle a Go TLS client needs).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS fetch
ADD --checksum=sha256:03c73a9d6f01493cd4f68cae18cbbf0fe38695c3cbfb6e4a2fa4d6bf10079dd3 https://github.com/aquasecurity/chain-bench/releases/download/v0.1.10/chain-bench_0.1.10_Linux-64bit.tar.gz /tmp/release.tar.gz
RUN mkdir /out && tar -xzf /tmp/release.tar.gz -C /out && test -x /out/chain-bench

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
COPY --from=fetch /out/chain-bench /usr/local/bin/chain-bench
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/chain-bench"]
