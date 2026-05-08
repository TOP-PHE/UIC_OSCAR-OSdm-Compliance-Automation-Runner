---
name: Bug report
about: Something is broken or behaves unexpectedly
title: "[bug] "
labels: bug
assignees: ''
---

<!--
Copyright [2026] [International Union of Railways (UIC)]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
       http://www.apache.org/licenses/LICENSE-2.0
-->

## Affected area

<!-- Tick the most specific one. -->

- [ ] Server (Node.js runner, REST API, admin UI)
- [ ] Bruno collection (a specific scenario or library script)
- [ ] Deployment (Docker, Watchtower, nginx, GHCR)
- [ ] Documentation
- [ ] Other / unclear

## What happened

<!-- Plain-language description. -->

## What you expected to happen

## Steps to reproduce

1. …
2. …
3. …

## Environment

- Release label (UI version chip or `/health` `release_label`):
- Server version (`/health` `server_version`):
- Collection version (`/health` `collection_version`):
- Browser (if UI bug):
- Deployment type: Docker on VPS / local dev

## Logs / screenshots

<!-- Paste container logs, browser console errors, screenshots, etc.
     Redact any secrets / company names if shared on a public issue. -->

```
<paste logs here>
```

## Severity (your view)

- [ ] Blocker — production unusable
- [ ] High — feature broken, workaround painful
- [ ] Medium — feature broken, workaround exists
- [ ] Low — cosmetic / minor
