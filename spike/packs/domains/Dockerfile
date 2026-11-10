FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /opt/tools
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
ADD --chmod=644 --checksum=sha256:b6fe6651ee3597dd09ef4cc65ee69329e2f9fb53cc9f23c710669548a83a2277 https://raw.githubusercontent.com/RetireJS/retire.js/5.2.5/repository/jsrepository.json /opt/tools/jsrepository.json
COPY analyze.mjs /opt/tools/analyze.mjs
ENTRYPOINT ["node", "/opt/tools/analyze.mjs"]
