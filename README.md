# OSCAR — OSDM Conformance Automation Runner

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Image: GHCR](https://img.shields.io/badge/image-ghcr.io%2Ftop--phe%2Foscar--server%3Astable-0090D4)](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/pkgs/container/oscar-server)
[![Release](https://img.shields.io/github/v/tag/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner?label=release&sort=semver)](CHANGELOG.md)

**OSCAR** is the UIC platform for automated conformance testing of OSDM API
implementations. It runs a curated catalogue of [Bruno](https://www.usebruno.com/)
scenarios against a candidate API and produces structured certification
reports — without requiring testers to install a local toolchain.

> 🚀 **Just want to run OSCAR on your own VPS?**
> Follow [**OSCAR — Self-Hosted Quick Start**](Documentation/Server_Operations/OSCAR%20-%20Self-Hosted%20Quick%20Start.md)
> ([PDF](Documentation/Server_Operations/OSCAR%20-%20Self-Hosted%20Quick%20Start.pdf)).
> Takes about 15 minutes; uses the prebuilt public Docker image; no source
> compilation needed.

---

## What's in this monorepo

| Folder | Owns |
|---|---|
| [`Oscar_Server/`](Oscar_Server/) | Node.js + Express server, REST API, admin web UI, Bruno CLI integration |
| [`Bruno_Collection/`](Bruno_Collection/) | OSDM conformance scenarios (`.bru` files) |
| [`OSCAR_Deploy/`](OSCAR_Deploy/) | Docker Compose stack, nginx snippets, alerting + observability overlay |
| [`OSDM_Simulator/`](OSDM_Simulator/) | A stub OSDM provider for testing OSCAR itself: issues the token, answers a basic sale flow, simulates several providers |
| [`Documentation/`](Documentation/) | Architecture, specification, admin and operations guides |
| [`compatibility.json`](compatibility.json) | Tested-together server ↔ collection version matrix |
| [`CHANGELOG.md`](CHANGELOG.md) | Combined release history |

The deployed runtime is a single container (`ghcr.io/top-phe/oscar-server:stable`)
plus its sidecars: Watchtower auto-updates, autoheal restarts on
healthcheck failure, and an opt-in metrics overlay (Prometheus + Grafana +
Loki + Alertmanager) for production-grade observability.

---

## Documentation map

### For operators deploying their own OSCAR

- 🆕 **[Self-Hosted Quick Start](Documentation/Server_Operations/OSCAR%20-%20Self-Hosted%20Quick%20Start.md)** — recommended path, ~15 min, Docker-based
- [Server Admin Guide](Documentation/Server_Operations/OSCAR%20-%20Server%20Admin%20Guide.md) — day-2 operations, Server Config UI, observability + alerting
- [Metrics & Monitoring](Documentation/Server_Operations/metrics-and-monitoring.md) — Prometheus / Grafana / Loki stack
- [OSDM Simulator](Documentation/Server_Operations/OSCAR%20-%20OSDM%20Simulator.md) — a stub provider on a host of its own, and how to point a company at it
- [Auto-Deploy Setup](Documentation/Server_Operations/auto-deploy-setup.md) — Watchtower + CI image promotion
- [VPS Deployment Guide](Documentation/Server_Operations/OSCAR%20-%20VPS%20Deployment%20Guide.md) — legacy non-Docker manual install

### For understanding the platform

- [Solution Architecture](Documentation/Oscar_Server/OSCAR%20-%20OSDM%20Conformance%20Automation%20Runner%20Solution%20Architecture.md)
- [Specification](Documentation/Oscar_Server/OSCAR%20-%20OSDM%20Conformance%20Automation%20Runner%20Specification.md)
- [Security model + audits](Documentation/Server_Operations/SECURITY_FIXES.md)

### For maintainers and contributors

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to file issues, propose changes, run the test suite
- [SECURITY.md](SECURITY.md) — how to report a vulnerability privately

---

## Versioning

Three Git-tag kinds, separately versioned per subsystem with a central compatibility manifest:

| Tag | Triggers | Used by |
|---|---|---|
| `server-vX.Y.Z` | Server-only release — rebuilds the Docker image | Watchtower auto-promotes `:stable` |
| `collection-v<...>` | Bruno collection change — no image rebuild | Picked up live via the read-only volume mount |
| `release-YYYY.MM` | Combined release — known-good server + collection combo | Recommended pin point for production |

At startup, OSCAR logs a warning if the running combination isn't listed in
[`compatibility.json`](compatibility.json). It never blocks — operators can
always run unsupported combinations at their own risk.

---

## Reporting issues and contributing

The repository accepts community input. Anyone with a free GitHub account
can file an issue or open a pull request:

- 🐛 **[Open an issue](../../issues/new/choose)** — bug, feature request, or operational question
- 🔒 **Security concerns** — see [SECURITY.md](SECURITY.md); please don't file public issues for vulnerabilities
- 🛠️ **Contributing code** — see [CONTRIBUTING.md](CONTRIBUTING.md)

---

## License

Apache License 2.0 — see [LICENSE](LICENSE). The names *OSCAR* and *OSDM*
remain with their respective owners (UIC, the OSDM working group); use them
in good faith and only to refer to this project.
