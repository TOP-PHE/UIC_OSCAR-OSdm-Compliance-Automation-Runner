# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0

# ─────────────────────────────────────────────────────────────────────────────
# Build stage — installs app dependencies (with native compilation for bcrypt)
# ─────────────────────────────────────────────────────────────────────────────
# Both FROM lines name the base image by digest as well as by tag (#545): the
# tag moves, the digest does not, so two builds of the same commit start from
# the same image. Dependabot (docker ecosystem) proposes the new digest when
# the tag moves. To update by hand, see CONTRIBUTING.md.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS builder

# Build deps for bcrypt native compilation
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ─────────────────────────────────────────────────────────────────────────────
# Runtime stage — installs Bruno CLI from its lockfile, then strips npm
# ─────────────────────────────────────────────────────────────────────────────
# After the Bruno install, we drop npm (and corepack) to:
#   1. Clear CVE-2026-33671 (picomatch ReDoS) flagged by Trivy inside the
#      npm-vendored copy of picomatch.
#   2. Shrink the runtime image by ~50 MB.
# OSCAR never invokes npm at runtime — node_modules is already in place
# (copied from the builder stage below).
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

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

# ── Bruno CLI (#545) ─────────────────────────────────────────────────────────
# One exact version, and its whole dependency tree with integrity hashes, come
# from bruno-cli/package.json + package-lock.json. CI (ci-collection.yml)
# installs the same lockfile, so the collection is validated against the
# engine production runs. A new Bruno version is a pull request that changes
# that lockfile (Dependabot proposes it); see CONTRIBUTING.md.
#
# The vulnerable copies Bruno bundles (axios, form-data, @faker-js/faker,
# js-yaml; #428, #532) are replaced by the `overrides` in that package.json.
# This used to be done here by unpacking tarballs over a global install,
# because a global install has no root package.json to carry overrides, and
# an override cannot change a direct dependency of the root. Here the root's
# only dependency is @usebruno/cli, so overriding its own dependencies is
# allowed. nanoid needs no override: Bruno 4.2.1 already ships 3.3.18.
# What each override clears (all HIGH, in Bruno's tree, not OSCAR's):
#   axios ^1.20.0       CVE-2026-42033/-42035/-42043/-42264/-44486/-44487/
#                       -44488/-44492/-44494/-44495/-44496 (#428) and
#                       CVE-2026-101898/-101901/-101903/-101905/-101906/
#                       -101907/-101909 (#532); Bruno 4.2.1 ships 1.18.0
#   form-data ^4.0.6    CVE-2026-12143; Bruno 4.2.1 ships 4.0.4 at the root
#   @faker-js/faker ^10.5.0  CVE-2026-73231; a major above Bruno's 9.x, safe
#                       because the collection never uses {{$faker...}}
#   js-yaml ^4.3.2      CVE-2026-84375 (#532); Bruno 4.2.1 ships 4.3.1
# The ranges are floors, not ceilings (CLAUDE.md, "an exact-version
# overrides entry"): the lockfile fixes the version actually installed.
#
# --ignore-scripts: one package in the tree has an install script (the
# lockfile marks it "hasInstallScript"): protobufjs, whose postinstall only
# prints a warning about how its dependents spell its version. Skipping it
# changes nothing, and a dependency added later cannot run code at build time
# unnoticed.
#
# /usr/local/bin/bru is a symlink, as a global install made it, so
# BRU_CMD=/usr/local/bin/bru (OSCAR_Deploy/docker-compose.yml) keeps working.
# Node resolves the symlink chain to bin/bru.js, so its relative requires work.
COPY bruno-cli/package.json bruno-cli/package-lock.json /opt/bruno-cli/
RUN cd /opt/bruno-cli && \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund && \
    ln -s /opt/bruno-cli/node_modules/.bin/bru /usr/local/bin/bru && \
    bru --version && \
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
