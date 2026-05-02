# Monorepo + Auto-Deploy Transformation

**Window:** 2026-04-30 → 2026-05-01
**Audience:** UIC operators, future maintainers, anyone who needs to know "why is the
repo laid out this way" or "how does production roll forward"

This note is a single source of truth covering the structural and operational
overhaul applied across two days. It complements the per-component docs
(`installation-guide.md`, `auto-deploy-setup.md`, etc.) and is meant to be
read top-to-bottom once.

---

## TL;DR

We took two repositories and a hand-managed VPS deploy and turned them into:

- A **single private GitHub monorepo** (`TOP-PHE/UIC_OSCAR_Temporary`, to be
  transferred to `UICrail` later) holding the server, the Bruno test
  collection, the deploy manifests and the documentation.
- A **versioned image pipeline** that publishes to GitHub Container Registry
  on every server commit, plus a `:stable` tag promoted only when an explicit
  `release-YYYY.MM` Git tag is pushed.
- A **production VPS** that pulls from GHCR via Watchtower and refreshes the
  Bruno collection on its own when collection-only commits land on `main`.
- A **version chip** in the UI top banner that shows what release / server /
  collection are actually running, color-coded by compatibility status.

Net effect: shipping a server change is now `git push` + `git tag release-…`
+ `git push --tags`. Production rolls within five minutes. Shipping a
collection change is just `git push`.

---

## 1. Repository reorganisation

### Before

Two siblings:

```
OSCAR-OSdm-Compliance-Automation-Runner/    ← server only
OTST_V2.0.1/ (in OSDM-testing repo)         ← Bruno collection only
```

Plus a `.env`, a hand-edited `Dockerfile`, and `oscar-user-management.ps1`
all loose at the root of the server repo. Documentation scattered across
the project share folder, a OneDrive subtree, and assorted Word/PowerPoint
files.

### After

A single monorepo:

```
OSCAR/
├── Oscar_Server/        ← Node.js / Express runner, the API, the admin UI
│   ├── src/
│   ├── public/
│   ├── tests/
│   ├── Dockerfile
│   ├── package.json
│   └── eslint.config.js
│
├── Bruno_Collection/    ← OSDM conformance scenarios (.bru files)
│   ├── 00-Access Token/   ... 04-Exchange/
│   ├── environments/
│   ├── library-bruno/
│   ├── opencollection.yml
│   └── VERSION                          ← single line, e.g. OTST_V2.0.1
│
├── OSCAR_Deploy/        ← everything to deploy
│   ├── docker-compose.yml
│   ├── .env.example
│   └── scripts/
│       ├── refresh-collection.sh        ← invoked over SSH by CI
│       └── oscar-user-management.ps1
│
├── Documentation/
│   ├── Oscar_Server/        ← architecture, audits, internals
│   ├── Bruno_Collection/    ← scenario authoring, OSDM mapping, assertion catalog
│   └── Server_Operations/   ← installation, upgrade, security, this file
│
├── compatibility.json   ← server ↔ collection version matrix
├── CHANGELOG.md
├── README.md
└── .github/workflows/   ← CI (see § 4)
```

Decisions taken along the way:

- **Single repo, owned by UIC.** Simpler than three repos for a small team
  with one product. Easier to grant access. Atomic releases.
- **Path-scoped CI.** `Oscar_Server/**` triggers the heavy server pipeline;
  `Bruno_Collection/**` triggers a lightweight collection check.
  Documentation-only PRs run nothing.
- **Collection bind-mounted, not baked into the image.** Lets us refresh
  scenarios without rebuilding or restarting OSCAR.
- **Versioning per subsystem + a central matrix** — see § 3.

### Migration of an existing VPS install

The existing `/opt/OSCAR-OSdm-Compliance-Automation-Runner/` install was
migrated to the new layout in place. The SQLite DB, datafiles and
artifacts directory were copied across; the env file (`oscar-server.env`)
was renamed to `OSCAR_Deploy/.env` with no value changes; `git remote
set-url` repointed at the monorepo. No data loss, no schema migration
needed (same server version).

---

## 2. Docker image — multi-stage build, Bruno CLI inside

### Why a multi-stage build

`node:22-slim` ships with an `npm` that vendors a vulnerable `picomatch`
(CVE-2026-33671, ReDoS, HIGH). OSCAR never invokes `npm` at runtime, so
the cleanest fix was to remove npm from the runtime image entirely.

### How the Dockerfile is structured

```
FROM node:22-slim AS builder           # has python3 / make / g++ for bcrypt
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev                  # produces /app/node_modules


FROM node:22-slim                      # runtime stage
WORKDIR /app

RUN npm install -g @usebruno/cli && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/{npm,npx,corepack} \
           /root/.npm

COPY --from=builder /app/node_modules ./node_modules
COPY src/ src/
COPY public/ public/
COPY package.json ./

RUN mkdir -p data/artifacts data/datafiles
RUN chown -R node:node /app
USER node
EXPOSE 3001
CMD ["node", "src/server.js"]
```

Two non-obvious design choices:

- **Bruno CLI is installed *in the runtime stage*, not copied from the
  builder.** A previous attempt with `COPY --from=builder /usr/local/bin/bru
  /usr/local/bin/bru` resolved the symlink and copied only the shim, breaking
  its `require('../src')` line. Installing in place preserves the symlink +
  the full `@usebruno/cli` tree, then npm gets removed in the same `RUN` for
  the CVE remediation.
- **`package.json` is COPYed into runtime.** `src/api/openapi.js` reads it
  for the Swagger version field. Without this line the container crashes
  on boot with `MODULE_NOT_FOUND`.

### What's in the image vs. what's mounted

| Lives in the image                | Lives on the host (bind-mount)        |
| --------------------------------- | ------------------------------------- |
| Server source (`src/`, `public/`) | SQLite DB + artifacts (`./data/`)     |
| Server `node_modules/`            | Bruno collection (`../Bruno_Collection`) |
| Bruno CLI (`/usr/local/bin/bru`)  | `compatibility.json`                  |
| `package.json`                    |                                       |

Result: image is ~250 MB, no npm CLI, runs as the unprivileged `node`
user (UID 1000), Trivy clean for HIGH+CRITICAL OS/library CVEs.

---

## 3. Versioning

Three orthogonal version strings are kept in lock-step via one matrix file.

### Sources of truth

| Layer            | File                                  | Format         | Example          |
| ---------------- | ------------------------------------- | -------------- | ---------------- |
| Server           | `Oscar_Server/package.json` `version` | semver         | `1.2.0`          |
| Collection       | `Bruno_Collection/VERSION`            | single line    | `OTST_V2.0.1`    |
| Combined release | `compatibility.json` `current_release`| `YYYY.MM`      | `2026.07`        |

### `compatibility.json`

A monorepo-level manifest listing tested-together combinations:

```json
{
  "current_release": "2026.07",
  "releases": [
    {
      "release": "2026.07",
      "date": "2026-05-01",
      "server": "1.2.0",
      "collection": "OTST_V2.0.1",
      "min_collection": "OTST_V2.0.0",
      "max_collection": "OTST_V2.0.x",
      "notes": ["..."]
    }
  ]
}
```

The server reads this at startup via `src/utils/versionInfo.js`, then
exposes a single `compatibility_status` flag through `/health`:

| Value                  | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `tested`               | Running combination matches a row in the matrix                |
| `untested_combination` | Server / collection versions are not in any row                |
| `matrix_missing`       | `compatibility.json` not loaded (file path issue)              |
| `unknown`              | Fetch failed (e.g. server unreachable from the chip's fetch)   |

A warning is logged once at boot if the combination is not `tested`. It
does **not** block startup — operators can run unsupported combinations
intentionally.

### Git tags

Three tag prefixes, all annotated (carry messages, become Releases on GitHub):

| Tag pattern              | Cut by         | Effect                                                |
| ------------------------ | -------------- | ----------------------------------------------------- |
| `server-vX.Y.Z`          | maintainer     | Marks an immutable server source revision; CI tags the image as `:server-vX.Y.Z` |
| `collection-OTST_VX.Y.Z` | maintainer     | Marks an immutable collection snapshot                |
| `release-YYYY.MM`        | maintainer     | The deployer-facing tag. Triggers `:stable` promotion → Watchtower rolls production. |

Initial tags applied during the transformation:

- `server-v1.2.0`
- `collection-OTST_V2.0.1`
- `release-2026.04` (initial release)
- `release-2026.05` / `release-2026.06` (pipeline tests, identical digests)
- `release-2026.07` (smoke-test that successfully proved the rollover path)

---

## 4. CI/CD pipeline

Five GitHub Actions workflows, each path-scoped so unrelated changes don't
trigger them.

### `.github/workflows/ci-server.yml`

Trigger: PRs and pushes touching `Oscar_Server/**`, `OSCAR_Deploy/**`,
`compatibility.json`, or this workflow.

Steps:

1. ESLint
2. `npm audit --omit=dev --audit-level=high`
3. Jest with coverage gate (`lines:50, branches:42`)
4. `docker build` (no push) for verification
5. Trivy vulnerability scan (HIGH + CRITICAL, OS + library)

Coverage thresholds were lowered from the original `60/50` to `50/42`
during the migration (the canonical worktree had 11 test files that the
local copy didn't, so a fresh sync from `main` was needed to get all 16
test files back).

### `.github/workflows/ci-collection.yml`

Trigger: PRs and pushes touching `Bruno_Collection/**`.

Steps:

1. Install `@usebruno/cli`
2. Sanity-check `Bruno_Collection/VERSION` is non-empty
3. Sanity-check `opencollection.yml` is valid YAML
4. Lint every `.bru` file for the required `meta {` block

Fast (~30 s). Refuses to merge a PR that drops or empties `VERSION`.

### `.github/workflows/publish-image.yml`

Trigger: push to `main` touching `Oscar_Server/**` or
`compatibility.json`, **or** a `server-v*` Git tag push.

Output: image at `ghcr.io/top-phe/oscar-server` with these tags:

| Tag           | Always pushed?  | Purpose                                  |
| ------------- | --------------- | ---------------------------------------- |
| `:edge`       | yes             | Tracks latest `main`. Use for staging.   |
| `:sha-XXXXX`  | yes (immutable) | Per-commit, useful for rollback          |
| `:server-vX.Y.Z` | only on tag pushes | Immutable per server release         |

Production is unaffected by this workflow — `:stable` is owned by
`promote-release.yml`.

### `.github/workflows/promote-release.yml`

Trigger: push of any `release-*` Git tag (or manual `workflow_dispatch`
with the tag name as input).

Action: re-builds the image *at the release tag's source*, pushes it as
`:stable` and `:release-YYYY.MM`. This is the **only** workflow that
touches `:stable`.

### `.github/workflows/refresh-collection.yml`

Trigger: push to `main` touching only `Bruno_Collection/**`.

Action:
1. Loads `SSH_DEPLOY_KEY` and `SSH_KNOWN_HOSTS` secrets
2. SSHes as `ubuntu@oscar.uic.org` and invokes
   `/opt/OSCAR/OSCAR_Deploy/scripts/refresh-collection.sh`

The script does a `git pull --ff-only`, refuses if the working tree is
dirty, logs every transition to `journalctl -t oscar-deploy`. Server is
**not** restarted — the bind-mount makes new `.bru` files visible to the
running container immediately.

### Per-tag matrix at a glance

| Action                               | What runs                              | Production effect              |
| ------------------------------------ | -------------------------------------- | ------------------------------ |
| Push to `main` (server change)       | ci-server, publish-image (`:edge`)     | None                           |
| Push to `main` (collection change)   | ci-collection, refresh-collection      | New `.bru` files live in seconds |
| Push to `main` (doc change)          | nothing                                | None                           |
| Push tag `server-vX.Y.Z`             | publish-image (`:server-vX.Y.Z`)       | None                           |
| Push tag `collection-OTST_VX.Y.Z`    | nothing (tag is informational)         | None                           |
| Push tag `release-YYYY.MM`           | promote-release (`:stable`, `:release-YYYY.MM`) | Watchtower rolls within 5 min |

---

## 5. Production VPS — Watchtower auto-rollover

### Server stack

`OSCAR_Deploy/docker-compose.yml` defines two containers:

```
oscar       (image: ghcr.io/top-phe/oscar-server:stable)
              labelled: com.centurylinklabs.watchtower.enable=true
              ports: 127.0.0.1:3001:3001
              volumes:
                ./data            → /app/data
                ../Bruno_Collection → /collection (ro)
                ../compatibility.json → /app/compatibility.json (ro)

watchtower  (image: nickfedor/watchtower:latest)
              volumes:
                /var/run/docker.sock                  → /var/run/docker.sock
                /home/ubuntu/.docker/config.json      → /config.json (ro)
              env:
                WATCHTOWER_LABEL_ENABLE=true
                WATCHTOWER_CLEANUP=true
                WATCHTOWER_POLL_INTERVAL=300         (5 minutes)
```

### Why nickfedor/watchtower

The original `containrrr/watchtower` is effectively unmaintained and
ships with a Docker SDK that requests API v1.25. Docker Engine 25+
enforces a minimum API version of 1.40 and refuses every request,
putting Watchtower in an endless retry loop. `nickfedor/watchtower` is
the actively-maintained drop-in fork using a current SDK (negotiates
v1.51 on Docker 28+).

### How a release rolls

```
maintainer pushes release-YYYY.MM tag
   ↓
GitHub Actions: promote-release.yml
   ↓ build & push
ghcr.io/top-phe/oscar-server:stable     (new digest)
   ↓ within ≤ 5 min
VPS Watchtower notices the digest change
   ↓
Stops oscar container, recreates it from the new image,
re-applying volumes + labels + env. SQLite DB and artifacts persist
because they live in the bind-mounted ./data folder.
   ↓
docker compose logs oscar → boot sequence with new release
```

Throughout this, the Bruno collection bind-mount and
`compatibility.json` bind-mount are unchanged, so the recreated
container reads the latest collection and matrix automatically.

### How a collection-only refresh works

```
maintainer commits .bru changes to main
   ↓
GitHub Actions: refresh-collection.yml
   ↓ ssh -i ~SSH_DEPLOY_KEY ubuntu@oscar.uic.org
   ↓ command="…/refresh-collection.sh" forces invocation of just the script
ssh-server runs refresh-collection.sh
   ↓ git pull --ff-only origin main
new .bru files now sit in /opt/OSCAR/Bruno_Collection/
   ↓ bind-mount makes them visible at /collection inside the container
The next Bruno run picks them up. No restart needed.
```

### SSH security model

The deploy key is **pinned to the refresh script** in
`~ubuntu/.ssh/authorized_keys`:

```
command="/opt/OSCAR/OSCAR_Deploy/scripts/refresh-collection.sh",
  no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding
ssh-ed25519 AAAA... github-actions-deploy
```

If the private key leaks (it lives only in GitHub Actions secrets,
encrypted at rest, never logged), the worst case is someone forces a
git-pull on the VPS — they cannot get a shell, cannot port-forward,
cannot transfer files.

The `refresh-collection.sh` script itself further refuses to run when
the working tree is dirty (avoids silently overwriting manual edits)
and logs every transition to `journalctl -t oscar-deploy`.

### GHCR pull credentials on the VPS

Watchtower pulls private images from GHCR using the credential file at
`/home/ubuntu/.docker/config.json`, written once with:

```bash
docker login ghcr.io -u TOP-PHE --password-stdin   # paste classic PAT with read:packages
chmod 600 ~/.docker/config.json
```

Token rotation: re-run the same command with a new PAT; Watchtower picks
up the new credentials on its next 5-minute poll cycle.

---

## 6. UI version chip

A small monospace chip rendered between the OSCAR brand and the menu in
the top banner of every authenticated page. Reads `/health`, caches the
result in `localStorage` for 5 minutes, refreshes in the background.

```
[OSCAR] ●  release-2026.07 · 1.2.0 / OTST_V2.0.1   |   Home   |   Dashboard   ...
```

Color coding by `compatibility_status`:

| Color  | Status                  |
| ------ | ----------------------- |
| 🟢 green | `tested`                |
| 🟡 amber | `untested_combination`  |
| 🔴 red   | `matrix_missing`        |
| ⚪ gray  | `unknown`               |

Hover tooltip expands to a multi-line summary — full versions and a plain-English explanation of the status colour.

Cache is cleared on logout so a re-login after a server upgrade picks
up the new versions immediately rather than flashing the old ones.

---

## 7. Daily life — the new shipping recipes

### Server change you want in production

```bash
# 1. make the change locally
git commit -am "feat: …"
git push origin main
# → publish-image.yml builds :edge, production unchanged

# 2. when ready to ship, bump versions
#    edit Oscar_Server/package.json   "version": "1.3.0"
#    edit compatibility.json          add row, set current_release
git commit -am "release: server v1.3.0 / collection OTST_V2.0.1 → 2026.08"
git push origin main

# 3. tag and push
git tag server-v1.3.0
git tag release-2026.08
git push origin server-v1.3.0 release-2026.08
# → promote-release.yml builds :stable
# → Watchtower picks it up within 5 min
# → production rolls; UI chip updates
```

### Collection change you want in production

```bash
git commit -am "fix: scenario OTST_BKG_REFUND_PARTIAL — clarify currency assertion"
git push origin main
# → refresh-collection.yml SSHes in, git pulls
# → next Bruno run uses the updated .bru
```

### Compatibility-only change

`compatibility.json`-only commits don't trigger the refresh workflow
(its path filter is `Bruno_Collection/**` only — by design, to keep
auto-refresh narrowly scoped). For a compat-only change, either:

- pair it with a real source change (recommended — that's what releases
  look like in practice anyway), or
- manually `docker compose restart oscar` on the VPS to re-read the file.

### Rolling back production

On the VPS, edit `OSCAR_Deploy/docker-compose.yml`:

```yaml
image: ghcr.io/top-phe/oscar-server:server-v1.2.0   # pin to a previous immutable tag
```

then `docker compose up -d`. To re-enable auto-update, restore
`:stable` in the compose file.

You can also temporarily disable Watchtower while you investigate:

```bash
docker compose stop watchtower
```

### Audit trail

| Event                 | Where to look                                  |
| --------------------- | ---------------------------------------------- |
| Image build / promote | https://github.com/TOP-PHE/UIC_OSCAR_Temporary/actions |
| Image versions        | https://github.com/TOP-PHE?tab=packages → `oscar-server` |
| Collection refreshes  | `journalctl -t oscar-deploy` on the VPS        |
| Watchtower scans      | `docker compose logs watchtower` on the VPS    |
| Server runtime info   | `https://oscar.uic.org/health` (server / collection / release / status) |

---

## 8. Known gotchas captured during the work

These are real things that tripped us up during the two-day implementation
and are worth knowing about so they don't bite again.

| Symptom                                                | Cause                                                                                       | Fix                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Container crashes on boot with `Cannot find module '../../package.json'` | Multi-stage Dockerfile didn't COPY package.json into the runtime stage                      | Add `COPY package.json ./` after `COPY public/ public/`                                    |
| `bru` invocation fails with `Cannot find module '../src'` | `COPY --from=builder /usr/local/bin/bru` resolved the symlink and copied only the JS shim   | Install Bruno CLI in the runtime stage instead of copying it across                       |
| Watchtower error loop `client version 1.25 is too old` | `containrrr/watchtower` ships with old Docker SDK, Docker 25+ refuses                       | Switch to `nickfedor/watchtower:latest`                                                   |
| `git pull` "dubious ownership in repository at /opt/OSCAR" | Repo cloned with `sudo`, then read as `ubuntu`                                              | `sudo chown -R ubuntu:ubuntu /opt/OSCAR`                                                  |
| `refresh-collection.sh` always says "working tree is dirty" with 0-byte diff | Script committed without exec bit; `chmod +x` on Linux shows as a mode change in git        | `git update-index --chmod=+x` and recommit                                                 |
| HEAD detached after `git checkout release-2026.04`     | Tags don't carry branch refs                                                                | `git checkout main` then `git pull origin main`                                            |
| `docker compose logs --tail=5 oscar` shows old release after restart | The 5 lines are from a *previous* startup that's still in the rolling window                | Use `--since=1m` or do a fresh `docker compose down && up`                                |
| Browser shows old version chip after rollover          | `localStorage.oscar_version_info` cached for 5 min                                          | Hard-refresh + clear via DevTools console                                                  |
| `release-2026.05` and `:06` had identical digest       | Source unchanged between the tags                                                           | Expected behaviour — Watchtower correctly does nothing if the digest hasn't moved          |
| `git push` returns 403 with stale Windows Credential Manager entry | An old GitHub OAuth token without `repo` scope is being offered                             | Use `gh auth login` with a fresh PAT — gh's cred takes precedence                          |
| `ssh-keyscan -t ed25519 oscar.uic.org` fails with "unsupported KEX method" | Old Windows OpenSSH client + new Ubuntu server                                              | Use `Select-String -Path ~\.ssh\known_hosts -Pattern oscar.uic.org` instead                |
| `docker pull` "permission denied while trying to connect to the docker API" | `ubuntu` not in `docker` group                                                              | `sudo usermod -aG docker ubuntu` then `newgrp docker` (or relog)                          |
| Fine-grained PAT can't push to GHCR (`docker login` fails) | Fine-grained PATs don't fully support packages yet                                          | Use a classic PAT with `read:packages` scope                                              |

---

## 9. Inventory of artifacts created or modified

For someone reading the repo cold, here's what was added or substantially
changed during the transformation. Skip if you're just deploying.

### New files

```
OSCAR/
├── compatibility.json
├── README.md                               (rewritten)
├── .gitignore                              (root)
│
├── Bruno_Collection/VERSION
│
├── Oscar_Server/src/utils/versionInfo.js
│
├── OSCAR_Deploy/
│   ├── docker-compose.yml                  (rewritten with image:, watchtower)
│   ├── .env.example                        (rewritten with sections)
│   └── scripts/
│       └── refresh-collection.sh
│
├── .github/workflows/
│   ├── ci-server.yml                       (rewritten for monorepo paths)
│   ├── ci-collection.yml                   (new)
│   ├── publish-image.yml                   (new)
│   ├── promote-release.yml                 (new)
│   └── refresh-collection.yml              (new)
│
└── Documentation/Server_Operations/
    ├── installation-guide.md               (new — supersedes the legacy single-folder guide)
    ├── auto-deploy-setup.md                (new — VPS-side setup for the GHCR + SSH wiring)
    └── monorepo-and-autodeploy-transformation.md   (this file)
```

### Modified files in `Oscar_Server/`

- `Dockerfile` — multi-stage rewrite
- `src/server.js` — version chip wiring (`require('./utils/versionInfo')`,
  enriched `/health` payload)
- `public/nav.js` — top banner version chip with localStorage cache
- (then a full sync from `main` brought in 11 missing test files and ~12
  drifted source files)

### Git tags created

`server-v1.2.0`, `collection-OTST_V2.0.1`, `release-2026.04`,
`release-2026.05`, `release-2026.06`, `release-2026.07`.

---

## 10. Open items for whoever picks this up

- **Transfer `TOP-PHE/UIC_OSCAR_Temporary` to `UICrail/OSCAR`** when ready.
  Tags, history, issues all carry over. Re-add Actions secrets
  (`SSH_DEPLOY_KEY`, `SSH_KNOWN_HOSTS`, plus GHCR pull token if you want CI
  to pull) — those don't transfer. Update the `image:` line in
  `docker-compose.yml` to point at `ghcr.io/uicrail/oscar-server:stable`.
- **Rotate any PATs** that were pasted in chat / on screen during the
  setup work. The VPS currently uses a `read:packages` classic PAT — replace
  with a fresh one and `docker login ghcr.io --password-stdin`.
- **Optional: extend `refresh-collection.yml`** path filter to include
  `compatibility.json` if you want compat-only commits to also auto-pull.
  Would also need to add a `docker compose restart oscar` to the script.
- **Optional: add notification channels to Watchtower** (Slack / email)
  via `WATCHTOWER_NOTIFICATIONS` so production rollovers ping somewhere
  visible.
- **Optional: lock down the GHCR pull token to a specific package** once
  GitHub finalises fine-grained PAT support for packages — currently we
  use a classic PAT.
- **Optional: ratchet up Jest coverage thresholds** in 5pp steps as new
  tests land for `runner.js` / `queue.js` (currently the worker is the
  big coverage gap, ~5%).
