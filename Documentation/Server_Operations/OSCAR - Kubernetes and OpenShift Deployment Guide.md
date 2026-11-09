# OSCAR — Kubernetes and OpenShift Deployment Guide

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC © 2026."

---

How to run OSCAR on a Kubernetes cluster or on OpenShift, with the files in
[`OSCAR_Deploy/kubernetes/`](../../OSCAR_Deploy/kubernetes/) (since server
1.11.443, #1059). The UIC production runs on a VPS with Docker Compose
([Self-Hosted Quick Start](OSCAR%20-%20Self-Hosted%20Quick%20Start.md)); this
guide is for an organisation that runs its own OSCAR on its own cluster.

**On one machine:** [OSCAR - k3s on one VPS](OSCAR%20-%20k3s%20on%20one%20VPS.md)
is the step-by-step for a single Ubuntu machine with k3s, its Traefik and pod
mode (`overlays/k3s`), tested by the CI on a real k3s.

**Status.** Every change to these files, and every week, a CI workflow
(`.github/workflows/ci-kubernetes.yml`) deploys them on a throw-away
Kubernetes cluster (kind), runs the pod under a user id the image does not
know (as OpenShift does) with the "restricted" pod security, runs a sale
scenario against the OSDM simulator through OSCAR's API, moves that data to a
second deployment with `oscar-data.sh` (section 6a) and reads it back there,
and runs the scenario again with each run in a pod of its own. They have not yet
been run on a real OpenShift cluster: the Route and OpenShift's own admission
are checked by reading, not by running. Tell us what you meet.

## 1. What runs, and what does not change

OSCAR is **one pod of two containers**, from the same image:

- `oscar`, the Node.js server, with its SQLite database on a persistent
  volume and its run queue in memory;
- `runner`, the runner agent, which starts one Bruno process per running
  scenario when the server asks. It holds none of the server's data, settings
  or secrets: not the data volume, not `oscar-secrets`. The two share only the
  runs' working folders (an `emptyDir`) and the pod's network; they do not see
  each other's processes.

That is the same program as on the VPS (where the runner is the optional
`oscar-runner` service); only the packaging differs.

| | VPS (Docker Compose) | Cluster (this guide) |
|---|---|---|
| Image | `oscar-server` from GHCR | the same server image, plus the Bruno collection and `compatibility.json` of the same release (the *bundle*), `oscar` on GHCR (section 3) |
| Collection | a folder mounted beside the container, updated by `git pull` | inside the bundle image: a new collection is a new image |
| Way in | nginx on the host, TLS | an Ingress (ingress-nginx) or an OpenShift Route |
| `/metrics` | nginx answers 404 from outside | OSCAR asks for `METRICS_TOKEN` |
| Updates | Watchtower follows `:stable` | you change the image tag and apply |
| Restarts | autoheal sidecar | Kubernetes, from the liveness probe |
| Backups | `oscar-backup.sh` on the host | volume snapshots, or `oscar-data.sh save` (section 9) |

**One replica, always.** A second pod would open the same SQLite file and run
its own queue: it would corrupt the first one's work, not share it. The
Deployment says `replicas: 1` and `strategy: Recreate` (the old pod stops
before the new one starts). OSCAR grows by giving its one pod more CPU and
memory (section 5). The runs, though, can each have a pod of their own,
spread over the cluster's nodes: pod mode, section 10a. Spreading the server
itself over several pods (PostgreSQL, a shared queue) is the Phase 3
architecture of the
[Solution Architecture](../Oscar_Server/OSCAR%20-%20OSDM%20Conformance%20Automation%20Runner%20Solution%20Architecture.md)
(§14.10); it is not built.

## 2. What you need

- A cluster with a storage class giving **ReadWriteOnce** volumes on a block
  or local file system. SQLite on a network file system (NFS, SMB, some
  "file" storage classes) risks a corrupt database: ask for block storage.
- For plain Kubernetes, an Ingress controller. `overlays/kubernetes` is
  written for ingress-nginx; **the community ingress-nginx stopped being
  maintained in March 2026** (no more security fixes): with another
  controller, translate the annotations of `ingress.yaml`, as `overlays/k3s`
  does for Traefik (`ingress.yaml`, `middleware.yaml`). For OpenShift,
  nothing more: OSCAR runs under the default `restricted-v2` SCC.
- The cluster pulls OSCAR's images from GHCR (section 3), or from your own
  registry if you build them (Docker or Podman).
- A way from the cluster to your OSDM providers' test systems (section 7).

## 3. The images

Each release's images are published on GitHub's registry, a few minutes after
the release (`.github/workflows/publish-cluster-images.yml`), under the
release's tag:

| Image | What it is |
|---|---|
| `ghcr.io/top-phe/oscar:release-YYYY.NNN` | the cluster's image (the *bundle*): the server image plus the Bruno collection and `compatibility.json` of that release. The overlays name it (`images:`). |
| `ghcr.io/top-phe/oscar-run:release-YYYY.NNN` | the run image, for pod mode only (section 10a) |

There is no `:stable` or `:latest` for a cluster: it runs the release its
overlay names, and moves to another by changing that tag (section 10).

**Building your own** (for a registry of yours, or to check what you run):
from a checkout of the **release** you deploy, so that the server and the
collection are a pair OSCAR has tested together:

```bash
git clone https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner.git oscar
cd oscar
git checkout release-2026.529          # the release to deploy
OSCAR_Deploy/kubernetes/build-images.sh registry.example.org/oscar release-2026.529
docker push registry.example.org/oscar/oscar:release-2026.529
```

The overlay's `images:` then names `registry.example.org/oscar/oscar`.
`build-images.sh` makes three images: `…/oscar-server:<tag>` (the server, as
on the VPS), `…/oscar:<tag>` (that image plus `Bruno_Collection/` and
`compatibility.json`, from `Dockerfile.bundle`), and `…/oscar-run:<tag>` (the
Bruno CLI, the collection and the run pod's entrypoint only, from
`Dockerfile.run`: one run in a pod of its own, for run isolation option 4,
#1130). The cluster runs the second; the third is for the per-run pods.
With Podman: `CONTAINER_CLI=podman OSCAR_Deploy/kubernetes/build-images.sh …`.

After the deployment, `GET /health` names the release that runs
(`release_label`) and says `compatibility_status: "tested"`. Anything else
means the server and the collection in the image are not a released pair.

## 4. Create the secrets

The secrets are never in the repository. Copy
[`base/secrets.env.example`](../../OSCAR_Deploy/kubernetes/base/secrets.env.example)
outside it, fill it in, create the Secret `oscar-secrets`, delete the copy:

```bash
kubectl create namespace oscar          # OpenShift: oc new-project oscar
kubectl -n oscar create secret generic oscar-secrets --from-env-file=secrets.env
```

The runner container has a Secret of its own, `oscar-runner`, holding only
the key the server and the runner share. The pod does not start without it:

```bash
kubectl -n oscar create secret generic oscar-runner \
  --from-literal=RUN_AGENT_TOKEN="$(openssl rand -hex 32)"
```

| Key | What it is |
|---|---|
| `ENCRYPTION_KEY` | encrypts every stored credential, data file and report. `openssl rand -hex 32`. **Keep a copy apart from the backups**: the volume cannot be read without it. |
| `JWT_SECRET` | signs sessions. `openssl rand -hex 64` |
| `PLATFORM_BOOTSTRAP_TOKEN` | creates the first administrator (section 6); remove it afterwards |
| `METRICS_TOKEN` | the bearer token `/metrics` asks for. Without it, `/metrics` is open to anyone who reaches the Ingress or Route, and its figures name your companies and providers |
| `SMTP_PASS` | mail server password, if any |

A secret manager (External Secrets, Vault, Sealed Secrets) can write the same
Secret instead.

## 5. Choose the settings

Work in an overlay, not in `base/`:

- [`overlays/kubernetes/`](../../OSCAR_Deploy/kubernetes/overlays/kubernetes/):
  an Ingress, and `fsGroup: 1000` so that the image's user can write the new
  volume.
- [`overlays/openshift/`](../../OSCAR_Deploy/kubernetes/overlays/openshift/):
  a Route; the cluster chooses the user id and the volume's group.

In the overlay you use, change:

1. **The release**: `newTag` under `images:` (section 3). The overlays name
   `ghcr.io/top-phe/oscar`; name your registry there if you build your own.
2. **The host**: `oscar.example.org` in `kustomization.yaml` (`APP_URL`,
   `ALLOWED_REDIRECT_HOSTS`) and in `ingress.yaml` or `route.yaml`.
   `APP_URL` is where the links of OSCAR's e-mails lead.
3. **The certificate**: the Secret `oscar-tls` for the Ingress; on OpenShift
   the router's default certificate applies unless you add one to the Route.

The other settings are in
[`base/settings.env`](../../OSCAR_Deploy/kubernetes/base/settings.env); to
change one, add it to the overlay's `configMapGenerator` literals
(`behavior: merge`). The ones you may want:

| Setting | Default | When to change it |
|---|---|---|
| `MAX_CONCURRENT_RUNS` | 6 | with the `runner` container's CPU limit: about 4 runs per CPU. One run is about 0.2 CPU and 250 MB. Raise that container's `resources.limits` (in a patch) and this together. |
| `TRUST_PROXY_HOPS` | 1 | 2 when a load balancer that adds its own `X-Forwarded-For` sits in front of the router or ingress controller. Too low: every user shares one login rate limit, so one person's failed logins lock everyone out. Too high: a user can pick the address they are counted under. |
| `TZ` | Europe/Paris | the time zone of logs and e-mails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` | none | to send registration, approval and password-reset e-mails |
| `ALLOW_PRIVATE_TARGETS` | not set | section 7 |

`MAX_CONCURRENT_RUNS` and the `SMTP_*` settings are read once, at the first
start, into Admin → *Server Config*; from then on that page's value counts, and
a change in `settings.env` does nothing. A database moved from a VPS (section
6a) brings the VPS's values.

The volume asks for 20 GiB (`base/data-volume.yaml`): reports grow with the
number of runs. The runs' working folders are an `emptyDir` of 4 GiB, emptied
as each run ends.

## 6. Deploy

```bash
# Kubernetes
kubectl -n oscar apply -k OSCAR_Deploy/kubernetes/overlays/kubernetes
# OpenShift
oc apply -k OSCAR_Deploy/kubernetes/overlays/openshift

kubectl -n oscar rollout status deployment/oscar
```

The first start creates the database (and an update migrates it): the startup
probe allows five minutes. Then create the first administrator as on a VPS
([Self-Hosted Quick Start](OSCAR%20-%20Self-Hosted%20Quick%20Start.md), Step 6),
with your host and the bootstrap token, and remove `PLATFORM_BOOTSTRAP_TOKEN`
from the Secret afterwards. Everything after that (companies, Test Managers,
endpoints, credentials, data files) is done in OSCAR's pages, as on any OSCAR.

The probes ask `/health` with `Host: localhost`: in production OSCAR
redirects plain http to https unless the request names localhost, and a probe
that got a redirect (or a 400 once `ALLOWED_REDIRECT_HOSTS` is set) would
restart the pod for nothing.

## 6a. Moving an OSCAR from a VPS

What moves is what a VPS backup holds: the database, the data files, the run
reports and the keys. Everything else is in the database and comes with it:
companies, providers, users and their passwords, endpoints, credentials, Test
Frameworks, findings, run history, Admin → *Server Config*.

**Before you start:**
- The cluster runs the **same release as the VPS, or a later one**. The first
  start migrates the database forward, and a migration is not undone: never an
  earlier release.
- Plan a pause. What is done on the VPS after its backup is lost: tell the
  users, and wait until the Dashboard shows no run going.
- On the workstation that does the move: `kubectl` (or `oc`), `jq`, `tar`,
  `gpg`, and bash.

**1. On the VPS: a backup, then stop OSCAR** at once
([Disaster Recovery](OSCAR%20-%20Disaster%20Recovery.md), section 5):

```bash
OSCAR_BACKUP_PASSPHRASE_FILE=~/.oscar-backup-pass /opt/OSCAR/OSCAR_Deploy/scripts/oscar-backup.sh
cd /opt/OSCAR/OSCAR_Deploy && docker compose --profile isolated stop oscar oscar-runner
```

Copy the archive to the workstation (`scp`, as the script prints). The backup
needs about the size of the VPS's `data/` free on its disk (plus the database
once more), and stops before writing anything when it is not there: check
with `df -h` and `sudo du -sh` of the `data/` folder first, and move older
archives off the VPS if needed ([Disaster Recovery](OSCAR%20-%20Disaster%20Recovery.md),
section 5).

**2. On the workstation: open the archive** in a folder you keep as safely
as a backup (it holds the key and every account's password hash):

```bash
mkdir oscar-move && cd oscar-move
gpg --decrypt ../oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg | tar -xz
ls                     # data/  .env  manifest.json
```

**3. The secrets, with the VPS's keys.** The same `ENCRYPTION_KEY`, or the
stored credentials, data files and reports cannot be read; the same
`JWT_SECRET`; a new `METRICS_TOKEN`; no `PLATFORM_BOOTSTRAP_TOKEN` (the
administrators come with the database):

```bash
grep -E '^(ENCRYPTION_KEY|JWT_SECRET|SMTP_PASS)=' .env > secrets.env
printf 'METRICS_TOKEN=%s\n' "$(openssl rand -hex 32)" >> secrets.env
kubectl create namespace oscar          # OpenShift: oc new-project oscar
kubectl -n oscar create secret generic oscar-secrets --from-env-file=secrets.env
kubectl -n oscar create secret generic oscar-runner \
  --from-literal=RUN_AGENT_TOKEN="$(openssl rand -hex 32)"
rm secrets.env
```

`kubectl` keeps a value as it is: if one is between quotes in `.env`, remove
them in `secrets.env` first.

**4. Deploy** (sections 5 and 6, and 10a for pod mode). OSCAR starts on the
empty volume and makes an empty database: do not create an administrator.

**5. Load the data:**

```bash
OSCAR_Deploy/kubernetes/oscar-data.sh load oscar-move/data
```

[`oscar-data.sh`](../../OSCAR_Deploy/kubernetes/oscar-data.sh) stops OSCAR
(its Deployment to 0), starts a pod of the same image, user and volume, puts
`oscar.db`, `datafiles/` and `artifacts/` there in place of the empty
database, checks the database and that its users and companies are those of
`manifest.json`, removes that pod and starts OSCAR again (the first start of a
later release migrates the database). It replaces a database that holds no
user, and refuses one that does unless you add `--replace`. `NAMESPACE`
(default `oscar`) and `KUBECTL=oc` change where and with what. If the copy
stops half-way, OSCAR stays stopped: run the load again.

**6. Check, before anyone uses it.** Through
`kubectl -n oscar port-forward service/oscar 3001:3001` and
`http://localhost:3001`, or the new address:
- `/health` names the release and says `compatibility_status: "tested"`;
- sign in as a known user; open a company's Test Config (its data file is
  read with the key) and run one scenario on the simulator (the credentials
  are read with the key, and the provider is reached);
- Admin → *Server Config* → *Max Concurrent Runs* is the VPS's: set it for the
  cluster (section 5 with the `runner` container; within the quota of the
  runs' namespace and your nodes in pod mode, section 10a).

**7. Switch.**
- The name: point it at the Ingress or Route. With the VPS's name, `APP_URL`
  and the links already sent keep working; the certificate must cover it.
- The outbound address: the cluster's traffic leaves from other addresses
  (an egress IP, a NAT gateway, or each node's address in pod mode). Give
  them to the providers that allow-list callers, and to the simulator, which
  trusts the VPS's address only: `SIM_TRUSTED_ADDRESSES` and nginx's `geo`
  block ([OSCAR - OSDM Simulator](OSCAR%20-%20OSDM%20Simulator.md), section 7,
  "Trusting the OSCAR server's address"). Without it a large batch meets the
  simulator's rate limits (429).
- Monitoring (section 8) and backups (section 9): the VPS's backup timer and
  Prometheus stay on the VPS. Once the cluster is in use, set the VPS's timer
  to `on-demand` (`oscar-backup-schedule.sh`).

**8. Keep the VPS stopped, not removed,** until the cluster has run for a
while. Going back is `docker compose up -d` there (in `/opt/OSCAR/OSCAR_Deploy`) and the
name pointed back: what was done on the cluster meanwhile stays on the
cluster (`oscar-data.sh save` copies it out, as a cold backup does).

## 7. Reaching the providers

Each run sends OSDM requests from the pod to the company's endpoint, and
token requests to the tester's token URL. The cluster must reach them the way
your workstation does today.

- **The provider's test system is on the internet** (https, a public address,
  possibly allow-listing callers): give the provider the cluster's outbound
  address (an egress IP on OpenShift, the NAT gateway's address elsewhere).
  Nothing to change in OSCAR.
- **It is reached through a VPN or a private network**: the cluster's network
  team must give the pod a route there (a site-to-site VPN, a peering).
  Its addresses are then private, and OSCAR refuses them: since 1.11.211 an
  endpoint or token URL must be https on a public address, so that a tenant
  cannot point OSCAR at the cluster's own services. `ALLOW_PRIVATE_TARGETS=1`
  turns that check off **entirely**. If you set it, put the limit back in the
  network, for example:

```yaml
# Only DNS, the providers' networks and the mail server. Adapt the addresses.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: oscar-egress
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: oscar
  policyTypes: [Egress]
  egress:
    - ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
    - to: [{ ipBlock: { cidr: 10.20.0.0/16 } }]        # the providers' test systems
    - to: [{ ipBlock: { cidr: 192.0.2.25/32 } }]       # the mail server
      ports: [{ protocol: TCP, port: 587 }]
```

  OpenShift also has `EgressFirewall` (OVN-Kubernetes) for names and
  addresses outside the cluster. The Bruno runs call OSCAR itself on
  `http://localhost:3001`, inside the pod: no rule is needed for that.

## 8. Monitoring

`/metrics` answers Prometheus with `Authorization: Bearer <METRICS_TOKEN>`,
and 404 to anything else. With the Prometheus Operator (OpenShift's user
workload monitoring included):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: oscar
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: oscar
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
      authorization:
        type: Bearer
        credentials:
          name: oscar-secrets
          key: METRICS_TOKEN
```

The Grafana dashboards of the VPS are in
[`OSCAR_Deploy/grafana/dashboards/`](../../OSCAR_Deploy/grafana/dashboards/)
and import as they are; what each figure means is in
[Metrics & Monitoring](metrics-and-monitoring.md). On a cluster the "host"
figures are the node's, and the container's memory is the pod's.

Logs are JSON on the container's output: your cluster's log collection takes
them as they are.

## 9. Backups

Everything is on the volume `oscar-data`: the database, the data files and
reports (encrypted with `ENCRYPTION_KEY`), the run workspaces. What a backup
holds and why the key matters: [Disaster Recovery](OSCAR%20-%20Disaster%20Recovery.md),
section 1. `oscar-backup.sh` is a host script for the VPS; on a cluster:

- **Volume snapshots** (`VolumeSnapshot`, if your storage class offers them):
  a snapshot of a running pod is like a power cut for SQLite, which recovers
  from its journal at the next start. For a copy you can trust without
  recovery, stop OSCAR first: `kubectl -n oscar scale deployment/oscar
  --replicas=0`, snapshot, `--replicas=1`.
- **Restore**: a new volume from the snapshot, named `oscar-data`, the same
  `ENCRYPTION_KEY` in `oscar-secrets`, then apply.
- **Without snapshots**: `OSCAR_Deploy/kubernetes/oscar-data.sh save <new
  folder>` stops OSCAR, copies the database, data files and reports out
  (with a `manifest.json` of their counts), and starts OSCAR again: a cold
  backup, as complete as a VPS backup's `data/`. Encrypt the folder and keep
  it off the cluster. `oscar-data.sh load <folder> --replace` puts it back.

Keep `ENCRYPTION_KEY` in your secret manager or vault, not only in the
cluster: a backup without it cannot be read, and the key alone holds no data.

The Admin Dashboard's backup card reads a status the VPS scripts write; on a
cluster it stays empty.

## 10. Updating

**From a deployment made before the runner container**: create the Secret
`oscar-runner` (section 4) before you apply, or the new pod waits for it.

Change `newTag` in the overlay to the new release (its images are on GHCR a
few minutes after the release, section 3; or build them), and in pod mode
`RUN_IMAGE` to the same release (section 10a), then apply. The old pod stops, the new one starts and migrates the database: OSCAR
is unavailable for that time. Runs in progress are cut off; they are marked
as such at the start (as after a restart of the VPS), and can be run again.
To go back, apply the previous tag, **before** anyone has used the new one
for long: a migration is not undone.

## 10a. Each run in a pod of its own (pod mode)

By default the runs execute in the pod's `runner` container. Runs that execute
at the same moment share that container. **Pod mode** (run isolation option 4,
#1130) gives each run a pod of its own, created when the run starts and
deleted when it ends. Runs then share nothing with each other: no container,
no process space, no file system, no network identity.

Pod mode adds three things to the cluster:

- **The run dispatcher**, a small Deployment beside OSCAR. It is the only
  component with Kubernetes rights, and those rights are limited to a
  namespace of its own, `oscar-runs`: create and delete a run's Job and
  Secret, follow its pod and read its log. The server keeps no Kubernetes
  credentials. The dispatcher holds none of the server's settings, secrets or
  data, and refuses to start if it can see one.
- **The runs' namespace, `oscar-runs`.** It is held to the "restricted" pod
  security standard and has a quota. Each run pod there runs the run image
  `oscar-run`, which holds Bruno, the collection and nothing of the server. A
  run pod gets:
  - no service account token, no service links;
  - a read-only root file system, every capability dropped, no privilege
    escalation, the RuntimeDefault seccomp profile;
  - the run's deadline;
  - only its own run's inputs and credentials.
- **The server's internal port, 3003**, the only thing a run pod calls. It
  serves the run's data file, the schema, the token refresh and the upload of
  the run's results, each with the run's secret, which is bound to that pod's
  address. The port has no page, no session and no other route. It is never
  exposed by an Ingress or a Route.

Network policies say who reaches what:
- a run pod reaches DNS, OSCAR's internal port and public addresses (the
  providers), not the cluster's other services, not private or link-local
  addresses, not another run;
- only run pods reach the internal port;
- only OSCAR's pod reaches the dispatcher.

They need a network plugin that enforces NetworkPolicy (Calico, Cilium,
OVN-Kubernetes on OpenShift, kindnet in recent kind). Without one, the rest
still holds, but nothing filters the run pods' traffic.

To switch:

1. **The run image** of each release is on GHCR,
   `ghcr.io/top-phe/oscar-run:release-YYYY.NNN` (section 3). If you build your
   own, push the third image `build-images.sh` makes:
   `docker push registry.example.org/oscar/oscar-run:<tag>`.
2. **Create the runs' namespace and the dispatcher's rights.** This needs a
   cluster administrator, or a project administrator on OpenShift who may
   create a project:

   ```bash
   kubectl apply -k OSCAR_Deploy/kubernetes/runs
   ```

3. **Add the component to your overlay** and name the run image of the same
   release as the overlay's `newTag` (the patch joins the overlay's
   `patches:` list when it has one):

   ```yaml
   # overlays/<yours>/kustomization.yaml
   components:
     - ../../components/pod-runs
   patches:
     - patch: |-
         apiVersion: v1
         kind: ConfigMap
         metadata:
           name: oscar-dispatcher-settings
         data:
           RUN_IMAGE: ghcr.io/top-phe/oscar-run:release-2026.529
   ```

   A patch, not a `configMapGenerator` with `behavior: merge`: kustomize
   runs an overlay's own generators before its components, so a merge into
   a ConfigMap the component makes finds nothing ("does not exist; cannot
   merge"), and a merge into `oscar-settings` of a key the component sets
   (`RUN_SERVER_URL`…) is overwritten by the component. Change any value the
   component sets with a patch like this one. The dispatcher's own image is
   the cluster image (`oscar-bundle`), as the server's is.
4. **Apply** (section 6). OSCAR's pod comes back with one container, and the
   `oscar-dispatcher` Deployment starts beside it. The Secret `oscar-runner`
   (section 4) is the key the server and the dispatcher share.
5. **Check:**

   ```bash
   kubectl -n oscar exec deploy/oscar -- printenv RUN_ISOLATION          # pod
   kubectl auth can-i create jobs -n oscar-runs --as=system:serviceaccount:oscar:oscar-dispatcher   # yes
   kubectl auth can-i get secrets -n oscar      --as=system:serviceaccount:oscar:oscar-dispatcher   # no
   ```

   Then run one scenario. `kubectl -n oscar logs deploy/oscar-dispatcher`
   shows `started oscar-run-<run id>`, and `kubectl -n oscar-runs get jobs`
   is empty again once the run has ended.

Details to know:

- **OSCAR's namespace is named in four places**: the dispatcher's
  RoleBinding and the network policy in `runs/`, and `RUN_SERVER_URL` and
  `RUN_RESULTS_URL` in the component. They say `oscar`; patch all four for
  another name.
- **A provider on a private address** (a VPN, a peering) also needs its
  range in the run pods' policy (`runs/network-policy.yaml`), as well as
  `ALLOW_PRIVATE_TARGETS` (section 7). The CI's `ci/pod-runs` does so for
  the simulator.
- **Size.** Each run pod asks for 200m CPU and 256 MiB, and may use 1 CPU
  and 1 GiB (`RUN_CPU_*`, `RUN_MEMORY_*` in `oscar-dispatcher-settings`).
  The quota of `oscar-runs` allows 50 pods: keep `MAX_CONCURRENT_RUNS` within
  it. A run pod over the quota is not made, and its run ends as "did not
  start".
- **Start time.** A run waits for its pod: a few seconds with the image
  already on the node, more on a node that must pull it first.
- **Metrics and alerts.** The server writes `oscar_run_pod_start_seconds`
  and `oscar_run_pods_ended_total{outcome}` (row *Run pods* of *OSCAR ·
  Overview*), and two alerts watch them: `OscarRunPodsNotStarting` and
  `OscarRunDispatcherRefusing` (*metrics-and-monitoring.md*, "Run pods").
  Your Prometheus reads them as section 8 says.
- **A sandboxed runtime** (gVisor, Kata Containers / OpenShift sandboxed
  containers) puts each run behind a kernel of its own. Set `RUN_RUNTIME_CLASS`
  to the RuntimeClass your cluster offers.
- **Going back:** remove the component from the overlay and apply. OSCAR's
  pod gets its `runner` container again. The runs' namespace can stay.

## 11. Not there on a cluster

- More than one replica (section 1).
- A read-only root file system: the pod writes only to its volume and `/tmp`,
  but that is not yet proven for every path, so the setting stays off.
- Grafana behind OSCAR's sign-in: on the VPS nginx asks OSCAR who you are
  before showing Grafana (`auth_request`). On a cluster use your Grafana's
  own sign-in.
- Admin → Alerting's *Apply* writes an Alertmanager file on the VPS
  (`ALERTMANAGER_CONFIG_PATH`); on a cluster configure Alertmanager as your
  cluster does.

## 12. Troubleshooting

| What you see | Why, and what to do |
|---|---|
| The pod restarts, probes answer 301 or 400 | a probe without `Host: localhost` (an edited Deployment): put the header back |
| The pod stops at once: `TRUST_PROXY_HOPS must be a whole number from 0 to 5` | the setting holds something else |
| `/health` says `data_dir` not writable, or the database cannot be opened | the volume is not writable by the pod's user: on plain Kubernetes keep `fsGroup: 1000` (`data-volume-group.yaml`); a storage class that ignores `fsGroup` needs its own way |
| An endpoint or token URL is refused: *must be an https address on a public host* | the provider is at a private address or on http: section 7 |
| Everybody is locked out of signing in after a few failed attempts | every user is seen at the router's address: `TRUST_PROXY_HOPS` is too low |
| A data file or checklist upload fails with 413 | the Ingress allows less than 50 MB: `proxy-body-size` |
| Long requests end with 504 | the router's timeout: `proxy-read-timeout` / `haproxy.router.openshift.io/timeout` (660 s) |
| `/health` shows `compatibility_status: "untested_combination"` | the image was not built from one release: rebuild from a `release-…` tag |
| Prometheus gets 404 on `/metrics` | its bearer token is not `METRICS_TOKEN` |
| The pod stays in `CreateContainerConfigError` | the Secret `oscar-runner` is missing (section 4) |
| Every run fails at once: *the runner agent could not be reached* | the `runner` container is not running: `kubectl -n oscar logs deploy/oscar -c runner` |
| The `runner` container stops at once, naming a secret or the database | it was given the server's settings (an `envFrom` or a volume added in a patch): it refuses to run beside them |
| Pod mode: every run fails at once, *the runner agent could not be reached* | the dispatcher is not running: `kubectl -n oscar logs deploy/oscar-dispatcher` |
| Pod mode: the dispatcher stops at once, naming a setting, a secret or the database | `RUN_IMAGE` or `RUN_RESULTS_URL` is missing, or it was given the server's settings: it refuses to run beside them |
| Pod mode: runs end as *the run's pod did not start* | `kubectl -n oscar-runs get events`: the run image cannot be pulled (`RUN_IMAGE`, the registry's credentials), the quota is full, or the pod is refused by the namespace's pod security |
| Pod mode: runs stop at their first request, *Required scenario variable … is empty* | the run pod cannot reach the internal port: the network policies, or `RUN_SERVER_URL` does not name OSCAR's namespace |
| The pod stays in `ImagePullBackOff` on `ghcr.io/top-phe/oscar` | the release named is not published yet (a few minutes after the release), or the tag is wrong: `release-` and the release, as in `compatibility.json` |
| `oscar-data.sh load` stops: *the volume holds a database with N users* | nothing was changed and OSCAR runs as before. Loading over a database in use needs `--replace` |
| `oscar-data.sh` stops: *the copy did not finish; OSCAR stays stopped* | the volume holds part of the data: run the same load again (it replaces it), then OSCAR starts |
| After a move, sign-in works but data files or credentials cannot be read | `oscar-secrets` does not hold the VPS's `ENCRYPTION_KEY` (section 6a, step 3) |
