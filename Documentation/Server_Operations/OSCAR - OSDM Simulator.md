# OSCAR — OSDM provider simulator

Issue #575. A stub OSDM provider that issues its own access tokens and answers
a basic sale flow, so that a company in OSCAR can run scenarios without any
operator's system. It exists to test OSCAR itself (a security test, a demo, a
check after a deployment), not to test OSDM: it is not a conformance reference.

The code and its reference are in [`OSDM_Simulator/`](../../OSDM_Simulator/README.md).
This page is about installing it and pointing a company at it.

## 1. What you get

One server that plays six providers, told apart by the first part of the path:

| Provider | Endpoint to give OSCAR | Currency | OSDM version | Token lifetime |
|---|---|---|---|---|
| `alpha` | `https://<simulator-host>/alpha` | EUR | 3.6.0 | 1 hour |
| `beta` | `https://<simulator-host>/beta` | CHF | 3.7.0 | 2 minutes |
| `gamma` | `https://<simulator-host>/gamma` | CZK | 3.8.0 | 15 minutes |
| `delta` | `https://<simulator-host>/delta` | PLN | 3.9.0 | 30 minutes |
| `epsilon` | `https://<simulator-host>/epsilon` | SEK | 3.10.0 | 10 minutes |
| `zeta` | `https://<simulator-host>/zeta` | NOK | 3.12.0 (in development) | 5 minutes |

Each provider answers in the shapes of its own version (#833): `alpha` gives
OSDM 3.6 answers, `beta` 3.7, `gamma` 3.8, `delta` 3.9 (#858; 3.9 changed no answer schema, so `delta` answers as `gamma` does), `epsilon` 3.10 (#920; released on 21/10/2026, it adds optional members only, so `epsilon` answers as `gamma` does, and serves `POST /trips-collections`), `zeta` 3.12, the version in development (#925: the OSDM `master` branch at the commit pinned in `osdm-dev.json`, given by `/healthz` under `development`; 3.11 and 3.12 add optional members and deprecations only, so far). `zeta` follows `master`: each OSDM change merged there that touches the simulator comes in a PR of its own; a weekly watch reports them. Below 3.8, for example, a
fulfilment holds its documents instead of naming them, and below 3.7 an
offer has no `inboundTripCoverage`. The simulator's tests check every answer
against the OSDM response schema of the provider's version. Since #824 the providers offer the same functions (exchange,
reservations and place selection, products and reduction cards, trip ids,
documents, idempotency, the checks behind the negative tests…), so every
reference scenario of the catalogue can be copied for and run on any of them.
The one exception is OSDM's own: a return in one offer (`outboundTripIds`)
needs OSDM 3.7, so `alpha` (3.6) does not declare it.

Every identifier a provider returns starts with its name (`ALPHA-BKG-…`,
`BETA-OFR-…`), and its carrier is named after it, so a report shows at a glance
which provider answered. A token issued by one provider is refused by the
others.

## 2. Where to install it

**On a host of its own, not on the OSCAR host.** OSCAR only accepts an OSDM
endpoint that is `https` on a public address, so the simulator needs:

- a public DNS name that resolves to the host;
- ports 80 and 443 open (80 for the certificate, 443 for the traffic);
- Docker with the compose plugin, nginx, certbot.

It holds no data and no secret of OSCAR. Its only secrets are the client
secrets of the simulated providers, which you generate below.

## 3. Install

Before anything is installed, set the host up as
[`OSCAR - Server Hardening.md`](OSCAR%20-%20Server%20Hardening.md) says: SSH by
key only and no root login, a firewall, fail2ban and security updates. Its
section 2 is the checklist to run once the simulator is up.

As root on the simulator host. Do not run `umask 077` first: the container runs
as an unprivileged user and has to read the checkout.

```bash
# Ubuntu 24.04; on another system install Docker with its compose plugin, nginx and certbot your usual way
apt-get update && apt-get install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx git
git clone --depth 1 https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner.git /opt/osdm-simulator
```

Everything the simulator needs on the host is in its deploy folder,
`/opt/osdm-simulator/OSDM_Simulator/deploy`: the compose file and the clients
file. The commands of this page name files by their full path, so they work
from any folder. Only `docker compose` has to be run from the deploy folder,
and each block that uses it starts with the `cd`. A new session on the host
starts in your home folder, not there.

Generate the clients file, with random secrets. It is written as
`clients.json` in the deploy folder, with access for its owner only, and an
existing file is never replaced.

```bash
docker run --rm -v /opt/osdm-simulator/OSDM_Simulator:/simulator -w /simulator node:22-slim \
  node scripts/make-clients.js deploy
chown 1000:1000 /opt/osdm-simulator/OSDM_Simulator/deploy/clients.json
```

Each provider gets three clients for Test Managers and three for testers, and
the id says which:

| Client id | Meant for |
|---|---|
| `alpha.tstmgr01`, `alpha.tstmgr02`, `alpha.tstmgr03` | Test Managers, on `alpha` |
| `alpha.tst01`, `alpha.tst02`, `alpha.tst03` | testers, on `alpha` |
| `beta.…`, `gamma.…` | the same on `beta` and `gamma` |

The command prints the ids it created (never a secret). For other numbers, add
them after `deploy`: `deploy 2 5` gives two Test Manager clients and five
tester clients per provider. The role is in the name only: the simulator
treats every client of a provider alike. Give each OSCAR account a client of
its own: two accounts that share one see each other's bookings on the
simulator.

The data folder (#930) keeps the accounts from the first start on, imported
from `clients.json`, with the audit of their changes. It belongs to the
container's user, and to it only. Then draw the administration key: OSCAR's
administrators manage the accounts from OSCAR, whose server calls the
simulator with this key. The simulator keeps only its SHA-256, in `.env` next
to the compose file (git ignores it); the key itself goes into OSCAR (*Admin →
OSDM Simulator*, OSCAR 1.11.383 or later) and is then needed nowhere else:

```bash
cd /opt/osdm-simulator/OSDM_Simulator/deploy
install -d -m 700 -o 1000 -g 1000 data
KEY=$(openssl rand -hex 32)
printf 'SIM_ADMIN_KEY_SHA256=%s\n' "$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)" > .env && chmod 600 .env
echo "$KEY"      # copy it into OSCAR now; it is kept nowhere on this host
unset KEY
```

Start the simulator and check it from the host:

```bash
cd /opt/osdm-simulator/OSDM_Simulator/deploy
docker compose up -d
docker compose ps                      # STATUS must reach "healthy"
curl -s http://127.0.0.1:3002/healthz  # {"status":"ok"}
```

Put nginx in front and get the certificate (replace the host name twice):

```bash
sed 's/simulator.example.org/<simulator-host>/' /opt/osdm-simulator/OSDM_Simulator/deploy/nginx-osdm-simulator.conf.example > /etc/nginx/sites-available/osdm-simulator
ln -s /etc/nginx/sites-available/osdm-simulator /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d <simulator-host>
```

If the certificate is refused because the host name belongs to the hosting
company's shared domain (too many certificates already issued for that domain),
point a name of your own at the host (a `CNAME` or an `A` record) and use that
name instead.

## 4. Check it from outside

The secrets are in the clients file on the simulator host. Read the one you
need there, by its id, without printing the whole file:

```bash
ID=alpha.tstmgr01; python3 -c "import json,sys;print(next(c['client_secret'] for p in json.load(open('/opt/osdm-simulator/OSDM_Simulator/deploy/clients.json')).values() for c in p if c['client_id']==sys.argv[1]))" "$ID"
```

To hand out the clients of one provider, this lists each id with its secret:

```bash
python3 -c "import json;[print(c['client_id'], c['client_secret']) for c in json.load(open('/opt/osdm-simulator/OSDM_Simulator/deploy/clients.json'))['alpha']]"
```

Both work from any folder. An id that is not in the file ends the first one
with `StopIteration`, and a provider that is not in it ends the second with
`KeyError`.

Then, from any other machine, in two steps.

First, on its own, this line. It stops at a prompt and waits: paste the secret
of that client and press Enter. Nothing is shown while you paste.

```bash
H=https://<simulator-host>; ID=alpha.tstmgr01; read -rsp "Secret of $ID: " SECRET; echo
```

Do not paste it together with the lines below: the terminal would then wait
for the secret without saying so, and look frozen.

Then the checks:

```bash
curl -s $H/healthz; echo
# a token for alpha
T=$(curl -s -d grant_type=client_credentials -d "client_id=$ID" --data-urlencode "client_secret=$SECRET" $H/alpha/oauth/token | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))")
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" $H/alpha/versions   # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" $H/beta/versions    # 401: alpha's token on beta
curl -s -o /dev/null -w '%{http_code}\n' $H/alpha/versions                                 # 401: no token
```

Expected: `{"status":"ok","version":"<version>"}`, then `200`, `401`, `401`. If the first number is
`401`, no token was issued: the secret is not the one of that client.

What needs no secret can be checked at any time: `/healthz` answers
`{"status":"ok","version":"<version>"}` over https with a valid certificate, `/alpha/versions`
without a token answers 401, and an unknown provider answers 404.

## 5. Point a company at it

Every setting of this section and the next, for each provider (API Config,
Test Framework, Test Data, the special stop places and the scenarios that fail
on purpose), is in that provider's pre-filled set-up checklist (#819):
[alpha](Simulator%20checklists/OSCAR_Checklist_Simulator-alpha_V01.07.docx),
[beta](Simulator%20checklists/OSCAR_Checklist_Simulator-beta_V01.07.docx),
[gamma](Simulator%20checklists/OSCAR_Checklist_Simulator-gamma_V01.07.docx),
[delta](Simulator%20checklists/OSCAR_Checklist_Simulator-delta_V01.07.docx),
[epsilon](Simulator%20checklists/OSCAR_Checklist_Simulator-epsilon_V01.07.docx),
[zeta](Simulator%20checklists/OSCAR_Checklist_Simulator-zeta_V01.07.docx).
Each name carries the template version (`V01.06`), so these links change with
it (a test fails on a link to a file that is not there). They are generated with the provider checklists' generator (kept in the
private repository), never edited by hand.

**The reference configurations (#838).** The repository holds, for each
provider, what such a company must hold:
`Bruno_Collection/data_base/reference/simulator-<provider>.json`. Each gives
the Test Framework (the editor's defaults, with every `fw.*` answer of the
provider's checklist), the Test Data (one train per trip leg of the data file,
one journey per trip of several legs) and the provider's run list (the
scenarios of its OSDM version, none that fails on purpose). It names
`simulator_datafile.json` rather than copying the scenarios. They are
generated by `Oscar_Server/scripts/generate-reference-configurations.js` from
the checklists, the simulator's profiles and the data file, never edited by
hand; a test fails until they are regenerated after any of the three changes.

**Following a reference (#838, 1.11.335).** Rather than steps 3 and 4 below, a
Test Manager of a company (or provider) made for the simulator can choose its
reference in Test Config → *Reference configuration* (`simulator-alpha`,
`-beta`, `-gamma`, `-delta`, `-epsilon` or `-zeta`), then click *Update from the reference*. The update
replaces the scenarios (the current data file stays the previous one, see
*Restore previous file*), the Test Framework and the Test Data trains and
journeys with the reference's, and sets the run list to the provider's; the
endpoint and the credentials are not touched. The reference is read from the
collection on the OSCAR server, which is pulled from the repository on every
push to `main`. When either the reference or the data file changes there,
Test Config and the run page say the configuration is not up to date, until a
Test Manager updates it again. Scenarios a tester added to such a company are
replaced too.

Use a company made for this. **Do not do it on a company that tests a real
provider:** step 3 replaces the company's data file. When the company has no
Test Framework or no train yet, OSCAR then offers to create them from the
file; it never replaces existing ones.

1. **Endpoint** (Test Manager, API Config → *OSDM API Endpoint*):
   `https://<simulator-host>/alpha`
2. **Credentials** (each tester, API Config, OAuth2):
   - Auth Profile: *Standard OAuth2 — credentials in Basic auth header*
     (*credentials in body* works as well);
   - Token URL: `https://<simulator-host>/alpha/oauth/token`
   - Client ID and Client Secret: one entry of `alpha` in `clients.json`,
     a `tstmgr` one for a Test Manager and a `tst` one for a tester, and not
     one somebody else already uses. Scope is left empty.
3. **Test data** (Test Manager, Test Config → *Upload datafile*): upload
   [`Bruno_Collection/data_base/simulator_datafile.json`](../../Bruno_Collection/data_base/simulator_datafile.json).
   Its scenarios are shared with the company's testers. Each ends in the
   OSDM version of its provider (`_36` `alpha`, `_37` `beta`, `_38` `gamma`);
   the functions added since are tested by the `_38` scenarios, and run on
   `alpha` and `beta` too through the reference scenarios (Test Config →
   *Copy scenarios* → the catalogue). What each one tests, what the
   simulator answers and what a run must show: the
   [scenario catalogue](OSCAR%20-%20OSDM%20Simulator%20scenarios.md).
   The file's run list is the `gamma` scenarios; for `alpha` or `beta`, tick
   that provider's in Test Config.
4. **Return journeys** (Test Manager, Test Config → Test Framework → *Sales
   Flows* → 🔁 *Return journeys*, since 1.11.236): `alpha` (OSDM 3.6) declares
   *Separate directions* only; `beta` and `gamma` declare both. A framework
   that existed before declares, on first opening, the models its scenarios
   use: both, since the file holds the scenarios of every version. On `alpha`
   the editor then says that *Both directions in one offer* needs OSDM 3.7:
   untick it. A return scenario whose model is not declared still runs, with a
   `[WARNING]` naming the model.
5. **Run** the scenarios of the provider's version. Expected: the version check and the sale steps answer
   200, the nine optional information requests answer 501 and are reported as
   "not implemented by this provider" (on `gamma`, `GET /reduction-cards` and
   `GET /products` answer 200), and no check fails. The warnings each
   scenario shows are listed in the catalogue.

The same data file runs without OSCAR too, with Bruno on a PC: see
[Run standalone](../../Bruno_Collection/README.md#run-standalone) in the
collection's README.

The data file works unchanged on every provider. A scenario of another
version also runs, with a warning from the version check: the scenario asks for
one version and the provider reports another.

One client can be given to several testers, but they then share their
bookings on the simulator. Give each tester a client of their own if their
runs must not see each other's.

## 6. Several providers for one distributor (#540)

In OSCAR, one company or provider has one endpoint, and each user has one set
of credentials for it. A second simulated provider is therefore a second
provider of the company, not a second set of credentials on the same one.

A Test Manager sets it up like this:

1. Menu **Providers** → *Add a provider*: a name (for example `Beta`) and the
   endpoint `https://<simulator-host>/beta`. Tick the testers who may use it.
2. **API Config** now has a section for `Beta`, next to the company's and the
   other providers', and its table at the top shows what is still missing.
   Open the `Beta` section, enter the token URL
   `https://<simulator-host>/beta/oauth/token` and a client of `beta` from
   `clients.json`, and press *Save configuration for Beta*. Each section is
   saved on its own, and each user enters their own credentials.
3. In the menu bar, set **Working on** to `Beta`. Test Config, New Run, the
   Dashboard and the reports of that browser tab now work on `Beta`.
4. **Test Config** → *Upload datafile*, the same file as in section 5: a
   provider has its own data file and Test Framework. Declare its return
   models as in section 5, step 4.
5. Run a scenario. Set **Working on** back to the company, or to another
   provider, to run there.

Do the same for `gamma`. Before v1.11.220, API Config showed one section only,
the one chosen in **Working on**: on such a version, do step 3 before step 2.

What this arrangement shows: a user who enters
`alpha`'s client on the `Beta` provider gets no token, and a token of `alpha`
sent to `beta` is refused with 401. A mix-up between providers is a failed run,
not a passing one, and every identifier in a report starts with the name of the
provider that answered.

## 6b. Faults on demand (#833)

The simulator can answer with chosen errors, to check that OSCAR's checks catch
them and that the AI analysis explains them. Each fault changes one kind of
answer; the bookings and offers stored are not changed.

Two ways to ask for them:

- **For one scenario:** the request header `X-Simulator-Faults: code, code`.
  The scenario field `simulatorFaults` makes the collection send it (#833 PR C).
- **For a whole provider:** a token asked with the scope
  `sim-faults:code,code` (the scope field of the tester's API Config), so every
  request made with that token is faulty. A second provider in OSCAR, for
  example "Gamma (faults)", pointing at the same simulator endpoint with such a
  scope, keeps the normal provider clean.

An unknown code is refused (HTTP 400 `UNKNOWN_FAULT`, or `invalid_scope` at the
token endpoint), so a typing mistake never looks like "OSCAR detected nothing".

| Code | What the simulator does | What OSCAR must report |
|---|---|---|
| `offer.price-below-parts` | an offer's minimalPrice is one unit below the sum of its admissions | 01: "Offer minimalPrice >= sum of admission parts price" fails |
| `offer.trip-unknown` | an offer covers a trip id the answer does not have | 01: "… is part of Trip ids" fails |
| `booking.currency-changed` | a new booking is priced in another currency | 02: "booking.provisionalPrice.currency matches offer currency" fails |
| `booking.passenger-dropped` | a new booking loses its last passenger | 02: "Booking contains exactly the expected number of passengers" fails |
| `booking.not-prebooked` | a new booking's admissions say CONFIRMED | 02: "Status is PREBOOKED for admission" fails |
| `passenger.name-altered` | a passenger update answers another last name | 03: "Last name is correct" fails |
| `fulfillment.wrong-status` | a confirmation gives fulfilments that say REFUNDED | 06: the fulfilment status comparison fails |
| `refund.amount-above-paid` | a refund offer gives back ten times its amount | 10: "Refund response bounds" fails |
| `refund.not-refunded` | a booking read after a refund shows its tickets FULFILLED | 14: the REFUNDED status check fails |
| `answer.html` | a booking read is answered with an HTML "Request Rejected" page | 05: "Content-Type is JSON" and "The answer is a JSON object" fail; the scenario stops |
| `error.problem-without-code` | every refusal (4xx) leaves out its problem code | the negative tests: a WARNING, "the refusal names no OSDM problem code" |
| `error.server-error-for-refusal` | every refusal (4xx) comes as HTTP 500 | the negative tests: "provider rejects with a client error (4xx)" fails |

The catalogue is `OSDM_Simulator/src/osdm/faults.js`; each entry says what
OSCAR must report (`expect`), which the detection report (#833 PR D) compares
with a run. The simulator's data file has one scenario per fault,
`SIM_FAULT_<CODE>_38` on gamma (listed in "OSCAR - OSDM Simulator scenarios"),
out of the run list because they fail on purpose: tick them, or copy the
field `simulatorFaults` into a scenario of your own (Test Config, "Simulator
faults", codes separated by commas). A real provider never sees the header:
the collection sends it only when the field is set.

**Reading the result (#833 PR D).** On the AI analysis page, choose the batch
and press **Faults detected in this batch**: for each fault a run asked for,
OSCAR says whether it was detected (every expected check seen, some, or
none) and which checks it saw. Nothing is sent to an AI service for that.
After an AI analysis of the same batch, **Score against the simulator's
faults** under its result also says, for each fault OSCAR failed, whether
the analysis explained it: a group with the provider as owner naming its
step (and its scenario, or none), another owner, or no group at all. The
score is the share explained; analysing the same batch with two models
gives two scores to compare. A fault seen only as a WARNING is not scored:
the analysis is sent failed checks only. The wording of the cause is not
judged, only owner, step and scenario.

## 7. Day to day

The `docker compose` commands are run from the deploy folder. In a new session
on the host, go there first:

```bash
cd /opt/osdm-simulator/OSDM_Simulator/deploy
```

| To do | How |
|---|---|
| See what is being called | `docker compose logs -f` (one line per request: time, method, path, status, provider, client; no header, no body) |
| Update the simulator | automatic on a new version, once set up (see below); by hand: `git -C /opt/osdm-simulator pull && docker compose restart` |
| See which version runs | `curl -s https://<simulator-host>/healthz` (`"version"`), or the first line of `docker compose logs` (`OSDM simulator <version> listening on …`) |
| Replace all clients and secrets | see below |
| Add, delete a client, give it a new secret | from OSCAR (*Admin → OSDM Simulator*), while it runs (below); `clients.json` is read on the first start only |
| Change the administration key | draw a new one as in section 3 (it replaces `.env`), `docker compose up -d`, and enter it in OSCAR |
| Clear every booking and end every token | `docker compose restart` |
| Stop it when the campaign is over | `docker compose down`, and remove the nginx site |

A restart clears the bookings and the tokens: they are kept in memory only, and the key that signs the tokens is drawn at
start-up. The accounts stay: they are in the data folder.

**Accounts while it runs** (#930). OSCAR's administrators add, delete or
reset them from OSCAR, in *Admin → OSDM Simulator*. The first time, enter the
simulator's address (`https://<simulator-host>`) and the key drawn in section
3, and press *Try and save*: OSCAR asks the simulator for its accounts with
that key, and saves address and key only if it answers. A new secret is shown once: hand it over then. A
deleted account, and the old secret of a reset one, are refused at once,
tokens included; the other accounts and their bookings are not touched. Each
change is a line of `deploy/data/audit.log`, with the OSCAR administrator who
asked. The API is called by the OSCAR server only: to keep it to that server,
fill in the `allow` / `deny` lines of the `/admin/` location in the nginx site
with the OSCAR server's address (a site set up before 0.51.0 has no such
location; add the block of `nginx-osdm-simulator.conf.example`). By hand, from
the host, with the key in `KEY`:

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'X-Admin-Actor: <your-name>' http://127.0.0.1:3002/admin/api/accounts
```

**Statistics** (0.52.0). The simulator counts, per day, provider and account,
the tokens, requests, offers, bookings, confirmations, refunds, exchanges and
answers in error; OSCAR shows them under Admin → OSDM Simulator → Statistics.
They are in `deploy/data/stats.json` (counts only), kept 400 days unless
`SIM_STATS_RETENTION_DAYS` says otherwise. A simulator without a data folder
counts nothing.
Above them, the same tab shows the test sets run from OSCAR on the
simulator (#930 PR 4), per provider and user: sets, scenarios, scenarios with
a failed check and failed checks. They come from OSCAR's own results: a run
counts when its company's endpoint is under the simulator address saved on
that page, so give companies that address exactly (same scheme and host).

**Moving an installed simulator to a data folder** (installed before 0.51.0).
The automatic update only restarts the container, which keeps the compose
settings it was made with: until `up -d`, the simulator reads `clients.json`
as before and the administration API answers `404`. Make the data folder and
the key as in section 3, then:

```bash
cd /opt/osdm-simulator/OSDM_Simulator/deploy
docker compose up -d          # re-creates the container: bookings and tokens are lost
docker compose logs | grep Imported   # "Imported N accounts from /run/osdm-simulator/clients.json"
```

The ids and secrets in use stay the same. Create the folder before any `docker
compose up -d`, the load test's included: without it Docker makes one that
user 1000 cannot write, and the simulator stops at start.

**Automatic update** (#617). Each simulator version is tagged
`simulator-<version>`, with a GitHub release whose notes come from the
CHANGELOG. When a merge to `main` changes the version, the workflow
*Simulator · update the installed simulator* connects to this host, runs the
update and checks that `/healthz` reports the new version. It runs only on a
version change, or when started by hand (Actions → the workflow → *Run
workflow*): a restart clears every booking and token, so an edit to the
documentation does not interrupt a campaign. Until the set-up below is done,
the workflow says that the secrets are missing and stops, green.

Set-up, once, as root on this host:

```bash
# 1. The update command, copied OUTSIDE the checkout: a merge cannot change
#    what the key may run. Read it before copying it again after an update.
install -m 0755 /opt/osdm-simulator/OSDM_Simulator/deploy/update.sh /usr/local/sbin/osdm-simulator-update
# 2. A user that may run it and nothing else (docker group for the restart).
useradd --create-home --shell /bin/sh simdeploy && usermod -aG docker simdeploy
chown -R simdeploy /opt/osdm-simulator
chown 1000:1000 /opt/osdm-simulator/OSDM_Simulator/deploy/clients.json   # the container's user reads it
chown -R 1000:1000 /opt/osdm-simulator/OSDM_Simulator/deploy/data          # and writes its data folder (#930)
# 3. A key pair; the private half goes to GitHub, the public half here,
#    restricted to the one command.
ssh-keygen -t ed25519 -N '' -C simulator-deploy -f /root/simulator-deploy
install -d -m 700 -o simdeploy /home/simdeploy/.ssh
echo "command=\"/usr/local/sbin/osdm-simulator-update\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat /root/simulator-deploy.pub)" > /home/simdeploy/.ssh/authorized_keys
chown simdeploy /home/simdeploy/.ssh/authorized_keys && chmod 600 /home/simdeploy/.ssh/authorized_keys
ssh-keyscan -t ed25519 <simulator-host>     # the known_hosts line
```

Then in the repository, Settings → Secrets and variables → Actions:
`SIMULATOR_SSH_KEY` (the content of `/root/simulator-deploy`, then delete that
file), `SIMULATOR_KNOWN_HOSTS` (the `ssh-keyscan` line),
`SIMULATOR_SSH_TARGET` (`simdeploy@<simulator-host>`), `SIMULATOR_URL`
(`https://<simulator-host>`). Start the workflow by hand once and watch it: it
must end with "The simulator reports <version>". The checkout must belong to
`simdeploy` (step 2), or `git pull` fails; `clients.json` and `data/` stay
with user 1000, or the container cannot read or write them.

**Replacing all clients and secrets**, for instance to move a simulator
installed before the `provider.role` ids to them. The script never replaces a
clients file, so the old one is put aside first:

```bash
cd /opt/osdm-simulator/OSDM_Simulator/deploy
git -C /opt/osdm-simulator pull
mv clients.json clients.json.old
docker run --rm -v /opt/osdm-simulator/OSDM_Simulator:/simulator -w /simulator node:22-slim \
  node scripts/make-clients.js deploy
chown 1000:1000 clients.json
docker compose restart
```

From the restart on, the old ids and secrets no longer work: every OSCAR
account that used one needs its new Client ID and Client Secret entered in API
Config. Until then its runs fail at the token step, and the simulator's log
shows `POST /<provider>/oauth/token 401`.

The check of section 4, done with a new id and its secret, shows that the new
file is the one in use: its first number is `200`. Once the new clients are in
place, delete the old file:

```bash
rm /opt/osdm-simulator/OSDM_Simulator/deploy/clients.json.old
```

**Load test of OSCAR** (#676, #1004). Every run of OSCAR reaches the
simulator from one address, the OSCAR server's, and makes about 25 requests in
a few seconds: some 4 requests a second per run. Two limits apply per address:
50 a second in nginx (burst 100) and 3,000 a minute in the simulator
(`SIM_REQUESTS_PER_MINUTE`). Beyond about 10 runs in parallel, an address that
is not trusted gets 429, and the runs report failures that are the limit's, not
OSCAR's.

OSCAR has its own ceilings, and they come first:

| Where | Setting | Default | Allowed |
|---|---|---|---|
| Test Config → Test Framework → *Concurrent Session Limit* (each company or provider) | runs of one company at the same time | 1 | 1 to 10 |
| Admin → *Server Config* → *Max Concurrent Runs* (`MAX_CONCURRENT_RUNS`; takes effect at once) | runs of the whole server at the same time | the server's `.env` | 1 to 50 |

So 50 runs at once at most, and 10 per company: for 50, use five companies or
providers pointing at the simulator. Each run is a Bruno process on the OSCAR
server; watch its memory (`docker stats`) as the number goes up.

**Trusting the OSCAR server's address, once** (#1004). The OSCAR server gets
limits of its own; every other address keeps 50 a second and 3,000 a minute.
As root on this host:

```bash
OSCAR_IP=203.0.113.10       # <- the OSCAR server's public address
cd /opt/osdm-simulator/OSDM_Simulator/deploy
# 1. The simulator: 30,000 a minute for that address (500 a second).
echo "SIM_TRUSTED_ADDRESSES=$OSCAR_IP" >> .env
docker compose up -d        # re-creates the container; "restart" would keep the old setting
docker compose exec osdm-simulator printenv SIM_TRUSTED_ADDRESSES   # the address
# 2. nginx: that address in the "geo" block of the site, in place of the
#    example line, gets the trusted zone (300 a second, burst 300).
sed -i "s|^    # 203.0.113.10 1;.*|    $OSCAR_IP 1;|" /etc/nginx/sites-available/osdm-simulator
grep -n -A3 'geo \$osdm_trusted' /etc/nginx/sites-available/osdm-simulator
nginx -t && systemctl reload nginx
```

A site set up before #1004 has no `geo` block: copy the lines from `geo` to
the second `limit_req_zone` of `deploy/nginx-osdm-simulator.conf.example` over
its one `limit_req_zone osdm_simulator` line, and add the line
`limit_req zone=osdm_simulator_trusted burst=300 nodelay;` under the first
`limit_req` of `location /`. `nginx -t` says whether it reads.

`docker compose up -d` re-creates the container: bookings and tokens are lost,
as with a restart. Several OSCAR servers: list their addresses separated by
commas in `SIM_TRUSTED_ADDRESSES`, and one line each in the `geo` block. The
simulator's own limit for them is `SIM_TRUSTED_REQUESTS_PER_MINUTE` (default
30000). Only IP addresses are accepted: the simulator does not start with a
host name in the list.

After a test, `docker compose logs --since 1h | grep -c ' 429 '` counts the
simulator's refusals; nginx's are in `/var/log/nginx/error.log` ("limiting
requests").

## 8. When something does not work

| What you see | Why |
|---|---|
| OSCAR refuses the endpoint or the token URL: "must be an https address on a public host" | the address is `http`, or the name does not resolve to a public address. The simulator has to be reachable the way a real provider is. |
| "Auth" fails at the start of a run, the simulator's log shows `POST /<provider>/oauth/token 401` | wrong secret, or the client belongs to another provider than the one in the token URL |
| A request gets 401 in the middle of a run on `beta` | `beta`'s tokens last two minutes; OSCAR refreshes the token at the start of each scenario, so one scenario that lasts longer than that ends with an expired token |
| 429 | more than 50 requests a second from one address (nginx), or 3,000 a minute (the simulator, `SIM_REQUESTS_PER_MINUTE`), from an address not in `SIM_TRUSTED_ADDRESSES`; for OSCAR's own server see "Load test of OSCAR" in section 7 |
| The container restarts in a loop, its log says "not started: the clients file cannot be read" | `clients.json` is missing from the deploy folder, or not readable by user 1000 (`chown 1000:1000 /opt/osdm-simulator/OSDM_Simulator/deploy/clients.json`) |
| On the host, a command answers `No such file or directory` about `clients.json`, or `docker compose` answers `no configuration file provided: not found` | the command was run from another folder than the deploy one, which is where a new session starts. `cd /opt/osdm-simulator/OSDM_Simulator/deploy` first. |
| The container restarts in a loop, its log says "not started: the data folder does not exist" or "cannot be written by this user" | `deploy/data` is missing, or Docker made it as root: `install -d -m 700 -o 1000 -g 1000 /opt/osdm-simulator/OSDM_Simulator/deploy/data` (or `chown 1000:1000` it), then `docker compose up -d` |
| The administration answers `404` | no key (`.env` missing, or made after the last `up -d`), or the container runs without the data folder (made before 0.51.0): see "Moving an installed simulator to a data folder" in section 7 |
| The administration answers `401` | OSCAR holds another key than the one whose SHA-256 is in `.env` |
| The administration answers `429` | 10 wrong keys from that address in 15 minutes: wait, and correct the key in OSCAR |
| The administration answers `403` (nginx) | the `allow` lines of the `/admin/` location do not name the OSCAR server's address |
| A booking made a while ago answers 404 | bookings are dropped after one hour, when a client has more than 200 of them, and at every restart |
