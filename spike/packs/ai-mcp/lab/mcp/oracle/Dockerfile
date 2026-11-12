# Built with network access (npm install), run with none.
# The image is the fixed lab artifact. It is never copied into a run workspace.
FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.mjs .
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
