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

**Status.** Every change to these files, and every week, a CI workflow
(`.github/workflows/ci-kubernetes.yml`) deploys them on a throw-away
Kubernetes cluster (kind), runs the pod under a user id the image does not
know (as OpenShift does) with the "restricted" pod security, and runs a sale
scenario against the OSDM simulator through OSCAR's API. They have not yet
been run on a real OpenShift cluster: the Route and OpenShift's own admission
are checked by reading, not by running. Tell us what you meet.

## 1. What runs, and what does not change

OSCAR is **one pod**: the Node.js server, its SQLite database on a persistent
volume, its run queue in memory, and one Bruno process per running scenario,
started by the server inside the same container. That is the same program as
on the VPS; only the packaging differs.

| | VPS (Docker Compose) | Cluster (this guide) |
|---|---|---|
| Image | `oscar-server` from GHCR | the same server image, plus the Bruno collection and `compatibility.json` of the same release (the *bundle*) |
| Collection | a folder mounted beside the container, updated by `git pull` | inside the bundle image: a new collection is a new image |
| Way in | nginx on the host, TLS | an Ingress (ingress-nginx) or an OpenShift Route |
| `/metrics` | nginx answers 404 from outside | OSCAR asks for `METRICS_TOKEN` |
| Updates | Watchtower follows `:stable` | you change the image tag and apply |
| Restarts | autoheal sidecar | Kubernetes, from the liveness probe |
| Backups | `oscar-backup.sh` on the host | volume snapshots (section 9) |

**One replica, always.** A second pod would open the same SQLite file and run
its own queue: it would corrupt the first one's work, not share it. The
Deployment says `replicas: 1` and `strategy: Recreate` (the old pod stops
before the new one starts). OSCAR grows by giving its one pod more CPU and
memory (section 5). Spreading runs over several pods (PostgreSQL, a shared
queue, one Kubernetes Job per run) is the Phase 3 architecture of the
[Solution Architecture](../Oscar_Server/OSCAR%20-%20OSDM%20Conformance%20Automation%20Runner%20Solution%20Architecture.md)
(§14.10); it is not built.

## 2. What you need

- A cluster with a storage class giving **ReadWriteOnce** volumes on a block
  or local file system. SQLite on a network file system (NFS, SMB, some
  "file" storage classes) risks a corrupt database: ask for block storage.
- For plain Kubernetes, ingress-nginx (another controller works: translate
  the annotations of `ingress.yaml`). For OpenShift, nothing more: OSCAR
  runs under the default `restricted-v2` SCC.
- A registry the cluster can pull from, and Docker or Podman to build.
- A way from the cluster to your OSDM providers' test systems (section 7).

## 3. Build the images

Build from a checkout of the **release** you deploy, so that the server and
the collection are a pair OSCAR has tested together:

```bash
git clone https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner.git oscar
cd oscar
git checkout release-2026.481          # the release to deploy
OSCAR_Deploy/kubernetes/build-images.sh registry.example.org/oscar release-2026.481
docker push registry.example.org/oscar/oscar:release-2026.481
```

`build-images.sh` makes two images: `…/oscar-server:<tag>` (the server, as on
the VPS) and `…/oscar:<tag>` (that image plus `Bruno_Collection/` and
`compatibility.json`, from `Dockerfile.bundle`). The cluster runs the second.
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

1. **The image**: `images:` → your registry, name and tag (section 3).
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
| `MAX_CONCURRENT_RUNS` | 6 | with the pod's CPU limit: about 4 runs per CPU. One run is about 0.2 CPU and 250 MB. Raise `resources.limits` (in a patch) and this together. |
| `TRUST_PROXY_HOPS` | 1 | 2 when a load balancer that adds its own `X-Forwarded-For` sits in front of the router or ingress controller. Too low: every user shares one login rate limit, so one person's failed logins lock everyone out. Too high: a user can pick the address they are counted under. |
| `TZ` | Europe/Paris | the time zone of logs and e-mails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` | none | to send registration, approval and password-reset e-mails |
| `ALLOW_PRIVATE_TARGETS` | not set | section 7 |

The volume asks for 20 GiB (`base/data-volume.yaml`): reports and run
workspaces grow with the number of runs.

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

Keep `ENCRYPTION_KEY` in your secret manager or vault, not only in the
cluster: a backup without it cannot be read, and the key alone holds no data.

The Admin Dashboard's backup card reads a status the VPS scripts write; on a
cluster it stays empty.

## 10. Updating

Build the new release's images (section 3), change `newTag` in the overlay,
apply. The old pod stops, the new one starts and migrates the database: OSCAR
is unavailable for that time. Runs in progress are cut off; they are marked
as such at the start (as after a restart of the VPS), and can be run again.
To go back, apply the previous tag, **before** anyone has used the new one
for long: a migration is not undone.

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
