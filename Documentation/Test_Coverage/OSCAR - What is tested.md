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

## 2. The simulator: six providers

The simulator is a stub OSDM provider. It builds a trip from the request
(no timetable: the same request gives the same trip and prices) and answers
in the shapes of each provider's own OSDM version (#833: before, every
provider answered in 3.8 shapes). Since #824 the providers offer the
same functions (`delta`, OSDM 3.9, since #858; `epsilon`, OSDM 3.10, since #920; `zeta`, OSDM 3.12 in development, since #925); they differ by their OSDM version, their currency, their
identifiers and their token lifetime:

| | `alpha` | `beta` | `gamma` | `delta` | `epsilon` | `zeta` |
|---|---|---|---|---|---|---|
| OSDM version reported | 3.6.0 | 3.7.0 | 3.8.0 | 3.9.0 | 3.10.0 | 3.12.0 (in development) |
| Currency | EUR, and CHF when asked | CHF, and EUR when asked | CZK, and EUR when asked | PLN, and EUR when asked | SEK, and EUR when asked | NOK, and EUR when asked |
| Identifiers | `ALPHA-…` | `BETA-…` | `GAMMA-…` | `DELTA-…` | `EPSILON-…` | `ZETA-…` |
| Token lifetime | one hour | two minutes (a long run renews its token) | 15 minutes | 30 minutes | 10 minutes | 5 minutes |
| Offers, booking, passengers, purchaser, confirmation, refund | yes | yes | yes | yes | yes | yes |
| Return in two offers (`outwardOfferIds`) | yes | yes | yes | yes | yes | yes |
| Return in one offer (`outboundTripIds`) | — (not in OSDM 3.6) | yes | yes | yes | yes | yes |
| Overrule codes on a refund: four codes, any other refused | yes | yes | yes | yes | yes | yes |
| Named products, group products, reduction cards | yes | yes | yes | yes | yes | yes |
| Two-leg trips with a second-class-only train, upgrade parts | yes | yes | yes | yes | yes | yes |
| Mandatory and optional seat reservations, place preferences, place map | yes | yes | yes | yes | yes | yes |
| `POST /trips-collection` and offers by trip id | yes | yes | yes | yes | yes, and `POST /trips-collections` (3.10 and later) | yes, and `POST /trips-collections` (3.10 and later) |
| Fulfilment documents, `GET /fulfillments/{id}`, refund receipt | yes | yes | yes | yes | yes | yes |
| `Idempotency-Key` | yes | yes | yes | yes | yes | yes |
| Exchange | yes | yes | yes | yes | yes | yes |
| Expiry after 60 s for trips from station 0000099 | yes | yes | yes | yes | yes | yes |
| Response variants, deliberately wrong answers | yes | yes | yes | yes | yes | yes |
| Requested information and passenger data checks, sales horizon, age tariffs | yes | yes | yes | yes | yes | yes |
| Fare offers for a requested section (`FARE_ADMISSION`, five clusters, a free child), alone when only fare parts are asked (#1046), built from DB's fare templates (#1048: border points, first class, cards, family, group, bicycle fare, several routes), the form of a real provider's answer (#1045: coverage on the route and the offer only), seven wrong variants (one priced without a section, #905) and five that warn only (#1045: a card not held, ages outside, another class, dates offset, an unknown covered leg); booking and fulfilment of a fare, two wrong fare fulfilments (#906); the refund of a fare, COMBINING fares, two wrong fare refunds (#907) | yes | yes | yes | yes | yes | yes |
| Fare reservations: a bicycle place in fare mode, two wrong answers (#255; OSDM 3.8 and later, so not on alpha and beta) | — | — | yes | yes | yes | yes |

Every new function goes to every provider: a test of the simulator
(`config.test.js`) fails when `alpha`, `beta`, `delta`, `epsilon` or `zeta` lacks a setting `gamma` has.
Every reference scenario of the catalogue can therefore be copied for, and
run on, each of them; the one exception is a return in one offer on `alpha`,
which OSDM 3.6 does not have. The "not implemented by this provider" path (a
`501`) is tested with a test-only provider. The scenarios of the simulator's
data file are named after their provider: `_36` runs on `alpha`, `_37` on
`beta`, `_38` on `gamma`. The answer the simulator gives to each scenario,
and the warnings a run must show, are in
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
| 01. POST Get Offer | `POST /offers` (by search criteria, or by trip id after `POST /trips-collection`) | at least one offer; each offer's id, creation date, passengers (as many as asked), price (`minimalPrice` not below the sum of its admissions), flexibility, service and travel class, pre-booking deadline in the future; the trips (legs with train, origin and destination, times in order) and that the offer covers one of them; for a trip specification, a leg answered with another carrier than the one asked is a warning (#1021); each admission's validity, price, mode, passengers. Depending on the scenario: the flexibility or product asked for is offered; a reduction card is applied; a group gets one collective admission; each leg gets the class asked; a mandatory or optional reservation is offered and linked from the admission; requested information is well-formed; refund or exchange is allowed when the scenario will do one. Whether the offers keep to the offer search criteria sent (offer mode, offer parts, flexibilities, travel and service classes, product tags): a warning when none does, INFO otherwise (#780). Fares (#903), when the request asks `FARE_ADMISSION` for a requested section: an offer holds fares; each fare has the members OSDM requires, a type asked, regional validities, after-sales conditions, a validity range and no negative price; every passenger has a fare in each fare offer and their fares cover the section (a gap fails, an overlap warns); CLUSTERING clusters are OSDM's five and allow none more flexible (warnings); the involved TCOs are named (warning); fares not asked fail. Warnings (#1045, O16–O20): a fare requiring a card that none of its passengers holds, or an empty `requiredCards`; a fare whose passenger constraints do not hold its passenger's age on the travel day; a travel class asked with no fare offer in it (a bicycle's fare does not count); valid travel dates whose `utcOffset` disagrees with their own offset (OSDM: the minutes added to get UTC); an offer's covered section naming a leg that is not a train of its trip. What a fare covers is read from its `coveredSection`, else its connection points, else its route's ends, else its offer's covered sections; when none says, the coverage is a warning. The trip may be a specification, search criteria or a trip id (#904); a requested section outside the trip fails the scenario as its own data, before the answer is read. A scenario that expects no fare (#905, `expectFares: false`) is checked for none instead, whether fares were asked or not, then ends here or goes on with a product sale (`bookMode` PRODUCT); OSDM sets no rule for a domestic trip or a request without a section, so that expectation is the Test Manager's. A fare offer that passed every FAIL-level check is booked next (#906), straight to 02; one that failed a check ends the scenario here. Fare reservations (#255, `FARE_RESERVATION`, a passenger of type BICYCLE, from OSDM 3.8): each bicycle has a reservation, in FARE_MODE when no product reservation was asked, with no product (a WARNING); fare reservations not asked fail; the chosen offer's fare reservations are selected for the booking (`optionalReservationSelections`) |
| 01b. POST Get Return Offer | `POST /offers` for the inbound journey | the same checks; the trip goes back, the passengers are the same; in two offers, the inbound offer covers an inbound trip; in one offer, it covers both the outbound and an inbound trip |
| 01c. POST Get Offer without Cards | `POST /offers` again, without the cards | a passenger with a reduction card pays less with it (not less is a WARNING: prices are the provider's choice); when the card declares its rate (`percent`, from the Test Framework, #889), the price is that share less, within one currency unit or 1 %, else a FAIL; not checked on a group tariff |
| 01d. POST Get Offer Individual | `POST /offers` again, as individuals | a group pays less than the same passengers alone (not less is a WARNING: prices are the provider's choice) |
| 08 / 08b. GET place map | `GET /availabilities/place-map` | only for a scenario that chooses seats |
| 02. POST Create Booking | `POST /bookings` | a booking with an id; `PREBOOKED` parts; a confirmation deadline in the future; `provisionalPrice` in the offer's currency and not below its `minimalPrice`; each booked part matches its offer part (paired by content, not by position): status, mode, prices, validity, refund and exchange conditions, passenger types and cards, reservations; exactly the passengers asked. For a return, both directions in one booking. With `Idempotency-Key`: the same key gives the same booking, another key a new one. In a fare sale (#906): the booking holds the fares booked; every offered fare has its booked fare, paired by content; each keeps the members OSDM requires and the offered price |
| 03. PATCH Multi Passenger | `PATCH /bookings/{id}/passengers/{id}` | the update is accepted and the answer holds the new details (a detail the provider does not keep, such as the date of birth, is a WARNING; a different one is a FAIL). Every passenger is updated, or only the first when the scenario says `passengerUpdateScope: MAIN` (providers that let only the main passenger change); negative tests: an update without a demanded field, or with an invalid one, is refused with a 4xx Problem |
| 04. GET Passenger | `GET /bookings/{id}/passengers/{id}` | each passenger has the details just written, or those of the booking when it was not updated |
| 09. POST Add Reservation to Booking | `POST /bookings/{id}/booked-offers/{id}/offer-parts` | a reservation added afterwards is in the booking, on the right leg |
| 12–14. Purchaser | `GET`, `PATCH`, `POST /bookings/{id}/purchaser` | a booking made without a purchaser has none, and gets one afterwards; a purchaser with a missing or invalid field is refused with a 4xx Problem |
| 05. GET Booking before Fulfillments | `GET /bookings/{id}` | the same checks as 02, on the stored booking. In a fare sale (#906): the same fare checks, each fare PREBOOKED, and `provisionalPrice` the sum of the fares (a WARNING) |
| 06. POST Obtaining Fulfillments from Booking | `POST /bookings/{id}/fulfillments` | the booking is confirmed: each fulfillment has an id, belongs to this booking, has a valid status and creation date, a control number, and names booking parts of this booking; in 3.8 its document references resolve to documents of the booking. With `Idempotency-Key`: the same key gives the same fulfillment. In a fare sale (#906), instead: each fare fulfilment is CONFIRMED or FULFILLED and names the parts it covers; a document, control number, issuer, continuous-service usage or links on it is a WARNING (OSDM: a fare fulfilment has none); no fulfilment holds fares and products together |
| 06b. GET Fulfillment | `GET /fulfillments/{id}` | an optional read (for a fare reservation, #255, an error or an empty fulfilment is allowed): the answer is that fulfillment, with its documents (`501` = not implemented). In a fare sale (#906): the fare fulfilment checks of 06, no document check |
| 07. GET Booking after Fulfillments | `GET /bookings/{id}` | parts and fulfillments `FULFILLED` or `CONFIRMED`; `confirmedPrice` present and in the booking's currency; the number of fulfillments a return should have; the documents asked for are there (a missing one is a WARNING); the product, the class per leg and the reservations booked are those of the offer. In a fare sale (#906), instead: the fare checks of 02 and 06, each fare CONFIRMED or FULFILLED, every fare in a fulfilment, and the regional constraint, travel validity and passenger constraints the offer gave (a WARNING when they differ); a REFUND scenario then goes on to the refund of the fares (10, #907), any other ends. With fare reservations (#255; also at 02 and 05): each selected is in the booking, in FARE_MODE, for its passengers, then CONFIRMED or FULFILLED and in a fulfilment; the place allocation and the IRS 90918-1 reference (`bookingPartCode`) are told |

### Refund

| Step | Request | What is checked |
|---|---|---|
| 10. POST Refund Offers | `POST /bookings/{id}/refund-offers` | one or more refund offers, each `PROPOSED`, with dates in order, a well-formed refundable amount and fee, non-negative, together not above the confirmed price; each names fulfillments of this booking, none twice. A partial refund gives back less than the whole. With an overrule code: the code is echoed, every fee is zero and the offers together give back what was paid; a code the provider does not accept is refused with a 4xx Problem. In a fare refund (#907): the fare fulfilments are refunded in full; the refund offers cover them (R1) and give back and keep what their fares cost (R2); for COMBINING fares the fee is the one the fares' after-sales conditions give at the time (R3, a WARNING); for a CLUSTERING fare whose fee is the provider's, the fee the scenario states (`fareRefundFee`, sent as `RefundSpecification.refundFee` from OSDM 3.8) is the refund offer's fee (R4) |
| 11. GET Refund Offer | `GET …/refund-offers/{id}` | the same, on the stored refund offer |
| 12. GET Booking before Patch Refund | `GET /bookings/{id}` | the booking is still fulfilled and unchanged. In a fare refund (#907), the fare checks of 07 on the booking instead |
| 13. PATCH Refund Offer | `PATCH …/refund-offers/{id}` | the refund offer is confirmed at the amounts it was proposed at |
| 14. GET Booking after Patch Refund | `GET /bookings/{id}` | the fulfillments the refund covered are `REFUNDED`, the others are not; for a full refund, every fulfillment is refunded (each refund offer confirmed in turn). In a fare refund (#907): the booked fares of the refunded fulfilments are `REFUNDED` too (R5), and the booking keeps its fares with the members OSDM requires |
| 14b. GET Booking Refund Receipt | `GET /bookings/{id}`, repeated | the refund receipt appears in the booking within the wait the scenario allows |
| 15. DEL Refund Offer / 16. GET Booking | `DELETE …/refund-offers/{id}` | a withdrawn refund offer leaves the ticket fulfilled |

### Exchange

| Step | Request | What is checked |
|---|---|---|
| 10. POST Exchange Offers | `POST /bookings/{id}/exchange-offers` | exchange offers with an id, a pre-booking deadline in the future, admissions, price, fee, and `amountToBePaid = exchangePrice + exchangeFee − confirmedPrice`; when the scenario's `exchange` block names another trip, day or time (#959), the offers cover that trip, and once confirmed (15) the booked offer of the exchange does too |
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

### 4.1 The simulator's data file

Each scenario, with what it tests, what the simulator answers and what a run
must show, is in
[OSCAR - OSDM Simulator scenarios](../Server_Operations/OSCAR%20-%20OSDM%20Simulator%20scenarios.md).
**Every scenario written for `gamma` (`_38`) also runs on `alpha` (`_36`),
`beta` (`_37`), `delta` (`_39`), `epsilon` (`_310`, OSDM 3.10, #920) and `zeta` (`_312`, OSDM 3.12 in development, #925)** (#914), but those a version cannot
express (a return in one offer on 3.6): each OSDM version is tested on all
the simulator does. The groups below are gamma's; the other five providers
have the same, as copies. In short:

| Group | Scenarios | Provider |
|---|---|---|
| Sale, two-offer return, full refund, partial refund by fulfillment | 5 | `gamma` (and its copies) |
| Return in one offer | 1 | `gamma` (and its copies from 3.7) |
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
| Fare sales for a requested section (#903, #904, #906): on a trip specification, by search criteria and by trip id, a free child, each fare booked and confirmed; eight wrong answers (not in the run list) | 4 + 8 | `gamma` |
| Fare refunds (#907): a CLUSTERING fare by its own conditions, with a fee OSCAR states, COMBINING fares by date; two wrong answers (not in the run list) | 3 + 2 | `gamma` |
| Fare reservations (#255): a bicycle place with a fare admission, and alone; two wrong answers (not in the run list) | 2 + 2 | `gamma` |
| Negative fare requests (#905): fares not asked, no section (by search, then a product sale; on a specification sent as domestic), an empty list of sections; one wrong answer (not in the run list) | 4 + 1 | `gamma` |
| Fares from DB's templates (#1048) and what a fare says (#1045): first class, a card holder, a family, a bicycle fare, a group, border to border, several routes, a NON_FLEX refund, the form of a real provider's answer; five wrong answers that warn only (not in the run list) | 9 + 5 | `gamma` |

### 4.2 The reference scenarios of the catalogue (89)

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
| `OTST_SALE_REDUCTION_CARD_1ADT` | Sale to an adult holding a reduction card, the first one the Test Framework declares: the offer names the card on the passenger and costs less than the same request without it. | a reduction card | 261 | `SIM_SALE_CARD_25_1ADT_38` |
| `OTST_SALE_REDUCTION_CARD_2ADT` | Sale to two adults, one holding the first reduction card the Test Framework declares: only that passenger pays less. | a reduction card | 321 | `SIM_SALE_CARD_50_2ADT_38` |
| `OTST_SALE_NAMED_PRODUCT_1ADT` | Sale to an adult of a named product, the first one the Test Framework declares, by its code and in its flexibility: the offer chosen holds that product, and the booking and its fulfilment name it. | a product the provider sells | 237 | `SIM_SALE_PRODUCT_TRAIN_BOUND_1ADT_38` |
| `OTST_SALE_GROUP_TARIFF` | Group sale in the COLLECTIVE mode with the first group product the Test Framework declares, by its code, for a group of its sizes: one collective admission for the whole group, every passenger in appliedPassengerTypes, and the group compared with the same passengers alone. | a group product the provider sells | 498 | `SIM_GROUP_6ADT_38` |
| `NHF_SALE_GROUP_TOO_LARGE` | Group of one passenger more than the maximum of the first group product the Test Framework declares with one: the provider must refuse the request or offer it without that product. | a group product with its maximum size | 172 | `SIM_GROUP_WEEKEND_6PAX_ABSENT_38` |
| `OTST_SALE_CLASS_PER_LEG_1ADT` | Travel class per leg on a two-leg trip: first class where the train has one. | — | 289 | `SIM_SALE_CLASS_PER_LEG_1ADT_38` |
| `OTST_SALE_RESERVATION_MANDATORY_2ADT` | A mandatory seat reservation, detected from the admission and booked with it. | — | 343 | `SIM_SALE_RESERVATION_MANDATORY_2ADT_38` |
| `OTST_SALE_RESERVATION_SELECTION_2ADT` | An optional seat reservation booked with `optionalReservationSelections`. | — | 369 | `SIM_SALE_RESERVATION_SELECTION_2ADT_38` |
| `OTST_SALE_RESERVATION_PLACE_SELECTION_2ADT` | An optional seat reservation booked with `placeSelections`. | — | 369 | `SIM_SALE_RESERVATION_PLACE_SELECTION_2ADT_38` |
| `OTST_SALE_RESERVATION_ADD_LATER_2ADT` | An optional seat reservation added to the pre-booked booking afterwards. | — | 368 | `SIM_SALE_RESERVATION_ADD_LATER_2ADT_38` |
| `OTST_SALE_SEAT_PREFERENCE_1ADT` | A seat preference (window) asked in the booking with the reservation; the place booked must give it. | — | 271 | `SIM_SALE_SEAT_PREFERENCE_1ADT_38` |
| `OTST_SALE_SEAT_PREFERENCES_FLOW_2ADT` | Seat preferences in the PREFERENCES flow: `GET /availabilities/preferences` before the booking; one not offered and one no longer available are warnings, the rest is asked and given. | place selection by the available preferences | 337 | `SIM_SALE_SEAT_PREFERENCES_FLOW_2ADT_38` |
| `OTST_SALE_NAMED_PLACE_2ADT` | Two named seats without a selection fee, chosen on the place map (`POST /availabilities/vehicle-place-map`); the booking gives them at the offer's price. | a named place without fee | 336 | `SIM_SALE_NAMED_PLACE_2ADT_38` |
| `OTST_SALE_NAMED_PLACE_FEE_1ADT` | A named seat with a selection fee, chosen on the place map; the booking gives it at the offer's price plus the fee. | a named place with a fee | 273 | `SIM_SALE_NAMED_PLACE_FEE_1ADT_38` |
| `OTST_SALE_NAMED_COMPARTMENT_2ADT` | A compartment booked as a whole, chosen on the place map; the booking gives it. | a named place without fee | 336 | `SIM_SALE_NAMED_COMPARTMENT_2ADT_38` |
| `OTST_SALE_NEARBY_PLACE_2ADT` | Two seats near the place of another passenger: the trip is booked first for the first passenger alone, and the place given is the reference place (#776). `GET /availabilities/nearby`, then the booking names it in `placeSelections[].referencePlace` and gives seats in its coach, never that place itself. The first booking is deleted. | place selection next to a given place | 336 | `SIM_SALE_NEARBY_PLACE_AUTO_2ADT_38` |
| `OTST_SALE_NEARBY_PLACE_1ADT` | The same for one passenger (#776): one seat near the place of a first booking. | place selection next to a given place | 273 | `SIM_SALE_NEARBY_PLACE_AUTO_1ADT_38` |
| `OTST_SALE_NAMED_PLACE_ADD_LATER_2ADT` | An optional reservation added after the booking with two named seats: the place map asked for the booking (`POST /availabilities/vehicle-place-map`, BOOKING context), the seats named in the offer-parts request and given. | a named place without fee; reservations added after the booking | 335 | `SIM_SALE_NAMED_PLACE_ADD_LATER_2ADT_38` |
| `OTST_SALE_NEARBY_PLACE_ADD_LATER_2ADT` | An optional reservation added after the booking near the place of another passenger: a first booking for the first passenger alone gives the reference place (#776); `GET /availabilities/nearby` for the booking, the reference place in the offer-parts request, seats given in its coach. | place selection next to a given place; reservations added after the booking | 335 | `SIM_SALE_NEARBY_PLACE_AUTO_ADD_LATER_2ADT_38` |
| `OTST_SALE_SEAT_PREFERENCES_ADD_LATER_2ADT` | An optional reservation added after the booking with a seat preference: `GET /availabilities/preferences` for the booking, the preference in the offer-parts request, and the place given names it. | place selection by the available preferences; reservations added after the booking | 336 | `SIM_SALE_SEAT_PREFERENCES_ADD_LATER_2ADT_38` |
| `OTST_SALE_BY_TRIP_ID_1ADT` | Offers asked by trip id, after a trip search (`POST /trips-collection`). | — | 241 | `SIM_SALE_BY_TRIP_ID_1ADT_38` |
| `OTST_SALE_SEARCH_TRAIN_FILTER_1ADT` | An offer search sent with the train filter (dataFilter): the answer must hold a trip of the train asked. Every other search goes by place and time only. | — | 235 | `SIM_SALE_SEARCH_TRAIN_FILTER_1ADT_38` |
| `OTST_SALE_DOCUMENTS_RETURN_1ADT` | Fulfillment documents of a return, and each fulfillment read with `GET /fulfillments/{id}`. | return model COMBINED, OSDM 3.7+ | 356 | `SIM_SALE_DOCUMENTS_RETURN_1ADT_38` |
| `OTST_SALE_IDEMPOTENCY_1ADT` | `Idempotency-Key` on the booking and the confirmation: the same key gives the same answer. | — | 240 | `SIM_SALE_IDEMPOTENCY_1ADT_38` |
| `OTST_SALE_REQUESTED_INFORMATION_1ADT` | Requested information: what the offers ask for is checked and supplied. | — | 237 | `SIM_RI_AUTOFEED_1ADT_38` |
| `OTST_PURCHASER_DEFERRED_1ADT` | Booking made without its purchaser, which is written afterwards. | — | 239 | `SIM_PURCHASER_DEFERRED_1ADT_38` |

#### Refund

| Code | Scope | Needs declared | Checks | Source |
|---|---|---|---|---|
| `OTST_REFUND_RETURN_FULL_1ADT` | Full refund of a return: every refund offer confirmed, every fulfillment refunded. | REFUND_FULL, return model SEPARATE | 527 | `SIM_REFUND_RETURN_1ADT_38` |
| `OTST_REFUND_RETURN_INBOUND_1ADT` | Partial refund of a return by fulfillment: the inbound ticket alone. | REFUND_PARTIAL, return model SEPARATE | 455 | `SIM_REFUND_INBOUND_1ADT_38` |
| `OTST_REFUND_PARTIAL_PASSENGER_2ADT` | Partial refund by passenger: two adults, the last one refunded alone; the other passenger's ticket stays. | REFUND_PARTIAL | 476 | `SIM_REFUND_PAX_2ADT_38` |
| `OTST_REFUND_PARTIAL_LEG_1ADT` | Partial refund by leg: a two-leg journey, the last leg refunded alone; the first leg stays. | REFUND_PARTIAL | 453 | `SIM_REFUND_LEG_1ADT_38` |
| `OTST_REFUND_PARTIAL_PASSENGERS_THIRD` | Partial refund of a third of the passengers, at the provider's maximum number of passengers: only theirs are refunded, the others' tickets stay. | REFUND_PARTIAL, the maximum number of passengers | 5237 | `SIM_REFUND_PAX_THIRD_19PAX_38` |
| `OTST_REFUND_TECHNICAL_CANCELLATION_1ADT` | Technical cancellation: refund with an overrule code, everything back and no fee. | REFUND_FULL, return model SEPARATE | 611 | `SIM_REFUND_OVERRULE_TECHNICAL_FAILURE_38` |
| `OTST_REFUND_WITHDRAWN_1ADT` | Refund offer asked for, then withdrawn instead of confirmed: the ticket stays. | REFUND_FULL | 333 | `SIM_REFUND_DELETE_1ADT_38` |
| `OTST_REFUND_OFFER_ONLY_1ADT` | Refund offer asked for and read, neither confirmed nor withdrawn. | REFUND_FULL | 300 | `SIM_REFUND_ONLY_OFFER_1ADT_38` |
| `OTST_REFUND_RECEIPT_RETURN_1ADT` | Full refund of a return, then the refund receipt waited for in the booking. | REFUND_FULL, return model SEPARATE | 530 | `SIM_REFUND_RECEIPT_RETURN_1ADT_38` |
| `OTST_REFUND_RETURN_COMBINED_FULL_1ADT` | Full refund of a return sold as one offer: every refund offer confirmed, every fulfillment refunded. | REFUND_FULL, return model COMBINED, OSDM 3.7+ | 595 | `SIM_REFUND_COMBINED_RETURN_1ADT_38` |
| `OTST_REFUND_RETURN_COMBINED_INBOUND_1ADT` | Partial refund by fulfillment of a return sold as one offer: the inbound ticket alone. | REFUND_PARTIAL, return model COMBINED, OSDM 3.7+ | 516 | `SIM_REFUND_COMBINED_INBOUND_1ADT_38` |
| `OTST_REFUND_TECHNICAL_CANCELLATION_COMBINED_1ADT` | Technical cancellation of a return sold as one offer: overrule code, everything back and no fee. | REFUND_FULL, return model COMBINED, OSDM 3.7+ | 758 | `SIM_REFUND_COMBINED_OVERRULE_TECHNICAL_FAILURE_38` |
| `OTST_REFUND_RECEIPT_RETURN_COMBINED_1ADT` | Full refund of a return sold as one offer, then the refund receipt waited for in the booking. | REFUND_FULL, return model COMBINED, OSDM 3.7+ | 598 | `SIM_REFUND_COMBINED_RECEIPT_1ADT_38` |

#### Exchange

| Code | Scope | Needs declared | Checks | Source |
|---|---|---|---|---|
| `OTST_EXCHANGE_1ADT` | Exchange of a one-way ticket: exchange offers, one taken, confirmed. | EXCHANGE_FULL | 389 | `SIM_EXCHANGE_1ADT_38` |
| `OTST_EXCHANGE_OTHER_ROUTE_1ADT` | Exchange of a one-way ticket for a trip on another route: the exchange offers and, once confirmed, the booking cover the new trip. | EXCHANGE_FULL | 392 | `SIM_EXCHANGE_OTHER_ROUTE_1ADT_38` |
| `OTST_EXCHANGE_WITHDRAWN_1ADT` | Exchange pre-booked, then withdrawn before its confirmation: the ticket stays. | EXCHANGE_FULL | 361 | `SIM_EXCHANGE_DELETE_1ADT_38` |

#### Negative tests (NHF: the provider must refuse)

| Code | Scope | Needs declared | Checks | Source |
|---|---|---|---|---|
| `NHF_REFUND_OVERRULE_CODE_REFUSED` | A refund with an overrule code the provider does not accept must be refused. | REFUND_FULL, return model SEPARATE | 361 | `SIM_REFUND_OVERRULE_REFUSED_38` |
| `NHF_SALE_BY_TRIP_ID_UNKNOWN` | Offers asked for a trip id the provider never gave must be refused. | — | 71 | `SIM_SALE_BY_TRIP_ID_UNKNOWN_38` |
| `NHF_SALE_TOO_MANY_PASSENGERS` | One passenger more than the provider's maximum: the offer request, or else the booking, must be refused. | the maximum number of passengers | 71 | `SIM_NHF_TOO_MANY_PASSENGERS_38` |
| `NHF_SALE_NO_PASSENGER` | An offer request with no passenger at all must be refused. | — | 71 | `SIM_NHF_NO_PASSENGER_38` |
| `NHF_SALE_BEYOND_SALES_HORIZON` | A departure one day beyond the provider's sales horizon: the offer request must be refused, or give no offer. | the sales horizon | 70 | `SIM_NHF_BEYOND_SALES_HORIZON_38` |
| `NHF_SALE_DEPARTURE_IN_PAST` | A departure yesterday: the offer request must be refused, or give no offer. | — | 72 | `SIM_NHF_DEPARTURE_IN_PAST_38` |
| `NHF_CONFIRM_TWICE` | A booking confirmed twice: the second confirmation must give the same tickets, or be refused; never new ones. | — | 235 | `SIM_NHF_CONFIRM_AGAIN_38` |
| `NHF_REFUND_TWICE` | A ticket refunded in full cannot be refunded again: the second refund offer request must be refused. | REFUND_FULL | 350 | `SIM_NHF_REFUND_AGAIN_38` |
| `NHF_EXCHANGE_REFUNDED` | A ticket refunded in full cannot be exchanged: the exchange offer request must be refused. | REFUND_FULL, EXCHANGE_FULL | 350 | `SIM_NHF_EXCHANGE_REFUNDED_38` |
| `NHF_EXPIRED_OFFER` | Booking an offer after its `preBookableUntil` must be refused. Waits up to 40 minutes. | — | 121 | `SIM_NHF_EXPIRED_OFFER_38` |
| `NHF_EXPIRED_BOOKING` | Confirming a booking after its confirmation time limit must be refused. Waits up to 40 minutes. | — | 191 | `SIM_NHF_EXPIRED_BOOKING_38` |
| `NHF_EXPIRED_REFUND_OFFER` | Confirming a refund offer after its `validUntil` must be refused. Waits up to 40 minutes. | REFUND_FULL | 304 | `SIM_NHF_EXPIRED_REFUND_OFFER_38` |
| `NHF_EXPIRED_EXCHANGE_OFFER` | Taking an exchange offer after its `preBookableUntil` must be refused. Waits up to 40 minutes. | EXCHANGE_FULL | 273 | `SIM_NHF_EXPIRED_EXCHANGE_OFFER_38` |
| `NHF_REQUESTED_INFORMATION_OMITTED` | A passenger update without a demanded field must be refused. | — | 147 | `SIM_NHF_RI_OMIT_1ADT_38` |
| `NHF_PASSENGER_DATA_INVALID` | A passenger update with an invalid field, one field per pass, must be refused. | — | 163 | `SIM_NHF_RI_INVALID_1ADT_38` |
| `NHF_PURCHASER_INVALID` | A purchaser with a missing or invalid field, one per pass, must be refused. | — | 250 | `SIM_NHF_PURCHASER_INVALID_1ADT_38` |
| `OTST_OFFER_OPTION_COMBINATIONS` | Random combinations of offer search options (#780 part 3): as many as the Test Framework asks (`OTST_OFFER_COMBO_1`…), each asking for two or more declared option values together, drawn from its seed (the same seed, the same combinations; the travel and service classes are never combined); no offer keeping to an option, or the provider ignoring it, fails, and the scenario ends after the offer. | — | 121 | `SIM_OFFER_PROBE_COMBINATION_38` |
| `OTST_TRIP_TRANSFER_LIMIT_0` | Trip search probe (#780 PR B): direct trips only and one result asked (`parameters.transferLimit` 0, `numberOfResults` 1); a trip with a transfer, more trips than asked, or the provider ignoring either, fails, and the scenario ends after the offer. Needs Transfer limit and Number of results in the Test Framework's trip search parameters (or no list). | — | 119 | `SIM_TRIP_PROBE_TRANSFER_LIMIT_0_38` |
| `OTST_OFFER_OPTION_DISCOVERY` | Offer request options (#227): the offer request with the mandatory parameters only (the passengers' externalRef and type, and the trip) must be answered with offers; then each optional parameter of the version's OfferCollectionRequest alone, random combinations (seeded) of those found supported, and all of them, within 30 requests. Each answer is classified: supported, refused, not implemented or error; then honoured, ignored (said or silent), no offer (said or silent) or accepted. A code only the provider can give (card, corporate or promotion code, product) is made up when none is declared and must be refused or said. The first request can fail, and so can a declared option the provider does not take and a combination of options found supported that it refuses; the rest is a report in the run log and in the coverage. | — | 70 | `SIM_OFFER_OPTION_DISCOVERY_38` |
| `OTST_OFFER_OPTION_NOT_DECLARED` | Undeclared option probe (#780 PR C): offers asked with the first offer search option value the Test Framework's lists leave out (travel class, service class, offer part, flexibility, product tag, in that order); a refusal, no offer, or the provider saying it ignored it pass, offers keeping to the value fail (the framework should declare it), offers not keeping to it with nothing said pass with a warning. The scenario ends after the offer. Copiable only when a list leaves a value out. | — | 70 | `SIM_OFFER_PROBE_NOT_DECLARED_38` |
| `OTST_OFFER_OPTION_PROBE` | Offer search probes (#780): one per option value the Test Framework declares (`OTST_OFFER_TRAVEL_CLASS_FIRST`, `OTST_OFFER_SERVICE_CLASS_HIGH`, `OTST_OFFER_FLEXIBILITY_NON_FLEXIBLE`…), offers asked with that value alone; no offer keeping to it, or the provider ignoring it, fails, and the scenario ends after the offer. | — | 118 | `SIM_OFFER_PROBE_TRAVEL_CLASS_FIRST_38` |
| `OTST_SALE_CURRENCY` | Currencies (#781): one per currency the Test Framework declares (`OTST_SALE_CURRENCY_EUR`…), a return sold in it and refunded in full; offers not in the currency asked fail, and so do a booking or refund offers in another one. | REFUND_FULL, the currencies sold | 527 | `SIM_CURRENCY_EUR_REFUND_RETURN_1ADT_38` |
| `OTST_EXCHANGE_CURRENCY` | Currencies (#781): one per currency declared (`OTST_EXCHANGE_CURRENCY_EUR`…), a ticket sold in it and exchanged; exchange offers in another currency fail. | EXCHANGE_FULL, the currencies sold | 389 | `SIM_CURRENCY_EUR_EXCHANGE_1ADT_38` |
| `OTST_SALE_DEFAULT_CURRENCY` | Currencies (#781): no currency asked, the offers must be in the default currency the Test Framework declares. | the default currency | 234 | `SIM_CURRENCY_DEFAULT_1ADT_38` |
| `NHF_CURRENCY_NOT_SOLD` | Currencies (#781): offers asked in a common currency not declared; a refusal or no offer passes, offers in that currency fail, and the scenario ends after the offer. | the currencies sold | 71 | `SIM_NHF_CURRENCY_NOT_SOLD_38` |

#### Fares (#937)

Offered only to a Test Framework that declares the fare-based distribution
(Distribution, #936); what it sells in fares is declared under Fares. A copy
asks a fare cluster the framework declares (its own, else the most flexible
declared), and moves the requested section onto the chosen trip by position:
the whole trip stays the whole trip, a section from a station inside it to the
destination becomes the new trip's last leg.

| Code | Scope | Needs declared | Checks | Source |
|---|---|---|---|---|
| `OTST_FARE_SPEC_1ADT` | Fare sale for one adult by trip specification: fares asked for the last leg's section, one fare offer per cluster checked (fares, passengers, section coverage, conditions), the fare offer of the chosen cluster booked and fulfilled as fares. | the fare-based distribution | 118 | `SIM_FARE_SPEC_1ADT_38` |
| `OTST_FARE_SRCH_1ADT` | Fare sale for one adult by search criteria: fares asked for the whole trip, the fare offers checked, the fare offer of the chosen cluster booked and fulfilled as fares. | the fare-based distribution | 118 | `SIM_FARE_SRCH_1ADT_38` |
| `OTST_FARE_TRIPIDS_1ADT` | Fare sale for one adult by trip id: POST /trips-collection, then the fares of the trip chosen, by its id, for the whole trip; the fare offer of the chosen cluster booked and fulfilled as fares. | the fare-based distribution | 125 | `SIM_FARE_TRIPIDS_1ADT_38` |
| `OTST_FARE_FREE_CHILD` | Fare sale for an adult and a child one year under the age the Test Framework declares free: every passenger has a fare, the child's priced 0. | the fare-based distribution, the age under which a fare is free | 117 | `SIM_FARE_SPEC_FREE_CHILD_38` |
| `NHF_FARE_UNASKED` | Negative fare request: a section named but only ADMISSION asked; a fare in the answer fails (fares are given only when asked). The scenario ends after the offer. | the fare-based distribution | 71 | `SIM_NHF_FARE_UNASKED_38` |
| `NHF_FARE_NO_SECTION` | Negative fare request: FARE_ADMISSION asked by trip specification without a section; a fare in the answer fails. The scenario ends after the offer. | the fare-based distribution | 71 | `SIM_NHF_FARE_NO_SECTION_SPEC_38` |
| `NHF_FARE_EMPTY_SECTIONS` | Negative fare request: FARE_ADMISSION asked by trip specification with an empty list of sections; a fare in the answer fails. The scenario ends after the offer. | the fare-based distribution | 71 | `SIM_NHF_FARE_EMPTY_SECTIONS_38` |
| `NHF_FARE_PRODUCT_ONLY` | Negative fare request, then a product sale: a search asking ADMISSION and FARE_ADMISSION without a section; a fare in the answer fails, and the sale goes on with a product offer, booked and fulfilled. | both distributions (product and fare) | 237 | `SIM_NHF_FARE_NO_SECTION_SRCH_38` |
| `NHF_FARE_EMPTY_SECTIONS_SRCH` | Negative fare request: FARE_ADMISSION asked by search criteria with an empty list of sections; a fare in the answer fails. The scenario ends after the offer. | the fare-based distribution | 71 | `SIM_NHF_FARE_EMPTY_SECTIONS_SRCH_38` |
| `NHF_FARE_NO_SECTION_TRIPIDS` | Negative fare request: FARE_ADMISSION asked by trip id without a section; a fare in the answer fails. The scenario ends after the offer. | the fare-based distribution | 78 | `SIM_NHF_FARE_NO_SECTION_TRIPIDS_38` |
| `NHF_FARE_EMPTY_SECTIONS_TRIPIDS` | Negative fare request: FARE_ADMISSION asked by trip id with an empty list of sections; a fare in the answer fails. The scenario ends after the offer. | the fare-based distribution | 78 | `SIM_NHF_FARE_EMPTY_SECTIONS_TRIPIDS_38` |
| `OTST_FARE_REFUND_1ADT` | Fare sale refunded in full, no fee stated: the refund offer for the fare fulfilment checked against the fare's conditions, confirmed, the fare and its fulfilment REFUNDED. | the fare-based distribution, a refund of fares | 181 | `SIM_FARE_REFUND_1ADT_38` |
| `OTST_FARE_REFUND_FEE_1ADT` | Fare sale refunded in full with a refund fee stated by OSCAR (RefundSpecification.refundFee, OSDM 3.8): the refund offer keeps the fee stated, CLUSTERING fares. | the fare-based distribution, a refund of fares, a stated refund fee, OSDM 3.8 | 182 | `SIM_FARE_REFUND_FEE_1ADT_38` |
| `OTST_FARE_REFUND_COMBINING_1ADT` | Fare sale of fares combined by COMBINING, refunded in full: the fee is the fare's own, from its refund conditions at the time of the refund offer. | the fare-based distribution, a refund of fares, COMBINING | 181 | `SIM_FARE_REFUND_COMBINING_1ADT_38` |
| `OTST_FARE_BICYCLE_1ADT` | Fare sale for an adult and a bicycle (OSDM 3.8): the adult's fare and the bicycle's fare reservation in fare mode, selected, booked and fulfilled with the fare. | the fare-based distribution, a bicycle fare reservation, passenger type BICYCLE, OSDM 3.8 | 131 | `SIM_FARE_BICYCLE_1ADT_38` |
| `OTST_FARE_BICYCLE_ONLY` | Fare reservation alone for a bicycle (OSDM 3.8): an offer holding the bicycle place in fare mode and no fare, booked and fulfilled as fares. | the fare-based distribution, a bicycle fare reservation, passenger type BICYCLE, OSDM 3.8 | 108 | `SIM_FARE_BICYCLE_ONLY_38` |

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
