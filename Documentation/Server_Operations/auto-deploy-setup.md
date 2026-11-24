# OSCAR — Auto-deploy setup

This guide wires up automated production rollout for the OSCAR server and
its Bruno collection. Once configured, you do *not* SSH into the VPS for
day-to-day updates — pushing a Git tag or merging a PR is enough.

The whole GitHub and CI set-up (environments, required checks, apps,
SonarCloud) is recorded in *OSCAR - GitHub and CI set-up*.

## Overview

| Trigger                                     | Action                                                              |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Push to `main` touching `Oscar_Server/**`   | CI builds image and pushes to GHCR as `:edge` and `:sha-XXXXX`      |
| Push of `server-vX.Y.Z` Git tag             | CI tags the image with `:server-vX.Y.Z` (immutable per-server-version) |
| Push of `release-YYYY.NNN` Git tag          | Once a reviewer approves the `production` environment: CI checks the tag is on `main`, rebuilds at that ref, pushes as `:stable` and `:release-YYYY.NNN`, then sends the digest it built to the VPS, which moves its checkout (collection, `compatibility.json`) to that tag and starts the server on that digest |

Production therefore only changes with a release tag, and only once the
`production` environment is approved. A merge to `main`, collection changes
included, deploys nothing by itself: the VPS checkout follows the newest
release tag on `main`, never `main`'s head.

Production runs the image digest that the approved promotion built
(`OSCAR_IMAGE_DIGEST` in `/opt/OSCAR/OSCAR_Deploy/.env`). A tag in the
registry, `:stable` included, decides nothing: nothing on the VPS follows one.

---

## One-time setup

There are three pieces to wire up: GHCR pull credentials on the VPS (only
for a private package), the SSH deploy key the promotion uses, and the first
image digest in `.env`.

### 1. Create a GHCR pull token

GitHub Container Registry treats packages as private by default (matching
the source repo's visibility). Docker on the VPS needs credentials to pull a
private package. The `oscar-server` package is public: this step and the
next are needed only if you make it private.

1. https://github.com/settings/personal-access-tokens/new
2. Token name: `vps-ghcr-pull`
3. Expiration: 90 days (renew yearly when you remember)
4. Repository access: `Only select repositories` → pick the OSCAR repo
5. **Repository permissions**: leave everything at "No access"
6. **Account permissions** → **Packages: Read-only**
7. Generate and copy the token (you won't see it again)

### 2. Log Docker on the VPS into GHCR

```bash
# On the VPS, as ubuntu (NOT root)
docker login ghcr.io -u <your-github-username> -p <ghcr-pull-token>
```

This writes `~/.docker/config.json` containing the credentials, which
`docker pull` uses when the deploy script, run as `ubuntu`, pulls an image.

Verify:
```bash
docker pull ghcr.io/top-phe/oscar-server:edge
```
If that succeeds, GHCR creds are good.

### 3. Generate an SSH deploy key (for collection-refresh)

**On your laptop (not on the VPS, not in CI):**

```bash
ssh-keygen -t ed25519 -C "github-actions-oscar-deploy" -f ./oscar-deploy-key -N ""
```

This produces two files:
- `oscar-deploy-key`     — private (goes into GitHub Actions Secrets only)
- `oscar-deploy-key.pub` — public (goes onto the VPS)

### 4. Install the public key on the VPS — locked down

Append the public key to `ubuntu`'s `authorized_keys`, restricted via
`command=` so a leaked private key can only run the refresh script.

The key runs a **copy** of the script installed outside the checkout, never
the checkout's own file. The script moves the checkout it lives in (to the newest release tag on `main`), so
with the checkout's file as the command, any change to it merged into `main`
would be run by the next deploy as `ubuntu`, who has `sudo`. With a copy, a
merge cannot change what the key runs; the script logs a `NOTE` when the
checkout's version differs from the installed one, and you copy it again by
hand after reading it.

On the VPS as `ubuntu`:

```bash
# The copy the key runs, outside the checkout (repeat after reading a new version)
sudo install -m 0755 -o root -g root /opt/OSCAR/OSCAR_Deploy/scripts/refresh-collection.sh /usr/local/sbin/oscar-refresh-collection

mkdir -p ~/.ssh && chmod 700 ~/.ssh
# Paste the contents of oscar-deploy-key.pub between the quotes below,
# then prefix it with the command= clause that pins it to the script.
echo 'command="/usr/local/sbin/oscar-refresh-collection",no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding ssh-ed25519 AAAA... github-actions-oscar-deploy' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Now even if someone gets the private key, they cannot get a shell — only
that one script runs, and a merge to `main` cannot change it.

What the workflow sends after the script's name is read as data, never run:
nothing, or one image digest (`sha256:` and 64 hex digits). Anything else is
refused before anything moves. With a digest (`promote-release.yml` sends the
one its build gave), the script, after moving the checkout:

- pulls `ghcr.io/top-phe/oscar-server@<digest>`;
- writes it as `OSCAR_IMAGE_DIGEST` in `/opt/OSCAR/OSCAR_Deploy/.env`;
- creates `oscar` (and `oscar-runner` when it runs) again with
  `docker compose up -d`, from the compose files and project the running
  server was made from (its `com.docker.compose.*` labels), so the
  monitoring overlay's additions stay;
- waits up to five minutes for `oscar` to be healthy on that image, and fails
  otherwise: the promotion then goes red.

It uses docker and `.env` as `ubuntu` when `ubuntu` may (the `docker` group,
and `.env` readable and writable by it), else through `sudo -n`; with
neither, it says so and deploys nothing. Each step is in
`journalctl -t oscar-deploy`.

**Moving an existing VPS to deploy by digest** (once). Before it, Watchtower
followed `:stable`. On the VPS as `ubuntu`:

```bash
cd /opt/OSCAR && git fetch origin main
# 1. Read the new script, then install it as the key's command.
git show origin/main:OSCAR_Deploy/scripts/refresh-collection.sh > /tmp/oscar-refresh-collection.new
less /tmp/oscar-refresh-collection.new
sudo install -m 0755 -o root -g root /tmp/oscar-refresh-collection.new /usr/local/sbin/oscar-refresh-collection
rm /tmp/oscar-refresh-collection.new
```

```bash
# 2. The deploy account may use docker and .env (prints "as ubuntu"), or sudo
#    without a password (prints "through sudo"). Neither: fix that first.
cd /opt/OSCAR/OSCAR_Deploy
if docker info >/dev/null 2>&1 && [ -r .env ] && [ -w .env ]; then echo "as ubuntu"; elif sudo -n true 2>/dev/null; then echo "through sudo"; else echo "neither"; fi
```

```bash
# 3. Name the image running now in .env, so that a "docker compose up" by
#    hand before the next promotion starts the same one.
cd /opt/OSCAR/OSCAR_Deploy
D=$(sudo docker inspect --format '{{index .RepoDigests 0}}' "$(sudo docker inspect --format '{{.Image}}' oscar)" | cut -d@ -f2)
echo "$D"
sudo grep -q '^OSCAR_IMAGE_DIGEST=' .env || echo "OSCAR_IMAGE_DIGEST=$D" | sudo tee -a .env >/dev/null
sudo grep '^OSCAR_IMAGE_DIGEST=' .env
```

```bash
# 4. Remove the Watchtower container: nothing follows a tag any more.
sudo docker rm -f watchtower
```

The next promotion's step *Refresh host repo and start the image on VPS* then
ends with `deployed ghcr.io/top-phe/oscar-server@sha256:…: oscar is healthy`.
An installed script older than the workflow ignores the digest: the step
warns about it.

**Moving an existing VPS to the installed copy:** run the `install` line
above, then edit the deploy key's line in `~/.ssh/authorized_keys` so that
`command="…"` names `/usr/local/sbin/oscar-refresh-collection` (keep the
rest of the line). Check it with
`grep -o '^command="[^"]*"' ~/.ssh/authorized_keys`, then re-run the
*Refresh · Bruno collection on production VPS* workflow by hand (Actions →
Run workflow): it must end green. The other server settings that go with it
are in `OSCAR - Server Hardening.md`.

### 5. Add the secrets to GitHub, in environments

Deploy secrets live in **environments**, not in the repository's secrets: a
repository secret can be read by a workflow on any branch, an environment
secret only by the jobs its rules admit.

**5a. Create three environments** (repo → **Settings** → **Environments** →
**New environment**):

| Environment  | Deployment branches and tags                     | Required reviewers | Used by |
| ------------ | ------------------------------------------------ | ------------------ | ------- |
| `production` | Selected: tag rule `release-*`, branch `main`    | Yes: the maintainers who may ship; tick *Prevent self-review* if there are two or more | `promote-release.yml`, `refresh-collection.yml` |
| `release`    | Selected: branch `main`                          | Yes: the maintainer (it runs on every merge that bumps a version, and waits for that approval) | `auto-tag-on-release.yml` |
| `simulator`  | Selected: branch `main`                          | Yes: the maintainer | `simulator-deploy.yml` |

**5b. Put each secret in its environment** (the environment's page →
**Environment secrets** → **Add secret**):

| Environment  | Name                            | Value |
| ------------ | ------------------------------- | ----- |
| `production` | `SSH_DEPLOY_KEY`                | Full contents of `oscar-deploy-key` (the private key file) |
| `production` | `SSH_KNOWN_HOSTS`               | Output of `ssh-keyscan -t ed25519 oscar.uic.org` from any machine |
| `release`    | `OSCAR_RELEASE_APP_ID`, `OSCAR_RELEASE_APP_PRIVATE_KEY` | The release App's id and private key |
| `simulator`  | `SIMULATOR_SSH_KEY`, `SIMULATOR_KNOWN_HOSTS`, `SIMULATOR_SSH_TARGET`, `SIMULATOR_URL` | As in *OSCAR - OSDM Simulator* |

Then **delete the repository-level copies** of these secrets (**Secrets and
variables** → **Actions**): while one remains, every workflow can still read
it. `SONAR_TOKEN`, `GITLEAKS_LICENSE` and `TEST_ENCRYPTION_KEY` stay
repository secrets (CI only, no access to a server).

**5c. Protect the release tags** (repo → **Settings** → **Rules** →
**Rulesets** → **New tag ruleset**): target `release-*` (and `server-v*`),
rules *Restrict creations*, *Restrict updates*, *Restrict deletions*, bypass
list: the release App only. A release tag is then pushed by the release
workflow alone, and never moved.

After adding the deploy key, **delete `oscar-deploy-key` from your laptop** — there is no other copy needed.

### 6. Switch the VPS to image-based deploy

The `oscar` service names its image by the digest in `.env`
(`OSCAR_IMAGE_DIGEST`); compose starts nothing without it. Before the first
promotion, set it to the image you start with (*Which image to run*, below).
Then on the VPS:

```bash
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose pull oscar       # pull the image named by its digest
sudo docker compose up -d            # recreate without rebuild
sudo docker compose logs -f oscar    # confirm it boots cleanly
```

After this, no more `--build` on production — each promotion starts its own
image.

### Which image to run

A release's image is `ghcr.io/top-phe/oscar-server:release-YYYY.NNN`; what
runs is its digest. To read it (a first install, another host):

```bash
R=release-2026.621   # ← the release you install
docker pull -q ghcr.io/top-phe/oscar-server:$R >/dev/null
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/top-phe/oscar-server:$R | cut -d@ -f2
```

Compare it with the digest in the summary of that release's *Promote* run
(GitHub → Actions): a tag can be moved, the run's summary says what was built.
Then put it in `.env` as `OSCAR_IMAGE_DIGEST=sha256:…`.

---

## Daily life after setup

### Server change you want in production

```bash
# 1. Make the change in your local working copy
git commit -am "feat: …"
git push origin main
# → publish-image.yml runs, pushes :edge and :sha-XXXXX. Production unchanged.

# 2. When ready to ship, bump server version + add release row
#    Edit Oscar_Server/package.json   "version": "1.3.0"
#    Edit compatibility.json          add a new release entry, set current_release
git commit -am "release: server v1.3.0 / collection OTST_V2.0.1 → 2026.05"
git push origin main

# 3. Tag and push
git tag server-v1.3.0
git tag release-2026.05
git push origin server-v1.3.0 release-2026.05
# → promote-release.yml waits for approval, then builds the image and starts it on the VPS by digest.
```

### Collection change you want in production

A collection change ships like any other: with a release (a
`compatibility.json` entry), whose tag the release workflow pushes, then
`promote-release.yml` once the `production` environment is approved. It moves
the VPS checkout to the release tag. *Refresh · Bruno collection on
production VPS* (Actions → Run workflow) does that last step again by hand.

If the change should also be tagged as a new collection version:

```bash
echo "OTST_V2.0.2" > Bruno_Collection/VERSION
git commit -am "chore(collection): bump VERSION to OTST_V2.0.2"
git tag collection-OTST_V2.0.2
git push origin main collection-OTST_V2.0.2
```

### When `refresh-collection.sh` fails with "working tree dirty"

The deploy workflows (`refresh-collection.yml` and `promote-release.yml`) both
SSH the VPS and run `refresh-collection.sh`, which refuses to move the checkout if
`/opt/OSCAR/` has any uncommitted edits OR untracked files. Two common
sources during incident response:

- **You edited config files directly on the VPS** to debug something
  (e.g. `OSCAR_Deploy/docker-compose.metrics.yml`, the nginx snippet, a
  Grafana provisioning YAML). Once the fix lands in source via a follow-up
  PR, the host's local edit becomes "clean" content-wise but git still
  sees uncommitted changes.

- **Stray `FETCH_HEAD`** at the repo root (not under `.git/`) — happens
  when someone runs `git fetch` from an unusual working dir.

Recovery:
```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR status     # see what's dirty
sudo -u ubuntu git -C /opt/OSCAR diff       # confirm content is now upstream
sudo -u ubuntu git -C /opt/OSCAR checkout -- .   # discard tracked-file edits
rm -f /opt/OSCAR/FETCH_HEAD                 # remove stray fetch artifact
sudo -u ubuntu git -C /opt/OSCAR status     # should now be clean
sudo -u ubuntu git -C /opt/OSCAR pull       # manual catch-up
```

After this, the next release-tagged push will auto-refresh the host normally.

### Rolling back production

If the image just deployed is broken, start the one before it again. The
digests deployed are in the deploy log, newest last. On the VPS:

```bash
journalctl -t oscar-deploy | grep deployed
```

```bash
D=sha256:...   # ← the known-good digest, from the log above
cd /opt/OSCAR/OSCAR_Deploy
sudo sed -i "s/^OSCAR_IMAGE_DIGEST=.*/OSCAR_IMAGE_DIGEST=$D/" .env
FILES=$(sudo docker inspect oscar --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')
sudo docker compose $(printf -- '-f %s ' ${FILES//,/ }) up -d oscar
```

The collection stays at the newest release. Fix in CI and release again: the
next promotion writes its own digest over this one.

### Viewing image history on GHCR

https://github.com/UICrail/OSCAR-OSdm-Compliance-Automation-Runner/pkgs/container/oscar-server  
(or wherever the package ends up after the repo transfer)

---

## Operational notes

- **Audit deploys** with `journalctl -t oscar-deploy`: each checkout move,
  and each image started, by digest.
- **GHCR pull token rotation** (a private package only): re-issue the token,
  run `docker login ghcr.io -u … -p …` again on the VPS. The
  `~/.docker/config.json` is updated and the next deployment's
  `docker pull` uses it.
- **First production deploy** before any image exists: temporarily
  uncomment the `build:` block in `docker-compose.yml` (and comment out
  `image:`), run `docker compose up -d --build`, then restore `image:`,
  set `OSCAR_IMAGE_DIGEST` and approve the first promotion.
