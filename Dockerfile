# syntax=docker/dockerfile:1

# --- build stage: compiles argon2's native binding, then prunes ------------
FROM node:20-alpine AS deps
WORKDIR /usr/src/app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
# npm ci requires a committed lockfile; fall back so a fresh clone still builds.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

# --- runtime stage ---------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nodejs -G nodejs

COPY --from=deps --chown=nodejs:nodejs /usr/src/app/node_modules ./node_modules
COPY --chown=nodejs:nodejs package*.json ./
COPY --chown=nodejs:nodejs src ./src
COPY --chown=nodejs:nodejs migrations ./migrations
COPY --chown=nodejs:nodejs scripts ./scripts
# The BCV intermediate certificate; without it the exchange rate lookup fails
# TLS verification inside the container. See src/config.js.
COPY --chown=nodejs:nodejs certs ./certs

USER nodejs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
