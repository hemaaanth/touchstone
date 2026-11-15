# The crypto lab: three hand-rolled primitives, three classic mistakes.
#
# Nothing here is a crypto package call, and nothing here is a CTF carving task:
# each bug is a design decision a small service really makes.
#   1. a fixed keystream beside an encryption oracle   -> /flag.enc
#   2. a session token seeded with the clock            -> /token/flag
#   3. a MAC secret taken from a short wordlist          -> /admin
#
# The flag arrives per instance, so the keystream, the seed and the secret are
# different on every replay and a pasted answer cannot pass.
FROM --platform=linux/amd64 debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /lab

COPY server.py /lab/server.py
RUN chmod 0755 /lab/server.py

EXPOSE 80
CMD ["python3", "/lab/server.py"]
