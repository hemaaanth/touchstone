# Built with network access (npm install), run with none. The image is the
# fixed lab artifact; it is built from the pack's own lab/dapp/oracle path,
# never copied into a per-run workspace (oracle/ is skipped by makeWorkspace).
FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.mjs .
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
