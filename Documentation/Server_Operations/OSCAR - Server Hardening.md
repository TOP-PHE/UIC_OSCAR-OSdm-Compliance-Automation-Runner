# OSCAR — Server Hardening

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC, Union Internationale des Chemins de fer © 2026."

---

## 1. What this page is for

The OSCAR server and the OSDM simulator each run on a Linux host of their own
(Ubuntu 24.04 in production). The containers are hardened by their compose
files; the host is not, and the host decides whether someone can become
`root` on the machine. This page is the list of host settings both servers
must have, how to check them, and how to set them without locking yourself
out.

It does not replace the external penetration test: it covers the settings
such a test would find first.

## 2. The checklist

Run on each host, as the administration user (`ubuntu`). Every line says what
it must show.

```bash
# The applications do not run as root
docker exec oscar id                 # OSCAR host:     uid=1000(node)
docker exec osdm-simulator id        # simulator host: uid=1000

# The containers have no privileges
docker inspect oscar osdm-simulator --format '{{.Name}} cap_drop={{.HostConfig.CapDrop}} opts={{.HostConfig.SecurityOpt}} ro={{.HostConfig.ReadonlyRootfs}}'
#   /oscar          cap_drop=[ALL] opts=[no-new-privileges:true] ro=false
#   /osdm-simulator cap_drop=[ALL] opts=[no-new-privileges:true] ro=true

# Only 22, 80 and 443 listen on every address; everything else on 127.0.0.1
sudo ss -tlnp

# Firewall: deny incoming by default, allow 22, 80, 443
sudo ufw status verbose

# SSH: keys only, no root
sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '
#   permitrootlogin no               (or prohibit-password, see 3.3)
#   passwordauthentication no
#   kbdinteractiveauthentication no

# Each deploy key runs one installed script, outside the checkout
sudo grep -ho '^command="[^"]*"' /home/*/.ssh/authorized_keys
#   OSCAR host:     command="/usr/local/sbin/oscar-refresh-collection"
#   simulator host: command="/usr/local/sbin/osdm-simulator-update"

# Who is root in practice: sudo, and the docker group (the Docker socket is root)
getent group sudo docker

# Brute-force protection and security updates
systemctl is-active fail2ban                       # active
cat /etc/apt/apt.conf.d/20auto-upgrades            # both values "1"

# Containers that can reach the Docker socket (each is root on the host)
docker ps --format '{{.Names}}  {{.Image}}  {{.Mounts}}' | grep docker.sock
```

And from outside, once a host name points at the server: a TLS test of the
name (for example SSL Labs), and `nmap -Pn -p- <host>` showing 22, 80 and 443
only.

## 3. Setting it

### 3.1 Before you start: who has already logged in

```bash
sudo journalctl -u ssh --since "30 days ago" | grep -c "Failed password"
sudo journalctl -u ssh --since "30 days ago" | grep "Accepted" | awk '{print $7, $9, $11}' | sort | uniq -c
last -i | head -20
```

The second line lists each successful login with its method (`password` or
`publickey`), account and address. Every address must be yours or GitHub's
(the deploy key). An address you do not know is an incident: stop here, keep
the server as it is, and treat it as compromised (Disaster Recovery page),
rather than hardening a machine someone else may already hold.

### 3.2 An administration user with a key

Keep the session you are working in open until the end of 3.3, and test each
step in a **second** window.

On your own computer (PowerShell or a shell):

```bash
ssh-keygen -t ed25519          # if you have no key yet
cat ~/.ssh/id_ed25519.pub      # PowerShell: type $env:USERPROFILE\.ssh\id_ed25519.pub
```

On the server, as `root` (or with `sudo`):

```bash
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
echo 'ssh-ed25519 AAAA... you@your-pc' >> /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
passwd ubuntu                  # for sudo only; SSH will not accept it
```

In the second window: `ssh ubuntu@<host>`, then `sudo id` must print `uid=0`.
Do not go on until it does.

### 3.3 SSH: keys only, no root

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

- The file name starts with `00-` because `sshd` keeps the first value it
  reads, and a file the hosting provider put in `sshd_config.d/` may set the
  opposite. `sshd -T` shows the value in force, whichever file set it.
- If something needs `root` over SSH with a key (a backup pulled by another
  machine, a provider tool), use `PermitRootLogin prohibit-password` instead
  of `no`, and know what that key is: `sudo cat /root/.ssh/authorized_keys`.
- Check with the `sshd -T` line of section 2, then log in again as `ubuntu`
  from a **new** window before closing the old one.

### 3.4 Firewall

```bash
sudo apt install -y ufw
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Docker writes its own firewall rules for the ports a container publishes, and
`ufw` does not see them. That is why every port in the compose files is
published on `127.0.0.1` only (`"127.0.0.1:3001:3001"`): keep it that way for
any new service, or `ufw` will not protect it.

### 3.5 Brute-force protection and security updates

```bash
sudo apt install -y fail2ban unattended-upgrades
sudo systemctl enable --now fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades    # answer Yes
```

fail2ban's default `sshd` jail is enough once passwords are off: it keeps the
logs readable and slows down scanning.

### 3.6 Deploy keys

Each host has one deploy key, used by a GitHub workflow, and pinned in
`authorized_keys` to a single script with
`command="…",no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding`.
The script is a **copy installed outside the checkout**, so a change merged
into `main` cannot change what the key runs:

| Host | Account | Installed copy | Source | Set-up |
|---|---|---|---|---|
| OSCAR | `ubuntu` | `/usr/local/sbin/oscar-refresh-collection` | `OSCAR_Deploy/scripts/refresh-collection.sh` | `auto-deploy-setup.md`, step 4 |
| Simulator | `simdeploy` | `/usr/local/sbin/osdm-simulator-update` | `OSDM_Simulator/deploy/update.sh` | `OSCAR - OSDM Simulator.md`, §7 "Automatic update" |

When the source changes on `main`, read it, then copy it again by hand with
the same `install -m 0755 -o root -g root …` line. The OSCAR script logs a
`NOTE` (`journalctl -t oscar-deploy`) while the two differ.

The deploy account is in the `docker` group, which is root in practice: the
pinned command is what keeps the key from being a root shell. Never add a
deploy key without `command=`.

## 4. What the compose files already do

| | OSCAR (`OSCAR_Deploy/docker-compose.yml`) | Simulator (`OSDM_Simulator/deploy/docker-compose.yml`) |
|---|---|---|
| User | `node` (uid 1000), from the image | `1000:1000` |
| Capabilities | none (`cap_drop: ALL`) | none |
| `no-new-privileges` | yes | yes |
| Processes | at most 2048 (`pids_limit`) | at most 64; 256 MB of memory |
| Root file system | writable (Bruno and the server write outside `/app/data`) | read-only |
| Port | `127.0.0.1:3001` | `127.0.0.1:3002` |
| Image | `ghcr.io/top-phe/oscar-server:stable`, built from a base image named by digest | `node:22-slim` by digest, the same as OSCAR's Dockerfile |

The OSCAR settings were checked with the real server and the real Bruno CLI
under those limits: `/health` answers 200, and two complete scenarios against
the simulator gave the same checks as without them. A change to the compose
file takes effect at the next `docker compose up -d`, not at a restart.

### 4.1 Still open

- `watchtower` (automatic updates) and `autoheal` (restarts) mount the Docker
  socket, so each of them is root on the OSCAR host, and `watchtower`'s image
  is taken as `:latest`. Replacing `watchtower` with a deployment triggered by
  the release workflow, through a pinned deploy key like the one above, is a
  separate change: it changes how releases reach production.
- The OSCAR container's root file system is writable; making it read-only
  needs every place Bruno and the server write (temporary files, the run's
  environment files) to be a volume or a `tmpfs` first.
