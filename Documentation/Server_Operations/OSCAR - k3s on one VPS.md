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
- what a run pod may reach.

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
- **The hosting provider's firewall: inbound 22, 80 and 443 only.** k3s's API
  (6443) and its kubelet (10250) must not be reachable from the internet. k3s
  recommends turning Ubuntu's own firewall off (`sudo ufw disable`): its rules
  get in the way of the pods' traffic.
- The tools this document uses:

```bash
sudo apt-get update && sudo apt-get install -y git jq openssl curl
```

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

## 9. Looking after it

On a managed cluster the provider does part of this. Here it is yours.

| What | When | How |
|---|---|---|
| **A new OSCAR release** | when you choose | `git pull` (then `diff -r OSCAR_Deploy/kubernetes/overlays/k3s OSCAR_Deploy/kubernetes/overlays/site` shows what moved besides your name), in `overlays/site/kustomization.yaml` set `newTag` and `RUN_IMAGE` to the release (its images are published a few minutes after it), then `sudo kubectl -n oscar apply -k OSCAR_Deploy/kubernetes/overlays/site`. OSCAR stops while the new pod starts. Watchtower does not apply here. |
| **A k3s update** | a patch about once a month, a new minor version about every 4 months (each is maintained about a year) | the install command of step 3 again, with the new `INSTALL_K3S_VERSION` (one minor version at a time). The settings stay. A minute without OSCAR. |
| **k3s's own certificates** | they last a year | renewed when k3s starts within 90 days of their end: an update does it, otherwise `sudo systemctl restart k3s` once a year. |
| **Backups** | as on the VPS | `sudo OSCAR_Deploy/kubernetes/oscar-data.sh save /root/oscar-save-$(date +%F)`: OSCAR stops for a minute, then the database, data files and reports are in that folder. Encrypt it and copy it off the machine. `ENCRYPTION_KEY` stays in your password manager. To restore: k3s, steps 4–6 with the same key, then `oscar-data.sh load <folder> --replace`. |
| **Disk** | now and then | `df -h /var/lib/rancher`. Old images are removed only near 85 % full; `sudo k3s crictl rmi --prune` removes the unused ones. |
| **Logs** | when something is wrong | `sudo kubectl -n oscar logs deploy/oscar`, `… logs deploy/oscar-dispatcher`, `sudo kubectl -n oscar-runs get events`, `sudo kubectl -n kube-system logs deploy/traefik`. |

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
