# OSCAR — Kubernetes run campaigns

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC © 2026."

---

What the campaigns on the k3s test machine measured, in November 2026, what
each one found, and how to run and read one. The machine is installed as
[OSCAR - k3s on one VPS](OSCAR%20-%20k3s%20on%20one%20VPS.md) describes, runs
in pod mode (each run in a pod, `RUN_ISOLATION=pod`), and the architecture is
in section 14.12 of the
[Solution Architecture](../Oscar_Server/OSCAR%20-%20OSDM%20Conformance%20Automation%20Runner%20Solution%20Architecture.md).

## 1. The series and the machine

- **The series.** The same 939 runs each time: the six simulator providers'
  scenarios selected as *Happy flows + Expected refusals*, one batch per
  provider (alpha 143, beta 156, delta, epsilon, gamma and zeta 160 each),
  launched within about 90 seconds of each other. The simulator is the
  *OSDM Simulator* on its own VPS ([OSCAR - OSDM Simulator](OSCAR%20-%20OSDM%20Simulator.md)).
- **The machine.** One VPS, k3s on one node, with OSCAR's database restored
  from a production backup (section 6a of the k3s guide). Server Config:
  *Max Concurrent Runs* 15, *Run Timeout* and *Run Budget Ceiling* 3,600,000
  (taken from production's database).
- **Its disk.** `fio` as etcd's FAQ runs it: 99 % of the syncs in 45 ms
  (median 2.4 ms), above the 10 ms etcd asks for. k3s was moved to etcd all
  the same (#1271): on one node etcd only needs its own disk.

## 2. The campaigns of 18 and 19 November

All on the same series. "95 %" is the time until 95 % of the runs had ended,
from the first run's start; one long run does not move it. The etcd warnings
are k3s's *slow fdatasync* and *apply request took too long* lines.

| | Started (UTC) | Release | k3s keeps its state in | Run pods | Failed | 95 % ended in | Runs/min (95 %) | Mean run | etcd warnings |
|---|---|---|---|---|---|---|---|---|---|
| A | 2026-11-18 15:29 | 2026.589 | kine over SQLite | one per run | 2 | 37.9 min | 23.5 | 36.6 s | — |
| B | 2026-11-18 19:55 | 2026.589 | kine over SQLite | kept for the batch | 9 | 39.4 min | 22.7 | 38.6 s | — |
| C | 2026-11-19 04:52 | 2026.591 | etcd | one per run | 0 | 60.0 min | 14.9 | 59.8 s | 14,558 |
| D | 2026-11-19 06:15 | 2026.591 | etcd | kept for the batch | 19 | 31.1 min | 28.6 | 30.8 s | 559 |
| E | 2026-11-19 12:30 | 2026.593 | etcd | kept for the batch | 0 | 27.6 min | 32.3 | 27.4 s | 426 |
| F | 2026-11-19 14:28 | 2026.594 | etcd | kept for the batch | 1 | 39.8 min | 22.4 | 39.0 s | 1,141 |

**E is the reference** for this machine: all 939 runs ended in 29.1 minutes.
That is 37 % faster than A, the same series on SQLite with a pod per run.

### What each showed, and what it led to

- **A and B, SQLite.** Kept pods gave nothing here (23.5 and 22.7 runs a
  minute): the CPU was the limit, Bruno's start above all.
  - During B, k3s stopped at 20:27:39: kine's clean-up of old versions did
    not commit in time ("Transaction commit failed"). Every run froze for
    about two minutes, and 6 failed. This led to k3s on etcd (#1271, guide
    section 9).
  - The other failures of A and B led to #1326 (a pod of one run waits for
    OSCAR's internal port before Bruno, 2026.590) and #1327 (a run renews
    its token before it expires, 2026.591).
- **C, etcd, a pod per run.** k3s held: no restart, no fatal error. It was
  the slowest campaign, though:
  - each run's pod is a Job, a Secret and a pod, each written to etcd, on a
    disk whose syncs take up to 45 ms;
  - a pod took 12 s to start (median; 95th percentile 35 s), and the load
    reached 2 to 2.4 per CPU.
- **D, etcd and kept pods.** The pods are made once per batch, so etcd
  writes far less: 559 warnings instead of 14,558. A pod takes a run in
  0.5 s, the load fell to 1 to 1.3 per CPU, and the disk stayed calm (I/O
  pressure 0.9 %, writes waiting 10 ms on average). It went 28.6 runs a
  minute, but 19 runs failed:
  - 18 refunds failed the check "Refund offer createdOn is valid and in the
    past": the simulator's clock was 1 to 14 ms ahead of the machine's, and
    that check allowed no difference. Fixed by #1334 (2026.592): the clock
    tolerance of #644, 2 minutes.
  - 1 run waited an hour: a kept pod took it and stayed idle before Bruno
    (25 MB, no CPU), until the run's one-hour deadline. Fixed by #1336
    (2026.593): in pod mode a run's first line must come within 3 minutes
    (*Run Pod First Line Limit*), whatever the silent run limit says.
  - In the same minutes, two kept pods' logs were cut by "failed to create
    fsnotify watcher: too many open files": the node's 128 inotify instances
    were all in use. #1336 raises them to 8192 (guide sections 3 and 9).
  - The silent run limit was off because production's database had
    `RUN_IDLE_TIMEOUT_MS = 0`. Saving Server Config stored every empty
    number field as 0, and on the test machine it switched the new limit off
    too. Fixed by #1338 (2026.594): an empty field is the default.
- **E, after those fixes.** All 939 runs completed. The longest took 3
  minutes: the expiry scenarios, which wait on purpose. There was no
  "too many open files", no k3s restart and no fatal error.
- **F, the same as E two hours later.** It ended 31 % fewer runs a minute,
  with the same code for the runs (2026.594 only changed the Server Config
  page); section 3 explains why. Its one failure was a connection to the
  simulator's host that could not open: `connect ETIMEDOUT` after 2 min 14 s
  on `GET /products`. A request that never connects runs no check, so Bruno
  ends with 1 and the run shows no failed check.

### Before these: the server's own thread (17 November)

The campaigns of 17 November, on SQLite with a pod per run, found the
server's thread to be the limit:
- Storing a run's results took about 4.6 s of it, and the series went at
  about 9 runs a minute.
- Checkpoints by log size (#1294, 2026.575) and the company index in place
  of the key index (#1295, 2026.576) brought it to 0.44 s, and the series to
  about 18 runs a minute.
- Run pods' work folders in memory (#1307, 2026.581) took the run pods off
  the disk.
- Two CPUs per run pod gave nothing, and their pods started 2 to 4 s later,
  so the limit went back to one (#1310, 2026.582).
- Each run's time has been logged step by step since #1312 (2026.583).

The plan behind these is #1233.

## 3. Two identical campaigns can differ

E and F ran the same series, with the same settings, a few hours apart. The
time each step of a run took, read by `step-times.js` (section 5):

| Step (mean / 95th percentile, seconds) | E | F |
|---|---|---|
| From its slot to its final status | 27.4 / 75.7 | 39.0 / 79.8 |
| Its pod preparing the work folder (until Bruno's first line) | 9.9 / 15.0 | 14.2 / 20.6 |
| The requests | 15.9 / 41.5 | 22.3 / 57.6 |
| The reports | 0.3 / 1.0 | 0.6 / 1.7 |
| Sending the results | 0.3 / 1.0 | 0.5 / 1.4 |
| Asking for its pod | 0.7 / 3.2 | 0.9 / 6.3 |

Every step was slower in F by about 40 %. What was ruled out:
- **The simulator.** It answered in about 5 ms (median and 95th
  percentile) in both, and its own CPU stayed low. It received fewer
  requests a second in F only because the runs went more slowly.
- **Something else on the machine.** CPU by namespace: the run pods took
  nearly all of it in both. The monitoring, OSCAR's pod and `kube-system`
  stayed low and alike.
- **The disk.** I/O wait stayed under 1.5 % most of the time in both.
- **The machine being full.** Its CPU was 80 to 85 % used in E and 70 to
  80 % in F: F did not have less of it.

What remains: in F each run used about a third more CPU time for the same
work. Waiting for a network uses none, so the machine's processor did less
work per second. On a VPS that is the mark of physical cores shared with
other customers, which the kernel's *steal* figure does not show (it stayed
at 0 in both).

**So:** to compare two settings, run their campaigns one right after the
other, or each more than once, and compare the time per step as well as
the runs a minute.

## 4. The settings in use on the test machine (19 November)

- Release 2026.594. k3s on etcd: the copy of its state from before the move
  was removed once E had run, so there is no way back to SQLite.
- `RUN_KEPT_PODS=on` (guide section 9, *Kept run pods*).
- Server Config:
  - *Max Concurrent Runs* 15;
  - *Run Timeout* and *Run Budget Ceiling* 3,600,000;
  - *Silent Run Limit* 300,000;
  - *Run Pod First Line Limit* 180,000.
- `fs.inotify.max_user_instances = 8192`.

## 5. Running and reading a campaign

All read-only. The four scripts are in `OSCAR_Deploy/kubernetes/measure/`.
Each runs in OSCAR's pod, the script on standard input and its arguments
after `-`. The log lines they read are encrypted in the database: they use
the server's own key, inside its pod, and never write anything.
`failures.js` and `run-log.js` print run log lines, which hold test data and
the e-mail of the person who ran: keep their output to yourself.

**1. Before.** Note when the campaign starts:

```bash
date -u
```

If you forgot, the queue keeps it. The first run of each batch since a time
(UTC):

```bash
sudo kubectl -n oscar exec deploy/oscar -c oscar -- node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/app/data/oscar.db", { readOnly: true }); for (const r of db.prepare("SELECT c.name AS company, MIN(r.queued_at) AS first, COUNT(*) AS n FROM runs r JOIN companies c ON c.id = r.company_id WHERE r.queued_at >= ? GROUP BY r.batch_id ORDER BY first").all(process.argv[1])) console.log(r.first + " UTC  " + String(r.n).padStart(4) + " runs  " + r.company)' '2026-11-19 12:00:00'
```

**2. After.** Set `START` a minute before the first batch, and `BEFORE` to
the start of the campaign to compare with.

The scripts are read from the repository's `main`. The checkout on the
machine stays on its release's tag, which may come before them:

```bash
START='2026-11-19 12:29:00 UTC'       # ← yours: a minute before the first batch
BEFORE='2026-11-19T06:15:00Z'         # ← yours: the campaign to compare with
cd /opt/oscar
git fetch -q origin
S=$(date -u -d "$START" +%FT%TZ)
measure() { f=$1; shift; git show "origin/main:OSCAR_Deploy/kubernetes/measure/$f" | sudo kubectl -n oscar exec -i deploy/oscar -c oscar -- node --no-warnings - "$@"; }
systemctl show k3s -p NRestarts
sudo journalctl -u k3s --since "$START" | grep -c 'level=fatal'
sudo journalctl -u k3s --since "$START" | grep -ciE 'slow fdatasync|apply request took too long'
measure campaign.js before "$BEFORE" "$S" this "$S" 2099-01-01T00:00:00Z
measure step-times.js before "$BEFORE" "$S" this "$S" 2099-01-01T00:00:00Z
measure failures.js "$S"
sudo kubectl -n oscar logs deploy/oscar -c oscar --since-time="$S" | grep -c 'too many open files'
```

- `NRestarts` and the `fatal` count stay at 0.
- The etcd warnings are counted from `START`: the fewer the better (section 2).
- `campaign.js` gives one line per window.
- `step-times.js` gives one column per window (section 3).
- `failures.js` lists the runs not completed, by exit code and message, then
  the longest run's steps and log lines.
- The last count stays at 0.

**3. One run in detail**, for a run `failures.js` names:

```bash
measure run-log.js "$S" SCENARIO_CODE
```

It prints the run's result, its failed checks, its steps with their first
and last line, the lines that speak of a failure, and its last lines.

**4. In Grafana** (*Explore*, Prometheus, over both campaigns):
- `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[2m])))`: the
  machine's CPU used.
- `sum by (namespace) (rate(container_cpu_usage_seconds_total{container!="", pod!=""}[2m]))`:
  who used it.
- `100 * avg(rate(node_cpu_seconds_total{mode="steal"}[2m]))` and the same
  with `mode="iowait"`: CPU taken by the host, and time waiting for the disk.

Then the *OSDM Simulator* dashboard: the simulator's answer time and request
rate over the same minutes.

Grafana shows local time; the database and the scripts use UTC.
