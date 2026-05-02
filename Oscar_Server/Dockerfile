# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0

# ─────────────────────────────────────────────────────────────────────────────
# Build stage — installs app dependencies (with native compilation for bcrypt)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

# Build deps for bcrypt native compilation
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ─────────────────────────────────────────────────────────────────────────────
# Runtime stage — installs Bruno CLI in place, then strips npm
# ─────────────────────────────────────────────────────────────────────────────
# We install Bruno CLI directly in the runtime stage rather than copying it
# from the builder. Reason: `npm install -g` creates a symlink at
# /usr/local/bin/bru pointing into /usr/local/lib/node_modules/@usebruno/cli/.
# A `COPY --from=builder /usr/local/bin/bru` resolves the symlink and copies
# only the shim file, breaking its relative require('../src') paths.
# Installing in-place preserves the symlink + the full @usebruno/cli tree.
#
# After install, we drop npm (and corepack) to:
#   1. Clear CVE-2026-33671 (picomatch ReDoS) flagged by Trivy inside the
#      npm-vendored copy of picomatch.
#   2. Shrink the runtime image by ~50 MB.
# OSCAR never invokes npm at runtime — node_modules is already in place
# (copied from the builder stage below).
FROM node:22-slim

WORKDIR /app

RUN npm install -g @usebruno/cli && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /root/.npm

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
