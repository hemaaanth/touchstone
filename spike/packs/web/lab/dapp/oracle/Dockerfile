# Built with network access (npm install), run with none. The image is the
# fixed lab artifact; it is built from the pack's own lab/dapp/oracle path,
# never copied into a per-run workspace (oracle/ is skipped by makeWorkspace).
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs .
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
