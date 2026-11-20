# Multies on Node (API + web app in one process). For Cloudflare Workers see wrangler.toml.
# Self-hosting on your own computer: docker-compose.selfhost.yml and docs/self-host.md.
FROM node:26-bookworm-slim AS build
# better-sqlite3 compiles from source when no prebuilt binary matches this Node version.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npx tsx scripts/selfhost/build.ts && npm prune --omit=dev

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/mymail.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# The database volume mounts here; it must be writable by the unprivileged user.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "dist/server/node.js"]
