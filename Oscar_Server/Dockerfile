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

# Pull Debian security updates for OS-level packages (libc-bin, libcap2,
# libsystemd0, …). The node:22-slim tag is rebuilt periodically but tagged
# releases can lag Debian's security tracker by days or weeks. Running
# apt-get upgrade on every image build clears HIGH/CRITICAL CVEs that Trivy
# would otherwise flag against the base layer
# (e.g. CVE-2026-0861 glibc memalign, CVE-2026-4878 libcap TOCTOU,
# CVE-2026-29111 systemd code exec — all fixed in deb12u14 / u3 / u2 point
# releases that ship in newer base-image rebuilds).
# ca-certificates: node:22-slim ships WITHOUT the system CA store, so
# /etc/ssl/certs does not exist. Every Bruno child process then printed
# "Cannot open directory /etc/ssl/certs to load OpenSSL certificates."
# to stderr at startup — harmless (Node verifies TLS against its bundled
# Mozilla CA store regardless) but it polluted every single run log.
# Installing ca-certificates creates the directory and silences the
# warning at the source.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g @usebruno/cli && \
    # ── Clear HIGH CVEs in Bruno CLI's bundled deps (issue #428) ─────────────
    # Bruno bundles vulnerable axios + form-data deep in its tree and pins them
    # rigidly: axios 1.13.6 is a DIRECT dep of @usebruno/cli AND exact-pinned by
    # @usebruno/js + @usebruno/requests. npm refuses to budge it — a `--no-save`
    # reinstall is pruned back to the pin, and an `overrides` entry errors
    # EOVERRIDE against the direct dependency. So we bypass npm resolution
    # entirely and unpack the patched release tarball directly over every nested
    # copy. axios/form-data's own runtime deps are hoisted in the tree with
    # compatible semver ranges, so replacing just the package dir is safe;
    # axios 1.x / form-data 4.0.x are API-stable drop-ins. Clears (all HIGH —
    # in BRUNO's deps, not OSCAR's):
    #   axios     1.13.6 -> 1.18.0  (CVE-2026-42033/-42035/-42043/-42264 +
    #                                -44486/-44487/-44488/-44492/-44494/-44495/-44496)
    #   form-data 4.0.4  -> 4.0.6   (CVE-2026-12143)
    cd /tmp && \
    npm pack axios@1.18.0 form-data@4.0.6 --silent && \
    AXIOS_TGZ="$(ls axios-*.tgz)" && FORMDATA_TGZ="$(ls form-data-*.tgz)" && \
    for d in $(find /usr/local/lib/node_modules/@usebruno -type d -path "*/node_modules/axios"); do \
      rm -rf "$d" && mkdir -p "$d" && tar -xzf "/tmp/$AXIOS_TGZ" -C "$d" --strip-components=1; \
    done && \
    for d in $(find /usr/local/lib/node_modules/@usebruno -type d -path "*/node_modules/form-data"); do \
      rm -rf "$d" && mkdir -p "$d" && tar -xzf "/tmp/$FORMDATA_TGZ" -C "$d" --strip-components=1; \
    done && \
    rm -f /tmp/axios-*.tgz /tmp/form-data-*.tgz && \
    # Fail the build immediately if any nested copy is still on the old version.
    for d in $(find /usr/local/lib/node_modules/@usebruno -type d -path "*/node_modules/axios"); do \
      v="$(node -p "require('$d/package.json').version")"; \
      [ "$v" = "1.18.0" ] || { echo "UNPATCHED axios@$v at $d"; exit 1; }; \
    done && \
    for d in $(find /usr/local/lib/node_modules/@usebruno -type d -path "*/node_modules/form-data"); do \
      v="$(node -p "require('$d/package.json').version")"; \
      [ "$v" = "4.0.6" ] || { echo "UNPATCHED form-data@$v at $d"; exit 1; }; \
    done && \
    echo "Bruno CLI deps patched: axios=1.18.0, form-data=4.0.6 in all nested copies" && \
    # ── Same shape, different day: nanoid (CVE-2026-67213/-67214, infinite loop
    # in customAlphabet, both HIGH) is exact-pinned "3.3.8" as a DIRECT dep of
    # FOUR Bruno sub-packages (@usebruno/converters, @usebruno/filestore,
    # @usebruno/js, @usebruno/schema) — same EOVERRIDE dead end as axios above,
    # same fix. Target 3.3.17, not the 5.x fixed line: nanoid 5 is ESM-only and
    # a breaking API change; 3.3.17 is the API-stable drop-in on the same major.
    npm pack nanoid@3.3.17 --silent && \
    NANOID_TGZ="$(ls nanoid-*.tgz)" && \
    for d in $(find /usr/local/lib/node_modules/@usebruno -type d -path "*/node_modules/nanoid"); do \
      rm -rf "$d" && mkdir -p "$d" && tar -xzf "/tmp/$NANOID_TGZ" -C "$d" --strip-components=1; \
    done && \
    rm -f /tmp/nanoid-*.tgz && \
    for d in $(find /usr/local/lib/node_modules/@usebruno -type d -path "*/node_modules/nanoid"); do \
      v="$(node -p "require('$d/package.json').version")"; \
      [ "$v" = "3.3.17" ] || { echo "UNPATCHED nanoid@$v at $d"; exit 1; }; \
    done && \
    echo "Bruno CLI deps patched: nanoid=3.3.17 in all nested copies" && \
    cd / && \
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
