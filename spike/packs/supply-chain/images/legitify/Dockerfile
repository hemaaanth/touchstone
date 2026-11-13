# Legitify v1.0.11, pinned. Built locally; a capture runs it with --pull=never.
# The release tarball is checked against its published SHA-256.
# Base: alpine 3.20 by digest (it carries the CA bundle a Go TLS client needs).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS fetch
ADD --checksum=sha256:90a8df588c7c2a334c8397ac74b614f411adb8cdf14b6472b7a7cfbe7ef57bdd https://github.com/Legit-Labs/legitify/releases/download/v1.0.11/legitify_1.0.11_linux_amd64.tar.gz /tmp/release.tar.gz
RUN mkdir /out && tar -xzf /tmp/release.tar.gz -C /out && test -x /out/legitify

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
COPY --from=fetch /out/legitify /usr/local/bin/legitify
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/legitify"]
