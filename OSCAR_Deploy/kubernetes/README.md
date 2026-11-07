# OSCAR on Kubernetes and OpenShift

One OSCAR pod on a cluster (#1059). The guide is
[OSCAR - Kubernetes and OpenShift Deployment Guide](../../Documentation/Server_Operations/OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md).

| Path | What it is |
|---|---|
| `build-images.sh` | builds the server image and the bundle (server + collection + `compatibility.json`) from a release checkout |
| `Dockerfile.bundle` | the bundle |
| `base/` | Deployment (one replica, `Recreate`; the server and the runner container), Service, volume, settings; `secrets.env.example` lists the Secret's keys (the runner's key is the Secret `oscar-runner`) |
| `overlays/kubernetes/` | an Ingress (ingress-nginx), `fsGroup: 1000` |
| `overlays/openshift/` | a Route; runs under the default `restricted-v2` SCC |
| `ci/` | what `.github/workflows/ci-kubernetes.yml` deploys on kind, and `smoke.sh` |
