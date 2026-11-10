# OSCAR — Disaster Recovery (backup & restore)

Issue #543 / audit item S13.1. Scheduled, encrypted, off-host backups and a
tested restore for the Docker deployment (`ghcr.io/top-phe/oscar-server:stable`
fronted by nginx, data bind-mounted under the compose directory).

Scripts live in `OSCAR_Deploy/scripts/`:
`oscar-backup.sh`, `oscar-restore.sh`, `oscar-backup-schedule.sh`.

**Where to restore.** A backup is made on the Docker VPS (sections 3 to 5).
It can be restored onto any of these, each by its own steps; all of them first
need the archive on the new machine (section 5a):

| Restore onto | Follow |
|---|---|
| a VPS with Docker, as production today | section 6 below |
| one machine with k3s (Kubernetes) | [OSCAR - k3s on one VPS](OSCAR%20-%20k3s%20on%20one%20VPS.md), section 6a |
| a Kubernetes or OpenShift cluster | [Kubernetes and OpenShift Deployment Guide](OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md), section 6a |

**Your values.** In the commands below, the values to change are the **first
lines of a block, in capitals, marked `# ← yours`** (`$Archive =` in
PowerShell): change them there, then paste the whole block. Each block sets
them again: a value is lost when the SSH session ends.

| Value | What to put | Where to find it |
|---|---|---|
| `ARCHIVE` | the backup's file name, e.g. `oscar-backup-20261110-091500.tar.gz.gpg` | `ls ~/oscar-backups` on the host, or the folder that keeps the archives |
| `FROM` / `TO` | your account and a machine's DNS name, e.g. `root@oscar-test.example.org` | how you connect to it with `ssh` |
| `DRILL_HOST` | the drill host's DNS name | the A record you made for it |
| the passphrase | never in a command: typed when asked (`read`, `gpg`) | your password manager |

## 1. What a backup contains

One self-contained, GPG-encrypted archive — `oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg` — holding:

| Inside | What it is |
|---|---|
| `data/oscar.db` | consistent SQLite snapshot — **all users** (+ bcrypt password hashes), companies (`api_base`, dedicated headers), test frameworks, findings, run history, personal run lists, places cache |
| `data/datafiles/` | per-company scenarios (AES-256-GCM at rest) |
| `data/artifacts/` | past run reports/results (encrypted at rest) |
| `.env` | configuration **including `ENCRYPTION_KEY`** |
| `manifest.json` | release tag, collection + schema version, user/company counts |

**The linchpin is `ENCRYPTION_KEY`.** Password hashes are self-contained, so a
restored DB lets everyone **log in** with any `JWT_SECRET`. But the stored OSDM
**credentials and datafiles are encrypted with `ENCRYPTION_KEY`** — only the
**same key** lets users **test**. That is why `.env` travels inside the archive.

## 2. Security model

The archive is a crown-jewel (it contains `ENCRYPTION_KEY`), so its **only**
protection is the GPG passphrase. Therefore:

- Keep the passphrase in a **password manager**, and in a `chmod 600` file on
  the host that the backup reads (`OSCAR_BACKUP_PASSPHRASE_FILE`). Never store
  the passphrase beside the archive.
- **Move every archive off the host.** A backup that lives only on the box it
  backs up dies with the box. For now that is Patrick's PC (`scp` it down);
  later, UIC object storage. Separating the archive (off-host) from the
  passphrase (password manager) is what gives real protection.

## 3. One-time setup on the OSCAR host

```bash
sudo apt-get update && sudo apt-get install -y sqlite3 gnupg
```

The passphrase file: choose a long random passphrase and store it in your
password manager too. Paste this line alone, type the passphrase (it is not
shown, nor kept in the shell's history), then Enter:

```bash
read -rs -p 'Backup passphrase: ' P; echo; (umask 077; printf '%s' "$P" > ~/.oscar-backup-pass); unset P
```

## 4. Choose the backup frequency

```bash
cd /opt/OSCAR/OSCAR_Deploy/scripts
./oscar-backup-schedule.sh daily      # 02:30 every day
./oscar-backup-schedule.sh weekly     # 02:30 every Monday
./oscar-backup-schedule.sh monthly    # 02:30 on the 1st   (baseline: monthly, keep >= 6)
./oscar-backup-schedule.sh on-demand  # no timer; run backups by hand (DR drills)
./oscar-backup-schedule.sh status     # show the current timer
```

Retention defaults to the newest **6** archives (`OSCAR_BACKUP_KEEP`). An
archive is about as large as OSCAR's `data/` folder (the reports and data files
are already encrypted, so they do not compress): choose a number the host's
disk holds next to OSCAR's own data and one more backup, or keep 1 and move
each archive off the host.

## 5. Run a backup by hand (also: before a DR drill)

```bash
OSCAR_BACKUP_PASSPHRASE_FILE=~/.oscar-backup-pass \
  /opt/OSCAR/OSCAR_Deploy/scripts/oscar-backup.sh
# then copy it off the host, to your PC: the scp the script prints at its end
```
The script discovers the data dir and `.env` from the running container, takes a
live-safe SQLite snapshot, writes the encrypted archive to `OSCAR_BACKUP_DIR`
(default `~/oscar-backups`), prunes old ones, and prints the `scp` to pull it.

**Free space.** Only the database snapshot is copied first (in `TMPDIR`, else
`/tmp`); the data files and reports are read where they are and go through tar
and gpg straight into the archive. The backup needs about the size of `data/`
plus the database once more, and leaves `OSCAR_BACKUP_MIN_FREE_MB` (2048) free.
It checks that before writing anything and stops with "not enough free space"
otherwise, so it never fills the disk OSCAR writes to; the Admin Dashboard then
shows a failed backup. Make room as below. The archive is written under a
hidden temporary name and renamed when complete: a backup that stops half-way
leaves no archive behind. Until November 2026 the script copied the data into
`/tmp`, then compressed it, then encrypted it, which needed about three times
the size of `data/`.

### "not enough free space": making room

The message gives the MB the backup needs and the MB that are free. On a disk
that holds `data/` and one archive, a second archive often does not fit (on
production in November 2026: 22 GB of data, a 17 GB archive, 40 GB free): the
previous archive must leave the host before the next backup. On the host, as
the user that runs the backups:

**1. What takes the space.**

```bash
df -h ~/oscar-backups /tmp
ls -la ~/oscar-backups
```

**2. The older archive safe on your PC.** If it is not there yet, copy it
(from your PC, in PowerShell or a terminal, in the folder that keeps the
archives):

```powershell
$Archive = 'oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg'   # ← yours: the older archive (ls above)
$From = 'ubuntu@oscar.example.org'                     # ← yours: your account @ the host
scp "${From}:~/oscar-backups/$Archive" .
```

Then compare its SHA-256 with the one the backup wrote beside it. On the host:

```bash
ARCHIVE=oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg   # ← yours: the older archive
cat ~/oscar-backups/"$ARCHIVE".sha256
```

On the PC, in the same folder (Linux or macOS: `sha256sum` and the file
name):

```powershell
$Archive = 'oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg'   # ← yours: the older archive
(Get-FileHash ".\$Archive" -Algorithm SHA256).Hash.ToLower()
```

The two must be the same. If not, copy it again: the copy is incomplete.

**3. Only then, remove it from the host**, the archive and its `.sha256`:

```bash
ARCHIVE=oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg   # ← yours: the older archive
rm ~/oscar-backups/"$ARCHIVE" ~/oscar-backups/"$ARCHIVE".sha256
```

A hidden `.oscar-backup-….part` that `ls -la` shows is what a backup that was
killed left behind: remove it too, when no backup is running.

**4. Run the backup again** (the command at the top of this section).

**Still not enough room:** `docker system df` shows what Docker could give
back (`docker image prune` removes the images left without a tag). Or write to
another disk: `OSCAR_BACKUP_DIR` for the archive and `TMPDIR` for the database
copy, both set in front of the command, for example
`OSCAR_BACKUP_DIR=/mnt/backup TMPDIR=/mnt/backup OSCAR_BACKUP_PASSPHRASE_FILE=~/.oscar-backup-pass /opt/OSCAR/OSCAR_Deploy/scripts/oscar-backup.sh`.

### The status on the Admin Dashboard (#572)

Each backup (ok or failed) and each change of frequency writes
`data/backup-status.json` next to the database, through
`OSCAR_Deploy/scripts/oscar-backup-status.sh`. The **Admin Dashboard** shows it
to administrators: last backup (date, size, result), last success and failure,
frequency, next run, retention, archives present, last restore drill, and
warnings (a failed backup, a next run in the past, more archives than kept, no
drill recorded).

The file holds metadata only: dates, a size, counts and the frequency. No path,
file name, host, passphrase or archive content. The panel is read only: OSCAR
cannot make, schedule or download a backup (the archive holds the encryption
key and every company's data).

A restore drill happens on another host, so record it on the OSCAR host
afterwards:

```bash
/opt/OSCAR/OSCAR_Deploy/scripts/oscar-backup-status.sh drill            # today
/opt/OSCAR/OSCAR_Deploy/scripts/oscar-backup-status.sh drill 2026-10-15 # a given day
/opt/OSCAR/OSCAR_Deploy/scripts/oscar-backup-status.sh show             # what the panel reads
```

## 5a. The archive on the new machine

Whatever the restore (section 6, or a k3s or cluster guide's 6a), the archive
must first be on the machine that restores it, and whole. Take its `.sha256`
with it: the backup writes one beside each archive.

**A real disaster: from where the archives are kept.** The server is gone,
so the copy comes from the off-host copy (section 2: for now the PC). From the
PC, in PowerShell or a terminal, in the folder that keeps the archives:

```powershell
$Archive = 'oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg'   # ← yours: the archive's file name
$To = 'root@oscar-test.example.org'                    # ← yours: your account @ the new machine
scp ".\$Archive" ".\$Archive.sha256" "${To}:~/"
```

A home connection sends slowly: about 1.4 MB/s in November 2026, so some
hours for a 17 GB archive. Start it first, and prepare the new machine
meanwhile.

**A drill, or a move, while the old server still runs: straight from it.**
Much faster, server to server. On the old server, as the user that runs the
backups:

```bash
ARCHIVE=oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg   # ← yours: ls ~/oscar-backups
TO=root@oscar-test.example.org                   # ← yours: your account @ the new machine
scp ~/oscar-backups/"$ARCHIVE" ~/oscar-backups/"$ARCHIVE".sha256 "$TO":~/
```

`scp` asks the new machine's password, or uses a key the old server holds.
If the new machine accepts keys only: on the old server, `ssh-keygen -t
ed25519` (if `~/.ssh/id_ed25519.pub` is not there yet), add that `.pub`
line to the new machine's `~/.ssh/authorized_keys`, copy, then remove the
line again.

**Check that it is whole**, on the new machine (the `.sha256` holds the hash
only):

```bash
ARCHIVE=oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg   # ← yours: the file copied here
echo "$(cat ~/"$ARCHIVE".sha256)  $HOME/$ARCHIVE" | sha256sum -c -
```

It must end with `OK`. `FAILED`: the copy is incomplete, copy it again.

## 6. Restore / DR drill on a second VPS (target: under 5 minutes)

**This section restores onto a VPS that runs OSCAR with Docker**, as
production does today. Restoring elsewhere is done by another guide, and
nothing of this section applies there:
- **one machine with k3s**: [OSCAR - k3s on one VPS](OSCAR%20-%20k3s%20on%20one%20VPS.md),
  section 6a. Do not install Docker on a k3s machine: its network rules can
  disturb the pods' traffic.
- **a Kubernetes or OpenShift cluster**:
  [Kubernetes and OpenShift Deployment Guide](OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md),
  section 6a.

**Provision the drill host once** (fresh VPS, Ubuntu):
```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git gnupg curl
sudo usermod -aG docker "$USER"   # re-login after this
```

Then the backup's passphrase (the same as on the OSCAR host): paste this line
alone, type it, then Enter.

```bash
read -rs -p 'Backup passphrase: ' P; echo; (umask 077; printf '%s' "$P" > ~/.oscar-backup-pass); unset P
```

**Restore** (the archive on the drill host first, section 5a, then):
```bash
ARCHIVE=oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg   # ← yours: the file copied here
DRILL_HOST=drill.example.org                     # ← yours: the drill host's DNS name
OSCAR_BACKUP_PASSPHRASE_FILE=~/.oscar-backup-pass \
  ./oscar-restore.sh "$ARCHIVE" --hostname "$DRILL_HOST"
```
It decrypts, clones the monorepo at the archive's **release tag**, drops the
restored `data/` + `.env` into the compose directory, adjusts
`ALLOWED_ORIGINS` / `ALLOWED_REDIRECT_HOSTS` for the drill hostname, runs
`docker compose up -d`, and waits for `/health` to report `ok`. The clone +
image pull is the slowest part; the data restore itself is seconds.

> The restore script fetches `oscar-restore.sh` only; to get all three scripts
> on a bare host, clone the repo first or `scp` the `scripts/` folder over.

**Browser access on the drill host.** The container binds `127.0.0.1:3001`
only. To log in from a browser, either front it with nginx + a TLS cert for the
drill hostname (see the nginx snippet in `OSCAR_Deploy/nginx/`), or SSH-tunnel:
`ssh -L 3001:127.0.0.1:3001 <user>@<drill-host>` then open `http://localhost:3001`.
For a real failover you would instead point the production DNS at the new host.

## 7. Verify the restore

- `/health` returns `status: ok` (the script checks this).
- Log in as a known user → succeeds (bcrypt hashes restored).
- Open a company's Test Config → scenarios render (datafiles decrypt → same
  `ENCRYPTION_KEY`), and a run authenticates against the vendor sandbox
  (per-tester OSDM credentials decrypt).
- User/company counts match `manifest.json`.

## 8. Caveats

- A restore brings up the **release** recorded in the backup; the collection is
  the version bind-mounted from that tag (code/collection compatibility holds).
- Runs started on the drill host hit the **real vendor sandbox** endpoints with
  the restored credentials — same as production. For a pure restore check, login
  + viewing restored data is enough.
- The drill host is not `oscar.uic.org`; use a test hostname (or DNS failover
  for a real event), and keep production untouched (`oscar-restore.sh` refuses
  to overwrite a running `oscar` container without `--force`).
- **Restoring onto a Kubernetes or OpenShift cluster** instead of a VPS: the
  archive's `data/` is loaded into the cluster's volume with
  `OSCAR_Deploy/kubernetes/oscar-data.sh load`, and its `.env` gives the
  cluster's Secret its `ENCRYPTION_KEY` and `JWT_SECRET`
  ([Kubernetes and OpenShift Deployment Guide](OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md),
  section 6a, the move from a VPS). On one machine with k3s,
  [OSCAR - k3s on one VPS](OSCAR%20-%20k3s%20on%20one%20VPS.md), section 6a,
  is the whole recovery step by step: the release to run, the secrets, the
  data, the monitoring and the alerts' e-mail from the restored Server
  Config, the checks and the name.
