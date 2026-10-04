# MCP server image — used by CI to publish to ghcr.io
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ dist/

# Run as the image's "node" user (UID/GID 1000) so files written into a
# bind-mounted vault are not owned by root.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787

CMD ["node", "dist/main.js"]
