# OSCAR — OSDM Conformance Automation Runner

OSCAR is the official UIC tool for automated conformance testing of OSDM API
implementations. It executes a curated catalog of Bruno-based scenarios
against a candidate API and produces structured reports for certification.

This repository is a **monorepo** owned by UIC, containing all components
needed to deploy and operate the platform.

---

## Repository layout

```
OSCAR/
├── Oscar_Server/        ← Node.js/Express runner + REST API + admin UI
├── Bruno_Collection/    ← OSDM conformance scenarios (.bru files)
├── OSCAR_Deploy/        ← Docker Compose, env template, ops scripts
├── Documentation/
│   ├── Oscar_Server/        ← architecture, internals, audits, visual identity
│   ├── Bruno_Collection/    ← scenario authoring, OSDM mapping, assertion catalog
│   └── Server_Operations/   ← installation, upgrade, backup, security guides
├── compatibility.json   ← tested-together server ↔ collection version matrix
├── CHANGELOG.md         ← combined release history
├── LICENSE
└── README.md            ← (this file)
```

| Subsystem            | Owner role        | Versioning                       |
| -------------------- | ----------------- | -------------------------------- |
| `Oscar_Server/`      | OSCAR dev team    | semver in `package.json`         |
| `Bruno_Collection/`  | OSDM spec team    | release tag (e.g. `OTST_V2.0.1`) |
| `OSCAR_Deploy/`      | Ops / deployers   | follows monorepo release         |
| Combined release     | UIC               | `release-YYYY.MM` Git tag        |

---

## Quick start (deploy)

```bash
git clone https://github.com/UIC/OSCAR.git
cd OSCAR/OSCAR_Deploy
cp .env.example .env
# Fill in ENCRYPTION_KEY, PLATFORM_BOOTSTRAP_TOKEN, JWT_SECRET in .env
sudo docker compose up -d --build
```

Create the first platform admin once the server is up:

```bash
curl -X POST http://localhost:3001/v1/auth/bootstrap/platform-user \
  -H "Content-Type: application/json" \
  -H "X-Platform-Bootstrap-Token: <PLATFORM_BOOTSTRAP_TOKEN>" \
  -d '{"email":"admin@example.org","password":"<strong-password>"}'
```

For full installation and HTTPS / nginx setup, see
[Documentation/Server_Operations/OSCAR - VPS Deployment Guide.md](./Documentation/Server_Operations/OSCAR%20-%20VPS%20Deployment%20Guide.md).

---

## For developers

- Server architecture & internals → [Documentation/Oscar_Server/](./Documentation/Oscar_Server/)
- Adding a new conformance scenario → [Documentation/Bruno_Collection/](./Documentation/Bruno_Collection/)

Local dev (server only):

```bash
cd Oscar_Server
npm ci
cp ../OSCAR_Deploy/.env.example .env   # edit values
npm run dev
```

---

## Versioning & compatibility

OSCAR uses **independent versioning per subsystem** with a central
[`compatibility.json`](./compatibility.json) manifest that records which
server versions have been tested with which collection versions.

Three kinds of Git tags:

- `server-v<X.Y.Z>` — server-only release (Docker image rebuilt).
- `collection-v<...>` — collection-only release (no rebuild needed; OSCAR
  picks up new `.bru` files via the read-only volume mount on next run).
- `release-YYYY.MM` — combined release; this is the tag deployers should
  check out for a known-good combination.

At startup the server logs a warning if the running combination is not in
`compatibility.json`. It does **not** block — operators can always run
unsupported combinations at their own risk.

---

## Reporting issues

- Server bugs / feature requests → issue with `server` label
- Conformance scenario issues → issue with `collection` label
- Deployment / ops problems → issue with `deploy` label

---

## License

See [LICENSE](./LICENSE).
