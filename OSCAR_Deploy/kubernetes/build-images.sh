#!/bin/sh
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# Builds the images a cluster runs (#1059), from a checkout of the release to
# deploy (git checkout release-YYYY.NNN):
#   <prefix>/oscar-server:<tag>  the server (Oscar_Server/Dockerfile), as on the VPS
#   <prefix>/oscar:<tag>         that image + Bruno_Collection/ + compatibility.json
#   <prefix>/oscar-run:<tag>     one run in a pod of its own (#1130): Bruno, the
#                                collection and Oscar_Server/src/run-pod only
# The cluster runs the second one (and the third, with RUN_ISOLATION=pod);
# push them to a registry the cluster can read.
#
#   OSCAR_Deploy/kubernetes/build-images.sh registry.example.org/oscar release-2026.480
#   docker push registry.example.org/oscar/oscar:release-2026.480
#
# CONTAINER_CLI=podman builds with podman instead of docker.
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <registry/namespace> <tag>" >&2
  exit 2
fi
prefix=$1
tag=$2
cli=${CONTAINER_CLI:-docker}
root=$(cd "$(dirname "$0")/../.." && pwd)
here="$root/OSCAR_Deploy/kubernetes"

release=$(sed -n 's/^ *"current_release": *"\([^"]*\)".*/\1/p' "$root/compatibility.json" | head -n 1)
echo "Release of this checkout: ${release:-unknown}, collection $(cat "$root/Bruno_Collection/VERSION")"
if git -C "$root" rev-parse --git-dir > /dev/null 2>&1 \
   && ! git -C "$root" diff --quiet HEAD -- Oscar_Server Bruno_Collection compatibility.json; then
  echo "Warning: Oscar_Server, Bruno_Collection or compatibility.json differ from the commit checked out:" >&2
  echo "         the images will not be that release." >&2
fi

"$cli" build -t "$prefix/oscar-server:$tag" "$root/Oscar_Server"

# The bundle's context is the repository root. Docker (BuildKit) finds
# Dockerfile.bundle.dockerignore by itself; podman is told.
ignore=""
if [ "$cli" = podman ]; then ignore="--ignorefile=$here/Dockerfile.bundle.dockerignore"; fi
# shellcheck disable=SC2086
"$cli" build -f "$here/Dockerfile.bundle" $ignore \
  --build-arg "OSCAR_SERVER_IMAGE=$prefix/oscar-server:$tag" \
  -t "$prefix/oscar:$tag" "$root"

# The run image (#1130): Bruno, the collection and the run pod's entrypoint,
# for one run in a pod of its own. Same context and ignore-file rule.
ignore=""
if [ "$cli" = podman ]; then ignore="--ignorefile=$here/Dockerfile.run.dockerignore"; fi
# shellcheck disable=SC2086
"$cli" build -f "$here/Dockerfile.run" $ignore -t "$prefix/oscar-run:$tag" "$root"

echo "Built $prefix/oscar-server:$tag, $prefix/oscar:$tag and $prefix/oscar-run:$tag"
