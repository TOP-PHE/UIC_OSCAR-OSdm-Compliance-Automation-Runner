# OSCAR — Disaster Recovery (backup & restore)

Issue #543 / audit item S13.1. Scheduled, encrypted, off-host backups and a
tested restore for the Docker deployment (`ghcr.io/top-phe/oscar-server:stable`
fronted by nginx, data bind-mounted under the compose directory).

Scripts live in `OSCAR_Deploy/scripts/`:
`oscar-backup.sh`, `oscar-restore.sh`, `oscar-backup-schedule.sh`.

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
# passphrase file (paste a long random passphrase; also store it in your password manager)
umask 077; printf '%s' 'CHOOSE-A-LONG-RANDOM-PASSPHRASE' > ~/.oscar-backup-pass
chmod 600 ~/.oscar-backup-pass
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

Retention defaults to the newest **6** archives (`OSCAR_BACKUP_KEEP`).

## 5. Run a backup by hand (also: before a DR drill)

```bash
OSCAR_BACKUP_PASSPHRASE_FILE=~/.oscar-backup-pass \
  /opt/OSCAR/OSCAR_Deploy/scripts/oscar-backup.sh
# then pull it to your PC (off-host):
#   scp <user>@<host>:~/oscar-backups/oscar-backup-*.tar.gz.gpg .
```
The script discovers the data dir and `.env` from the running container, takes a
live-safe SQLite snapshot, writes the encrypted archive to `OSCAR_BACKUP_DIR`
(default `~/oscar-backups`), prunes old ones, and prints the `scp` to pull it.

## 6. Restore / DR drill on a second VPS (target: under 5 minutes)

**Provision the drill host once** (fresh VPS):
```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git gnupg curl
sudo usermod -aG docker "$USER"   # re-login after this
umask 077; printf '%s' 'THE-SAME-BACKUP-PASSPHRASE' > ~/.oscar-backup-pass; chmod 600 ~/.oscar-backup-pass
```

**Restore** (copy the archive to the drill host first, then):
```bash
OSCAR_BACKUP_PASSPHRASE_FILE=~/.oscar-backup-pass \
  ./oscar-restore.sh oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg --hostname drill.example.org
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
