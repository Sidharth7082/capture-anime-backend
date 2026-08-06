# ============================================================================
# Multi-stage build: install deps in a builder, then copy a slim production
# image with only runtime dependencies.
# ============================================================================
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node db ./db
COPY --chown=node:node src ./src
# Run as non-root: a compromised process must not be root in the container.
USER node
EXPOSE 3000

# BusyBox wget ships with alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Run migrations, then start the API. The container must have a reachable
# DATABASE_URL (see docker-compose.yml).
CMD ["sh", "-c", "node db/migrate.js up && node src/server.js"]
