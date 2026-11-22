# OSCAR - GitHub and CI set-up

What the repository's GitHub settings, CI, SonarCloud and test environments
are, and why. This page is a **record**: GitHub keeps no history of its
settings, so a change made there is written here in the same PR, or in one of
its own.

Read on 2026-11-22 from GitHub's API (§ 10 gives the commands). Secrets are
named here, **never their values**: GitHub never shows a value again, and a
lost value is replaced, not recovered.

Related pages:
- *auto-deploy-setup.md*: making the deploy keys and the GHCR token;
- *OSCAR - Production smoke test*: the `oscar-smoke` environment and its account;
- *OSCAR - OSDM Simulator*: the simulator's host;
- `CONTRIBUTING.md`: local development, tests, pinned versions, releases.

## 1. Repository

| Setting | Value | Why |
|---|---|---|
| Visibility | **public** | The code is UIC's open source. Nothing secret is in it: credentials live in environments (§ 4) |
| Merge methods | squash, merge commit and rebase allowed; **squash by convention** | One commit per PR on `main`. `--match-head-commit` names the commit the checks ran on |
| Auto-merge | allowed | Used on request only, never by default |
| Delete head branches on merge | on | |
| *Always suggest updating PR branches* | off | |
| Code owners | `@TOP-PHE` for everything (`.github/CODEOWNERS`) | |

## 2. Protection of `main`

A classic branch protection rule. A ruleset named *main branch* exists but is
**disabled**: the classic rule is the one in force.

- **Required status checks**, and the branch must be **up to date** before merging:
  - `Lint, audit, test` (CI · Server)
  - `Docker image build` (CI · Server)
  - `Container image scan (Trivy)` (CI · Server)
  - `Validate Bruno collection` (CI · Bruno collection)
  - `Analyze (javascript-typescript)` (CodeQL)
  - `Scan repo for secrets` (Gitleaks)
  - `SonarCloud Code Analysis` (SonarCloud)
- **Linear history** required; **conversations must be resolved**.
- **Pull request** required, with **0 approvals** (one maintainer); stale reviews are dismissed.
- Administrators are not held to it (`enforce_admins` off). By convention
  nobody merges with `--admin`.

**Checks that run but are not required.** Read them before merging; GitHub
does not hold a PR on them:

| Check | Why it matters |
|---|---|
| `CodeQL` (the results check) | A new alert in a PR's diff shows here, not in `Analyze`. A large diff re-reports a file's old alerts |
| `Kubernetes deployment (kind)`, `k3s on one machine` (CI · Kubernetes) | On their paths and weekly. Auto-merge once merged a PR with the k3s job red (#1337) |
| `SonarCloud Code Analysis` from the *SonarQube Cloud* GitHub App | Its PR comment. The required check of the same name comes from the workflow |
| `label` (PR labeler) | |

## 3. Tags

Ruleset **release tag** (active) on `refs/tags/release-*` and
`refs/tags/server-v*`: creation, update, deletion and force-push are refused.
The only bypass is the **OSCAR Release Bot** GitHub App (§ 5): only
`auto-tag-on-release.yml` mints these tags. A release tag starts the
promotion (§ 6).

Simulator tags (`simulator-*`) are not under this ruleset.

## 4. Environments

Every secret a workflow needs to reach outside lives in an **environment**,
never as a repository secret. Each environment admits only the branches or
tags listed.

| Environment | Protection | Branches / tags | Secrets | Used by |
|---|---|---|---|---|
| `production` | **reviewer `TOP-PHE` required** | `main`, tags `release-*` | `SSH_DEPLOY_KEY`, `SSH_KNOWN_HOSTS` | `promote-release.yml`, `refresh-collection.yml` |
| `release` | none | `main` | `OSCAR_RELEASE_APP_ID`, `OSCAR_RELEASE_APP_PRIVATE_KEY` | `auto-tag-on-release.yml` |
| `simulator` | none | `main` | `SIMULATOR_SSH_KEY`, `SIMULATOR_KNOWN_HOSTS`, `SIMULATOR_SSH_TARGET`, `SIMULATOR_URL` | `simulator-deploy.yml` |
| `oscar-smoke` | none (it must start by itself) | `main` | `OSCAR_SMOKE_CLIENT_ID`, `OSCAR_SMOKE_PRIVATE_KEY` | `production-smoke.yml` |

- **Every promotion waits for the maintainer's approval**, because of
  `production`'s reviewer. A job needing the deploy key cannot run unattended,
  and that is on purpose. The production smoke test has its own environment
  for that reason.
- The SSH deploy key on the production VPS is pinned, in `authorized_keys`, to
  the installed copy of `refresh-collection.sh`: whatever command is sent, that
  script runs (*auto-deploy-setup.md*). The simulator's key is pinned the same
  way to its update script.
- `simulator-deploy.yml`'s header still says "Secrets (repository)": they are
  in the `simulator` environment.
- No environment holds variables. `production-smoke.yml` reads two optional
  ones, `OSCAR_SMOKE_PROVIDER` and `OSCAR_SMOKE_SCENARIOS`.

**Repository secrets:** only `SONAR_TOKEN` (§ 7). It must reach pull request
builds, which an environment would hold up. **Repository variables:** none.
**Dependabot secrets:** none: Dependabot's runs skip the steps that need
secrets and still report green.

## 5. GitHub Apps and integrations

| App | What for |
|---|---|
| **SonarQube Cloud** (github.com/apps/sonarqubecloud) | Decorates PRs: its own check, and a comment with the gate's verdict and the new issues. The workflow's scan does not need `GITHUB_TOKEN` for this |
| **OSCAR Release Bot** (the repository's own app) | `auto-tag-on-release.yml` pushes `release-*` / `server-v*` tags with its token, the only actor the tag ruleset lets through. Its key is in the `release` environment; to rotate it, see the workflow's header |
| **Dependabot** | Version and security updates (§ 8) |

## 6. Workflows

| File | Name | Runs on | What it does |
|---|---|---|---|
| `ci-server.yml` | CI · Server | push, PR | Lint, audit, unit and integration tests (server, simulator, MCP server, API test tool); Docker build; Trivy scan |
| `ci-collection.yml` | CI · Bruno collection | push, PR | Validates the collection with the pinned Bruno CLI |
| `ci-kubernetes.yml` | CI · Kubernetes | PR and push on its paths, weekly | OSCAR on kind (OpenShift-like and Kubernetes) and on k3s, a run on the simulator. Not required |
| `codeql.yml` | CodeQL | push, PR, weekly | JavaScript analysis, config `.github/codeql/codeql-config.yml` |
| `gitleaks.yml` | Gitleaks (secret scan) | push, PR | Every commit of the PR |
| `sonar.yml` | SonarCloud | push, PR | Tests with coverage (server, simulator, MCP, API test tool), then the scan |
| `labeler.yml` | PR labeler | `pull_request_target` | Labels by path (`.github/labeler.yml`) |
| `publish-image.yml` | Publish · server image to GHCR | push to `main` | `:edge`, `:sha-…`, `:server-v…`. Production unchanged |
| `auto-tag-on-release.yml` | Release · auto-tag on merge | push to `main` | When `compatibility.json#current_release` changes, mints `release-YYYY.NNN` |
| `promote-release.yml` | Promote · release tag → :stable image | tag `release-*` | **Waits for approval** (`production`). Builds `:stable` and moves the VPS checkout to the release. Watchtower takes the image within ~5 minutes |
| `refresh-collection.yml` | Refresh · Bruno collection on production VPS | manual | Moves the VPS checkout to the newest release. Waits for approval |
| `publish-cluster-images.yml` | Publish · cluster images to GHCR | tag `release-*` | The bundle and run images for Kubernetes |
| `simulator-release.yml` | Simulator · tag and release | push to `main` | A new simulator version gets its tag and GitHub release |
| `simulator-deploy.yml` | Simulator · update the installed simulator | push to `main` | On a version change, updates the simulator's host over SSH |
| `production-smoke.yml` | Production smoke · OSCAR API | after a promotion, daily 06:17 UTC, manual | Three GAMMA scenarios through the test automation API, as a company's CI would |

**Actions settings:** every action allowed, but by convention each is pinned
to a full commit SHA with its version in a comment (`CONTRIBUTING.md`,
*Pinned GitHub Actions*). The default `GITHUB_TOKEN` is **read-only**, and
workflows cannot approve PRs. Each workflow declares the permissions it needs.
Values from an event reach a script through `env:` only, never written into
the script.

## 7. SonarCloud

- **Organization** `top-phe`, **project** `TOP-PHE_UIC_OSCAR_Temporary`
  (`sonar-project.properties` holds sources, tests, exclusions and the
  coverage reports).
- **Scan:** `sonar.yml` with `sonarqube-scan-action`, token `SONAR_TOKEN`
  (repository secret). On a PR, only the changed files are analysed.
- **Quality gate "OSCAR Gate"**, set in SonarCloud, not in the repository:
  - coverage of new code **≥ 83 %**;
  - duplication of new code **< 4 %**;
  - **one new bug fails it**; code smells do not.

  `sonar-project.properties` records why and the history of the coverage
  floor. Raise the floor there and in SonarCloud together.
- **Reading a PR's issues** needs no token (the project is public):
  `https://sonarcloud.io/api/issues/search?componentKeys=TOP-PHE_UIC_OSCAR_Temporary&pullRequest=<N>&resolved=false`
  (`&branch=main` for `main`).
- Pages under `Oscar_Server/public/` are excluded from coverage: a PR touching
  only pages reads 0 % on new code, and the gate still passes.

## 8. Security and dependency features

- **Secret scanning** and **push protection**: on. Validity checks and
  non-provider patterns: off.
- **Dependabot security updates**: on. **Version updates**
  (`.github/dependabot.yml`):
  - npm in `Oscar_Server` and in `Oscar_Server/bruno-cli` (the pinned Bruno
    CLI): weekly;
  - Docker in `Oscar_Server` and docker-compose in `OSCAR_Deploy`: weekly;
  - GitHub Actions: monthly.
- **Several Dependabot npm PRs at once:** they are combined into one PR
  (cherry-picked unchanged) rather than rebased one after another
  (`CLAUDE.md`, § 2).
- **CodeQL**, **Gitleaks** and **Trivy**, as required checks (§ 2).

## 9. Test environments outside GitHub

| What | Where | Used for |
|---|---|---|
| **Production** | `oscar.uic.org`, a VPS with Docker; Watchtower follows `:stable` | The real service. Promotion only, after approval |
| **k3s test machine** | a VPS of its own, OSCAR on k3s | Load and recovery rehearsals (*OSCAR - k3s on one VPS*). Never production data unless decided |
| **OSDM simulator** | a VPS of its own, behind nginx (*OSCAR - OSDM Simulator*) | Six providers `alpha` … `zeta`, one per OSDM version. Updated by `simulator-deploy.yml`; managed from OSCAR, *Admin → OSDM Simulator* |
| **Simulator company in OSCAR** | company **UIC Simulateurs** in production, its providers ALPHA … ZETA | Manual tests and the API checks |

API accounts of *UIC Simulateurs*:
- **TOP_Gamma_API**: manual tests with `OSCAR_API_TestTool/`. It may test the six simulators.
- **GitHub production smoke**: `production-smoke.yml`, GAMMA only. Its key
  exists only in the `oscar-smoke` environment.

Locally, see `CONTRIBUTING.md`. `CLAUDE.md` § 4 covers working trees outside
OneDrive (`C:/t/…`) and their `node_modules` link.

## 10. Reading the settings again

With the GitHub CLI, as the repository's administrator:

```bash
R=TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner
gh api repos/$R --jq '{visibility, allow_squash_merge, allow_auto_merge, delete_branch_on_merge}'
gh api repos/$R/branches/main/protection --jq '{strict: .required_status_checks.strict, checks: [.required_status_checks.checks[].context]}'
gh api repos/$R/rulesets --jq '.[] | "\(.name) \(.target) \(.enforcement)"'
gh api repos/$R/environments --jq '.environments[].name'
gh api repos/$R/environments/production/secrets --jq '[.secrets[].name]'
gh api repos/$R/actions/secrets --jq '[.secrets[].name]'
gh api repos/$R --jq '.security_and_analysis'
```

## 11. Setting it up again from nothing

In this order:

1. **Repository:** squash merge, delete branches on merge, `CODEOWNERS`.
2. **SonarCloud:** import the repository into organization `top-phe`. Make the
   gate *OSCAR Gate* (§ 7) and assign it. Put the token in the repository
   secret `SONAR_TOKEN`, and install the SonarQube Cloud GitHub App.
3. **The release app (OSCAR Release Bot):** create it with repository contents read and write, so it can push tags. Put its id and key in
   the `release` environment, and add it as the tag ruleset's bypass (§ 3).
4. **Environments:** `production` (reviewer, `main` + tags `release-*`),
   `simulator`, `oscar-smoke`, with their secrets (*auto-deploy-setup.md*,
   *OSCAR - OSDM Simulator*, *OSCAR - Production smoke test*).
5. **Protection of `main`:** the seven required checks, up to date, linear
   history, conversations resolved. The workflows must have run once for
   GitHub to offer their checks.
6. **Security:** secret scanning, push protection, Dependabot security
   updates.
7. Check everything with § 10, and update this page.
