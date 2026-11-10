# OSCAR — k3s on one VPS

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC © 2026."

---

Step by step: OSCAR on one Ubuntu machine with [k3s](https://k3s.io), each
run in a pod of its own (pod mode), behind the Traefik that k3s ships. Use it
for a test installation beside the production VPS, or for a production on one
machine. The details behind each step are in the
[Kubernetes and OpenShift Deployment Guide](OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md).

**Tested.** On every change to these files, and every week, the job
"k3s on one machine" of `.github/workflows/ci-kubernetes.yml` follows this
document on a fresh machine:
- the same k3s version and files;
- a scenario run on the OSDM simulator, in a pod of its own;
- Traefik's redirect, body limit and client address;
- what a run pod may reach;
- the monitoring of section 8a: what Prometheus reads, the alerts, Grafana
  behind OSCAR's sign-in, the logs in Loki, who reaches what.

Only Let's Encrypt is left out: the CI machine has no public name.

| Step | What |
|---|---|
| 1 | The machine, its name and its firewall |
| 2 | The files |
| 3 | k3s |
| 4 | The runs' namespace |
| 5 | OSCAR's namespace and secrets |
| 6 | OSCAR |
| 6a | Or: OSCAR from a backup (recovery, or the move from the VPS) |
| 7 | First administrator, e-mail, parallel runs |
| 8 | A test on the simulators |
| 8a | Monitoring: Prometheus, Grafana, Loki |
| 9 | Looking after it |
| 10 | Removing it |
| 11 | When something does not work |

## 1. The machine, its name and its firewall

- **Ubuntu 24.04 LTS.** 4 vCPU and 8 GB at least. Each run is a pod of its
  own, which costs more CPU than a run on the VPS: count about one scenario
  at a time per vCPU (section 7). 8 vCPU and 16 GB run about 8 at once; 20 at
  once need about 20 vCPU. 40 GB of disk.
- **Nothing else on ports 80 and 443**: no nginx, no OSCAR Docker stack on
  this machine.
- **A DNS name** (an A record) pointing at the machine, *before* step 6: Let's
  Encrypt checks it. Below it is `oscar-test.example.org`; use yours.
- **A firewall in front of the machine: inbound 22, 80 and 443 only**, set
  before section 3 (below).
- The tools this document uses:

```bash
sudo apt-get update && sudo apt-get install -y git jq openssl curl
```

### The firewall

Set it **before section 3**. From its first start k3s listens on every
address: its API (port 6443) gives every right on the cluster to whoever
holds a token, and its kubelet (10250) runs commands in the pods. Use the
**hosting provider's firewall**, which filters the traffic before it reaches
the machine:

| Inbound | From | What for |
|---|---|---|
| TCP 22 | your own addresses if they are fixed, else anywhere | SSH |
| TCP 80 | anywhere | http, which Traefik sends to https |
| TCP 443 | anywhere | OSCAR and Grafana; Let's Encrypt checks the certificate there |
| anything else | **blocked** | among them 6443 (k3s's API), 10250 (the kubelet), 9100 (the machine's exporter, section 8a) |

Outbound stays open: OSCAR reaches the providers, the simulator, the mail
server, GitHub, the image registries and Let's Encrypt from here.

- **Contabo**: customer panel → *Network* → *Firewall* → create a firewall
  with three inbound rules, TCP 22, 80 and 443, every other inbound traffic
  blocked; then assign it to the VPS. Other hosts have the same under another
  name (OVHcloud: the *Edge Network Firewall* of the machine's IP; Hetzner:
  *Firewalls*).
- **Ubuntu's own firewall stays off**: `sudo ufw disable`. k3s advises it,
  because ufw's rules get in the way of the pods' traffic. If your host has no
  firewall of its own, choose one that does: a firewall on the machine itself
  must let the pods' networks through, which this guide does not cover.

**Check it from your PC** once k3s and Traefik run (end of section 3), with
your machine's name. In PowerShell:

```powershell
Test-NetConnection oscar-test.example.org -Port 443 -InformationLevel Quiet
Test-NetConnection oscar-test.example.org -Port 6443 -InformationLevel Quiet
Test-NetConnection oscar-test.example.org -Port 10250 -InformationLevel Quiet
Test-NetConnection oscar-test.example.org -Port 9100 -InformationLevel Quiet
```

443 must answer `True`; 6443, 10250 and 9100 `False` (after a few seconds
each). From Linux or macOS: `nc -zv -w 5 oscar-test.example.org 6443` must
fail. A `True` on any of the last three: the firewall is not applied to this
machine, or lets that port through.

## 2. The files

```bash
sudo mkdir -p /opt/oscar && sudo chown "$USER" /opt/oscar
git clone https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner.git /opt/oscar
cd /opt/oscar
```

Every command below runs from `/opt/oscar`.

## 3. k3s

**First, the machine's name lookups.** k3s downloads its images by name, and
OSCAR's pods find the providers through the machine's resolvers. Some hosts'
resolvers answer slowly: in November 2026, Contabo's took 5 s for one name,
and k3s's image downloads failed. Check:

```bash
time getent hosts auth.docker.io
```

If `real` is over a second, or no address comes back, give the machine and
k3s's pods public resolvers before going on:

```bash
sudo mkdir -p /etc/systemd/resolved.conf.d /etc/rancher/k3s
sudo tee /etc/systemd/resolved.conf.d/public-dns.conf > /dev/null <<'EOF'
[Resolve]
DNS=1.1.1.1 9.9.9.9
EOF
sudo systemctl restart systemd-resolved
sudo tee /etc/rancher/k3s/resolv.conf > /dev/null <<'EOF'
nameserver 1.1.1.1
nameserver 9.9.9.9
EOF
time getent hosts auth.docker.io
```

The second lookup answers in a few hundredths of a second. Two files, because
the machine and the pods do not read the same list:
- `public-dns.conf` is the machine's (k3s's image downloads). It puts the
  public resolvers first; the host's own stay as a fallback.
- `/etc/rancher/k3s/resolv.conf` is the pods'. k3s gives it to CoreDNS, which
  every pod asks (OSCAR, the runs, the monitoring). Without it k3s gives
  CoreDNS the machine's whole list, the slow resolvers included, and CoreDNS
  picks among them at random. The install below names it in k3s's settings.

On a machine that must use your organisation's own resolvers, ask its network
team instead.

Then put k3s's settings and Traefik's in place, and install the pinned k3s.
Replace the e-mail address with the one Let's Encrypt writes to about your
certificate:

```bash
cd /opt/oscar
sudo mkdir -p /etc/rancher/k3s /var/lib/rancher/k3s/server/manifests
sudo cp OSCAR_Deploy/kubernetes/k3s/config.yaml /etc/rancher/k3s/config.yaml
if [ -f /etc/rancher/k3s/resolv.conf ]; then echo 'resolv-conf: /etc/rancher/k3s/resolv.conf' | sudo tee -a /etc/rancher/k3s/config.yaml; fi
sudo cp OSCAR_Deploy/kubernetes/k3s/traefik-config.yaml /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
sudo sed -i 's/CHANGE-ME@example.org/you@example.org/' /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.36.6+k3s1 sh -
```

The `if` line prints `resolv-conf: /etc/rancher/k3s/resolv.conf` when you
wrote the pods' resolvers above, and nothing otherwise.

What the two files do:
- [`k3s/config.yaml`](../../OSCAR_Deploy/kubernetes/k3s/config.yaml): the
  kubeconfig, which holds every right on the cluster, is root's only, and
  Kubernetes Secrets (OSCAR's `ENCRYPTION_KEY` among them) are encrypted on
  disk. This one must be in place before the first start.
- [`k3s/traefik-config.yaml`](../../OSCAR_Deploy/kubernetes/k3s/traefik-config.yaml):
  - `http` is sent to `https`;
  - Let's Encrypt certificates, by the TLS challenge on port 443, kept on the
    machine;
  - the client's own address reaches OSCAR, so its sign-in limit counts per
    person;
  - a slow upload is waited for as long as on the VPS.

Check, a minute or two after the install. Run the commands one at a time and
compare each answer with the table:

```bash
sudo kubectl get nodes
sudo kubectl -n kube-system rollout status deployment/traefik --timeout=5m
sudo kubectl -n kube-system get pods
```

| Command | The right answer | Otherwise |
|---|---|---|
| `get nodes` | One line: the machine's name, `Ready`, `control-plane`, `v1.36.6+k3s1` | `NotReady`: k3s is still starting; ask again in a minute. Still `NotReady` after 5 minutes: `sudo journalctl -u k3s --since -10min \| tail -n 50` says why. *The connection to the server 127.0.0.1:6443 was refused*: k3s is not running, `sudo systemctl status k3s`. |
| `rollout status … traefik` | `deployment "traefik" successfully rolled out` | *deployments.apps "traefik" not found*: k3s has not installed Traefik yet (its `helm-install-traefik` job); ask again in a minute. *timed out waiting*: the next command says which pod waits. |
| `get pods` | Every pod `Running` (READY `1/1`, `2/2` for `svclb-traefik-…`) or `Completed` (the two `helm-install-traefik…` jobs). The list: `coredns`, `local-path-provisioner`, `metrics-server`, `svclb-traefik`, `traefik`, `helm-install-traefik`, `helm-install-traefik-crd`. A job may show `RESTARTS` 1 or 2: it waited for Traefik's resource types. | `ImagePullBackOff` or `ErrImagePull` (often `svclb-traefik` and a `helper-pod-create-pvc-…`), Traefik `Pending`: k3s could not download an image, see section 11. `CrashLoopBackOff` on `traefik`: `sudo kubectl -n kube-system logs deploy/traefik --tail=30` says why, usually a typo in `traefik-config.yaml`. |

If you gave the pods public resolvers, check what they received:

```bash
sudo sh -c 'cat /var/lib/rancher/k3s/agent/containerd/io.containerd.grpc.v1.cri/sandboxes/*/resolv.conf' | grep nameserver | sort | uniq -c
```

Only `nameserver 10.43.0.10` (CoreDNS, which the pods ask), `nameserver
1.1.1.1` and `nameserver 9.9.9.9` (CoreDNS's own) may appear, each with a
count. Any other address is one of the host's resolvers: the `resolv-conf`
line is missing from `/etc/rancher/k3s/config.yaml` (section 11).

`kubectl` is k3s itself, which reads `/etc/rancher/k3s/k3s.yaml`. If another
`kubectl` was already installed, write `sudo k3s kubectl` instead.

Then check the firewall from your PC (section 1, *Check it from your PC*):
443 must answer `True`; 6443, 10250 and 9100 `False`. 443 `False` while every
pod above is right: the firewall does not let 443 through, or is not assigned
to this machine yet.

**Why Traefik and not ingress-nginx:** the community ingress-nginx stopped
being maintained in March 2026 (no more security fixes). Traefik is the one
k3s installs and updates itself.

## 4. The runs' namespace

The runs' namespace `oscar-runs`, its quota, its network policy, and the run
dispatcher's rights there:

```bash
cd /opt/oscar
sudo kubectl apply -k OSCAR_Deploy/kubernetes/runs
```

## 5. OSCAR's namespace and secrets

```bash
cd /opt/oscar
sudo kubectl create namespace oscar
sudo kubectl label namespace oscar pod-security.kubernetes.io/enforce=restricted
umask 077
printf 'ENCRYPTION_KEY=%s\nJWT_SECRET=%s\nPLATFORM_BOOTSTRAP_TOKEN=%s\nMETRICS_TOKEN=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 64)" "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > ~/oscar-secrets.env
sudo kubectl -n oscar create secret generic oscar-secrets --from-env-file="$HOME/oscar-secrets.env"
sudo kubectl -n oscar create secret generic oscar-runner --from-literal=RUN_AGENT_TOKEN="$(openssl rand -hex 32)"
cat ~/oscar-secrets.env
```

- **Copy `ENCRYPTION_KEY` into your password manager.** Without it, neither a
  backup nor this machine's disk can be read.
- Keep `PLATFORM_BOOTSTRAP_TOKEN` for step 7.
- Then remove the file:

```bash
shred -u ~/oscar-secrets.env
```

## 6. OSCAR

Copy the overlay to a folder of your own (`overlays/site`, which git leaves
alone, so a later `git pull` never meets your changes), write your name in
it, then deploy:

```bash
cd /opt/oscar
cp -r OSCAR_Deploy/kubernetes/overlays/k3s OSCAR_Deploy/kubernetes/overlays/site
HOST=oscar-test.example.org
sed -i "s/oscar.example.org/$HOST/g" OSCAR_Deploy/kubernetes/overlays/site/kustomization.yaml OSCAR_Deploy/kubernetes/overlays/site/ingress.yaml
sudo kubectl -n oscar apply -k OSCAR_Deploy/kubernetes/overlays/site
sudo kubectl -n oscar rollout status deployment/oscar-dispatcher
sudo kubectl -n oscar rollout status deployment/oscar
curl -s "https://$HOST/health"
```

- [`overlays/k3s`](../../OSCAR_Deploy/kubernetes/overlays/k3s/) runs OSCAR in
  pod mode. Its images are the published ones of a release
  (`ghcr.io/top-phe/oscar` and `oscar-run`): `newTag` and `RUN_IMAGE` name the
  same release.
- The first `https` request can take a minute while Traefik obtains the
  certificate.
- `/health` names the release and says `"compatibility_status": "tested"`.

## 6a. Or: OSCAR from a backup (recovery, or the move from the VPS)

To bring back an OSCAR that was lost, or to move the VPS's, from a backup
([Disaster Recovery](OSCAR%20-%20Disaster%20Recovery.md)): do sections 1 to 4,
then this section **instead of** sections 5 to 7. Everything that is in the
database comes with it: companies, providers, users and their passwords,
endpoints and credentials, Test Frameworks, findings, run history, and Admin
→ *Server Config* (the mail server and the alert recipients included).

**1. The backup on this machine.** Copy the archive here (`scp` from where it
is kept), then open it in a folder only you can read: it holds the
encryption key and every account's password hash. The passphrase is asked.

```bash
sudo apt-get install -y gnupg
mkdir -m 700 ~/oscar-restore
gpg --decrypt ~/oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg | tar -xz -C ~/oscar-restore
jq . ~/oscar-restore/manifest.json
```

`release_tag` is the release the backup was made with. **This machine runs
that release or a later one, never an earlier one**: the first start migrates
the database forward, and a migration is not undone.

**2. The files of that release** (or a later one, the same in both commands):

```bash
cd /opt/oscar
git fetch --tags origin
git checkout release-YYYY.NNN
```

**3. OSCAR's secrets, with the backup's keys.** The same `ENCRYPTION_KEY`, or
the stored credentials, data files and reports cannot be read; the same
`JWT_SECRET`; a new `METRICS_TOKEN`; no `PLATFORM_BOOTSTRAP_TOKEN` (the
administrators come with the database). If a value is between quotes in
`.env`, remove them in `oscar-secrets.env` first.

```bash
cd /opt/oscar
sudo kubectl create namespace oscar
sudo kubectl label namespace oscar pod-security.kubernetes.io/enforce=restricted
umask 077
grep -E '^(ENCRYPTION_KEY|JWT_SECRET)=' ~/oscar-restore/.env > ~/oscar-secrets.env
printf 'METRICS_TOKEN=%s\n' "$(openssl rand -hex 32)" >> ~/oscar-secrets.env
sudo kubectl -n oscar create secret generic oscar-secrets --from-env-file="$HOME/oscar-secrets.env"
sudo kubectl -n oscar create secret generic oscar-runner --from-literal=RUN_AGENT_TOKEN="$(openssl rand -hex 32)"
shred -u ~/oscar-secrets.env
```

**4. OSCAR**, as in section 6, with the images of the release of step 2: the
overlay in the files names an older one.

```bash
cd /opt/oscar
cp -r OSCAR_Deploy/kubernetes/overlays/k3s OSCAR_Deploy/kubernetes/overlays/site
HOST=oscar-test.example.org
sed -i "s/oscar.example.org/$HOST/g" OSCAR_Deploy/kubernetes/overlays/site/kustomization.yaml OSCAR_Deploy/kubernetes/overlays/site/ingress.yaml
sed -i "s/release-[0-9]*\.[0-9]*/release-YYYY.NNN/" OSCAR_Deploy/kubernetes/overlays/site/kustomization.yaml
grep -n 'release-' OSCAR_Deploy/kubernetes/overlays/site/kustomization.yaml
sudo kubectl -n oscar apply -k OSCAR_Deploy/kubernetes/overlays/site
sudo kubectl -n oscar rollout status deployment/oscar --timeout=600s
```

`grep` shows `newTag` and `RUN_IMAGE` both on that release. OSCAR starts with
an empty database: **do not create an administrator**.

**5. The data.** OSCAR stops for the copy, the database is checked against
`manifest.json` (users, companies), then OSCAR starts again and migrates it:

```bash
cd /opt/oscar
sudo OSCAR_Deploy/kubernetes/oscar-data.sh load ~/oscar-restore/data
sudo kubectl -n oscar rollout status deployment/oscar --timeout=900s
curl -s "https://$HOST/health"
```

`/health` names the release and says `"compatibility_status": "tested"`. A
large database takes a few minutes to migrate at the first start. If the copy
stops half-way, OSCAR stays stopped: run the load again.

**6. Admin → *Server Config*.** Sign in with an administrator account of the
backup.
- **Max Concurrent Runs** is the VPS's: set it for this machine (section 7).
- The mail server and the alert recipients are the VPS's: OSCAR's e-mails
  (sign-in links, access requests) work at once, and their links name `$HOST`.
- *Apply alerting config* writes the VPS's file only: on this machine the
  alerts are configured in section 8a, from these same values.

**7. Monitoring**: section 8a. At its step 1, make Alertmanager's
configuration from *Server Config* (the first way there): the e-mail of the
alerts is then the VPS's, with nothing typed again.

**8. Check before anyone uses it.**
- Sign in as a tester or Test Manager; open a company's Test Config (its data
  file is read with the key).
- Run one scenario on the simulator (the credentials are read with the key,
  and a provider is reached).
- In Grafana (section 8a), *OSCAR · Overview* shows the run.

**9. The name and the addresses.**
- **A real recovery:** point OSCAR's name (`oscar.uic.org`) at this machine,
  and use it as `HOST` in steps 4 and 8a. Links already sent keep working.
- **A test while the VPS still runs:** use a test name. This copy holds the
  providers' real endpoints and the testers' credentials. A run here reaches
  their systems from this machine's address: the providers that allow-list the
  VPS refuse it. A provider that renews an OAuth token by rotating it may
  sign the VPS out of it, until the tester saves the credentials there again.
  The e-mails this copy sends go to the real users, with links to the test
  name.
- **The simulator** trusts the VPS's address only: add this machine's
  ([OSCAR - OSDM Simulator](OSCAR%20-%20OSDM%20Simulator.md), section 7,
  "Trusting the OSCAR server's address").

**10. Clean up**, once the checks pass. The folder holds the key and every
password hash:

```bash
rm -rf --one-file-system ~/oscar-restore
```

On the VPS, record the restore drill for the Admin Dashboard
([Disaster Recovery](OSCAR%20-%20Disaster%20Recovery.md), section 5):
`/opt/OSCAR/OSCAR_Deploy/scripts/oscar-backup-status.sh drill`.

**What does not come with a backup:** Prometheus's figures, Loki's logs and
Grafana's users (made again at their first visit, as viewers), and the VPS's
backup timer: this machine's backups are `oscar-data.sh save` (section 9).

## 7. First administrator, e-mail, parallel runs

After section 6a, only *Parallel runs* below applies: the administrators and
the mail server came with the backup.

**First administrator.** With the bootstrap token from step 5 (password: at
least 12 characters, upper and lower case, a digit):

```bash
curl -X POST https://oscar-test.example.org/v1/auth/bootstrap/platform-user \
  -H 'Content-Type: application/json' \
  -H 'X-Platform-Bootstrap-Token: PASTE_PLATFORM_BOOTSTRAP_TOKEN_HERE' \
  -d '{
    "email":    "you@example.org",
    "password": "ChooseAStrongPasswordHere123!",
    "role":     "administrator"
  }'
```

Then remove the token from the Secret, so it cannot be used again:

```bash
sudo kubectl -n oscar patch secret oscar-secrets --type=json \
  -p='[{"op":"remove","path":"/data/PLATFORM_BOOTSTRAP_TOKEN"}]'
sudo kubectl -n oscar rollout restart deployment/oscar
```

**E-mail.** Set the SMTP server in Admin → *Server Config*. People get into
OSCAR by an e-mailed link, the first Test Manager of a company included:
without e-mail, nobody but the administrator can sign in.

**Parallel runs.** Admin → *Server Config* → *Max Concurrent Runs*.
- Each run is a pod: Bruno takes 0.4 to 0.7 CPU while it starts (about 7 s
  of CPU), then about 0.25; k3s and containerd add the work of making and
  removing the pod.
- **About one per vCPU**: 6 on 6 vCPU, 8 on 8. Measured on 6 vCPU (#1150):
  20 and 10 at once filled the machine (up to 56 processes waiting for a
  CPU), OSCAR answered its health check after more than 10 s and stopped
  serving pages; 6 at once kept the load near 1.3 per CPU.
- The first start set it to 6. **A database moved from the VPS keeps the
  VPS's value** (section 6a of the Deployment Guide): set it again here.
- Watch it in Grafana (section 8a), *OSCAR · Kubernetes*: *Load per CPU*
  under about 1.5 and *CPU by run pod* tell whether to raise or lower it.

## 8. A test on the simulators

- Set up the companies or providers as on the VPS: their endpoint on the
  simulator, the credentials, then Test Config → a simulator reference
  ([OSCAR - OSDM Simulator](OSCAR%20-%20OSDM%20Simulator.md), section 5).
- **Tell the simulator this machine's address.** It trusts the production
  VPS's address only: add this machine's to `SIM_TRUSTED_ADDRESSES` and to
  nginx's `geo` block on the simulator's host (same document, section 7,
  "Trusting the OSCAR server's address"). Without it, a large batch meets the
  simulator's rate limits (429).
- During a batch, each running scenario is a pod, removed when it ends:

```bash
sudo kubectl -n oscar-runs get pods
```

- **A copy of the production data (section 6a) runs against the providers'
  real systems**: it holds their real endpoints and the testers' credentials,
  and the runs would go to them from an address they do not know. Read step 9
  of section 6a before running anything there.

## 8a. Monitoring

What the VPS's metrics overlay gives (`docker-compose.metrics.yml`), on this
machine:
- **Prometheus, Alertmanager and Grafana**: the chart kube-prometheus-stack 92.13.1,
  which k3s's own Helm controller installs (no `helm` to install);
- **Loki** for the logs, with the VPS's configuration, and **Grafana Alloy**
  to send them there;
- what OSCAR adds: the reading of `/metrics`, the VPS's alerts, and its
  dashboards.

It takes about 1.5 GB of memory. Prometheus keeps 15 days (8 GB at most);
Loki keeps the logs without limit, as on the VPS.

**1. Alertmanager's configuration.** It holds the mail server's password, so
it is a Secret of your own, made one of two ways.

**From Admin → *Server Config***, when its *SMTP* and *Alerting* sections are
filled in (always after section 6a: they are the VPS's). OSCAR writes the
file from those values, as on the VPS, and you make it the Secret; the server
itself gets no right on the cluster:

```bash
cd /opt/oscar
sudo kubectl apply -f OSCAR_Deploy/kubernetes/monitoring/stack/namespace.yaml
umask 077
sudo kubectl -n oscar exec deploy/oscar -c oscar -- node --no-warnings -e "console.log = console.error; process.stdout.write(require('/app/src/utils/alertmanagerConfig').renderConfig())" > ~/alertmanager.yaml \
  && sudo kubectl -n monitoring create secret generic oscar-alertmanager --from-file=alertmanager.yaml="$HOME/alertmanager.yaml"
shred -u ~/alertmanager.yaml
```

- "SMTP_HOST is empty" or "ALERT_RECIPIENTS is empty": fill that in Server
  Config first (and nothing was created).
- From server 1.11.494 the file sends the chart's Watchdog (an alert that
  always fires) and its "info" alerts to no one; an earlier server's file
  mails the Watchdog every 4 hours.
- After a change in Server Config, run the same lines again, ending the
  second command with `--dry-run=client -o yaml | sudo kubectl apply -f -`:
  it replaces the Secret, and Alertmanager reads it again within a minute.
  *Apply alerting config* on that page writes the VPS's file only.

**Or by hand**, from the example: fill in the mail server and the
administrators' address, then:

```bash
cd /opt/oscar
sudo kubectl apply -f OSCAR_Deploy/kubernetes/monitoring/stack/namespace.yaml
cp OSCAR_Deploy/kubernetes/monitoring/alertmanager.yaml.example ~/alertmanager.yaml
nano ~/alertmanager.yaml
sudo kubectl -n monitoring create secret generic oscar-alertmanager --from-file=alertmanager.yaml="$HOME/alertmanager.yaml"
shred -u ~/alertmanager.yaml
```

**2. The stack**, in a copy of its own with your name (`monitoring/site`,
which git leaves alone), as for OSCAR in step 6:

```bash
cp -r OSCAR_Deploy/kubernetes/monitoring/stack OSCAR_Deploy/kubernetes/monitoring/site
HOST=oscar-test.example.org
sed -i "s/oscar.example.org/$HOST/g" OSCAR_Deploy/kubernetes/monitoring/site/kube-prometheus-stack.yaml OSCAR_Deploy/kubernetes/monitoring/site/grafana-ingress.yaml
sudo kubectl apply -k OSCAR_Deploy/kubernetes/monitoring/site
```

**3. What OSCAR adds**, once the chart is in (a few minutes: the first loop
waits for it):

```bash
until sudo kubectl -n monitoring get deployment kube-prometheus-stack-operator > /dev/null 2>&1; do sleep 5; done
sudo kubectl -n monitoring rollout status deployment/kube-prometheus-stack-operator --timeout=600s
sudo kubectl apply -k OSCAR_Deploy/kubernetes/monitoring/oscar
sudo kubectl -n monitoring get pods
```

**4. Grafana.** Sign in to OSCAR as an administrator, then Admin →
*Dashboard* → *Grafana* (`https://oscar-test.example.org/grafana/`). As on
the VPS, Traefik asks OSCAR who is signed in before each request, and only an
administrator gets through. The dashboards:
- *OSCAR · Overview*, *OSCAR · Logs*, *OSDM Simulator*: the VPS's;
- *OSCAR · Kubernetes*: each run's memory and CPU, the runs stopped for
  memory, the runs' quota, OSCAR's pods, the machine;
- the chart's own *Kubernetes / …* dashboards, for any pod.

What differs from the VPS:
- **A run is a pod.** The *run processes* figures of *OSCAR · Overview* stay
  at 0 here; *OSCAR · Kubernetes* has them. Prometheus reads every 15 s, so a
  run shorter than that may not show.
- **A run's own output is not in Loki.** It is test data, which OSCAR keeps
  with the run, encrypted; Loki has no access control. Loki holds the logs of
  OSCAR's pods (the server and the dispatcher).
- **Alerts.** The VPS's, two more for the run pods (`OscarRunPodNearMemoryLimit`,
  `OscarRunPodOutOfMemory`: raise `RUN_MEMORY_LIMIT`), and the chart's own
  (a pod that does not start, the disk, the memory). Admin → *Alerting* →
  *Apply* writes the VPS's file only: here the mail comes from the Secret. To
  change it, edit a copy of the example again, then
  `sudo kubectl -n monitoring create secret generic oscar-alertmanager --from-file=alertmanager.yaml="$HOME/alertmanager.yaml" --dry-run=client -o yaml | sudo kubectl apply -f -`.
- **Prometheus's and Alertmanager's pages are not published.** To look at
  them: `sudo kubectl -n monitoring port-forward service/kube-prometheus-stack-prometheus 9090`
  on the machine, `ssh -L 9090:localhost:9090 <machine>` from your PC, then
  `http://localhost:9090`.
- **Who reaches what.** Only Traefik reaches Grafana, and neither OSCAR's pods
  nor the run pods reach Grafana, Prometheus, Alertmanager or Loki (network
  policies). The machine's exporter listens on port 9100 of the host, and
  answers Prometheus's account only.

## 9. Looking after it

On a managed cluster the provider does part of this. Here it is yours.

| What | When | How |
|---|---|---|
| **A new OSCAR release** | when you choose | `git pull` (then `diff -r OSCAR_Deploy/kubernetes/overlays/k3s OSCAR_Deploy/kubernetes/overlays/site` shows what moved besides your name), in `overlays/site/kustomization.yaml` set `newTag` and `RUN_IMAGE` to the release (its images are published a few minutes after it), then `sudo kubectl -n oscar apply -k OSCAR_Deploy/kubernetes/overlays/site`. OSCAR stops while the new pod starts. Watchtower does not apply here. |
| **A k3s update** | a patch about once a month, a new minor version about every 4 months (each is maintained about a year) | the install command of step 3 again, with the new `INSTALL_K3S_VERSION` (one minor version at a time). The settings stay. A minute without OSCAR. |
| **k3s's own certificates** | they last a year | renewed when k3s starts within 90 days of their end: an update does it, otherwise `sudo systemctl restart k3s` once a year. |
| **Backups** | as on the VPS | `sudo OSCAR_Deploy/kubernetes/oscar-data.sh save /root/oscar-save-$(date +%F)`: OSCAR stops for a minute, then the database, data files and reports are in that folder. Encrypt it and copy it off the machine. `ENCRYPTION_KEY` stays in your password manager. To restore: section 6a from its step 2, with the key from your password manager (a saved folder has no `.env`) and `oscar-data.sh load <folder>`. |
| **Disk** | now and then | `df -h /var/lib/rancher`. Old images are removed only near 85 % full; `sudo k3s crictl rmi --prune` removes the unused ones. |
| **Logs** | when something is wrong | Grafana's *OSCAR · Logs* (section 8a), or `sudo kubectl -n oscar logs deploy/oscar`, `… logs deploy/oscar-dispatcher`, `sudo kubectl -n oscar-runs get events`, `sudo kubectl -n kube-system logs deploy/traefik`. |
| **Monitoring** | after a `git pull` | `diff -r OSCAR_Deploy/kubernetes/monitoring/stack OSCAR_Deploy/kubernetes/monitoring/site` shows what moved besides your name (a new chart `version`, for instance): bring it into `monitoring/site`, then `sudo kubectl apply -k OSCAR_Deploy/kubernetes/monitoring/site` and `sudo kubectl apply -k OSCAR_Deploy/kubernetes/monitoring/oscar`. |

`oscar-data.sh` runs as root here (`sudo`), so it uses k3s's `kubectl`.

## 10. Removing it

```bash
sudo /usr/local/bin/k3s-uninstall.sh
```

This removes k3s and everything in it, OSCAR's data included: save it first
if you need it.

## 11. When something does not work

| What you see | Why, and what to do |
|---|---|
| Step 2 or 3 stops: *Could not resolve host: github.com*, or k3s's install says *Download failed* | The machine reached GitHub badly: its name lookup (`getent hosts github.com`) or GitHub itself ([githubstatus.com](https://www.githubstatus.com)). Run the same command again; if names keep failing, give the machine and the pods public resolvers (section 3, first step): k3s's pods find the providers through those resolvers too. |
| After k3s's install, pods stay in `ImagePullBackOff` (`svclb-traefik`, `helper-pod-create-pvc-…`), Traefik and its volume `Pending`, and port 443 does not answer from your PC | k3s could not download those images. `sudo kubectl -n kube-system get events \| grep -i pull` says why. *lookup … Try again* or *i/o timeout*: the machine's resolvers are slow or down (`time getent hosts auth.docker.io` takes seconds); give the machine and the pods public resolvers (section 3, first step: both files). k3s is already installed, so name the pods' file in its settings yourself: add the line `resolv-conf: /etc/rancher/k3s/resolv.conf` to `/etc/rancher/k3s/config.yaml` if it is not there (`sudo grep resolv-conf /etc/rancher/k3s/config.yaml`), then `sudo systemctl restart k3s` and `sudo kubectl -n kube-system rollout restart deployment/coredns`: CoreDNS, which every pod asks, keeps the resolvers it started with. A minute later, section 3's last check lists no other address than `10.43.0.10`, `1.1.1.1` and `9.9.9.9`. *429 Too Many Requests*: Docker Hub's limit for this address; wait an hour. A pod waiting for its image tries again within 5 minutes. |
| The browser warns about Traefik's own certificate | Let's Encrypt did not give one yet. Check that the name points at the machine, port 443 is open, and the e-mail is not still `CHANGE-ME@example.org`. `sudo kubectl -n kube-system logs deploy/traefik \| grep -i acme` says why. Let's Encrypt refuses a name after five failures in an hour. |
| Everyone is locked out of signing in after a few failed attempts | OSCAR sees one address for everyone. `sudo kubectl -n kube-system get service traefik -o jsonpath='{.spec.externalTrafficPolicy}'` must say `Local`: `traefik-config.yaml` was not in place, or was changed. |
| A file over 50 MB is refused with 413 | On purpose, as on the VPS (`overlays/k3s/middleware.yaml`). |
| Runs end as *the run's pod did not start* | `sudo kubectl -n oscar-runs get events`: the run image cannot be pulled (`RUN_IMAGE`), or the quota is full. |
| Every run fails at once, *the runner agent could not be reached* | The dispatcher is not running: `sudo kubectl -n oscar logs deploy/oscar-dispatcher`. |
| During a large batch OSCAR's pages stop answering, or a second batch cannot be started | Too many runs at once for the machine's CPUs: OSCAR waits for a CPU and answers its health check late. `sudo kubectl -n oscar get events \| grep -i unhealthy` shows `Readiness probe failed … context deadline exceeded`. Lower *Max Concurrent Runs* to about one per vCPU (section 7). Manifests from before November 2026 took OSCAR out of service after 30 s of slow answers and restarted it after 90 s: pull and apply the overlay again. |
| Runs of a large batch get 429 from the simulator | This machine's address is not trusted by the simulator (section 8). |
| `kubectl`: *permission denied* on `/etc/rancher/k3s/k3s.yaml` | Use `sudo`: the kubeconfig is root's only, on purpose. |
| `/grafana/` answers *restricted to administrators* (401) | Nobody is signed in to OSCAR in this browser, or not as an administrator: sign in to OSCAR first, then open Grafana. |
| Step 3 of section 8a: *no matches for kind "ServiceMonitor"* | The chart was not in yet: its install is a job, `sudo kubectl -n kube-system logs job/helm-install-kube-prometheus-stack` says how far it got. Run step 3 again. |
| Alertmanager's pod waits (*ContainerCreating*) | The Secret `oscar-alertmanager` is missing in `monitoring` (section 8a, step 1). |
| *OSCAR · Kubernetes* shows no run | Runs are pods in pod mode only (`overlays/k3s`), and a run shorter than 15 s may come and go between two readings. |
