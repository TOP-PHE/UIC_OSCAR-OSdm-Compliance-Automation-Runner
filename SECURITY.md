<!--
Copyright [2026] [International Union of Railways (UIC)]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
       http://www.apache.org/licenses/LICENSE-2.0
-->

# Security Policy

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Use GitHub's private Security Advisories:

1. Go to **Security → Advisories** on this repository, or directly to:
   https://github.com/TOP-PHE/UIC_OSCAR_Temporary/security/advisories/new
2. Click **"Report a vulnerability"**
3. Fill in the form. The maintainers receive a private notification — no
   one outside the named recipients can see the report until you and the
   maintainers jointly decide to publish it.

Alternatively, email `security@uic.org` with the subject
`[OSCAR] Security disclosure`. Please encrypt sensitive details with the
team's PGP key (fingerprint published at https://uic.org/security).

## What to include in a report

- A clear description of the issue and its impact
- Steps to reproduce (the minimum payload / sequence that triggers it)
- The version you tested against — `release_label`, `server_version`, and
  `collection_version` from `/health`
- Whether the issue is exploitable from outside the network or requires
  authentication
- Any proof-of-concept code (please do not include real production
  credentials, even your own)

## Response targets

We aim to:

| Step | Target |
|---|---|
| Acknowledge receipt of the report | Within 3 working days |
| Initial severity triage | Within 10 working days |
| Fix released for **CRITICAL** issues (CVSS ≥ 9.0) | Within 14 days |
| Fix released for **HIGH** issues (CVSS 7.0 – 8.9) | Within 30 days |
| Fix released for **MEDIUM / LOW** issues | Bundled into the next minor release |
| Public disclosure (CVE assignment + advisory publication) | Coordinated with the reporter, normally within 90 days |

These targets are aspirational, not contractual. We will keep you
informed if a fix is going to take longer than the target window.

## Supported versions

Only the most recent **combined release tag** (`release-YYYY.MM`) is
supported with security updates. Older releases may still work but will
not receive security patches.

The current supported release is documented in:
- `/health` `release_label` on a running instance
- `compatibility.json` `current_release` at the repository root

If you are running an older release, please upgrade before requesting
support — see
[`Documentation/Server_Operations/installation-guide.md`](./Documentation/Server_Operations/installation-guide.md)
section "Upgrade procedure".

## Scope

The following components are **in scope** for security reports:

- The `Oscar_Server` Node.js application (REST API, auth, admin UI)
- The deployment manifests in `OSCAR_Deploy/`
- The CI / CD workflows in `.github/workflows/`
- The Docker image published to GHCR (`ghcr.io/top-phe/oscar-server`)

The following are **out of scope**:

- The Bruno conformance scenarios (`Bruno_Collection/`) — these are
  intentionally observable test inputs, not a privileged surface
- The `Documentation/` content — please open a normal issue for
  inaccuracies
- Third-party dependencies — please report directly to the upstream
  project. We will track and roll out their fixes via the Dependabot
  pipeline.
- DDoS / volumetric attacks against your own deployment — operator
  responsibility, not a defect in OSCAR

## Hall of fame

Security researchers who responsibly disclose issues will be credited
in the corresponding release notes (with their permission), and listed
here once a fix has shipped.

_(No reports yet — be the first.)_

## What this policy does NOT cover

- Operational security of your own VPS — locking down SSH, firewall
  rules, OS patches, and TLS certificates is the operator's
  responsibility. See `Documentation/Server_Operations/` for
  recommended hardening.
- Misconfiguration — e.g. running with `JWT_SECRET` blank, or exposing
  port 3001 directly without a reverse proxy. The installation guide
  covers the secure-by-default deployment path.
- Findings that require physical access to the VPS, root credentials,
  or pre-existing administrative access on the OSCAR instance.
