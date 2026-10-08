# OSCAR — VPS Deployment Guide

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC © 2026."

---

> ## ⚠️ Superseded — do not follow this guide
>
> This guide described an **older, non-production** deployment model: a manual
> `pm2` + Node.js install under `/home/oscaradmin/oscar-server`, with files
> copied over by `scp` and started with `node src/server.js`. **That is not how
> OSCAR is deployed today** and the steps below no longer match reality (they
> still reference server version `1.0.0`).
>
> The current UIC production is **Docker Compose on `/opt/OSCAR`**: the
> pre-built image `ghcr.io/top-phe/oscar-server:stable` (promoted on a
> `release-*` Git tag), the Bruno collection bind-mounted from the monorepo,
> nginx terminating TLS in front of `127.0.0.1:3001`, and Watchtower rolling the
> image forward automatically. Day-to-day you do **not** SSH in to update —
> merging a PR / pushing a release tag ships it.
>
> **Use these instead:**
> - **[OSCAR — Installation Guide](installation-guide.md)** — deploy from scratch with Docker Compose (clone, secrets, `docker compose up`, nginx + HTTPS, first admin).
> - **[OSCAR — Auto-deploy setup](auto-deploy-setup.md)** — the CI/CD rollout (image publish → `:stable` promotion → Watchtower → collection refresh).
> - **[OSCAR — Disaster Recovery](OSCAR%20-%20Disaster%20Recovery.md)** — scheduled encrypted backups and a tested restore.
> - **[Monorepo + Auto-Deploy Transformation](monorepo-and-autodeploy-transformation.md)** — background on why the repo and deployment are laid out this way.
> - Non-UIC, single-box evaluation only: **[OSCAR — Self-Hosted Quick Start](OSCAR%20-%20Self-Hosted%20Quick%20Start.md)**.
>
> The previous pm2/Node instructions remain in this file's **git history** if a
> manual self-host is ever needed; they are intentionally not reproduced here to
> avoid a second, contradictory source of truth.
