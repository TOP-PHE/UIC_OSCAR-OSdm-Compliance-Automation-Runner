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

## Pinned versions

What the image build and CI install is fixed in the repository, so two builds
of the same commit get the same thing (#545). Dependabot proposes each update
as a pull request; the steps below are for doing it by hand.

### Bruno CLI

The version, and its whole dependency tree, are in
`Oscar_Server/bruno-cli/package.json` and `package-lock.json`. The Dockerfile
and `.github/workflows/ci-collection.yml` both install them with `npm ci`.

```bash
cd Oscar_Server/bruno-cli
npm install --ignore-scripts @usebruno/cli@<version> --save-exact
npm ls axios form-data nanoid @faker-js/faker js-yaml --all   # check the overrides still apply
```

- Keep the version exact (`--save-exact`): it is the engine of every run.
- The `overrides` in that file replace vulnerable copies Bruno bundles. Keep
  them as `^` floors, never exact versions (an exact override is a ceiling
  that silently blocks Dependabot). Remove one when Bruno ships the fixed
  version itself, and keep the Dockerfile comment that lists them in step.
- A new Bruno version changes the engine of every run: it is a server release
  (bump `Oscar_Server/package.json`, add a `compatibility.json` entry), and
  the collection should be run against it before it merges.
- Run the same version on your own machine:
  `npm install -g @usebruno/cli@<version>`, or `npm ci` in
  `Oscar_Server/bruno-cli` and point `BRU_CMD` at
  `Oscar_Server/bruno-cli/node_modules/.bin/bru` (`bru.cmd` on Windows).
  Check with `bru --version`.

### Base image

Both `FROM` lines of `Oscar_Server/Dockerfile` carry the tag and the digest
(`node:22-slim@sha256:…`). Docker uses the digest; the tag is there for people
and for Dependabot. To move to the image the tag points at today:

```bash
docker buildx imagetools inspect node:22-slim   # "Digest:" of the index, not of one platform
```

Put that digest on both lines and say in the pull request where it was read.
A new Node major (`node:24-slim`) is a deliberate migration, not an update.

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

## Pinned GitHub Actions

Every `uses:` in `.github/workflows/` names a full commit SHA, with the
release it is in a trailing comment (#545):

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

A tag can be moved by whoever controls the action's repository; a commit
cannot. Dependabot (`github-actions` ecosystem, monthly) proposes new
releases and updates the SHA and the comment together. To pin or update one
by hand, take the commit the tag points to, not the tag object:

```bash
git ls-remote --tags https://github.com/actions/checkout 'v7.0.1*'
# an annotated tag lists two lines: use the one ending in ^{} (the commit)
```

Name the most precise release that points at that commit in the comment
(`# v7.0.1`, not `# v7`), so Dependabot and a reader see the same version.
A new action is added pinned the same way.

## Questions

Open a `question`-labelled issue or ping the maintainers in the discussion
that triggered your contribution. We try to respond within a few business
days.
