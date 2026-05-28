# vanilla-jsoneditor — vendored third-party asset

| | |
|---|---|
| Package    | [`vanilla-jsoneditor`](https://github.com/josdejong/svelte-jsoneditor) |
| Version    | **3.12.0** |
| License    | **ISC** |
| Upstream   | https://github.com/josdejong/svelte-jsoneditor |
| Vendored as | `standalone.js` (the upstream standalone ES bundle, fetched from `https://cdn.jsdelivr.net/npm/vanilla-jsoneditor@3.12.0/standalone.js`) |
| Used by    | `Oscar_Server/public/run-detail.html` — lazy-imported when a tester clicks the **Tree** toggle on a request/response body in the HTTP Traffic panel (#287). |

## Why vendored (not an npm dependency)

This OSCAR change only needs the standalone front-end bundle — the Node/back-end
tree never imports it. Adding it to `Oscar_Server/package.json` would force a
re-resolve of `package-lock.json` for a purely client-side asset. Vendoring the
single self-contained file:

- Keeps `package-lock.json` untouched (no surprise lock churn).
- Keeps CSP simple: served from `'self'` via the existing `express.static(PUBLIC_DIR)`.
- Pins the exact version that was reviewed.

## Upgrade procedure

1. Download the new bundle:
   `https://cdn.jsdelivr.net/npm/vanilla-jsoneditor@<new-version>/standalone.js`
2. Replace `standalone.js` in this directory.
3. Update the version line at the top of this file.
4. Smoke-test the **Tree** toggle in `run-detail.html` on a JSON body.

## Upstream license (ISC)

```
ISC License

Copyright (c) 2016-2026 by Jos de Jong

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
