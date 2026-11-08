#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# Moves OSCAR's data into or out of its volume on a cluster (#1059): the
# database, the data files and the run reports, what a VPS backup holds
# (OSCAR_Deploy/scripts/oscar-backup.sh). Guide: "OSCAR - Kubernetes and
# OpenShift Deployment Guide", section 6a.
#
#   oscar-data.sh load <folder> [--replace]   the folder's data into the volume
#   oscar-data.sh save <folder>               the volume's data into a new folder
#
# <folder> holds oscar.db, datafiles/ and artifacts/: the data/ folder of a
# decrypted VPS backup, or what `save` wrote. Nothing else is copied.
#
# OSCAR is stopped while the data moves (its Deployment scaled to 0), then
# started again. A pod of the same image, user and volume does the copy, and is
# deleted afterwards. `load` replaces a database that holds no user (the one a
# first start makes) and refuses one that does, unless --replace.
#
# Needs bash, kubectl (or oc: KUBECTL=oc), jq and tar. NAMESPACE (oscar by
# default) is OSCAR's namespace. The data passes from this machine to the pod
# through kubectl exec: the encrypted files stay encrypted, but the database
# holds every account's password hash; keep the folder where you keep backups.
set -euo pipefail

KUBECTL=${KUBECTL:-kubectl}
# macOS's tar: no AppleDouble files in the archive.
export COPYFILE_DISABLE=1
NAMESPACE=${NAMESPACE:-oscar}
DEPLOYMENT=oscar
HELPER=oscar-data-copy
DATA=/app/data
# What a backup holds, in that order; a WAL file goes with its database.
ITEMS=(oscar.db oscar.db-wal datafiles artifacts)

usage() {
  echo "Usage: $0 load <folder> [--replace] | save <folder>" >&2
  exit 2
}
say() { echo "── $*"; }
fail() { echo "oscar-data: $*" >&2; exit 1; }
k() { "$KUBECTL" -n "$NAMESPACE" "$@"; }

[ "$#" -ge 2 ] || usage
command=$1
folder=$2
replace=""
case "$command" in
  load) [ "$#" -le 3 ] || usage; [ "${3:-}" = "" ] || [ "${3:-}" = "--replace" ] || usage; replace=${3:-} ;;
  save) [ "$#" -eq 2 ] || usage ;;
  *) usage ;;
esac
for tool in "$KUBECTL" jq tar; do
  command -v "$tool" > /dev/null || fail "$tool is not installed"
done

# ── What there is to copy ──────────────────────────────────────────────────────
present=()
if [ "$command" = load ]; then
  [ -f "$folder/oscar.db" ] || fail "$folder holds no oscar.db: give the data/ folder of a decrypted backup"
  for item in "${ITEMS[@]}"; do
    if [ -e "$folder/$item" ]; then present+=("$item"); fi
  done
  for entry in "$folder"/* "$folder"/.[!.]*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    case " ${ITEMS[*]} manifest.json oscar.db-shm " in
      *" $name "*) ;;
      *) echo "   left out: $name" ;;
    esac
  done
else
  if [ -e "$folder" ] && [ -n "$(ls -A "$folder" 2>/dev/null)" ]; then
    fail "$folder is not empty: give a new folder"
  fi
fi

# ── OSCAR's pod, as the Deployment describes it ────────────────────────────────
spec=$(k get deployment "$DEPLOYMENT" -o json) || fail "no Deployment $DEPLOYMENT in namespace $NAMESPACE"
replicas=$(jq -r '.spec.replicas // 1' <<< "$spec")
selector=$(jq -r '.spec.selector.matchLabels | to_entries | map("\(.key)=\(.value)") | join(",")' <<< "$spec")
claim=$(jq -r '.spec.template.spec.volumes[] | select(.name == "data") | .persistentVolumeClaim.claimName // empty' <<< "$spec")
[ -n "$claim" ] || fail "the Deployment has no volume named data on a claim"

# The copying pod: OSCAR's image, user, groups and security, its data volume,
# a command that waits. Not selected by OSCAR's Service (another name label).
helper_pod=$(jq --arg name "$HELPER" --arg claim "$claim" --arg data "$DATA" '
  .spec.template.spec as $p
  | ($p.containers[] | select(.name == "oscar")) as $c
  | {
      apiVersion: "v1", kind: "Pod",
      metadata: { name: $name, labels: { "app.kubernetes.io/name": $name, "app.kubernetes.io/part-of": "oscar" } },
      spec: ({
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 5,
        securityContext: ($p.securityContext // {}),
        containers: [{
          name: "copy",
          image: $c.image,
          imagePullPolicy: ($c.imagePullPolicy // "IfNotPresent"),
          command: ["sleep", "infinity"],
          securityContext: ($c.securityContext // {}),
          env: [{ name: "HOME", value: "/tmp" }],
          resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "1", memory: "512Mi" } },
          volumeMounts: [{ name: "data", mountPath: $data }, { name: "tmp", mountPath: "/tmp" }]
        }],
        volumes: [{ name: "data", persistentVolumeClaim: { claimName: $claim } }, { name: "tmp", emptyDir: {} }]
      } + ($p | with_entries(select(.key | IN("imagePullSecrets", "nodeSelector", "tolerations", "affinity", "serviceAccountName")))))
    }' <<< "$spec")

# The database's counts and check, read in the copying pod (null: no database).
DB_FACTS='
const fs = require("node:fs");
const file = process.argv[1];
if (!fs.existsSync(file)) { console.log("null"); process.exit(0); }
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(file);
const count = (t) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; } };
const check = db.prepare("PRAGMA quick_check").get();
if (process.argv[2] === "checkpoint") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
let schema = null;
try { schema = db.prepare("SELECT MAX(version) AS v FROM schema_version").get().v; } catch { /* none */ }
console.log(JSON.stringify({ users: count("users"), companies: count("companies"), runs: count("runs"), schema_version: schema, check: Object.values(check)[0] }));
db.close();'
facts() { k exec "$HELPER" -- node --no-warnings -e "$DB_FACTS" "$DATA/oscar.db" "${1:-}"; }

# ── Stop OSCAR, start the copying pod; put things back on the way out ──────────
stopped=""
changed=""
done_ok=""
finish() {
  k delete pod "$HELPER" --ignore-not-found --wait=false > /dev/null 2>&1 || true
  if [ -n "$stopped" ]; then
    if [ -n "$changed" ] && [ -z "$done_ok" ]; then
      echo "oscar-data: the copy did not finish; OSCAR stays stopped. Run the load again, or restore the volume." >&2
    else
      say "starting OSCAR again ($replicas replica)"
      k scale deployment "$DEPLOYMENT" --replicas="$replicas" > /dev/null || true
      if [ "$replicas" != 0 ]; then
        # The first start of a newer release migrates the database: give it time.
        k rollout status deployment "$DEPLOYMENT" --timeout=600s \
          || echo "oscar-data: OSCAR is not ready yet: $KUBECTL -n $NAMESPACE get pods" >&2
      fi
    fi
  fi
}

# Before the trap: the pod of a copy still running is not this run's to delete.
if k get pod "$HELPER" > /dev/null 2>&1; then
  fail "a pod $HELPER is already there: another copy is running, or delete it"
fi
trap finish EXIT

say "stopping OSCAR (namespace $NAMESPACE)"
k scale deployment "$DEPLOYMENT" --replicas=0 > /dev/null
stopped=1
pods() { k get pods -l "$selector" -o name 2> /dev/null; }
for _ in $(seq 1 90); do
  [ -z "$(pods)" ] && break
  sleep 2
done
[ -z "$(pods)" ] || fail "OSCAR's pod did not stop within 3 minutes"

say "starting the copying pod on $claim"
k apply -f - <<< "$helper_pod" > /dev/null
k wait --for=condition=Ready "pod/$HELPER" --timeout=300s > /dev/null \
  || { k describe pod "$HELPER" | tail -n 20 >&2; fail "the copying pod did not start"; }

if [ "$command" = save ]; then
  before=$(facts checkpoint)
  [ "$before" != null ] || fail "the volume holds no database"
  [ "$(jq -r .check <<< "$before")" = ok ] || fail "the volume's database does not pass its check: $before"
  mkdir -p "$folder"
  say "copying the volume's data to $folder"
  k exec "$HELPER" -- sh -c 'cd "$1" && shift && for i in "$@"; do [ -e "$i" ] && printf "%s\n" "$i"; done | tar -cf - -T -' sh "$DATA" "${ITEMS[@]}" \
    | tar -C "$folder" -xf -
  [ -f "$folder/oscar.db" ] || fail "nothing arrived in $folder"
  jq -n --argjson f "$before" --arg ns "$NAMESPACE" \
    '{saved_at: (now | todate), namespace: $ns, users: $f.users, companies: $f.companies, runs: $f.runs, schema_version: $f.schema_version}' \
    > "$folder/manifest.json"
  done_ok=1
  say "saved: $(jq -c '{users, companies, runs, schema_version}' "$folder/manifest.json")"
  exit 0
fi

# ── load ───────────────────────────────────────────────────────────────────────
there=$(facts)
if [ "$there" != null ]; then
  users=$(jq -r '.users // 0' <<< "$there")
  if [ "$users" != 0 ] && [ "$replace" != --replace ]; then
    fail "the volume holds a database with $users users: nothing changed. Add --replace to overwrite it."
  fi
  echo "   replacing the volume's database ($users users)"
fi

changed=1
say "removing the volume's data"
k exec "$HELPER" -- sh -c 'cd "$1" && rm -rf oscar.db oscar.db-wal oscar.db-shm datafiles artifacts' sh "$DATA"

say "copying $folder (${present[*]}) to the volume"
tar -C "$folder" -cf - "${present[@]}" \
  | k exec -i "$HELPER" -- tar -C "$DATA" -xf - --no-same-owner --warning=no-unknown-keyword
# The image's convention: the server's user and its group (0 on OpenShift,
# fsGroup elsewhere) may write the data.
k exec "$HELPER" -- sh -c 'cd "$1" && shift && for i in "$@"; do [ -e "$i" ] && chmod -R u+rwX,g+rwX "$i"; done; true' sh "$DATA" "${present[@]}"

after=$(facts)
[ "$after" != null ] || fail "no database in the volume after the copy"
[ "$(jq -r .check <<< "$after")" = ok ] || fail "the database copied does not pass its check: $after"

# The counts a backup's manifest, or save's, recorded.
manifest=""
for m in "$folder/manifest.json" "$folder/../manifest.json"; do
  if [ -f "$m" ]; then manifest=$m; break; fi
done
if [ -n "$manifest" ]; then
  for key in users companies; do
    want=$(jq -r --arg k "$key" '.[$k] // empty' "$manifest")
    got=$(jq -r --arg k "$key" '.[$k]' <<< "$after")
    if [ -n "$want" ] && [ "$want" != "$got" ]; then
      fail "$key: $got in the volume, $want in $manifest"
    fi
  done
  echo "   counts as in $manifest"
fi
done_ok=1
say "loaded: $(jq -c '{users, companies, runs, schema_version}' <<< "$after")"
