# ─────────────────────────────────────────────────────────────────────────────
# Build stage — has npm, build tools, Bruno CLI install
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

# Build deps for bcrypt native compilation
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install Bruno CLI globally — used at runtime by the worker via the
# /usr/local/lib/node_modules path. Bruno only needs the bru.cmd / bru
# binary and its own node_modules tree; the global npm CLI itself is
# not invoked at runtime, so it gets dropped in the runtime stage below.
RUN npm install -g @usebruno/cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ─────────────────────────────────────────────────────────────────────────────
# Runtime stage — minimal, no npm CLI (clears CVE-2026-33671 picomatch)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim

# Remove the bundled npm CLI from the runtime image. The OSCAR server
# never invokes npm itself — node_modules is already installed by the
# build stage and copied in below. Dropping npm:
#   1. Eliminates the HIGH-severity CVE-2026-33671 (picomatch ReDoS) that
#      Trivy flags inside npm's vendored picomatch.
#   2. Shrinks the image by ~50 MB.
# corepack is also removed since it bundles its own dependencies and is
# not used at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack

WORKDIR /app

# Bring in the Bruno CLI installed in the builder stage. The global
# install path on the official node image is /usr/local — copying that
# subtree preserves both the package files and the bin shims.
COPY --from=builder /usr/local/lib/node_modules/@usebruno /usr/local/lib/node_modules/@usebruno
COPY --from=builder /usr/local/bin/bru /usr/local/bin/bru

# App dependencies (already installed without dev deps in the builder)
COPY --from=builder /app/node_modules ./node_modules

# Application code
COPY src/ src/
COPY public/ public/
COPY package.json ./

# Create data directory for SQLite DB, artifacts, and datafiles
RUN mkdir -p data/artifacts data/datafiles

# Security: run as non-root user
# The official node image already has a 'node' user (uid 1000). We chown the
# app + data dir so it can write to SQLite, datafiles, and artifacts.
RUN chown -R node:node /app
USER node

EXPOSE 3001

CMD ["node", "src/server.js"]
