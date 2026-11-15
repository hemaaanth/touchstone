# The binary lab: compiles three binaries with this instance's flag baked in, then
# serves the vulnerable one over TCP. The binaries are built at container start
# because the flag is per instance.
#
# -O0 -fno-stack-protector -no-pie on purpose: the overflow is a layout bug, not a
# modern-mitigations exercise. The other two are reversing exercises.
FROM --platform=linux/amd64 debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc libc6-dev socat file binutils xxd python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /lab

COPY build.sh entrypoint.sh /lab/
COPY vuln.c check.c hidden.c /lab/
RUN chmod 0755 /lab/build.sh /lab/entrypoint.sh

EXPOSE 9001
ENTRYPOINT ["/lab/entrypoint.sh"]
