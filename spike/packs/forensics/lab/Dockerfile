# The forensics lab is a generator, not a service: it writes three artifacts into
# the workspace once per instance, each hiding the instance's flag a different way.
# The container then idles so the attacker container always has a target handle.
FROM --platform=linux/amd64 debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 tcpdump zip python3-pil \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /lab

COPY generate.py /lab/generate.py
RUN chmod 0755 /lab/generate.py
CMD ["sh", "-c", "touch /lab/ready && exec sleep infinity"]
