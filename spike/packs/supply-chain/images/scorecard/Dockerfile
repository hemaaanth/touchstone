# OSSF Scorecard v5.6.0, pinned. Built locally; a capture runs it with --pull=never.
# The release tarball is checked against its published SHA-256.
# Base: alpine 3.20 by digest (it carries the CA bundle a Go TLS client needs).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS fetch
ADD --checksum=sha256:19bde07129450cb65a95c6e3b9f34e034341579e6f0e241546ec3ae6efb2dd9a https://github.com/ossf/scorecard/releases/download/v5.6.0/scorecard_5.6.0_linux_amd64.tar.gz /tmp/release.tar.gz
RUN mkdir /out && tar -xzf /tmp/release.tar.gz -C /out && test -x /out/scorecard

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
COPY --from=fetch /out/scorecard /usr/local/bin/scorecard
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/scorecard"]
