# jsluice has no official image. Build it from one pinned commit.
# The Go checksum database verifies the module source. The binary hash below must match.
FROM golang:1.22.12-bookworm@sha256:3d699e4d15d0f8f13c9195c0632a16702b8cbdece2955af1c23b37ae5d55a253 AS build
ENV CGO_ENABLED=1 GOTOOLCHAIN=local GOFLAGS=-trimpath GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
RUN go install -ldflags='-s -w -buildid=' github.com/BishopFox/jsluice/cmd/jsluice@0ddfab153e060a9eeaded4d8669233f7c071e7e4
RUN echo "0ff64cc9c92eef8c936614a26bd1f7f24d87fdcafbb26f3cdb7adc8847f86a7f  /go/bin/jsluice" | sha256sum -c -

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
COPY --from=build /go/bin/jsluice /usr/local/bin/jsluice
ENTRYPOINT ["/usr/local/bin/jsluice"]
