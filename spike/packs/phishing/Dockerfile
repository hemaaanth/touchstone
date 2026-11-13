# dnstwist with dnspython, so a capture can read NS, A, AAAA and MX from one named resolver.
# The base is pinned by digest. Every wheel is pinned by sha256.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --no-deps --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt
USER 65534:65534
ENTRYPOINT ["dnstwist"]
