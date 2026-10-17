# ── Stage 1: dependencies ──────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user for least privilege
RUN addgroup -S vw && adduser -S vw -G vw

# Only copy what we need
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/           ./src/
COPY scripts/       ./scripts/

USER vw

# Expose the port the app listens on (actual port set via PORT env var)
EXPOSE 3001

# Graceful shutdown — SIGTERM triggers the handler in server.js
STOPSIGNAL SIGTERM

# Health check: Render / Fly / Docker Compose all use this
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/api/v1/health || exit 1

CMD ["node", "src/server.js"]
