# Metrics & Monitoring — Prometheus + Grafana

This guide explains how to enable, use, and extend the optional metrics
stack for OSCAR.

The metrics stack is **opt-in**. Default deployments don't run Prometheus
or Grafana, so existing installations are unaffected by simply pulling
this version of the repo.

---

## What you get

Two pre-built Grafana dashboards at **`https://oscar.uic.org/grafana/`**:

**OSCAR · Overview** — runtime metrics:
- Active runs / queue depth (current snapshot)
- HTTP request rate and P95 latency (pages and API: the run pods' calls
  are left out, #1205)
- HTTP latency percentiles (p50/p95/p99) over time
- HTTP requests per second by status code (find error spikes)
- Bruno runs completed/sec by status (COMPLETED / FAILED)
- Auth + SMTP success/failure rates
- Process memory (RSS, heap used, heap total)
- Process CPU + Node.js event-loop lag
- Row *OSCAR host* (#1013): the machine's CPU by mode, load against CPUs,
  memory and swap, the container's memory, and the run processes (Bruno)
  with their memory
- Row *Runs by company or provider* (#1017): runs going and waiting, runs
  ended per minute, and requests to the provider per second
- Row *OSCAR's thread: what each run costs it* (#1205): the share of the
  server's one thread taken by the work done for each run, how long requests
  waited for the thread, the slowest addresses, one run's work (see
  *OSCAR's thread* below)
- Row *A run's time, step by step* (#1312): the mean seconds of each step of
  a run, from the slot it is given to its final status, and the 95th
  percentile of each (see *A run's time, step by step* below)

Which address is slow: Grafana → **Explore** → Prometheus, the 99th
percentile by listener, method and route over the last 5 minutes:

```
histogram_quantile(0.99, sum by (le, listener, method, route) (rate(oscar_http_request_duration_seconds_bucket[5m])))
```

`listener` (from server 1.11.502, #1205) is `public` for the pages and the
API, `internal` for the run pods' calls (`INTERNAL_PORT`: a run's data
file, its results, its token renewed), which nothing measured before.

`route` is the address's pattern with its router's path (`/v1/runs`,
`/v1/runs/:id`, `/v1/company/datafile`; from server 1.11.499, #1196, before
which the root of every router read `/`), a static file its own path, any
other address `unmatched`.

**OSCAR · Logs** — centralised log aggregation:
- Errors-only view: OSCAR's lines at level error or fatal, and other lines
  holding error, fatal or panic as a word of their own (#1187)
- Full live tail (5s refresh) with substring search box
- Per-container filter (variable dropdown)
- Log rate timeseries by container

**OSDM Simulator · Overview** (#1005) — the simulator and its host, when
Admin → OSDM Simulator holds its address and key:
- Whether it answers OSCAR, its version, request rate and P95 answer time
- Host memory used, swap used, CPU by mode, load, data disk
- Requests per second by status and by provider, refusals of its rate limit
  (429, trusted address or not)
- Its process: memory, CPU, event-loop delay; offers and bookings it keeps

All metrics scraped from OSCAR's `/metrics` at 15s intervals (15-day retention);
the simulator's every 30 s, see *The OSDM simulator* below.
All logs shipped via Promtail from the log files Docker writes for each container
(no Docker socket, #1434; indefinite retention by
default — adjust in `OSCAR_Deploy/loki/loki-config.yaml` if disk pressure).

**Plus, since v1.8.0, an end-to-end watchdog stack:**

- **Restarts from the host** (`oscar-autoheal`, a systemd timer, every 30 s; the sidecar until #1434) restart any container labelled `autoheal=true` that fails its Docker healthcheck (3× in 90s). Self-healing for the common transient hangs — no human action needed.
- **Alertmanager** routes Prometheus alerts to email, with deduping, grouping, and re-paging. Hooks into the same SMTP relay you set up for OSCAR's own emails (Brevo, etc.).
- **Pre-defined alert ruleset** covers OSCAR down, restart loops, queue stuck, sustained run failure, SMTP degradation, login attack burst, memory leak, event-loop lag.

Full operational guide: [`OSCAR - Server Admin Guide.md` § 14](OSCAR%20-%20Server%20Admin%20Guide.md#14-operational-monitoring--alerting-v18).

---

## Architecture

```
┌─────────────┐   scrape every 15s    ┌────────────┐
│  Prometheus │ ───────────────────▶ │   oscar    │
│  (private)  │   http://oscar:3001  │  /metrics  │
└─────┬───────┘                       └────────────┘
      │ datasource
      ▼
┌─────────────┐    auth_request      ┌────────────┐
│   Grafana   │ ◀──── /grafana/ ──── │   nginx    │
│ (port 3000) │     X-WEBAUTH-USER   │  (public)  │
└─────────────┘                       └─────┬──────┘
       ↑                                    │  /v1/auth/sso-check
       │                                    ▼
       │                              ┌────────────┐
       │     X-WEBAUTH-USER set if    │   oscar    │
       └─── role==administrator ─────│ JWT cookie │
                                      └────────────┘
```

- `/metrics` endpoint: **no auth** in the app, but **404'd by nginx**
  for external requests. Only Prometheus (in the same Docker network
  as `oscar`) can reach it. Where no nginx guards it (Kubernetes,
  OpenShift), `METRICS_TOKEN` makes OSCAR itself answer 404 to any
  request without that bearer token (#1059, 1.11.443; the
  [Kubernetes and OpenShift guide](OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md),
  section 8).
- Grafana: gated by **OSCAR SSO** at `https://oscar.uic.org/grafana/`.
  When you click the menu link, nginx's `auth_request` calls OSCAR's
  `/v1/auth/sso-check`. If your JWT cookie says `role=administrator`,
  the request continues with the `X-WEBAUTH-USER` header carrying your
  email — Grafana auto-creates a matching user (Viewer by default,
  promote to Editor / Admin in the Grafana UI).
- Prometheus has no public port at all.

### The OSCAR server's machine (#1013)

Each run is a Bruno process, a child of the server: its CPU and memory do not
show in the server process's own metrics (`oscar_node_process_*`). A load
test of 36 parallel runs saturated a 6-CPU machine (load 29.7, 2.6 GiB of
memory available, no swap) while the dashboard showed none of it. Since
1.11.424 OSCAR's `/metrics` also writes, read at each scrape:

- `oscar_host_*`: memory total and available, swap total and free, load
  (1, 5, 15 minutes), CPU count, CPU time by mode, from `/proc` as the
  container sees it (on a VM, the VM's own figures);
- `oscar_container_memory_bytes` and, when the container has one, its limit
  (cgroup);
- `oscar_run_processes` and their total resident memory: the server's own
  child processes (Bruno, report merge), counted. No name, path or argument
  of a process is written.

The row *OSCAR host* of *OSCAR · Overview* shows them. How to read it:

- **Load per CPU** over 1 means processes wait for a CPU. Pages and runs
  slow down together. Over 2 for 10 minutes fires `OscarHostOverloaded`.
- **Memory available** under 10 % for 5 minutes fires `OscarHostMemoryLow`
  (critical). Past it the machine swaps or the kernel kills a process, the
  OSCAR server included.
- **Swap used** over 1 GiB for 10 minutes fires `OscarHostSwapping`.

**How many parallel runs a machine holds.** A run costs about 0.2 CPU and
250 MB (measured on the simulator, up to 430 MB for a long scenario). So
*Max Concurrent Runs* (Admin → Server Config, applied at once) is about 4
per CPU, as long as runs × 250 MB stays well under the memory available
without runs: 24 on 6 CPUs and 11 GiB. 50 runs need about 12 CPUs and 16 to
24 GiB. Above that the machine does no more work, it only shares it out
more slowly. **In pod mode** (Kubernetes, each run a pod) count about one
run per vCPU instead: a run pod's start costs 0.4 to 0.7 CPU for a few
seconds, and the node makes and removes a pod per run (#1150, measured on 6
vCPU with k3s).

### Runs by company or provider (#1017)

Four metrics carry the labels `company` (the company or provider's name) and
`distributor` (its parent's name, empty for a top-level company):

- `oscar_company_runs_running` and `oscar_company_runs_queued`, read from the
  queue every 5 seconds. With several providers at work, the runs going
  should even out between them as runs end (#1015).
- `oscar_company_runs_finished_total{status}`.
- `oscar_company_run_requests_total`: the requests a run stored, counted when
  the run ends. Bruno sends them straight to the provider, so OSCAR cannot
  count them live. The rate lags by about one run, and requests a script
  sends itself are not counted.

No metric names a user: an e-mail would be personal data in Prometheus, and
the series would grow with every user. *Admin → Server Activity → Runs in
Progress* lists runs going and waiting by user and company or provider. A
company renamed keeps its old name in the labels until OSCAR restarts.

### OSCAR's thread (#1205)

OSCAR's server answers every page on one thread. Work done for a run on
that thread makes every page wait while it lasts, with the CPU, memory and
disk far from their limits (on the k3s test machine, four providers'
batches at once made pages take more than 10 s). From server 1.11.502, that
work is measured where it runs:

- `oscar_run_work_seconds{work}`, a histogram, one observation per run and
  kind: `datafile_copy` (the run's copy of the data file, with the Test
  Framework's warnings and the trips' calendars, made each time a run asks
  for its data file), `results_read` (from 1.11.506: the run's Bruno
  results file decrypted, parsed and planned, one block, observed only
  for a run that has the file) and `results_store` (the run's checks,
  steps and requests stored; from 1.11.505 in slices, and only the slices'
  time is counted, not the waits between them);
- `oscar_run_results_bytes`, a histogram (from 1.11.506): the size of each
  run's results file, as stored;
- `oscar_results_slice_seconds`, a histogram (from 1.11.520, #1240): each
  slice of a run's results stored. A slice stops once about 20 ms are spent,
  checked after each check since 1.11.520 (after each request before, which
  let a request with many checks run to 47 to 84 ms): its length is 20 ms
  plus one check, so nearly all slices fall under 0.025 or 0.03;
- `oscar_run_log_lines_total` and `oscar_run_log_seconds_total`: every
  line of a run's log, counted, and the time it took in total (its
  encryption, and its share of the write that stores it);
- `oscar_db_commit_seconds`, a histogram (from 1.11.507, #1221): each
  database COMMIT of a transaction, on the thread. Every results slice and
  every batch of log lines ends with one, so their time is part of
  `results_store` and of the log lines'. A statement written alone, outside
  a transaction, commits too and is not counted;
- `oscar_db_synchronous`, a gauge (from 1.11.508, #1224): the server
  connection's synchronous mode, 1 NORMAL or 2 FULL;
- from 1.11.517 (#1237), SQLite's memory on the server's connection, read
  from the connection at start (below, *SQLite's memory*):
  - `oscar_db_memory_bytes{use}`, a gauge: the page cache (`use="cache"`)
    and the memory map (`use="mmap"`), in bytes;
  - `oscar_db_temp_store`, a gauge: where temporary sorts and groupings go,
    as SQLite numbers it (1 files, 2 memory);
- from 1.11.518 (#1238), SQLite's statistics (below, *SQLite's statistics*):
  - `oscar_db_analyze_seconds`, a histogram: each table analyzed, in the
    checkpoint thread, not the server's;
  - `oscar_db_optimize_runs_total{outcome}`, a counter: each run, `done` or
    `failed`;
- from 1.11.510 (#1230), the checkpoints of the thread that runs them:
  - `oscar_db_checkpoint_seconds`, a histogram: each checkpoint's time, off
    the server's thread;
  - `oscar_db_wal_frames` and `oscar_db_wal_frames_not_copied`, gauges: the
    write-ahead log's size at the last checkpoint and what it could not copy
    (pages a reader still used), in frames of one page;
  - `oscar_db_checkpoint_thread`, a gauge: 1 while that thread checkpoints,
    0 when the server's connection does in its COMMITs
    (`OSCAR_DB_CHECKPOINTS=inline`, or the thread stopped);
  - from 1.11.536 (#1294), `oscar_db_wal_bytes`, a gauge: the size of the
    log file as that thread last saw it, each second, copied or not;
- from 1.11.511 (#1234), every statement of the database helpers `all`,
  `get` and `run` (most of OSCAR's statements):
  - `oscar_db_statement_seconds`, a histogram: each one's time on the
    server's thread;
  - `oscar_db_slow_statements_total`, a counter: those of
    `OSCAR_DB_SLOW_MS` (50 by default) or more. Each of those is also
    logged (below);
- `oscar_run_datafile_reads_total{use, from}`, a counter (from 1.11.513,
  #1235): the data file read for a run's checks (`use="checks"`) or its copy
  (`use="copy"`), from the file now (`from="file"`) or kept in memory since
  (`from="memory"`). In a batch it is mostly `memory`: a run's copy is made
  once per version of the data file, the Test Framework and the Test Data,
  and `datafile_copy` then takes about a millisecond.

The row *OSCAR's thread* of *OSCAR · Overview* reads them:

| Panel | How to read it |
|---|---|
| Share of the thread taken by run work | Seconds of work a second, by kind. Near 100 % in all, every page waits behind the runs. |
| Event loop: how long requests waited | The worst wait and the 99th percentile since the last reading. Seconds here are seconds every page waited. |
| Slowest addresses (99th percentile) | The ten slowest, with their listener. Slow everywhere at once is the thread; one address alone is that address. |
| One run's work (95th percentile) | How long one run's copy or results take, and log lines a second. `results_read` is one block: its line is the longest the thread waits for it. |
| A run's results file (size) | The median and 95th percentile of the results files read. A bigger file, a longer `results_read`. |
| Database commits | How long a COMMIT holds the thread (median, 99th percentile), and how many took over 0.1 s in 5 minutes. Each of those is a wait for every page. |
| Database checkpoints, in a thread of their own | How long a checkpoint takes (99th percentile), off the server's thread, and the log's size and what was not copied, in frames. A log that keeps growing means the checkpoints do not keep up. |
| Database statements: the slow ones | Every statement of `all`/`get`/`run` (median, 99th percentile), and how many took `OSCAR_DB_SLOW_MS` or more in 5 minutes. Which ones they were: *OSCAR · Logs*, panel *Slow database statements*. |

**Which statements are slow** (#1234). Each statement of `OSCAR_DB_SLOW_MS`
or more writes one warning line, `slow database statement`, with:
- `ms`, its time;
- `sql`, its SQL on one line, lists of `?` shortened, 400 characters at
  most. **Never its values**: they are passed apart from the SQL;
- `from`, the place in OSCAR's code that ran it, such as
  `src/api/routes/runs.js:385`.

*OSCAR · Logs* lists them in the panel *Slow database statements*. To count
them by place over the last hour, in *Explore* (Loki):

```
sum by (from) (count_over_time({container="oscar"} |= "slow database statement" | json [1h]))
```

The statements a module prepares itself are not in it: the results slices
(`results_store`) and the run log batches (`log lines`) have their own
metrics.

The alert `OscarEventLoopLag` reads the same 99th percentile. **Until
1.11.502 it could never fire**: it read a `_bucket` series that prom-client
does not write (the event loop's lag is a set of gauges).

**What the first reading showed** (k3s test machine, 15 runs going, #1210):
log lines took half of the thread and up to 85 %, about 180 a second at
2.7 ms each, and requests waited up to 6.8 s. Each line was written alone,
so each was a write that waits for the disk. From server 1.11.503 the lines
of every run are written together, every 0.2 s: about 0.07 ms a line
instead of 1.8 measured on one machine. A running run's log on its page
still shows every line at once (the page's request writes the waiting lines
first).

**The second reading** (all six simulated providers at once, server
1.11.503, #1214): pages answered in 10–100 ms, log lines took 15 % of the
thread, and storing each run's results 34 %, 2.2 to 3 s a run in one block.
From server 1.11.505 the results are stored in slices of about 20 ms, other
requests served between them; the longest block left is the results file
decrypted and read (about 0.1 s for 9 MB of results, measured on one
machine).

**The third reading** (the same, server 1.11.505, #1218): the waits fell
from 7.3 s to 3.1 s at most, but requests still waited 1.6 to 3 s, with
storing the results at 32 % of the thread. From server 1.11.506 the file's
read is its own kind, `results_read`, with the file's size beside it: they
say whether that block is the one left.

**The fourth reading** (the same, server 1.11.506, #1221): that read is
not the block left, 16 to 21 ms a run for files of 285 to 473 KB. Storing
the results took 22 % of the thread, 1.8 s a run (95th percentile), and
requests still waited 0.3 to 1 s at almost every reading. Each slice ends
with a COMMIT, which its 20 ms do not count. OSCAR did not set SQLite's
`synchronous`, so the server's connection used SQLite's default, 2 (FULL):
in WAL mode each COMMIT waits for the disk, and the one that takes the
journal past 1,000 pages also copies them into the database file. From
server 1.11.507 each COMMIT's time is measured.

**The fifth reading** (the same, server 1.11.507, #1224): a COMMIT took
7 ms at the median, 150 to 240 ms at the 99th percentile, and COMMITs took
10 to 24 % of the thread during a batch. 28 to 85 in 5 minutes took over
0.1 s, 1 to 2 over 0.5 s. From server 1.11.508 the server's connection uses
`synchronous = NORMAL`: a COMMIT waits for the disk only when it copies the
journal into the database file (a checkpoint). The database stays safe from
corruption; a power loss or a crash of the machine can roll back the last
transactions, a crash of OSCAR alone cannot
([SQLite](https://www.sqlite.org/pragma.html#pragma_synchronous)).
`OSCAR_DB_SYNCHRONOUS=FULL` keeps the old behaviour. The mode in use is
`oscar_db_synchronous` (1 NORMAL, 2 FULL; *Explore*) and the start-up line
`[db] SQLite ready → … (synchronous NORMAL)`. A `PRAGMA synchronous` asked
on a connection of its own reads that connection's mode, not the server's.

**The sixth reading** (the same, server 1.11.508, #1227):
- **Commits:** a COMMIT took 0.7 ms at the median (7 ms before) and about
  100 ms at the 99th percentile. 18 to 56 in 5 minutes took over 0.1 s
  (28 to 85 before).
- **Storing the results:** 14.5 % of the thread, 1.5 s a run.
- **The waits did not move:** requests still waited 0.5 to 1 s at almost
  every reading, and 4.5 s when the batch started.
- **The garbage collector** explained a few of the waits only: at most 6
  pauses over 0.1 s in 5 minutes, and under 3 % of the thread.

So a CPU profile of the server was taken during a batch. The thread was
busy 31 % of the time. A third of that went to the Dashboard's list of
runs, which the page asks for every 3 seconds while a batch is going: 14 s
of 120, in blocks of 0.5 to 1 s. Each call counted every run's reports and
scenarios in the whole database, then kept the 100 of the page.

From server 1.11.509, the list reads its page first, then counts for the
runs it shows only. Two indexes find the newest runs of a company and the
runs of a batch.

**The seventh reading** (the same, server 1.11.509, #1230):
- **Requests waited less:** 0.2 to 0.5 s at most readings, up to 1.3 s
  (0.5 to 1 s before), and 303 ms at most at the 99th percentile (674 ms).
- **The profile:** the thread was busy 21 % of the time (31 %). 17
  stretches of 200 ms or more had no pause (43); the longest took 0.5 s
  (1.4 s). The list of runs took 0.1 s of 120.

Read millisecond by millisecond, those stretches held:
- **COMMITs that ran a checkpoint**, 90 to 261 ms each. SQLite's automatic
  checkpoint runs inside the COMMIT that takes the write-ahead log past
  1,000 pages. That COMMIT copies the log into the database file and waits
  for the disk, on the server's thread. About 28 COMMITs in 5 minutes took
  over 0.1 s.
- **Result slices** of 47 to 84 ms instead of 20. From server 1.11.520
  (#1240) a slice checks its time after each check, not each request:
  `oscar_results_slice_seconds` shows their lengths.

From server 1.11.510 a thread of its own checkpoints, with a connection of
its own. It runs a passive checkpoint, which never blocks a
reader or a writer, and the server's connection no longer checkpoints in its
COMMITs (`PRAGMA wal_autocheckpoint = 0`). If that thread fails, ends or
reports nothing for a minute, the server's connection checkpoints by itself
again, so the log never grows without bound. `OSCAR_DB_CHECKPOINTS=inline`
keeps the old way. The start-up line says which:
`[db] SQLite ready → … (synchronous NORMAL, checkpoints thread)`.

**When the thread checkpoints** (#1294, server 1.11.536). Until then it did
every second. The performance audit of 2026-11-17 found the cost of that on
the server's thread: the first write after a complete checkpoint starts the
log again from its beginning, and SQLite then syncs the log to the disk, with
`synchronous = NORMAL` too. That write is the server's. During a batch the
log was emptied about once a second, so the server's thread waited for the
disk about once a second: about 200 COMMITs over 0.1 s per 5 minutes on the
k3s test machine, 367 ms at the 99th percentile. Reproduced with two
connections: the COMMIT right after a checkpoint took 1.32 ms, the others
0.026 ms, and a COMMIT with `synchronous = FULL` 1.22 ms.

The thread still looks at the log every second, but copies it only:
- when the log file is larger than `OSCAR_DB_CHECKPOINT_MB` (16 by default,
  1 to 1024), and was written since the last checkpoint;
- when its last checkpoint is older than `OSCAR_DB_CHECKPOINT_SECONDS` (30 by
  default, 1 to 600);
- at the next look, when the last checkpoint could not copy everything (a
  reader still used some pages).

The server's connection sets `journal_size_limit` to the same size: the log
file is cut back when it starts again, so its size says how much it holds.
A wrong value of either setting stops the start. To check on a batch: the
COMMITs over 0.1 s in 5 minutes (panel *Database commits*) should fall from
about 200 to a handful.

**The checks' index** (#1295, server 1.11.537). The checks of every run
(`run_assertions`) had an index by company and text of the check. Sorted by
that text, it gave each of a run's 250 to 400 checks a page of its own, in an
index of more than a gigabyte. Measured with the server's own code on a
database of 7.7 million checks:

| | Pages of log written per run | Time to store a run |
|---|---|---|
| With that index | 860 | 119 ms |
| With an index by company alone | 94 | 24 ms |

It held 1.2 GB of a 4.7 GB database. Its two readers were the trend routes
(`GET /v1/reports/trends` and `/trends/summary`), which now read the
company's latest finished runs, a few at a time, and a deleted company's
cascade, which the index by company alone serves.

Replacing one index by the other reads the old index and every check. So:

- **A new database, or one of at most 500,000 checks** (about 2,000 runs):
  done at the first start of 1.11.537, in a moment.
- **A larger database** keeps the old index, which still works, and each
  start says so in one line: `[db] the checks are still indexed by their
  text (about N checks) …`. An administrator of the machine then runs one
  command, once, at a quiet time.

What there is, and what the command would do (changes nothing):

```bash
sudo docker exec oscar node --no-warnings src/db/checkIndexes.js
```

The swap:

```bash
sudo docker exec oscar node --no-warnings src/db/checkIndexes.js --apply
```

On Kubernetes, the same in the server's container:

```bash
kubectl -n oscar exec deploy/oscar -c oscar -- node --no-warnings src/db/checkIndexes.js --apply
```

What the command does, since server 1.11.538 (#1305). It works in two
parts: the old index removed, then the new one made. Each part has two
steps, and says each one before it starts:

| Step | The server meanwhile | What the command prints |
|---|---|---|
| It reads what the part needs (the old index, then the checks) | works as usual: a reader blocks nobody | `Reading … without any lock`, then `read so far: …` every ten seconds |
| It changes the database | pages are read as usual; whatever *writes* (a sign-in, a save, a run) waits five seconds, then fails | `Now removing it: the server cannot write until the next line`, then `Removed: the server could not write for N s` |

The reading is the long step. Done first, it leaves the pages in memory,
so the change that follows holds the database for much less time.

What to know before running it:

- **Choose a time when nobody works, and no run is going.** The command
  refuses while a run is queued or running, at the start and again before
  each change: a run started while it was reading stops it before the
  change, and the command is run again later. It goes on from where it was.
- **How long.** The first run on a server, on the k3s test machine with 8.5
  million checks in a database of 14 GB, was made by 1.11.537, which read
  *while* it held the database: 442 s for the first part, about a quarter
  of an hour in all, every write of the server failing for all that time.
  The reading takes as long with 1.11.538, but the server works meanwhile.
  How long the two changes then hold the database on a server is not
  measured yet: the command prints it.
- **Closing the window, or Ctrl-C, does not stop it.** It goes on in the
  container. What it says is also written beside the database, in
  `check-indexes.log`; to read it from another window:
  `sudo docker exec oscar tail -n 20 data/check-indexes.log`. To stop it:
  `sudo docker exec oscar sh -c "kill N"`, N being the process number its
  first lines give. A part that had not ended changes nothing; a part that
  had ended stays, and the command run again does the rest.
- **Disk:** it needs about 150 bytes per check free beside the database
  while it makes the new index (1.1 GB for 7.7 million checks), and refuses
  with less. The database file does not grow: the new index is written in
  the pages the old one frees, and the rest of those pages hold the next
  data stored.
- **With the server stopped** (a container of the same image and volume),
  the runs the server left marked running make it refuse: add `--force`.

It ends with `done. The database file keeps its size; N MB of it are free
and will hold the next data stored.` A second run answers `nothing to do`,
and the start-up line is gone at the next start. To check on a batch
afterwards: `oscar_run_work_seconds{work="results_store"}` per run and the
growth of `oscar_db_wal_bytes` should both fall.

**SQLite's memory** (#1237, server 1.11.517). SQLite's defaults were a page
cache of 2 MB, no memory map, and temporary sorts and groupings in files.
With a database of 10 GB, each lookup or insert that misses those 2 MB asks
the operating system for its page, and storing one check updates 8 B-trees
(`run_assertions` and its 7 indexes). The server's connection now runs with:

| Setting | Default | What it is |
|---|---|---|
| `OSCAR_DB_CACHE_MB` | 64 | The page cache, 2 to 1024 MB. Memory of OSCAR's process, used as the pages are read. |
| `OSCAR_DB_MMAP_MB` | 256 | How much of the database file is read through a memory map, 0 (none) to 2047 MB. The mapped pages are the operating system's own cache of the file, not a second copy. |
| `OSCAR_DB_TEMP_STORE` | `MEMORY` | Where temporary sorts and groupings go: `MEMORY` or `FILE` (as before). |

A wrong value stops the start. The values in use are on the start-up line,
`[db] SQLite ready → … (… cache 64 MB, memory map 256 MB, temporary storage
memory)`, and in `oscar_db_memory_bytes` and `oscar_db_temp_store`
(*Explore*). The checkpoint thread's connection keeps SQLite's defaults: it
only copies the log into the file.

To compare before and after on one machine, run one batch with
`OSCAR_DB_CACHE_MB=2`, `OSCAR_DB_MMAP_MB=0` and `OSCAR_DB_TEMP_STORE=FILE`
(SQLite's defaults), one without them, and read the row *OSCAR's thread* and
the slow statements of each.

**SQLite's statistics** (#1238, server 1.11.518; off by default since
1.11.524, #1269). SQLite chooses an index from statistics that `ANALYZE`
writes into `sqlite_stat1`. `ANALYZE` had never run on OSCAR's database, so
the planner guessed how many rows an index gives, and a query could walk
every run of a company instead of using the index of its batch (#1227). The
queries where that mattered now name their index (`INDEXED BY`, or `+` in
front of a column, #1227 and #1246).

- **Off by default, for what it costs.** An `ANALYZE` reads every index of
  its table in full to count its entries; the analysis limit bounds only the
  sample (measured: a limited `ANALYZE` of a 3-million-row table took as long
  as a walk of its index). It holds the database's write lock all along. On
  the k3s test machine, a minute after a restart (a database of 10 GB not yet
  in memory), one table took more than a minute: the server's writes waited
  their 5 s busy timeout and failed, so two sign-ins answered 500, and a run
  storing its results then would have lost them.
- **When, if asked.** With `OSCAR_DB_OPTIMIZE=daily`, the checkpoint thread
  runs SQLite's `PRAGMA optimize` a minute after the start, then once a day:
  the advice of [SQLite](https://www.sqlite.org/pragma.html#pragma_optimize)
  for a connection that stays open. It analyzes only the tables that have no
  statistics yet, or whose number of rows changed tenfold since. Choose it
  only where the database stays in memory, or for one start at a quiet
  moment (then `off` again).
- **Never on the server's thread.** The thread analyzes one table at a time,
  with an analysis limit of 1,000 rows per index, and pauses a quarter of a
  second after each. It says before each table that it is analyzing it, so
  the watchdog of the checkpoint thread does not take a long analysis for a
  dead thread (until 1.11.524 it did: the thread was given up and the COMMITs
  checkpointed by themselves again until the next restart). An analysis
  longer than a minute is one error line: `[db] statistics: <table> analyzed
  for over 60 s, holding the write lock: …`.
- **The server's plans follow.** A connection reads the statistics when it
  reads the schema, and another connection's `ANALYZE` does not make it read
  them again. So the server's connection runs `ANALYZE sqlite_schema` after
  each run that analyzed a table: about a millisecond.
- **What it says.** One line per run, with the tables' names:
  `[db] statistics: 12 tables analyzed in 3.4 s (runs, run_assertions, …),
  read again in 0.8 ms`, or `no table needed them again`. A failure is an
  error line and `oscar_db_optimize_runs_total{outcome="failed"}`; the next
  run is the next day.
- **To check a change of plan.** Statistics change the plans of every query.
  Compare the slow statements of one batch before the first run and one
  after (*OSCAR · Logs*, *Slow database statements*).
- **If a query became slower.** Set `OSCAR_DB_OPTIMIZE=off`, remove the
  statistics, then restart OSCAR. On a cluster:

```bash
sudo kubectl -n oscar exec deploy/oscar -c oscar -- node --no-warnings -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/app/data/oscar.db', { timeout: 5000 }); db.exec('DELETE FROM sqlite_stat1'); console.log('statistics removed')"
```

  On the VPS, the same `node` command with `docker exec oscar` in place of
  `sudo kubectl -n oscar exec deploy/oscar -c oscar --`. Then name the slow
  statement in an issue: the fix is in the query (`INDEXED BY`, or `+` in
  front of a column, as #1227 and #1246 did).
- **Statistics already kept stay** when `OSCAR_DB_OPTIMIZE` is `off`: a
  server that ran 1.11.518 to 1.11.523 may hold some, from the tables
  analyzed before a long one. The planner reads them; remove them as above
  only if a query became slower.

### Run pods (#1130)

With `RUN_ISOLATION=pod` (Kubernetes or OpenShift, each run in a pod of its
own; *OSCAR - Kubernetes and OpenShift Deployment Guide*, section 10a), two
more metrics; in any other mode they stay empty:

- `oscar_run_pod_start_seconds`, a histogram: from the server asking the run
  dispatcher for a run to its pod running. A few seconds with the run image
  already on the node; more on a node that must pull it.
- `oscar_run_pods_ended_total{outcome}`, one per run: `ran` (Bruno ended,
  passed or not), `deadline` (the run's Job reached its deadline),
  `not_started` (the pod never ran), `stopped` (on the server's word: a stop,
  a time limit) or `refused` (by the dispatcher, or the server lost it).

The row *Run pods* of *OSCAR · Overview* shows both. Two alerts:
`OscarRunPodsNotStarting` (the run image cannot be pulled, the runs'
namespace's quota is full, or its pod security refuses the pod) and
`OscarRunDispatcherRefusing` (the dispatcher is down, refuses the server's
key, has as many runs as `RUN_DISPATCHER_MAX_RUNS`, or the Kubernetes API
did not answer for `RUN_DISPATCHER_API_WAIT_MS`, 2 minutes by default). Since
#1272 the dispatcher waits for the API that long instead of refusing at
once, and logs each refusal with its reason.

### A run's time, step by step (#1312)

`oscar_run_work_seconds` is the server's thread. `oscar_run_step_seconds{step}`
is the run's own clock: the time between the moments the server sees for a
run, from the slot it is given to its final status. The server notes those
moments itself; nothing is read from what the run prints.

| Step | From the step before, to | Modes |
|---|---|---|
| `prepare` | the run is handed to the launcher (the server's checks, the token, the run's environment) | all |
| `job` | the dispatcher made the run's Secret and Job | pod |
| `pod` | the pod's container runs | pod |
| `folder` | the pod's first line: its work folder is ready and Bruno is being started | pod |
| `bruno_start` | Bruno's first call to the server (the data file, or a token) | all |
| `requests` | the scenario's requests, as Bruno timed each: its scripts and the provider's answers | all |
| `reports` | the rest until the first result file reaches the server (pod), or Bruno's end (other modes): Bruno between requests, its reports, their merging | all |
| `send` | the last result file is kept | pod |
| `end` | the dispatcher reports the pod's end | pod |
| `link` | the reports are linked to the run | all |
| `store` | the checks are stored and the final status written | all |

- `scenario` stands for `requests` and `reports` as one step, for a run whose
  results were not stored (Bruno's own times are read from them).
- A step is given only when both its ends were seen. A run refused before it
  was launched, or stopped by an emergency stop, gives none.
- The dispatcher looks at a pod once a second, so `pod` and `end` are known
  to the second.
- Not counted: the time a run waits in the queue (it depends on the batch),
  and the removal of the Job and the Secret, which the dispatcher does after
  the run's end.

The row *A run's time, step by step* of *OSCAR · Overview* shows the mean
per step, stacked (one run's mean time), and the 95th percentile of each. The
same figures are in each run's log, in one line at its end:

```
[runner] Where this run's time went (37.0 s from its slot to its final status): preparing the run 0.5 s, asking for its pod 0.5 s, waiting for its pod 6.0 s, …
```

### Kept run pods (#1309)

With `RUN_KEPT_PODS=on` (pod mode; *OSCAR - k3s on one VPS*, section 9,
*Kept run pods*) the runs of one batch go one after another to a pod kept
for that batch. Three more metrics; with `off` they stay at 0:

- `oscar_kept_pods{state}`: the kept pods now, `new` (made, not called yet),
  `waiting` (for its batch's next run, 30 s at most) or `running`.
- `oscar_kept_pod_runs_total{pod}`: each run handed to a kept pod, `first`
  (the pod's first run, made for it) or `again` (a pod that ran before: its
  start saved).
- `oscar_kept_pods_stopped_total{reason}`: each pod given up, by reason:
  `batch-done`, `idle`, `max-runs` (the usual ends), `abnormal-end` (a run
  ended otherwise than with Bruno's 0 or 1, or sent no result), `not-clean`
  (a run left a process behind), `not-started`, `pod-ended`, `deadline`,
  `stopped` (the runner stopped the run), `revoked` (an intrusion, another
  endpoint, new credentials) and `protocol` (below).

The row *Kept run pods* of *OSCAR · Overview* shows all three. With kept
pods, a run handed again shows near 0 in *Run pods* (time for a run's pod to
start) and in the steps `job` and `pod` of *A run's time, step by step*.

One alert, critical: `OscarKeptPodProtocolFault`. A kept pod called the
internal port in a way its program never does (a second call while one was
held, a call during a run, the end of another run, another address). The
server has stopped that pod and every pod of its company already: something
in the pod read its secret, so a run there may have been compromised by the
provider under test. The server's log names the company.

### On Kubernetes (#1147)

This page's stack is the VPS's (`docker-compose.metrics.yml`). On a cluster:
- `OSCAR_Deploy/kubernetes/monitoring/oscar` gives a cluster's Prometheus
  Operator the same jobs, alerts and dashboards (*OSCAR - Kubernetes and
  OpenShift Deployment Guide*, section 8);
- on one machine with k3s, `monitoring/stack` installs Prometheus,
  Alertmanager, Grafana and Loki as well (*OSCAR - k3s on one VPS*, section
  8a).

In pod mode a run is a pod, which OSCAR's own process figures do not see.
Its memory and CPU come from the kubelet (cAdvisor), its limit and end from
kube-state-metrics, in the dashboard *OSCAR · Kubernetes*: each run pod's
memory against `RUN_MEMORY_LIMIT`, its CPU, the runs stopped for memory, the
quota of `oscar-runs`, OSCAR's pods and the machine. Two alerts there:
`OscarRunPodNearMemoryLimit` (over 90 % of the limit for a minute) and
`OscarRunPodOutOfMemory` (Kubernetes stopped a run at the limit; OSCAR shows
it as failed). Prometheus reads every 15 s, so a run shorter than that may not
show.

### The OSDM simulator (#1005)

The simulator runs on a host of its own and is read **through OSCAR**: the
job `osdm-simulator` scrapes `http://oscar:3001/metrics?source=simulator`,
and OSCAR asks the simulator's administration API (`GET /admin/api/metrics`)
with the address and key saved in Admin → OSDM Simulator, then writes the
answer in Prometheus's format (`osdm_sim_*`). So Prometheus holds no key,
nothing new is opened on the simulator's host, and nginx's
`location = /metrics` 404 covers the path (a query string does not change
that match). OSCAR reads the simulator at most once every 10 s.

What the simulator reports: requests by provider, method and status and
their duration (its administration API left out), refusals of its rate
limit, its process (memory, CPU, event-loop delay), and its host as `/proc`
shows it: memory, swap, load, CPU time by mode, and the disk of its data
folder. Never an account, a token or a body.

`oscar_simulator_configured` is 0 while no simulator is set up, and nothing
fires. Once set up, `oscar_simulator_up` says whether it answered. The rules
are in `prometheus/alerts/osdm-simulator-alerts.yml`: unreachable (critical),
swap over 256 MiB, memory over 90 %, P95 over 1 s, 429s to the OSCAR server,
disk under 10 %, event-loop delay over 200 ms.

---

## One-time setup

### 1. Pull the repo (gets the new compose overlay + dashboard files)

```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR pull
```

### 2. SSO instead of htpasswd

Grafana is now SSO'd through OSCAR — no separate password file. Anyone signed in to OSCAR as **administrator** lands directly in Grafana when they click the menu link or visit `https://oscar.uic.org/grafana/`. Non-admins get bounced back to the OSCAR login page.

(If you previously installed an `/etc/nginx/.htpasswd-grafana` file for the v1.5.0 / v1.5.1 basic-auth setup, you can leave it on disk — it's no longer referenced — or remove it: `sudo rm /etc/nginx/.htpasswd-grafana`.)

### 3. Add the nginx snippet

Open the OSCAR site config (e.g. `/etc/nginx/sites-enabled/oscar.uic.org`)
and paste the two `location` blocks from
`/opt/OSCAR/OSCAR_Deploy/nginx/oscar-metrics.conf.snippet` into the
existing `server { ... }` block.

Reload:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Start the metrics stack

```bash
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d
```

This pulls + starts `oscar-prometheus` and `oscar-grafana` alongside the
existing `oscar` container. The original `oscar` container is unaffected
(no recreate, no downtime).

### 5. Open the dashboard

Visit **`https://oscar.uic.org/grafana/`**, log in with the htpasswd
credentials. The "OSCAR · Overview" dashboard loads automatically.

---

## Day-to-day

### Stop just the metrics stack (leave OSCAR running)

```bash
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml stop prometheus grafana
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml rm -f prometheus grafana
```

### Or just turn off the overlay on next restart

```bash
sudo docker compose -f docker-compose.yml down                 # stops everything
sudo docker compose -f docker-compose.yml up -d                # restarts WITHOUT metrics
```

### Resource budget

Steady state on a small VPS:

| Container | RAM | Disk |
|-----------|-----|------|
| Prometheus | ~150 MB | ~500 MB (15d retention) |
| Grafana | ~120 MB | ~50 MB |
| Loki | ~80 MB | grows ~5-50 MB/day depending on log volume |
| Promtail | ~30 MB | minimal (positions file) |
| Alertmanager (v1.8) | ~30 MB | minimal (silences, notification log) |
| **Total added** | **~410 MB** | **~600 MB after 30d typical** |

### Where data lives

Two named Docker volumes survive container recreation:
- `oscar_deploy_prometheus-data` — TSDB samples
- `oscar_deploy_grafana-data` — Grafana's internal SQLite (annotations, etc.)

Grafana dashboards themselves are NOT stored in `grafana-data` — they're
provisioned from `/opt/OSCAR/OSCAR_Deploy/grafana/dashboards/*.json` on
every container start. To customize, edit the JSON in Git and reload the
container.

---

## Adding a new metric

Three steps:

1. **Declare it** in `Oscar_Server/src/utils/metrics.js`:
   ```js
   const myCounter = new promClient.Counter({
     name: 'oscar_my_thing_total',
     help: 'Description of what this counts',
     labelNames: ['result'],
     registers: [register]
   });
   module.exports = { ..., myCounter };
   ```

2. **Increment it** wherever the event happens:
   ```js
   const { myCounter } = require('../../utils/metrics');
   myCounter.inc({ result: 'success' });
   ```

3. **Add a panel** to `OSCAR_Deploy/grafana/dashboards/oscar-overview.json`
   (or create a new dashboard JSON file in the same directory). Reload
   Grafana — the new panel appears within 30 seconds.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Grafana 502 from nginx | Grafana container down or wrong port | `docker logs oscar-grafana` |
| Empty graphs in Grafana | Prometheus can't reach OSCAR | `docker exec oscar-prometheus wget -qO- http://oscar:3001/metrics \| head` |
| `/grafana/` redirect loop on first login | `GF_SERVER_DOMAIN` defaulted to `localhost` | Source has it hardcoded since v1.6.0 — verify env via `docker exec oscar-grafana env \| grep GF_SERVER` |
| `/grafana/` ERR_TOO_MANY_REDIRECTS | nginx `proxy_pass http://127.0.0.1:3000/;` has trailing slash | Remove the `/` — source has the correct form since v1.6.0 |
| `/grafana/` returns 500 from nginx | `auth_request` got a 3xx redirect (only 2xx/401/403 accepted) | The `/auth/sso-check` location must send `Host: localhost` AND `X-Forwarded-Proto: https`. Source snippet has both since v1.6.1 |
| Grafana panels show "No data" with red triangles | Datasource UID mismatch | Datasource provisioning must set `uid: prometheus` (source has it since v1.6.0) |
| Grafana panels show "No data" without errors | Prometheus has no data (target down) — see next row | |
| Prometheus `oscar-server` target down with 400 / ECONNREFUSED | OSCAR's HTTPS-redirect intercepting plain-HTTP scrape | v1.5.1+ exempts `/metrics` from the redirect — make sure you're on v1.5.1 or later |
| External `https://oscar.uic.org/metrics` returns OSCAR HTML | nginx snippet not installed | Re-do nginx step, reload nginx |
| External `https://oscar.uic.org/metrics` returns the metrics in clear | nginx snippet not installed correctly | Re-do nginx step, **immediate fix** |
| `refresh-collection.sh` fails with "working tree dirty" on the deploy workflow | Local edits in `/opt/OSCAR/` block `git pull` | `sudo -u ubuntu git -C /opt/OSCAR status` to see what's dirty; `git checkout -- .` to discard tracked-file edits; `rm /opt/OSCAR/FETCH_HEAD` if that's the only "untracked" entry |
| **Alertmanager won't start — `error loading config: yaml: did not find expected key`** | `alertmanager.yml` not created on host (gitignored — only `.example` ships) | `cp alertmanager/alertmanager.yml.example alertmanager/alertmanager.yml` then edit + `docker compose up -d alertmanager` |
| **Alerts fire in Prometheus but no email arrives** | Alertmanager SMTP credentials wrong | `docker logs oscar-alertmanager --tail 50` shows the SMTP error verbatim. Note: Alertmanager has its OWN config file — it doesn't reuse OSCAR's Server Config DB |
| **Autoheal restarts oscar repeatedly** | Healthcheck failing because OSCAR can't actually reach DB / disk | `docker exec oscar node -e "fetch('http://127.0.0.1:3001/health').then(r=>r.json()).then(console.log)"` — shows which subsystem is unhealthy |
| **`oscar` container shows `(unhealthy)` but it was not restarted** | The host's timer is not installed (`systemctl list-timers oscar-autoheal.timer`; *Server Admin Guide*, 13.8), or the container is missing the `autoheal=true` label | Recreate with `docker compose up -d --force-recreate oscar` (label only applies on create, not start) |

### Operator note: dirty-tree on the host

`refresh-collection.sh` refuses to `git pull` when the host's working tree has any uncommitted edits OR untracked files (treated as "dirty"). Two common sources:

- **Manual debugging edits** — common during incident response. Once the equivalent fix lands in source via a PR, discard the local edit with `git checkout -- <file>` to let auto-pull resume.
- **Stray `FETCH_HEAD`** at the repo root — git creates this file during a fetch from a non-standard working dir; it's usually `.git/FETCH_HEAD` (which git ignores) but can land at the repo root in some shells. Safe to delete.

After cleaning, the next release-tagged push will auto-refresh the host repo via `refresh-collection.yml` + `promote-release.yml` (both SSH the host, both run the same script).
