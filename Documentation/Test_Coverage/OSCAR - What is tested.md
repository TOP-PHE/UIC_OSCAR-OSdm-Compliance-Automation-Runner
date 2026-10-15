# OSCAR — What is tested

What a run of OSCAR tests, from the request to the verdict: what the OSDM
simulator answers on each of its providers, which checks the Bruno collection
makes on each answer, and which ready-made scenarios exist and what each one
covers.

Three documents hold the detail; this one ties them together:

| Question | Where |
|---|---|
| What does the simulator answer, scenario by scenario, and what must a run show? | [OSCAR - OSDM Simulator scenarios](../Server_Operations/OSCAR%20-%20OSDM%20Simulator%20scenarios.md) |
| What exactly does each step check, and what does each scenario check that the others do not? | [OSCAR - Checks by scenario](OSCAR%20-%20Checks%20by%20scenario.md), generated from a real run |
| How is the simulator installed, and which requests does it answer? | [OSCAR - OSDM Simulator](../Server_Operations/OSCAR%20-%20OSDM%20Simulator.md), [`OSDM_Simulator/README.md`](../../OSDM_Simulator/README.md) |

The older [OSCAR Test Coverage Map](OSCAR_Test_Coverage_Map.md) and
[assertion catalogue](OSCAR_Assertion_Catalog.xlsx) describe the collection
as of release 2026.123 (collection OTST_V2.0.43); nothing added since is in
them.

## 1. How a test is put together

```
 simulator_datafile.json            scenario_catalogue.json
 (89 scenarios, SIM_…)  ──source──►  (50 reference scenarios, OTST_… / NHF_…)
          │                                     │
          │ run as is, against the simulator    │ copied into a company's data file
          ▼                                     ▼ (Test Config → Copy scenarios from… → Scenario catalogue)
   Bruno collection: one scenario = one run    the company's own scenarios, trips re-mapped
   steps 01 → 02 → … → 07 (+ refund 10–16,     onto its Test Data, run against its provider
   exchange 10–17)
          │
          ▼
   each step checks the answer: PASS / FAIL, plus WARNING and INFO lines
```

- **A scenario** is one entry of a data file. It names a trip, the
  passengers, the purchaser, the offer criteria and the fulfillment options
  (each an entry of a list in the same file), and what to do: a sale, a
  refund or an exchange, with its options.
- **A run** is one execution of the Bruno collection for one scenario. The
  collection goes through its steps in order; a scenario's options decide
  which steps run (a refund adds steps 10 to 16, a return adds 01b, and so
  on). Each step sends one OSDM request and checks the answer.
- **The simulator's data file**,
  `Bruno_Collection/data_base/simulator_datafile.json`, holds the scenarios
  that run against the simulator as they are: their trips use the
  simulator's stations. Its tests keep it valid and answerable
  (`OSDM_Simulator/tests/datafile.test.js`).
- **The scenario catalogue**,
  `Bruno_Collection/data_base/scenario_catalogue.json`, picks 31 of those
  scenarios as reference scenarios under generic codes. It holds no scenario
  data of its own: each entry names its source scenario. When a company copies
  one from Test Config, the trip is re-mapped onto a train or journey of the
  company's Test Data and every entry gets a fresh id, so the copy runs
  against the company's provider. A reference scenario that needs something
  the company's Test Framework does not declare is greyed out and cannot be
  copied (the golden rule).

## 2. The simulator: three providers

The simulator is a stub OSDM provider. It builds a trip from the request
(no timetable: the same request gives the same trip and prices) and answers
with OSDM 3.8 shapes on every provider. The three providers differ by the
version they report, their currency and what they implement:

| | `alpha` | `beta` | `gamma` |
|---|---|---|---|
| OSDM version reported | 3.6.0 | 3.7.0 | 3.8.0 |
| Currency | EUR | CHF | CZK |
| Token lifetime | one hour | two minutes (a long run renews its token) | one hour |
| Offers, booking, passengers, purchaser, confirmation, refund | yes | yes | yes |
| Return in two offers (`outwardOfferIds`) | yes | yes | yes |
| Return in one offer (`outboundTripIds`, OSDM 3.7+) | — | yes | yes |
| Overrule codes on a refund | any code accepted | any code accepted | four codes, any other refused |
| Named products, group products, reduction cards | — | — | yes |
| Two-leg trips with a second-class-only train, upgrade parts | — | — | yes |
| Mandatory and optional seat reservations | — | — | yes |
| `POST /trips-collection` and offers by trip id | 501 | 501 | yes |
| Fulfilment documents, `GET /fulfillments/{id}`, refund receipt | none, 501 | none, 501 | yes |
| `Idempotency-Key` | ignored | ignored | yes |
| Exchange | 501 | 501 | yes |
| Expiry after 60 s for trips from station 0000099 | — | — | yes |
| Response variants, deliberately wrong answers | — | — | yes |
| Requested information and passenger data checks | — | — | yes |

Every new function goes to `gamma`; `alpha` and `beta` keep the basic sale
and refund, which also keeps the "not implemented by this provider" path
(a `501`) under test. The scenarios of the simulator's data file are named
after their provider: `_36` runs on `alpha`, `_37` on `beta`, `_38` on
`gamma`. The answer the simulator gives to each scenario, and the warnings a
run must show, are in
[OSCAR - OSDM Simulator scenarios](../Server_Operations/OSCAR%20-%20OSDM%20Simulator%20scenarios.md).

## 3. What the Bruno collection checks, step by step

Each step sends one request and checks the answer. The table says what is
checked; [OSCAR - Checks by scenario](OSCAR%20-%20Checks%20by%20scenario.md)
lists every check of every step word for word, as a real run makes it, with
how many scenarios make it.

**Every step** checks the HTTP status (the one expected, or a refusal for a
negative test), that the answer is JSON, and — where OSDM marks a member as
required — that it is there. A value from an OSDM code list is a FAIL only
when it is not text; a value outside a list OSDM calls extensible is a
WARNING.

### Access token and system information (run once per run)

| Step | Request | What is checked |
|---|---|---|
| Access token | the provider's token endpoint | a token is obtained |
| 00 | `GET /versions` | the answer is a list of versions; the version the data file names is one of them (a soft check: a mismatch is reported, not failed) |
| 01–10 (system information) | `GET /coach-(deck-)layouts`, `/passenger-categories`, `/promotion-codes`, `/reduction-cards`, `/zones`, `/products`, `/products/{id}`, `/product-tags` | optional reads: a `501`, a `404` or `OPERATION_NOT_PERMITTED` is "not implemented by this provider" (a passing INFO row); an answer is checked against the OSDM schema of its version |

### Sale

| Step | Request | What is checked |
|---|---|---|
| 01. POST Get Offer | `POST /offers` (by search criteria, or by trip id after `POST /trips-collection`) | at least one offer; each offer's id, creation date, passengers (as many as asked), price (`minimalPrice` not below the sum of its admissions), flexibility, service and travel class, pre-booking deadline in the future; the trips (legs with train, origin and destination, times in order) and that the offer covers one of them; each admission's validity, price, mode, passengers. Depending on the scenario: the flexibility or product asked for is offered; a reduction card is applied; a group gets one collective admission; each leg gets the class asked; a mandatory or optional reservation is offered and linked from the admission; requested information is well-formed; refund or exchange is allowed when the scenario will do one |
| 01b. POST Get Return Offer | `POST /offers` for the inbound journey | the same checks; the trip goes back, the passengers are the same; in two offers, the inbound offer covers an inbound trip; in one offer, it covers both the outbound and an inbound trip |
| 01c. POST Get Offer without Cards | `POST /offers` again, without the cards | a passenger with a reduction card pays less with it (not less is a WARNING: prices are the provider's choice) |
| 01d. POST Get Offer Individual | `POST /offers` again, as individuals | a group pays less than the same passengers alone (not less is a WARNING: prices are the provider's choice) |
| 08 / 08b. GET place map | `GET /availabilities/place-map` | only for a scenario that chooses seats |
| 02. POST Create Booking | `POST /bookings` | a booking with an id; `PREBOOKED` parts; a confirmation deadline in the future; `provisionalPrice` in the offer's currency and not below its `minimalPrice`; each booked part matches its offer part (paired by content, not by position): status, mode, prices, validity, refund and exchange conditions, passenger types and cards, reservations; exactly the passengers asked. For a return, both directions in one booking. With `Idempotency-Key`: the same key gives the same booking, another key a new one |
| 03. PATCH Multi Passenger | `PATCH /bookings/{id}/passengers/{id}` | the update is accepted and the answer holds the new details (a detail the provider does not keep, such as the date of birth, is a WARNING; a different one is a FAIL). Every passenger is updated, or only the first when the scenario says `passengerUpdateScope: MAIN` (providers that let only the main passenger change); negative tests: an update without a demanded field, or with an invalid one, is refused with a 4xx Problem |
| 04. GET Passenger | `GET /bookings/{id}/passengers/{id}` | each passenger has the details just written, or those of the booking when it was not updated |
| 09. POST Add Reservation to Booking | `POST /bookings/{id}/booked-offers/{id}/offer-parts` | a reservation added afterwards is in the booking, on the right leg |
| 12–14. Purchaser | `GET`, `PATCH`, `POST /bookings/{id}/purchaser` | a booking made without a purchaser has none, and gets one afterwards; a purchaser with a missing or invalid field is refused with a 4xx Problem |
| 05. GET Booking before Fulfillments | `GET /bookings/{id}` | the same checks as 02, on the stored booking |
| 06. POST Obtaining Fulfillments from Booking | `POST /bookings/{id}/fulfillments` | the booking is confirmed: each fulfillment has an id, belongs to this booking, has a valid status and creation date, a control number, and names booking parts of this booking; in 3.8 its document references resolve to documents of the booking. With `Idempotency-Key`: the same key gives the same fulfillment |
| 06b. GET Fulfillment | `GET /fulfillments/{id}` | an optional read: the answer is that fulfillment, with its documents (`501` = not implemented) |
| 07. GET Booking after Fulfillments | `GET /bookings/{id}` | parts and fulfillments `FULFILLED` or `CONFIRMED`; `confirmedPrice` present and in the booking's currency; the number of fulfillments a return should have; the documents asked for are there (a missing one is a WARNING); the product, the class per leg and the reservations booked are those of the offer |

### Refund

| Step | Request | What is checked |
|---|---|---|
| 10. POST Refund Offers | `POST /bookings/{id}/refund-offers` | one or more refund offers, each `PROPOSED`, with dates in order, a well-formed refundable amount and fee, non-negative, together not above the confirmed price; each names fulfillments of this booking, none twice. A partial refund gives back less than the whole. With an overrule code: the code is echoed, every fee is zero and the offers together give back what was paid; a code the provider does not accept is refused with a 4xx Problem |
| 11. GET Refund Offer | `GET …/refund-offers/{id}` | the same, on the stored refund offer |
| 12. GET Booking before Patch Refund | `GET /bookings/{id}` | the booking is still fulfilled and unchanged |
| 13. PATCH Refund Offer | `PATCH …/refund-offers/{id}` | the refund offer is confirmed at the amounts it was proposed at |
| 14. GET Booking after Patch Refund | `GET /bookings/{id}` | the fulfillments the refund covered are `REFUNDED`, the others are not; for a full refund, every fulfillment is refunded (each refund offer confirmed in turn) |
| 14b. GET Booking Refund Receipt | `GET /bookings/{id}`, repeated | the refund receipt appears in the booking within the wait the scenario allows |
| 15. DEL Refund Offer / 16. GET Booking | `DELETE …/refund-offers/{id}` | a withdrawn refund offer leaves the ticket fulfilled |

### Exchange

| Step | Request | What is checked |
|---|---|---|
| 10. POST Exchange Offers | `POST /bookings/{id}/exchange-offers` | exchange offers with an id, a pre-booking deadline in the future, admissions, price, fee, and `amountToBePaid = exchangePrice + exchangeFee − confirmedPrice` |
| 11. POST Exchange Operations | `POST …/exchange-operations` | the operation is created `PREBOOKED` with the offer taken |
| 12. GET Exchange Offer, 13. GET Booking | reads | the parts sold first are `EXCHANGE_ONGOING`, checked against the original offer; the exchange's new parts, when the provider already shows them, are `PREBOOKED` (OSDM does not say whether they show before the confirmation) |
| 14. POST Obtaining Fulfillments, 15. / 17. GET Booking | confirmation and reads | the old parts are `EXCHANGED`, checked against the original offer; the new admissions are in the booking, fulfilled; the confirmed price updated. After a withdrawn exchange (17), the old parts are back |
| 16. DEL Exchange Offer | `DELETE …/exchange-operations/{id}` | a withdrawn exchange leaves the original ticket |

### Expiry probes

Four negative tests wait for a deadline and check that the provider then
refuses: booking an offer past its `preBookableUntil` (step 02), confirming a
booking past its time limit (step 06, then 07 checks its parts are released),
confirming a refund offer past its `validUntil` (step 13), taking an exchange
offer past its `preBookableUntil` (step 11). Each refusal must be a 4xx with
an RFC 9457 Problem body.

### OSCAR's own requests

Every request OSCAR sends with a body (offers, booking, passenger and
purchaser updates, reservations added later, confirmation, refund and
exchange) is checked against the OSDM request schema of the version under
test, once it has gone out: one check per request, named `[OSCAR request]`.
A failure is OSCAR's issue, not the provider's, whatever the provider
answered: it lists the paths and members at fault, never their values. The
negative tests that send a wrong body on purpose (the passenger and purchaser
sweeps, the empty passenger list) say so and pass. Requests a step's script
sends itself (the trip search, the Idempotency-Key and after-sale probes) are
not checked.

## 4. The ready-made scenarios

### 4.1 The simulator's data file (89 scenarios)

Each scenario, with what it tests, what the simulator answers and what a run
must show, is in
[OSCAR - OSDM Simulator scenarios](../Server_Operations/OSCAR%20-%20OSDM%20Simulator%20scenarios.md).
In short:

| Group | Scenarios | Provider |
|---|---|---|
| Sale, two-offer return, full refund, partial refund by fulfillment | 5 per version | `alpha`, `beta`, `gamma` |
| Return in one offer | 1 per version from 3.7 | `beta`, `gamma` |
| Refund withdrawn, refund offer only, overrule codes (4 accepted, 1 refused) | 7 | `gamma` |
| Refunds of a return in one offer (full, inbound only, overrule code, receipt) | 4 | `gamma` |
| Partial refund by passenger and by leg, on trips sold with one ticket per passenger or per leg | 2 | `gamma` |
| Passenger limits: the maximum, one over it, a third of the maximum refunded | 3 | `gamma` |
| After-sale refusals: refund again, exchange a refunded ticket, confirm again | 3 | `gamma` |
| Accented and long names; an offer request with no passenger | 2 | `gamma` |
| Departure dates: the last day of the sales horizon, the day after, yesterday | 3 | `gamma` |
| Passengers on the edges of the age bands | 1 | `gamma` |
| Reduction cards, named products, group tariffs (two of them negative), class per leg | 14 | `gamma` |
| Seat reservations (mandatory, and the three ways of booking an optional one) | 4 | `gamma` |
| Offers by trip id (two ways of choosing the trip, one refused id) | 3 | `gamma` |
| Documents, refund receipt, `Idempotency-Key` | 3 | `gamma` |
| Exchange, exchange withdrawn | 2 | `gamma` |
| Expiry probes (one per deadline, and two chained in one scenario) | 5 | `gamma` |
| Response variants (per passenger, reordered, minimal, main passenger only) | 5 | `gamma` |
| Deliberately wrong answers (must fail; not in the run list) | 5 | `gamma` |
| Requested information and purchaser | 5 | `gamma` |

### 4.2 The reference scenarios of the catalogue (50)

These are the scenarios a company can copy from Test Config. **Scope** is
what the scenario tests. **Needs declared** is what the company's Test
Framework must declare for the copy to be allowed (sales flows always include
`SALE`). **Checks** is the number of checks the source scenario made on the
simulator's `gamma`; on a real provider the number differs with what it
returns (more passengers, more parts, more fulfillments mean more checks).
**Source** is the scenario of the simulator's data file it is made from.

#### Sale

| Code | Scope | Needs declared | Checks | Source |
|---|---|---|---|---|
| `OTST_SALE_ONE_WAY_1ADT` | One-way sale for one adult: offers, booking, passenger update, confirmation, documents. | — | 234 | `SIM_SALE_SEARCH_1ADT_38` |
| `OTST_SALE_ONE_WAY_2ADT_SAVER` | One-way sale for two adults, choosing the non-flexible (saver) offer. | — | 294 | `SIM_SALE_SEARCH_2ADT_SAVER_38` |
| `OTST_SALE_MAX_PASSENGERS` | Sale at the provider's maximum number of passengers per offer and booking, every passenger updated after booking. | the maximum number of passengers | 1314 | `SIM_SALE_MAX_PASSENGERS_38` |
| `OTST_SALE_ACCENTED_LONG_NAMES` | Accented (Czech) and long names, updated after booking to other accented names: every read must give them back unchanged. | — | 294 | `SIM_SALE_ACCENTED_NAMES_38` |
| `OTST_SALE_AT_SALES_HORIZON` | Sale of a departure on the last day of the provider's sales horizon. | the sales horizon | 234 | `SIM_SALE_AT_SALES_HORIZON_38` |
| `OTST_SALE_AGE_LIMITS` | Three passengers on the edges of the age ranges: a child on the last day of its range, a passenger the day it leaves it, an adult on the first day of the adult range; each priced as its type. | CHILD and ADULT age ranges | 408 | `SIM_SALE_AGE_LIMITS_38` |
| `OTST_SALE_RETURN_SEPARATE_1ADT` | Return sold as two offers, one per direction (`returnSearchParameters.outwardOfferIds`). | return model SEPARATE | 314 | `SIM_RETURN_SEPARATE_1ADT_38` |
| `OTST_SALE_RETURN_COMBINED_1ADT` | Return sold as one offer covering both directions (`outboundTripIds`). | return model COMBINED, OSDM 3.7+ | 356 | `SIM_RETURN_COMBINED_1ADT_38` |
| `OTST_SALE_CLASS_PER_LEG_1ADT` | Travel class per leg on a two-leg trip: first class where the train has one. | — | 288 | `SIM_SALE_CLASS_PER_LEG_1ADT_38` |
| `OTST_SALE_RESERVATION_MANDATORY_2ADT` | A mandatory seat reservation, detected from the admission and booked with it. | — | 343 | `SIM_SALE_RESERVATION_MANDATORY_2ADT_38` |
| `OTST_SALE_RESERVATION_SELECTION_2ADT` | An optional seat reservation booked with `optionalReservationSelections`. | — | 369 | `SIM_SALE_RESERVATION_SELECTION_2ADT_38` |
| `OTST_SALE_RESERVATION_PLACE_SELECTION_2ADT` | An optional seat reservation booked with `placeSelections`. | — | 369 | `SIM_SALE_RESERVATION_PLACE_SELECTION_2ADT_38` |
| `OTST_SALE_RESERVATION_ADD_LATER_2ADT` | An optional seat reservation added to the pre-booked booking afterwards. | — | 368 | `SIM_SALE_RESERVATION_ADD_LATER_2ADT_38` |
| `OTST_SALE_SEAT_PREFERENCE_1ADT` | A seat preference (window) asked in the booking with the reservation; the place booked must give it. | — | 271 | `SIM_SALE_SEAT_PREFERENCE_1ADT_38` |
| `OTST_SALE_SEAT_PREFERENCES_FLOW_2ADT` | Seat preferences in the PREFERENCES flow: `GET /availabilities/preferences` before the booking; one not offered and one no longer available are warnings, the rest is asked and given. | place selection by the available preferences | 337 | `SIM_SALE_SEAT_PREFERENCES_FLOW_2ADT_38` |
| `OTST_SALE_BY_TRIP_ID_1ADT` | Offers asked by trip id, after a trip search (`POST /trips-collection`). | — | 241 | `SIM_SALE_BY_TRIP_ID_1ADT_38` |
| `OTST_SALE_SEARCH_TRAIN_FILTER_1ADT` | An offer search sent with the train filter (dataFilter): the answer must hold a trip of the train asked. Every other search goes by place and time only. | — | 235 | `SIM_SALE_SEARCH_TRAIN_FILTER_1ADT_38` |
| `OTST_SALE_DOCUMENTS_RETURN_1ADT` | Fulfillment documents of a return, and each fulfillment read with `GET /fulfillments/{id}`. | return model COMBINED, OSDM 3.7+ | 356 | `SIM_SALE_DOCUMENTS_RETURN_1ADT_38` |
| `OTST_SALE_IDEMPOTENCY_1ADT` | `Idempotency-Key` on the booking and the confirmation: the same key gives the same answer. | — | 240 | `SIM_SALE_IDEMPOTENCY_1ADT_38` |
| `OTST_SALE_REQUESTED_INFORMATION_1ADT` | Requested information: what the offers ask for is checked and supplied. | — | 237 | `SIM_RI_AUTOFEED_1ADT_38` |
| `OTST_PURCHASER_DEFERRED_1ADT` | Booking made without its purchaser, which is written afterwards. | — | 239 | `SIM_PURCHASER_DEFERRED_1ADT_38` |

#### Refund

| Code | Scope | Needs declared | Checks | Source |
|---|---|---|---|---|
| `OTST_REFUND_RETURN_FULL_1ADT` | Full refund of a return: every refund offer confirmed, every fulfillment refunded. | REFUND_FULL, return model SEPARATE | 529 | `SIM_REFUND_RETURN_1ADT_38` |
| `OTST_REFUND_RETURN_INBOUND_1ADT` | Partial refund of a return by fulfillment: the inbound ticket alone. | REFUND_PARTIAL, return model SEPARATE | 455 | `SIM_REFUND_INBOUND_1ADT_38` |
| `OTST_REFUND_PARTIAL_PASSENGER_2ADT` | Partial refund by passenger: two adults, the last one refunded alone; the other passenger's ticket stays. | REFUND_PARTIAL | 476 | `SIM_REFUND_PAX_2ADT_38` |
| `OTST_REFUND_PARTIAL_LEG_1ADT` | Partial refund by leg: a two-leg journey, the last leg refunded alone; the first leg stays. | REFUND_PARTIAL | 453 | `SIM_REFUND_LEG_1ADT_38` |
| `OTST_REFUND_PARTIAL_PASSENGERS_THIRD` | Partial refund of a third of the passengers, at the provider's maximum number of passengers: only theirs are refunded, the others' tickets stay. | REFUND_PARTIAL, the maximum number of passengers | 5237 | `SIM_REFUND_PAX_THIRD_19PAX_38` |
| `OTST_REFUND_TECHNICAL_CANCELLATION_1ADT` | Technical cancellation: refund with an overrule code, everything back and no fee. | REFUND_FULL, return model SEPARATE | 533 | `SIM_REFUND_OVERRULE_TECHNICAL_FAILURE_38` |
| `OTST_REFUND_WITHDRAWN_1ADT` | Refund offer asked for, then withdrawn instead of confirmed: the ticket stays. | REFUND_FULL | 332 | `SIM_REFUND_DELETE_1ADT_38` |
| `OTST_REFUND_OFFER_ONLY_1ADT` | Refund offer asked for and read, neither confirmed nor withdrawn. | REFUND_FULL | 299 | `SIM_REFUND_ONLY_OFFER_1ADT_38` |
| `OTST_REFUND_RECEIPT_RETURN_1ADT` | Full refund of a return, then the refund receipt waited for in the booking. | REFUND_FULL, return model SEPARATE | 532 | `SIM_REFUND_RECEIPT_RETURN_1ADT_38` |
| `OTST_REFUND_RETURN_COMBINED_FULL_1ADT` | Full refund of a return sold as one offer: every refund offer confirmed, every fulfillment refunded. | REFUND_FULL, return model COMBINED, OSDM 3.7+ | 599 | `SIM_REFUND_COMBINED_RETURN_1ADT_38` |
| `OTST_REFUND_RETURN_COMBINED_INBOUND_1ADT` | Partial refund by fulfillment of a return sold as one offer: the inbound ticket alone. | REFUND_PARTIAL, return model COMBINED, OSDM 3.7+ | 516 | `SIM_REFUND_COMBINED_INBOUND_1ADT_38` |
| `OTST_REFUND_TECHNICAL_CANCELLATION_COMBINED_1ADT` | Technical cancellation of a return sold as one offer: overrule code, everything back and no fee. | REFUND_FULL, return model COMBINED, OSDM 3.7+ | 603 | `SIM_REFUND_COMBINED_OVERRULE_TECHNICAL_FAILURE_38` |
| `OTST_REFUND_RECEIPT_RETURN_COMBINED_1ADT` | Full refund of a return sold as one offer, then the refund receipt waited for in the booking. | REFUND_FULL, return model COMBINED, OSDM 3.7+ | 602 | `SIM_REFUND_COMBINED_RECEIPT_1ADT_38` |

#### Exchange

| Code | Scope | Needs declared | Checks | Source |
|---|---|---|---|---|
| `OTST_EXCHANGE_1ADT` | Exchange of a one-way ticket: exchange offers, one taken, confirmed. | EXCHANGE_FULL | 387 | `SIM_EXCHANGE_1ADT_38` |
| `OTST_EXCHANGE_WITHDRAWN_1ADT` | Exchange pre-booked, then withdrawn before its confirmation: the ticket stays. | EXCHANGE_FULL | 357 | `SIM_EXCHANGE_DELETE_1ADT_38` |

#### Negative tests (NHF: the provider must refuse)

| Code | Scope | Needs declared | Checks | Source |
|---|---|---|---|---|
| `NHF_REFUND_OVERRULE_CODE_REFUSED` | A refund with an overrule code the provider does not accept must be refused. | REFUND_FULL, return model SEPARATE | 320 | `SIM_REFUND_OVERRULE_REFUSED_38` |
| `NHF_SALE_BY_TRIP_ID_UNKNOWN` | Offers asked for a trip id the provider never gave must be refused. | — | 71 | `SIM_SALE_BY_TRIP_ID_UNKNOWN_38` |
| `NHF_SALE_TOO_MANY_PASSENGERS` | One passenger more than the provider's maximum: the offer request, or else the booking, must be refused. | the maximum number of passengers | 71 | `SIM_NHF_TOO_MANY_PASSENGERS_38` |
| `NHF_SALE_NO_PASSENGER` | An offer request with no passenger at all must be refused. | — | 71 | `SIM_NHF_NO_PASSENGER_38` |
| `NHF_SALE_BEYOND_SALES_HORIZON` | A departure one day beyond the provider's sales horizon: the offer request must be refused, or give no offer. | the sales horizon | 70 | `SIM_NHF_BEYOND_SALES_HORIZON_38` |
| `NHF_SALE_DEPARTURE_IN_PAST` | A departure yesterday: the offer request must be refused, or give no offer. | — | 72 | `SIM_NHF_DEPARTURE_IN_PAST_38` |
| `NHF_CONFIRM_TWICE` | A booking confirmed twice: the second confirmation must give the same tickets, or be refused; never new ones. | — | 235 | `SIM_NHF_CONFIRM_AGAIN_38` |
| `NHF_REFUND_TWICE` | A ticket refunded in full cannot be refunded again: the second refund offer request must be refused. | REFUND_FULL | 352 | `SIM_NHF_REFUND_AGAIN_38` |
| `NHF_EXCHANGE_REFUNDED` | A ticket refunded in full cannot be exchanged: the exchange offer request must be refused. | REFUND_FULL, EXCHANGE_FULL | 352 | `SIM_NHF_EXCHANGE_REFUNDED_38` |
| `NHF_EXPIRED_OFFER` | Booking an offer after its `preBookableUntil` must be refused. Waits up to 40 minutes. | — | 121 | `SIM_NHF_EXPIRED_OFFER_38` |
| `NHF_EXPIRED_BOOKING` | Confirming a booking after its confirmation time limit must be refused. Waits up to 40 minutes. | — | 191 | `SIM_NHF_EXPIRED_BOOKING_38` |
| `NHF_EXPIRED_REFUND_OFFER` | Confirming a refund offer after its `validUntil` must be refused. Waits up to 40 minutes. | REFUND_FULL | 303 | `SIM_NHF_EXPIRED_REFUND_OFFER_38` |
| `NHF_EXPIRED_EXCHANGE_OFFER` | Taking an exchange offer after its `preBookableUntil` must be refused. Waits up to 40 minutes. | EXCHANGE_FULL | 269 | `SIM_NHF_EXPIRED_EXCHANGE_OFFER_38` |
| `NHF_REQUESTED_INFORMATION_OMITTED` | A passenger update without a demanded field must be refused. | — | 147 | `SIM_NHF_RI_OMIT_1ADT_38` |
| `NHF_PASSENGER_DATA_INVALID` | A passenger update with an invalid field, one field per pass, must be refused. | — | 163 | `SIM_NHF_RI_INVALID_1ADT_38` |
| `NHF_PURCHASER_INVALID` | A purchaser with a missing or invalid field, one per pass, must be refused. | — | 250 | `SIM_NHF_PURCHASER_INVALID_1ADT_38` |

The expiry probes wait 40 minutes on a real provider (the catalogue sets
their `…MaxWaitMinutes`); on the simulator their deadlines are one minute.
A scenario that waits longer than the provider's deadline is needed for the
probe to see the refusal; shorten or lengthen the wait in Test Config after
the copy if the provider's deadlines differ.

## 5. Reading a run

- **PASS / FAIL** — a check that holds or does not. A scenario passes with
  no failed check; a negative test passes when the provider refuses what it
  must refuse.
- **WARNING** — something to look at that OSDM does not forbid: a value
  outside an extensible code list, a document missing, a capability used but
  not declared in the Test Framework, a known deviation (a status the company
  has baselined as a finding).
- **INFO** — a step the provider does not implement (`501`, `404`, or
  `OPERATION_NOT_PERMITTED` on an optional read), or a value shown for the
  record.

On the simulator, the warnings each scenario must show are listed with it;
any other warning, or any failed check, is a change to look into.

## 6. Keeping these documents current

- [OSCAR - OSDM Simulator scenarios](../Server_Operations/OSCAR%20-%20OSDM%20Simulator%20scenarios.md)
  is kept in step with the simulator's data file by
  `OSDM_Simulator/tests/datafile.test.js`: a scenario without its row fails
  the tests.
- [OSCAR - Checks by scenario](OSCAR%20-%20Checks%20by%20scenario.md) is
  generated. After a collection release, with the simulator and the data
  file served locally (see the replay section of
  [`Bruno_Collection/README.md`](../../Bruno_Collection/README.md)), in
  `OSDM_Simulator/`:

  ```bash
  node scripts/replay.js record after      # about 13 minutes
  node scripts/replay.js catalogue         # the catalogue's check counts still hold
  node scripts/replay.js describe          # rewrites the document
  ```

- The tables of section 4.2 come from `scenario_catalogue.json`; a new
  reference scenario needs its row here.
