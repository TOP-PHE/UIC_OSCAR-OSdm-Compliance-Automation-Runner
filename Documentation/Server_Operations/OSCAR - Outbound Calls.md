# OSCAR — Outbound Calls

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC, Union Internationale des Chemins de fer © 2026."

---

## 1. What this page is for

The calls OSCAR **receives** are described by its OpenAPI document,
`/v1/openapi.json` (Swagger UI at `/v1/docs`), which a test keeps equal to the
server's routes. This page is the other direction: every call OSCAR **sends**
to another system, who sends it, where it goes and what protects it.

| # | Destination | Sent by | Section |
|---|---|---|---|
| 1 | The provider's OSDM API (a railway's system, or the OSDM simulator) | the Bruno runs, and a few server features | 2 |
| 2 | The provider's token endpoint (OAuth and similar) | the server | 3 |
| 3 | An AI service (optional, *AI analysis of results*) | the server | 4 |
| 4 | The OSDM simulator's administration API (optional) | the server | 5 |
| 5 | Mail server, Alertmanager, OSCAR itself (loopback) | the server, the runs | 6 |

Nothing else leaves the server: no call home, no analytics, no other
third-party API.

## 2. OSDM requests to the provider

### 2.1 Reference

The requests follow the OSDM specification published on osdm.io. The copies
OSCAR works from are in `Documentation/Test_Coverage/OSDM_reference/`
(`OSDM-online-api-v3.8.0.yml` to `v3.12.0.yml`; `osdm-dev.json` pins the
version in development). OSDM 3.8 defines 94 operations; OSCAR sends those
listed below and no other. The bodies OSCAR sends are checked against the schema of the
scenario's OSDM version at every run (`library-bruno/osdmRequestSchemas.js`,
generated from those files), and a body that does not conform fails a check
reported as OSCAR's own.

The address is the company's or provider's OSDM endpoint (`api_base`), set by
its Test Manager. Every request carries the tester's bearer token, the
`Content-Type` / `Accept` of the scenario's OSDM version, the optional
`Requestor` and subscription-key headers saved with the credentials, the
company's dedicated headers, and W3C `traceparent` (and `tracestate` when the
Test Framework sets one).

### 2.2 The requests of a run

Sent by the Bruno CLI the server starts for each run. "File" = a request file
of the collection (`Bruno_Collection/0x-…/*.yml`); "Script" = sent from a
step's script (`bru.sendRequest`).

**System information** (optional reads; `01-System Infos Requests`)

| Method | Path | Sent by |
|---|---|---|
| GET | `/versions` | File |
| GET | `/coach-deck-layouts` (3.8 and later) or `/coach-layouts` | File |
| GET | `/coach-deck-layouts/{layoutId}` or `/coach-layouts/{layoutId}` | File |
| GET | `/passenger-categories` | File |
| GET | `/promotion-codes` | File |
| GET | `/reduction-cards` | File |
| GET | `/zones` | File |
| GET | `/products` | File |
| GET | `/products/{productId}` | File |
| GET | `/product-tags` | File |

**Offers and trips**

| Method | Path | Sent by |
|---|---|---|
| POST | `/offers` | File (steps 01, 01b, 01c, 01d), Script (the offer request option discovery, an idempotency replay, a reference booking's offer) |
| POST | `/trips-collection` (up to 3.9) or `/trips-collections` (3.10 and later) | Script (offers by trip id) |
| GET | `/availabilities/place-map?…` | File (08, 08b) |
| POST | `/availabilities/vehicle-place-map` | Script (a named place or compartment) |
| GET | `/availabilities/preferences?…` | Script (seat preferences) |
| GET | `/availabilities/nearby?…` | Script (a place near another) |

**Booking and fulfilment**

| Method | Path | Sent by |
|---|---|---|
| POST | `/bookings` | File (02), Script (idempotency replays, a reference booking) |
| GET | `/bookings/{bookingId}` (some with `?embed=ALL`) | File (05, 07, 12, 14, 14b, 16, and the exchange steps) |
| DELETE | `/bookings/{bookingId}` | Script (releases the reference booking of a "near a place" sale) |
| PATCH | `/bookings/{bookingId}/passengers/{passengerId}` | File (03) |
| GET | `/bookings/{bookingId}/passengers/{passengerId}` | File (04) |
| GET / POST / PATCH | `/bookings/{bookingId}/purchaser` | File |
| POST | `/bookings/{bookingId}/booked-offers/{bookedOfferId}/offer-parts` (3.7 and later) or `…/reservations` | File (09) |
| POST | `/bookings/{bookingId}/booked-offers/{bookedOfferId}/ancillaries` | File (10) |
| GET | `/bookings/{bookingId}/booked-offers/{bookedOfferId}/additional-offers` | File (11) |
| POST | `/bookings/{bookingId}/fulfillments` | File (06), Script (idempotency replay, confirmation sent again) |
| GET | `/fulfillments/{fulfillmentId}` | File (06b) |

**Refund**

| Method | Path | Sent by |
|---|---|---|
| POST | `/bookings/{bookingId}/refund-offers` | File (10), Script (one per fulfilment, refund-again probe) |
| GET | `/bookings/{bookingId}/refund-offers/{refundOfferId}` | File (11) |
| PATCH | `/bookings/{bookingId}/refund-offers/{refundOfferId}` | File (13) |
| DELETE | `/bookings/{bookingId}/refund-offers/{refundOfferId}` | File (15) |

**Exchange**

| Method | Path | Sent by |
|---|---|---|
| POST | `/bookings/{bookingId}/exchange-offers` | File (10), Script (exchange of a refunded ticket, a probe) |
| POST | `/bookings/{bookingId}/exchange-operations` | File (11) |
| GET | `/bookings/{bookingId}/exchange-operations/{exchangeOperationId}` | File (12) |
| DELETE | `/bookings/{bookingId}/exchange-operations/{exchangeOperationId}` | File (16) |

Some scenarios send a request wrong on purpose (the "not happy flow"
probes): an empty passenger list, a currency not sold, an invalid purchaser,
and the like. Each is listed with its expected refusal in
`Documentation/Server_Operations/OSCAR - OSDM Simulator scenarios.md`.

The folder `00-Access Token` holds token requests for running the collection
on its own, outside OSCAR. A run started by OSCAR does not send them: the
server gets the token (section 3).

### 2.3 OSDM requests the server sends itself

All go to the same `api_base`, with the caller's own saved credentials, from a
Test Manager's (or, for the credential test, any member's) action on a page.

| Method | Path | Feature | Route that triggers it |
|---|---|---|---|
| GET | `/versions` | *Test my credentials* | `POST /v1/me/credentials/test` |
| GET | `/places?page=…` | Stop-place lookup | `POST /v1/company/places/refresh` |
| POST | `/offers` | Discover timetable, fill calendars, re-probe, journey probe | `POST /v1/company/test-resources/discover-timetable`, `…/fill-calendars`, `…/reprobe-offers`, `…/probe-journey`, `…/{id}/probe-journey` |
| POST | `/trips-collection` | The same features, when asked to search trips first | the same routes |

### 2.4 Protections

- **Where a request may go.** `api_base` is refused unless it is `https` on a
  public address (`utils/urlPolicy.js`; the start-up DNS lookup is bounded to
  10 s); only a Test Manager may change it (`companyEndpointChange()`).
  A self-hosted test box can allow private addresses with
  `ALLOW_PRIVATE_TARGETS=1`.
- **The run's process.** The Bruno CLI receives an allow-listed environment
  (`childBaseEnv()`), the token through its process environment and never in
  a file, and every value of its environment file escaped (`envVar()`). A
  data file holding `{{…}}` is refused before the token is read.
- **A provider that stops answering** stops the run after
  `RUN_IDLE_TIMEOUT_MS` of silence.
- **The server's own calls**: fixed timeouts (15 s for the credential test,
  20 s a search), and the answer kept by size.
- **What is stored.** Requests and answers are kept per run, encrypted; the
  `Authorization` header and the run's secrets are masked before storage.

## 3. Token requests

Sent by the server before each run (`worker/access-token.js`) and by *Test my
credentials*, to the token address the tester saved with their credentials,
in the form of the chosen profile (`worker/auth-profiles.js`):

| Profile | Request |
|---|---|
| `oauth2_basic` | POST, client id and secret in HTTP Basic, `grant_type=client_credentials` |
| `oauth2_post` | POST, client id and secret in the form body |
| `paxone_json`, `sqills_extension` | POST, the provider's own JSON shape |
| `custom` | POST, the template the Test Manager wrote (`{{client_id}}`-style placeholders) |

Every field is trimmed; 15 s per request; every request is logged with its values masked except
an explicit list of structural fields. Tokens are cached per (user, company),
encrypted, and dropped when a run gets a 401.

## 4. AI service (optional)

Sent only when an administrator has approved a Test Manager's access to the
*AI analysis of results* and that Test Manager has configured a service
(`services/aiConnector.js`, the one place OSCAR calls an AI).

| Service | Method | Path | When |
|---|---|---|---|
| Anthropic Messages | POST | `{baseUrl}/v1/messages` | an analysis, the connection test |
| Anthropic | GET | `{baseUrl}/v1/models?limit=100` | the list of models on the page |
| OpenAI-compatible | POST | `{baseUrl}/chat/completions` | an analysis, the connection test |

- **Address**: `https` on a public address (`urlPolicy.js`); redirects are not
  followed; 30 s (5 minutes for an analysis); answer capped at 256 KB.
- **Key**: stored encrypted, never returned or logged, masked in echoed
  errors, and sent only to the service and host it was typed for.
- **What is sent**: what the preview showed, nothing else (the run must carry
  the preview's hash). Failed checks with the run's values replaced, problem
  codes, scenario codes and descriptions, the Test Framework's declarations,
  findings' titles, warnings, the provider's set-up checklist answers (never
  its `api.*` or `meta.*` answers), an extract of the OSDM specification, and
  for the most failing groups a request and answer sample masked by
  `utils/aiMask.js` (names, birth dates, contacts, addresses, cards, identity
  documents, connection data and URLs removed). Never a token, credential,
  endpoint or header.

## 5. OSDM simulator administration (optional)

Sent only when an administrator has saved the simulator's address and key
(*Admin → OSDM Simulator*, `services/simulatorAdmin.js`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | the simulator's version (no key sent) |
| GET | `/admin/api/accounts` | accounts list; also the check before saving |
| POST | `/admin/api/accounts/{provider}` | create an account |
| POST | `/admin/api/accounts/{provider}/{clientId}/reset-secret` | new secret |
| DELETE | `/admin/api/accounts/{provider}/{clientId}` | delete an account |
| GET | `/admin/api/audit` | the simulator's audit log |
| GET | `/admin/api/stats?from&to` | request statistics |
| GET | `/admin/api/metrics` | metrics relayed to Prometheus |

`Authorization: Bearer <key>` and `X-Admin-Actor` (the administrator's
e-mail); the key is stored encrypted, sent only to the address it was saved
with, masked in errors; `https` public address, no redirect, 15 s, 256 KB.

## 6. Other

| Destination | Sent by | What |
|---|---|---|
| Mail server (`SMTP_HOST`) | server | registration, approval, password reset, alert test e-mails |
| Alertmanager (`ALERTMANAGER_RELOAD_URL`, internal Docker network) | server | POST `/-/reload` after an administrator changes the alert settings |
| OSCAR itself, `127.0.0.1:3001` (loopback) | the run | GET `/data/{filename}` (the run's data file), POST `/v1/runs/{runId}/refresh-access-token`, GET `/json_validator/datafile.schema.json`; each with the run's one-time secret, valid only while the run lasts |

## 7. On a test instance with only the simulator

When every company of an instance points at the OSDM simulator, sections 2
and 3 reach the simulator only. Section 4 reaches an AI service only if one is
configured there, section 5 only if the simulator's administration is saved,
and section 6 the instance's own mail server and loopback.
