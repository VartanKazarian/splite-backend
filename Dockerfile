FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Security: Create non-root system user
RUN addgroup -g 1001 -S nodejs && \
    adduser -u 1001 -S nodejs -G nodejs

RUN chown -R nodejs:nodejs /usr/src/app

USER nodejs

EXPOSE 3000

CMD ["node", "src/server.js"]

# Copy schema file for initialization if using multi-stage builds or container DBs
COPY docs/schema.sql /docker-entrypoint-initdb.d/schema.sql


