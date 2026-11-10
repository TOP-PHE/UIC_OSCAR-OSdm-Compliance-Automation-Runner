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
| 7 | First administrator, e-mail, parallel runs |
| 8 | A test on the simulators |
| 8a | Monitoring: Prometheus, Grafana, Loki |
| 9 | Looking after it |
| 10 | Removing it |
| 11 | When something does not work |

## 1. The machine, its name and its firewall

- **Ubuntu 24.04 LTS.** 4 vCPU and 8 GB at least; 8 vCPU and 16 GB to run
  about 20 scenarios at once. 40 GB of disk.
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

Put k3s's settings and Traefik's in place first, then install the pinned k3s.
Replace the e-mail address with the one Let's Encrypt writes to about your
certificate:

```bash
cd /opt/oscar
sudo mkdir -p /etc/rancher/k3s /var/lib/rancher/k3s/server/manifests
sudo cp OSCAR_Deploy/kubernetes/k3s/config.yaml /etc/rancher/k3s/config.yaml
sudo cp OSCAR_Deploy/kubernetes/k3s/traefik-config.yaml /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
sudo sed -i 's/CHANGE-ME@example.org/you@example.org/' /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.36.6+k3s1 sh -
```

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

Check (a minute or two after the install):

```bash
sudo kubectl get nodes
sudo kubectl -n kube-system rollout status deployment/traefik
```

`kubectl` is k3s itself, which reads `/etc/rancher/k3s/k3s.yaml`. If another
`kubectl` was already installed, write `sudo k3s kubectl` instead.

Then check the firewall from your PC (section 1, *Check it from your PC*):
443 open, 6443 and 10250 closed.

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

## 7. First administrator, e-mail, parallel runs

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
- One run takes about 0.25 CPU.
- On one machine, about 2.5 per vCPU leaves room for k3s, Traefik and OSCAR:
  20 on 8 vCPU.
- The first start set it to 6.

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

- **Do not load a copy of the production data here to run it.** It holds the
  providers' real endpoints and the testers' credentials: the runs would go to
  their systems from an address they do not know. Moving a VPS for good is
  section 6a of the
  [Deployment Guide](OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md).

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
it is a Secret of your own. Fill in the mail server and the administrators'
address, then:

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
| **Backups** | as on the VPS | `sudo OSCAR_Deploy/kubernetes/oscar-data.sh save /root/oscar-save-$(date +%F)`: OSCAR stops for a minute, then the database, data files and reports are in that folder. Encrypt it and copy it off the machine. `ENCRYPTION_KEY` stays in your password manager. To restore: k3s, steps 4–6 with the same key, then `oscar-data.sh load <folder> --replace`. |
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
| Step 2 or 3 stops: *Could not resolve host: github.com*, or k3s's install says *Download failed* | The machine reached GitHub badly: its name lookup (`getent hosts github.com`) or GitHub itself ([githubstatus.com](https://www.githubstatus.com)). Run the same command again; if names keep failing, give the machine public resolvers (`DNS=1.1.1.1 9.9.9.9` in `/etc/systemd/resolved.conf.d/`, then `systemctl restart systemd-resolved`): k3s's pods use the machine's resolvers to find the providers too. |
| The browser warns about Traefik's own certificate | Let's Encrypt did not give one yet. Check that the name points at the machine, port 443 is open, and the e-mail is not still `CHANGE-ME@example.org`. `sudo kubectl -n kube-system logs deploy/traefik \| grep -i acme` says why. Let's Encrypt refuses a name after five failures in an hour. |
| Everyone is locked out of signing in after a few failed attempts | OSCAR sees one address for everyone. `sudo kubectl -n kube-system get service traefik -o jsonpath='{.spec.externalTrafficPolicy}'` must say `Local`: `traefik-config.yaml` was not in place, or was changed. |
| A file over 50 MB is refused with 413 | On purpose, as on the VPS (`overlays/k3s/middleware.yaml`). |
| Runs end as *the run's pod did not start* | `sudo kubectl -n oscar-runs get events`: the run image cannot be pulled (`RUN_IMAGE`), or the quota is full. |
| Every run fails at once, *the runner agent could not be reached* | The dispatcher is not running: `sudo kubectl -n oscar logs deploy/oscar-dispatcher`. |
| Runs of a large batch get 429 from the simulator | This machine's address is not trusted by the simulator (section 8). |
| `kubectl`: *permission denied* on `/etc/rancher/k3s/k3s.yaml` | Use `sudo`: the kubeconfig is root's only, on purpose. |
| `/grafana/` answers *restricted to administrators* (401) | Nobody is signed in to OSCAR in this browser, or not as an administrator: sign in to OSCAR first, then open Grafana. |
| Step 3 of section 8a: *no matches for kind "ServiceMonitor"* | The chart was not in yet: its install is a job, `sudo kubectl -n kube-system logs job/helm-install-kube-prometheus-stack` says how far it got. Run step 3 again. |
| Alertmanager's pod waits (*ContainerCreating*) | The Secret `oscar-alertmanager` is missing in `monitoring` (section 8a, step 1). |
| *OSCAR · Kubernetes* shows no run | Runs are pods in pod mode only (`overlays/k3s`), and a run shorter than 15 s may come and go between two readings. |
