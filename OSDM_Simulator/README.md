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
[`Bruno_Collection/data_base/simulator_datafile.json`](../Bruno_Collection/data_base/simulator_datafile.json)
as the company's data file.

To run the collection against it without OSCAR (Bruno on your PC), see
[Run standalone](../Bruno_Collection/README.md#run-standalone) in the
collection's README: same data file, same checks.

Every scenario of that data file, what it tests, what the simulator answers
and what a run must show:
[scenario catalogue](../Documentation/Server_Operations/OSCAR%20-%20OSDM%20Simulator%20scenarios.md).

## What it answers

| Request | Answer |
|---|---|
| `POST /<provider>/oauth/token` | an access token (`client_credentials`; client id and secret in a Basic header or in the body) |
| `GET /<provider>/versions` | the provider's OSDM version (`alpha` 3.6.0, `beta` 3.7.0, `gamma` 3.8.0) |
| `POST /<provider>/offers` | one direct trip and three offers (flexible, semi-flexible, saver), for a search or a specified trip, for 1 to 19 passengers. A return (#594): with `returnSearchParameters.outwardOfferIds`, inbound offers; with `returnSearchParameters.outboundTripIds`, offers covering the outbound and the inbound trip at a return price. An id the client was not given is refused. With `offerSearchCriteria.offerMode` `COLLECTIVE` (#599), also the group products whose rules the group meets; when there is none, a `COLLECTIVE_OFFER_NOT_AVAILABLE` Problem says why. The classes asked are read from `offerSearchCriteria.travelClasses` (second class when none is). A specified leg keeps the train category it names. First class on a trip with a leg in second class only (#600) is, per passenger, a second-class admission for the whole trip and an upgrade part (product type `UPGRADE_POINT2POINT`) on the other legs, priced as the difference on those legs; the offer then has no `overallTravelClass`. No first-class offer when no leg has a first class. Offers for trips named by id (`tripIds`, #602): trips this client was given, by `POST /trips-collection` or in an earlier answer; an unknown id is `400`, as is `inboundTripIds` (a return by ids is not simulated) |
| `POST /<provider>/trips-collection` | `gamma` (its profile's `tripsCollection`, #602): four direct departures for the search, half an hour before the time asked, at that time, one and two hours after, each with a train number of its own; the departure at the time asked is the trip a search for offers gets. A return is `400`. The others answer `501` |
| `POST /<provider>/bookings` | a `PREBOOKED` booking of offers this client received |
| `GET /<provider>/bookings/{id}` | the booking. On `gamma`, `refundReceiptDelaySeconds` (30) after a refund is confirmed, a receipt (type `INFORMATION`, `PDF_A4`) appears in its `fulfillmentDocuments` (#603) |
| `GET`, `PATCH /<provider>/bookings/{id}/passengers/{id}` | a passenger |
| `GET`, `PATCH`, `POST /<provider>/bookings/{id}/purchaser` | the purchaser |
| `POST /<provider>/bookings/{id}/booked-offers/{bookedOfferId}/offer-parts` | adds to a pre-booked booking the reservations its `placeSelections` name (#601); twice is `409`, after confirmation `409`; ancillaries `501`. Any other booked-offer resource is `501` |
| `POST /<provider>/bookings/{id}/fulfillments` | confirms the booking: its parts and its tickets become `FULFILLED`, one ticket per trip (two for a return), or one for the whole booking for a product sold so (the weekend group, #599). On `gamma` (its profile's `documents`, #603), the documents of the media the offers asked for, in the OSDM 3.8 shape (the booking's `fulfillmentDocuments`, each ticket naming its own in `fulfillmentDocumentRefs`), also in the answer: `PDF_A4` one PDF for the whole booking, `RETAILER_APP` one PNG per ticket |
| `GET /<provider>/fulfillments/{id}` | `gamma` (#603): the ticket and its documents; the merged PDF comes with a `DOCUMENT_COVERS_MORE_FULFILLMENTS` Problem. An unknown id, or another client's, is `404`. The others answer `501` |
| `POST`, `GET /<provider>/bookings/{id}/refund-offers` | one refund offer per fulfillment named in `fulfillmentIds` (#595), each holding all its parts. A refund scoped by booking part or passenger (`refundSpecifications` with `bookingPartIds` or `passengerIds`) is refused with `PARTIAL_REFUND_NOT_SUPPORTED`. Fee by flexibility: none (flexible), a quarter (semi-flexible), the whole price (saver); an `overruleCode` waives it. `gamma` accepts four codes (`CONNECTION_BROKEN`, `PAYMENT_FAILURE`, `SALES_STAFF_ERROR`, `TECHNICAL_FAILURE`, its profile's `overruleCodes`, #596) and refuses any other with `OVERRULE_CODE_NOT_SUPPORTED`; `alpha` and `beta` accept any |
| `GET`, `PATCH`, `DELETE /<provider>/bookings/{id}/refund-offers/{id}` | the refund offer; `PATCH {status: CONFIRMED}` refunds its fulfillment and parts and lowers the confirmed price; `DELETE` withdraws a proposed offer (204), not a confirmed one (409) |
| `GET /<provider>/products`, `GET /<provider>/products/{id}` | `gamma`: its six named products (#598, #599), in both classes except the group ticket (second class only); an unknown id is `404`; the others answer `501` |
| `GET /<provider>/reduction-cards` | `gamma`: its three cards (`SIM_CARD_25`, `SIM_CARD_50`, `SIM_STUDENT`, its profile's `reductionCards`, #597); the others answer `501` |
| `POST /<provider>/bookings/{id}/exchange-offers` | on a provider with `exchange` (`gamma`, #611): an offer request plus the `fulfillmentIds` given up; one exchange offer per offer, with `exchangePrice`, `exchangeFee` (by the exchangeability of what is given up: none, a quarter, the whole price; an accepted `overruleCode` waives it) and `amountToBePaid` = new price + fee − price given up, or `refundableAmount` when negative. Else 501 |
| `POST /<provider>/bookings/{id}/exchange-operations`; `GET`, `DELETE …/{id}` | one exchange offer taken: the operation `PREBOOKED`, the parts given up `EXCHANGE_ONGOING`; `POST …/fulfillments` then confirms it (old parts and fulfillments `EXCHANGED`, a new booked offer and fulfillment `FULFILLED`, the confirmed price updated). `DELETE` withdraws a pre-booked one (204), not a confirmed one (409). Else 501 |
| any other OSDM resource (places, products, seat maps, …) | `501`, which the collection reports as "not implemented by this provider" |
| `GET /healthz` | `{"status":"ok","version":"<package.json version>"}`, for the container health check and to see which version runs (#617) |

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
| `overruleCodes` | optional: the only overrule codes a refund request may carry (#596); absent, any code |
| `products` | optional: the named products it sells, `{ code, name, flexibility, factor, isTrainBound }` (#598), one offer each (in each class asked). The refund and exchange conditions follow the flexibility. `gamma`: `SIM_FLEXI_BASIC`, `SIM_ALL_DAY`, `SIM_FLEXI_SAVER`, `SIM_TRAIN_BOUND`, and the group products below. Absent: one product per flexibility. A group product (#599) adds `group`: `minPassengers`, `maxPassengers`, optional `maxOver15` (passengers aged 15 or more on the day of travel; no date of birth counts as 15 or more), `weekendOnly` (every trip on a Saturday or a Sunday, local date), `secondClassOnly`, `oneFulfillment` (one ticket for the whole booking), and its price: `pricedPassengers` (the full fare of that many passengers) or `followerPercent` (the full fare for the first, that percentage of it for each other one). It is offered only to a `COLLECTIVE` request, as one `COLLECTIVE` admission per direction for the whole group, naming each passenger as `ADULT` or `CHILD` (under 15), with no card reduction. `gamma`: `SIM_WEEKEND_GROUP` (2 to 5 passengers, at most 2 aged 15 or more, weekend only, one ticket, the price of two) and `SIM_GROUP` (2 to 19, second class only, 60 % for the second and each further passenger). Public holidays are not simulated |
| `reservations` | optional: the seat reservation of each train category, by short name, `MANDATORY` or `OPTIONAL` (#601). `gamma`: `SC` mandatory, `EC` optional. On such a leg an offer holds one reservation offer part for all its passengers (`COLLECTIVE`, one leg), and each admission of the trip a relation to it (`minGroupItemsToBeBooked` 1 or 0, `isReservationRequired` when mandatory); a mandatory one is in `minimalPrice`. A booking takes every mandatory reservation and those named in `optionalReservationSelections` or `placeSelections` (whose trip and leg must be the reservation's); a booked reservation carries `placeAllocation` with a coach and one seat per passenger, and the admissions point to it in `reservationRefs`. Reservations are on the ticket and refunded with it. Absent: no reservation |
| `documents` | optional: the media of the documents issued on confirmation, `PDF_A4` (one PDF merged for the booking) and `RETAILER_APP` (one PNG per ticket), when the offers asked for them (#603); requires `refundReceiptDelaySeconds` (0 to 3600), after which a refund's receipt appears in the booking. `gamma`: both, 30 s. Absent: no document, and `GET /fulfillments/{id}` is `501` |
| `idempotency` | optional: `true` keeps the answers of `POST /bookings` and `POST …/fulfillments` per client and `Idempotency-Key`, as first given, and gives them again for the same key (#604); the same key for another body or request is `409 IDEMPOTENCY_KEY_REUSED`. `gamma` only. Absent: the header is ignored |
| `exchange` | optional: `true` exchanges a confirmed booking (`exchange-offers`, `exchange-operations`, #611). `gamma` only. Absent: those routes answer 501 |
| `variants` | optional: `{ wrongOffersFrom }`. A booking takes the variants its passengers' last names name (`Simvariant-<name>`): `per-passenger` (one fulfillment per passenger; a refund scoped by passenger or part is offered), `reordered`, `minimal`, and four deliberately wrong ones (`wrong-booking-price`, `wrong-fulfillment-status`, `wrong-refund-amount`, `wrong-exchange-amount`). Offers of a trip from `wrongOffersFrom` have `minimalPrice` one cent off (#611). `gamma`: `urn:uic:stn:0000098` |
| `shortDeadlines` | optional: `{ stopPlaceRef, seconds }` (10 to 600). A trip leaving from that stop place gives offers, and then the booking, refund offers and exchange offers made from them, that expire after `seconds` instead of 30 minutes, for the collection's `expired…Test` probes (#611). `gamma`: `urn:uic:stn:0000099`, 60 s. A pre-booked booking past its time limit is read with its parts `RELEASED` (any provider) |
| `tripsCollection` | optional: `true` answers `POST /trips-collection` (#602). `gamma` only. Absent: `501` |
| `secondClassOnlyCategories` | optional: the train categories (short names) that run in second class only (#600). `gamma`: `R`, `Os`. Each non-group product then has an upgrade product `<prefix>-PRD-UPG-<code>` in `GET /products`. Absent: every train has a first class |
| `reductionCards` | optional: the cards it knows, `{ code, name, percent }` (#597). A passenger's known card takes `percent` off its price and is named in the admission's `appliedPassengerTypes`; of several, the largest. An unknown card is ignored with a `REDUCTION_CARD_NOT_APPLIED` Problem in `problems`. Absent: `GET /reduction-cards` is `501` and every card is unknown |

Shipped: `alpha` (EUR, OSDM 3.6.0, one-hour tokens), `beta` (CHF, 3.7.0,
two-minute tokens, so a long run goes through OSCAR's token refresh), `gamma`
(CZK, 3.8.0). Not every provider is on 3.8, and the collection sends and checks
according to the version, so each provider reports another one (#614). `gamma`
is the provider that receives each new function.

**The answers are 3.8 answers on every provider.** Only the version check
differs. The collection's sale requests and checks are the same at 3.6, 3.7
and 3.8, so the ready-made scenarios pass on all three; answers in each
version's own shapes are left for when a scenario needs them.

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
| `deploy/` | compose file and reverse-proxy example |
| `tests/` | `node --test` |
