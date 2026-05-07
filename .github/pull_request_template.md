<!--
Copyright [2026] [International Union of Railways (UIC)]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
       http://www.apache.org/licenses/LICENSE-2.0
-->

## Summary

<!-- 1–2 sentences. What does this PR do, and why? -->


## Type of change

<!-- Tick the one that fits best. Multiple may apply only if a single PR
     genuinely spans them; otherwise prefer to split into separate PRs. -->

- [ ] **Server feature / fix** (`Oscar_Server/**`) — bumps `Oscar_Server/package.json` version
- [ ] **Bruno scenario change** (`Bruno_Collection/**`) — auto-deploys via refresh-collection workflow on merge
- [ ] **Deploy / CI change** (`OSCAR_Deploy/**`, `.github/**`)
- [ ] **Documentation only** (`Documentation/**`, `*.md`)
- [ ] **Compatibility matrix update** (`compatibility.json`)
- [ ] **Dependency bump** (Dependabot — should not normally need manual editing)


## Checklist

- [ ] Tests added or updated (Jest unit / integration where applicable)
- [ ] `Oscar_Server/package.json` version bumped (server feature/fix only)
- [ ] `compatibility.json` row added with the new release label (server feature/fix that ships to production)
- [ ] `CHANGELOG.md` entry under `[Unreleased]` or under the matching `release-YYYY.MM` section
- [ ] News entry added at the top of `Oscar_Server/public/news/index.json` (user-visible feature only)
- [ ] OpenAPI spec updated (`Oscar_Server/src/api/openapi.js`) for any new/changed endpoint
- [ ] Documentation updated under `Documentation/` for any operator- or user-facing change
- [ ] No secrets, tokens or `.env` values in this diff
- [ ] All required CI checks expected to pass (lint, audit, tests, docker build, Trivy, Sonar, CodeQL, Gitleaks)


## How was this tested?

<!-- Local repro / smoke test / unit tests / what you actually ran. -->


## Release plan

<!-- For server feature/fix that should reach production: -->

- [ ] After merge, tag `release-YYYY.MM` and push so `promote-release.yml` rebuilds `:stable`
- [ ] On the VPS, `git pull` + `docker compose restart oscar` if `compatibility.json` changed (bind-mount, not in image)
- [ ] Verify `/health` reports the new `release_label` and `compatibility_status: tested`
- [ ] Hard-refresh UI to update the version chip


## Linked issues / context

<!-- "Closes #123", design docs, ADRs, security advisories, etc. -->
