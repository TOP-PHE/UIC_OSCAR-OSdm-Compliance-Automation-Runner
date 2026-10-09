# OSDM provider simulator

A stub OSDM provider for testing OSCAR itself. It issues the access token and
answers a basic sale flow (offer, booking, tickets), so a company in OSCAR can
run a scenario end to end without any operator's system being involved.

It simulates several providers at once. The provider is the first part of the
path, and each one answers with its own carrier, currency, prices, OSDM version
and identifiers:

```
https://<simulator-host>/alpha/offers
https://<simulator-host>/beta/oauth/token
```

**It is not a conformance reference.** It answers what the OSCAR collection
asks in a basic sale, nothing more. The aim is to exercise OSCAR, not OSDM.

Installing it on a host and pointing a company at it:
[Documentation/Server_Operations/OSCAR - OSDM Simulator.md](../Documentation/Server_Operations/OSCAR%20-%20OSDM%20Simulator.md).

## Run it locally

Node 22 or later. There is nothing to install: the simulator has no dependency.

```bash
node scripts/make-clients.js     # writes clients.json with random secrets (git-ignored)
node server.js                   # listens on 127.0.0.1:3002
npm test
```

To run the OSCAR collection against a local simulator, start OSCAR with
`ALLOW_PRIVATE_TARGETS=1` (development only: it lets an endpoint be
`http://127.0.0.1:3002/alpha`), set the company's OSDM endpoint and a tester's
OAuth2 credentials as described in the operations page, and load
`oscar/datafile.json` as the company's data file.

## What it answers

| Request | Answer |
|---|---|
| `POST /<provider>/oauth/token` | an access token (`client_credentials`; client id and secret in a Basic header or in the body) |
| `GET /<provider>/versions` | the provider's OSDM version |
| `POST /<provider>/offers` | one direct trip and three offers (flexible, semi-flexible, saver), for a search or a specified trip |
| `POST /<provider>/bookings` | a `PREBOOKED` booking of offers this client received |
| `GET /<provider>/bookings/{id}` | the booking |
| `GET`, `PATCH /<provider>/bookings/{id}/passengers/{id}` | a passenger |
| `GET`, `PATCH`, `POST /<provider>/bookings/{id}/purchaser` | the purchaser |
| `POST /<provider>/bookings/{id}/fulfillments` | confirms the booking: its parts and its ticket become `FULFILLED` |
| any other OSDM resource (places, products, refund offers, seat maps, …) | `501`, which the collection reports as "not implemented by this provider" |
| `GET /healthz` | `{"status":"ok"}`, for the container health check |

There is no timetable. A trip is built from the request: the same origin,
destination and time give the same trip and the same prices every time.

## Providers

One file per provider in [`providers/`](providers/). The file name is the key
used in the path.

| Field | Effect |
|---|---|
| `name`, `carrier` | appear in trips, offers and tickets |
| `currency`, `priceFactor` | the same journey has another price on another provider |
| `osdmVersion` | what the version check reports |
| `idPrefix` | every trip, offer, booking, passenger and ticket id starts with it |
| `utcOffset` | the offset a time without one is read in |
| `tokenLifetimeSeconds` | how long a token lasts |

Shipped: `alpha` (EUR, 3.8.0, one-hour tokens), `beta` (CHF, two-minute tokens,
so a long run goes through OSCAR's token refresh), `gamma` (CZK, reports 3.7.0).

## Clients

The client ids and secrets are **not in the repository**. They are read from a
clients file (see [`clients.example.json`](clients.example.json)), and without
that file the simulator does not start: there is no default credential. A
secret shorter than 32 characters, or the placeholder of the example file, is
refused. `scripts/make-clients.js` writes a file with random secrets, either
next to `server.js` (`local`, the default) or in `deploy/` (`deploy`): two
places git ignores. It takes no other path.

The ids it creates say who each client is for:

```
<provider>.tstmgr01  <provider>.tstmgr02  <provider>.tstmgr03    Test Managers
<provider>.tst01     <provider>.tst02     <provider>.tst03       testers
```

Three of each per provider by default; `node scripts/make-clients.js local 2 5`
gives two and five. The role is in the name only: the simulator treats every
client of a provider alike. One client per OSCAR account keeps their bookings
apart. Any other id is accepted in a clients file written by hand, as long as
it has no colon.

Only a SHA-256 digest of each secret is kept in memory.

## Rules it keeps

- **A token belongs to one provider and one client.** Used on another provider
  it gets `401`. If the caller ever mixed two providers up, the run fails
  instead of passing.
- **What a client created, only that client reads.** Another client of the same
  provider, or the same client id on another provider, gets `404`, the same
  answer as for a booking that never existed.
- **Nothing is written to disk and nothing is requested from outside.** State
  is in memory; a restart clears it and ends every token (the signing key is
  drawn at start-up).
- **Memory is bounded.** Each client keeps at most a fixed number of offers and
  bookings, the oldest is dropped first, and everything expires after the time
  to live. The clients are a fixed list, so the total is bounded too.
- **Answers are JSON, never HTML.** Text received in a request (names, e-mail,
  phone) is kept within a length limit and only ever sent back inside JSON.
- **The log has no secret.** One line per request: time, method, path without
  its query string, status, duration, provider, client id.

## Settings

All optional, read from the environment.

| Variable | Default | Meaning |
|---|---|---|
| `SIM_HOST` | `127.0.0.1` | address to listen on |
| `SIM_PORT` | `3002` | port |
| `SIM_CLIENTS_FILE` | `./clients.json` | the clients file |
| `SIM_PROVIDERS_DIR` | `./providers` | the provider profiles |
| `SIM_TRUST_PROXY` | off | `1` behind a reverse proxy: the caller's address is the last one in `X-Forwarded-For` |
| `SIM_MAX_BODY_BYTES` | `262144` | largest request body |
| `SIM_MAX_OFFERS_PER_CLIENT` | `600` | offers kept per client |
| `SIM_MAX_BOOKINGS_PER_CLIENT` | `200` | bookings kept per client |
| `SIM_TTL_SECONDS` | `3600` | how long an offer or a booking is kept |
| `SIM_REQUESTS_PER_MINUTE` | `3000` | requests accepted per caller address and minute |

## Layout

| Path | Role |
|---|---|
| `server.js` | start-up: settings, profiles, clients file, HTTP server |
| `src/app.js` | routing, authentication, request limit, log line |
| `src/config.js` | reading and checking the profiles, the clients file and the settings |
| `src/tokens.js` | issuing and checking tokens |
| `src/store.js` | the bounded, per-client memory |
| `src/osdm/offers.js` | the answer to `POST /offers` |
| `src/osdm/bookings.js` | bookings, passengers, purchaser, tickets |
| `providers/` | the provider profiles |
| `oscar/datafile.json` | a ready-made OSCAR data file with two sale scenarios |
| `deploy/` | compose file and reverse-proxy example |
| `tests/` | `node --test` |
