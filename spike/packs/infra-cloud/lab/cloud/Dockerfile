# The live-cloud lab for the `http` proof. Built with network, run with none.
# node + ethers/siwe are needed by the shared request-script harness in
# lib/proof-http.mjs. The finding script signs its own SigV4 calls.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev \
 && python3 -m pip install --no-cache-dir --break-system-packages boto3==1.44.1 "moto[server]==5.2.5"
COPY lab.py .
RUN chown -R node:node /app
USER node
# Moto allows every unsigned call until this count is used up. Zero makes IAM
# real: the proof depends on the role's policy, not on moto being permissive.
ENV INITIAL_NO_AUTH_ACTION_COUNT=0
EXPOSE 5000
CMD ["python3", "/app/lab.py"]
