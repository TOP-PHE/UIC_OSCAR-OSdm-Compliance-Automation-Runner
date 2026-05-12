# Contributing to OSCAR

Thanks for your interest in OSCAR. Everything below assumes you have a
free GitHub account and want to file an issue, propose a fix, or
contribute a feature.

## Filing an issue

Any GitHub user can file an issue. Pick the template that matches:

- 🐛 **Bug report** — something that worked before / should work, doesn't
- 💡 **Feature request** — a new capability or improvement
- 🧪 **Conformance scenario** — a new OSDM check or a fix to an existing
  Bruno scenario
- ❓ **Question** — for anything that isn't quite a bug or feature

Apply at least one label so the right person picks it up:

| Concern | Label |
|---|---|
| Server runtime, REST API, admin UI | `server` |
| Bruno collection (`.bru` files, new scenarios) | `collection` |
| Docker, CI, Watchtower, deploy automation | `deploy` |
| Documentation only | `docs` |

For **security vulnerabilities**, please don't open a public issue —
follow [SECURITY.md](SECURITY.md).

## Proposing a change

1. **Fork** the repository under your own GitHub account
2. **Branch** from `main`: `git checkout -b feat/short-description`
3. **Commit** small, focused changes with messages that explain *why*
   (the *what* is in the diff)
4. **Push** and open a pull request against `main`

The CI pipeline runs automatically on every PR:

- ESLint + Jest unit + integration tests
- CodeQL static analysis
- SonarCloud quality gate
- Gitleaks secret-scanning
- Bruno collection validation
- Docker image build (also Trivy-scanned)
- Coverage threshold (lines ≥ 50 %, branches ≥ 42 %)

All seven must be green before merge. A maintainer will review once CI
passes. Auto-merge is available — set it once and the merge fires the
moment requirements are met.

## Running the server locally

```bash
git clone https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner.git OSCAR
cd OSCAR/Oscar_Server
npm ci
cp .env.example .env   # then fill in the placeholders
npm run dev            # node --watch src/server.js
```

The dev server listens on `http://localhost:3001`. Open the same URL in a
browser to reach the admin UI.

## Running the tests

```bash
cd Oscar_Server
npm test                          # full suite
npm test -- --coverage            # with coverage report
npm test -- tests/unit/foo.test.js  # one file
```

## Coding conventions

- **Language**: JavaScript (Node 22+). Files use CommonJS `require`.
- **Style**: enforced by ESLint (`npm run lint`). LF line endings (see
  `.gitattributes`).
- **Comments**: prose-style, explain *why* (the code shows *what*).
  Architecture decisions worth preserving go into the file's top comment.
- **Tests**: unit tests under `tests/unit/`, integration under
  `tests/integration/`. New modules need at least the happy path covered.

## Release process

OSCAR ships independently versioned subsystems with a central compatibility
matrix. Maintainers tag releases:

- `server-vX.Y.Z` — server-only (triggers Docker image rebuild + `:stable`
  promotion + Watchtower roll-out on the canonical deployment)
- `collection-v...` — Bruno collection change (no image rebuild)
- `release-YYYY.MM` — combined known-good combination

The auto-tag workflow detects version bumps in `Oscar_Server/package.json`
or in `compatibility.json` and creates the matching Git tag automatically.
Contributors don't need to tag anything manually.

## Questions

Open a `question`-labelled issue or ping the maintainers in the discussion
that triggered your contribution. We try to respond within a few business
days.
