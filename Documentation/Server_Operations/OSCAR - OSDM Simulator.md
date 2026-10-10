# OSCAR — OSDM provider simulator

Issue #575. A stub OSDM provider that issues its own access tokens and answers
a basic sale flow, so that a company in OSCAR can run scenarios without any
operator's system. It exists to test OSCAR itself (a security test, a demo, a
check after a deployment), not to test OSDM: it is not a conformance reference.

The code and its reference are in [`OSDM_Simulator/`](../../OSDM_Simulator/README.md).
This page is about installing it and pointing a company at it.

## 1. What you get

One server that plays three providers, told apart by the first part of the path:

| Provider | Endpoint to give OSCAR | Currency | OSDM version | Token lifetime |
|---|---|---|---|---|
| `alpha` | `https://<simulator-host>/alpha` | EUR | 3.6.0 | 1 hour |
| `beta` | `https://<simulator-host>/beta` | CHF | 3.7.0 | 2 minutes |
| `gamma` | `https://<simulator-host>/gamma` | CZK | 3.8.0 | 15 minutes |

The version is what each provider reports; the answers have the 3.8 shapes on
all three.

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

Expected: `{"status":"ok"}`, then `200`, `401`, `401`. If the first number is
`401`, no token was issued: the secret is not the one of that client.

What needs no secret can be checked at any time: `/healthz` answers
`{"status":"ok"}` over https with a valid certificate, `/alpha/versions`
without a token answers 401, and an unknown provider answers 404.

## 5. Point a company at it

Use a company made for this. **Do not do it on a company that tests a real
provider:** step 3 replaces the company's data file, and the upload also
rebuilds its Test Framework from the file.

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
   It holds two sale scenarios, shared with the company's testers, once per
   OSDM version: `SIM_SALE_SEARCH_1ADT_36` and `SIM_SALE_SEARCH_2ADT_SAVER_36`
   for `alpha`, `…_37` for `beta`, `…_38` for `gamma`, and return journeys
   (#594): `SIM_RETURN_SEPARATE_1ADT_…` on each version and
   `SIM_RETURN_COMBINED_1ADT_…` (one offer for both directions) on 3.7 and 3.8,
   and refunds of a return (#595): `SIM_REFUND_RETURN_1ADT_…` (full: each
   refund offer, one per ticket, is confirmed) and `SIM_REFUND_INBOUND_1ADT_…`
   (the inbound ticket only) on each version, and technical cancellations
   (#596) on 3.8 only: `SIM_REFUND_OVERRULE_<code>_38` for each overrule code
   `gamma` accepts and `SIM_REFUND_OVERRULE_REFUSED_38`, which expects the
   refusal of a code it does not accept.
   The file's run list is the `gamma` scenarios; for `alpha` or `beta`, tick
   that provider's in Test Config.
4. **Run** the scenarios of the provider's version. Expected: the version check and the sale steps answer
   200, the nine optional information requests answer 501 and are reported as
   "not implemented by this provider", and no check fails.

The same data file runs without OSCAR too, with Bruno on a PC: see
[Run standalone](../../Bruno_Collection/README.md#run-standalone) in the
collection's README.

The data file works unchanged on the three providers. A scenario of another
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
   provider has its own data file and Test Framework.
5. Run a scenario. Set **Working on** back to the company, or to another
   provider, to run there.

Do the same for `gamma`. Before v1.11.220, API Config showed one section only,
the one chosen in **Working on**: on such a version, do step 3 before step 2.

What this arrangement shows: a user who enters
`alpha`'s client on the `Beta` provider gets no token, and a token of `alpha`
sent to `beta` is refused with 401. A mix-up between providers is a failed run,
not a passing one, and every identifier in a report starts with the name of the
provider that answered.

## 7. Day to day

The `docker compose` commands are run from the deploy folder. In a new session
on the host, go there first:

```bash
cd /opt/osdm-simulator/OSDM_Simulator/deploy
```

| To do | How |
|---|---|
| See what is being called | `docker compose logs -f` (one line per request: time, method, path, status, provider, client; no header, no body) |
| Update the simulator | `git -C /opt/osdm-simulator pull && docker compose restart` |
| Replace all clients and secrets | see below |
| Add a client | add an entry to `clients.json` in the deploy folder (an id of the same form, a secret of 32 characters or more), `docker compose restart` |
| Clear every booking and end every token | `docker compose restart` |
| Stop it when the campaign is over | `docker compose down`, and remove the nginx site |

A restart clears everything: bookings are kept in memory only, and the key that
signs the tokens is drawn at start-up.

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

## 8. When something does not work

| What you see | Why |
|---|---|
| OSCAR refuses the endpoint or the token URL: "must be an https address on a public host" | the address is `http`, or the name does not resolve to a public address. The simulator has to be reachable the way a real provider is. |
| "Auth" fails at the start of a run, the simulator's log shows `POST /<provider>/oauth/token 401` | wrong secret, or the client belongs to another provider than the one in the token URL |
| A request gets 401 in the middle of a run on `beta` | `beta`'s tokens last two minutes; OSCAR refreshes the token at the start of each scenario, so one scenario that lasts longer than that ends with an expired token |
| 429 | more than 50 requests a second from one address (nginx), or 3,000 a minute (the simulator, `SIM_REQUESTS_PER_MINUTE`) |
| The container restarts in a loop, its log says "not started: the clients file cannot be read" | `clients.json` is missing from the deploy folder, or not readable by user 1000 (`chown 1000:1000 /opt/osdm-simulator/OSDM_Simulator/deploy/clients.json`) |
| On the host, a command answers `No such file or directory` about `clients.json`, or `docker compose` answers `no configuration file provided: not found` | the command was run from another folder than the deploy one, which is where a new session starts. `cd /opt/osdm-simulator/OSDM_Simulator/deploy` first. |
| A booking made a while ago answers 404 | bookings are dropped after one hour, when a client has more than 200 of them, and at every restart |
