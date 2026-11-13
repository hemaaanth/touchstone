# Strix, as a container so it goes through runDocker() like every other engine.
#
# Strix is the ONE networked, non-offline engine: it needs the internet for the
# target and for its own model calls, and it starts sandbox containers of its
# own. That is why it gets the Docker socket mounted and its own image instead
# of running as a host binary. See lib/strix.mjs for the full rationale.
#
# Pinned: strix-agent 1.7.0, Docker CLI 27.5.1 (static, x86_64).
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz -o /tmp/docker.tgz \
 && tar -xzf /tmp/docker.tgz -C /tmp \
 && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker /tmp/docker.tgz

RUN pip install --no-cache-dir strix-agent==1.7.0

ENV \
    STRIX_TELEMETRY=0 \
    STRIX_API_TYPE=chat_completions \
    SHIM_URL_FILE=/tmp/shim.url

COPY lib/llm-shim.mjs /opt/shim/shim.mjs
COPY tools/strix/entrypoint.sh /usr/local/bin/strix-entry
RUN chmod 0755 /usr/local/bin/strix-entry

ENTRYPOINT ["/usr/local/bin/strix-entry"]
