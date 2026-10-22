# OSCAR — OSDM Simulator: scenario catalogue

Every scenario of the simulator's data file
(`Bruno_Collection/data_base/simulator_datafile.json`), with what it tests,
what the simulator answers, and what a run must show. Install and set-up are
in [OSCAR - OSDM Simulator](OSCAR%20-%20OSDM%20Simulator.md); the simulator's
requests and profiles in [`OSDM_Simulator/README.md`](../../OSDM_Simulator/README.md).

`OSDM_Simulator/tests/datafile.test.js` fails when a scenario of the data file
is missing here, or when a scenario named here is not in the file: add the
row in the same change as the scenario.

## How to read it

- **Provider.** The suffix of the code names the OSDM version and so the
  provider to run it against: `_36` → `alpha` (3.6.0), `_37` → `beta`
  (3.7.0), `_38` → `gamma` (3.8.0), `_39` → `delta` (3.9.0, #858). Since #824 every function is on all of them (a COMBINED return excepted on `alpha`: OSDM 3.6 has no `outboundTripIds`), and since #914 every `_38` scenario is copied for the other three (below).
  Run a scenario against another provider and it tests something else, or
  fails.
- **Expected result.** Every scenario passes with **no failed check**. A
  negative test passes when the provider refuses what it must refuse; the
  refusal is graded as a check. The warnings listed are the only ones a run
  shows; any other warning, or any failed check, is a change to look into.
- **Check counts** change with each collection release, so they are not
  listed. The CHANGELOG entry of a release gives the counts measured then.
- **Trips.** The data file holds six trips:
  - 1: a search from station 0000001 to 0000002 at 08:00, on the next
    weekday;
  - 2: the same from 0000003 to 0000001 at 14:30;
  - 3: trip 1 on a Saturday;
  - 4: two specified legs, an InterCity from 0000001 to 0000004, then a
    regional train (second class only) to 0000002;
  - 5: two specified legs, a SuperCity (seat reservation mandatory) from
    0000001 to 0000005, then a EuroCity (reservation optional) to 0000002;
  - 6: trip 1 naming train 1854.

### What every run shows

These come from the steps every sale runs, so they are not repeated in each
row below:

- **`06b. GET Fulfillment`** reads each ticket of the booking; every provider
  answers it.
- Every booking gets its documents, on every provider since #824: one PDF for
  the whole booking, plus a PNG per ticket when the scenario asks for
  `RETAILER_APP`. A booking with two tickets (a return) therefore shows two
  warnings at 06b, one per ticket: *"document … covers this fulfillment only —
  it also holds …"*. That is the merged PDF, as ČD delivers it.

Since #824, `alpha` and `beta` offer every function `gamma` has, so a scenario
gives the same checks on each (the `_36`, `_37` and `_38` copies of one
scenario: 234, 294, 314, 527 and 455 checks; 356 for the return in one offer
on `beta` and `gamma`). Before, `alpha` and `beta` sold three unnamed offers
and issued no documents, which showed as one warning, *"the PDF_A4 medium
asked for is delivered — 0 document(s)"*.

## Every gamma scenario on every version (#914)

Each `_38` scenario of the sections below also exists for `alpha` (`_36`),
`beta` (`_37`) and `delta` (`_39`), so each OSDM version is tested on
everything the simulator does. A copy is the `_38` scenario with its code,
`osdmVersion` and description changed, and gamma's currencies replaced by
its provider's (gamma's CZK by the provider's own, EUR by its second one:
alpha EUR / CHF, beta CHF / EUR, delta PLN / EUR); the four providers have the
same functions (#824). It tests the same thing, the simulator answers it
the same way in the shapes of its own version (#833), and a run shows the
same result as its `_38` row, with the differences listed below. The
deliberately wrong and fault scenarios are copied too, and stay out of the
run lists like gamma's.

`OSDM_Simulator/scripts/version-copies.js` appends the copies that are
missing (`version-copies-lib.js` holds the rules), and
`OSDM_Simulator/tests/datafile.test.js` fails until every `_38` scenario has
them: add a scenario for gamma, then run the script. The copies have no row of
their own here.

**Not possible on a version**, so not copied:

| Version | Scenarios | Why |
|---|---|---|
| 3.6 (`alpha`) | Every scenario with a return in one offer (`returnModel` COMBINED): `SIM_RETURN_COMBINED_1ADT`, `SIM_GROUP_WEEKEND_RETURN_1ADT_2CHD`, `SIM_SALE_DOCUMENTS_RETURN_1ADT`, `SIM_REFUND_COMBINED_RETURN_1ADT`, `SIM_REFUND_COMBINED_INBOUND_1ADT`, `SIM_REFUND_COMBINED_OVERRULE_TECHNICAL_FAILURE`, `SIM_REFUND_COMBINED_RECEIPT_1ADT`, `SIM_SALE_CARD_STUDENT_RETURN_1YTH`, `SIM_SALE_PRODUCT_ALL_DAY_RETURN_1ADT`, `SIM_VARIANT_ONE_FULFILLMENT_PER_REFUND_1ADT` | OSDM 3.6 has no `outboundTripIds`, `inboundDate` or `inboundTripCoverage` (3.7). |
| 3.6 (`alpha`) | `SIM_OFFER_PROBE_PRODUCT_SELECTION_TAG` (any scenario with `productSelections`) | OSDM 3.6 has no `OfferSearchCriteria.productSelections` (3.7). |
| 3.6 (`alpha`), 3.7 (`beta`) | `SIM_SALE_NAMED_COMPARTMENT_2ADT` (any scenario naming a compartment, `namedPlaceKind` COMPARTMENT) | `PlaceSelection.compartments` comes with 3.8. |
| 3.9 (`delta`) | none | |

**Differences from the `_38` row:** none beyond the version's own answer
shapes (documents held by each fulfilment below 3.8; the refund receipt in
`Booking.documents` below 3.8, #914) and the provider's currency.

## alpha — OSDM 3.6.0

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_SEARCH_1ADT_36` | A sale by search criteria for one adult, passenger details updated after the booking (PATCH, then GET passenger). | One direct trip and the named products, from flexible to saver; the flexible one is booked and confirmed. One ticket and its PDF. | No failed check. |
| `SIM_SALE_SEARCH_2ADT_SAVER_36` | A sale of the non-flexible offer for two adults, on trip 2. | The saver offer for both passengers, one ticket. | No failed check. |
| `SIM_RETURN_SEPARATE_1ADT_36` | A return in two offers: the inbound request names the outbound offer (`outwardOfferIds`). Both offers booked together. | Inbound offers for the outbound one; one booking, one ticket per direction. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_RETURN_1ADT_36` | A full refund of a return: one refund offer per ticket, each confirmed, then the booking read again. | Two refund offers (no fee: flexible); each confirmed refunds its ticket and lowers the confirmed price. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_INBOUND_1ADT_36` | A partial refund by fulfillment: the inbound ticket only, named in `fulfillmentIds`. | One refund offer for the inbound ticket; the outbound one stays FULFILLED. | No failed check; the two merged-PDF warnings. |

## beta — OSDM 3.7.0

The same scenarios as `alpha`, plus the return in one offer, which OSDM
defines from 3.7.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_SEARCH_1ADT_37` | As `SIM_SALE_SEARCH_1ADT_36`, in 3.7. | As on `alpha`. | No failed check. |
| `SIM_SALE_SEARCH_2ADT_SAVER_37` | As `SIM_SALE_SEARCH_2ADT_SAVER_36`, in 3.7. | As on `alpha`. | No failed check. |
| `SIM_RETURN_SEPARATE_1ADT_37` | As `SIM_RETURN_SEPARATE_1ADT_36`; from 3.7 the inbound date goes in `offerSearchCriteria.inboundDate`. | As on `alpha`. | No failed check; the two merged-PDF warnings. |
| `SIM_RETURN_COMBINED_1ADT_37` | A return in one offer: the inbound request names the outbound trip (`outboundTripIds`); the offer chosen covers both trips and is booked alone. | Offers covering both trips at a return price; one booking, one ticket per direction. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_RETURN_1ADT_37` | As `SIM_REFUND_RETURN_1ADT_36`, in 3.7. | As on `alpha`. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_INBOUND_1ADT_37` | As `SIM_REFUND_INBOUND_1ADT_36`, in 3.7. | As on `alpha`. | No failed check; the two merged-PDF warnings. |

## delta — OSDM 3.9.0

The same scenarios as `beta` (#858). OSDM 3.9 changed no request or answer
schema OSCAR sends or reads; its one change is that the search date-times are
`format: date-time` (with an offset), which OSCAR does not send yet: the
OSDM working group is asked first. `delta` accepts both forms, as `gamma`
does.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_SEARCH_1ADT_39` | As `SIM_SALE_SEARCH_1ADT_36`, in 3.9. | As on `alpha`, in PLN. | No failed check. |
| `SIM_SALE_SEARCH_2ADT_SAVER_39` | As `SIM_SALE_SEARCH_2ADT_SAVER_36`, in 3.9. | As on `alpha`, in PLN. | No failed check. |
| `SIM_RETURN_SEPARATE_1ADT_39` | As `SIM_RETURN_SEPARATE_1ADT_37`, in 3.9. | As on `alpha`, in PLN. | No failed check; the two merged-PDF warnings. |
| `SIM_RETURN_COMBINED_1ADT_39` | As `SIM_RETURN_COMBINED_1ADT_37`, in 3.9. | As on `beta`, in PLN. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_RETURN_1ADT_39` | As `SIM_REFUND_RETURN_1ADT_36`, in 3.9. | As on `alpha`, in PLN. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_INBOUND_1ADT_39` | As `SIM_REFUND_INBOUND_1ADT_36`, in 3.9. | As on `alpha`, in PLN. | No failed check; the two merged-PDF warnings. |

## gamma — OSDM 3.8.0

### Sale, return and refund

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_SEARCH_1ADT_38` | As `SIM_SALE_SEARCH_1ADT_36`, in 3.8. | As on `alpha`. | No failed check. |
| `SIM_SALE_SEARCH_2ADT_SAVER_38` | As `SIM_SALE_SEARCH_2ADT_SAVER_36`, in 3.8. | The train-bound saver for both passengers. | No failed check. |
| `SIM_RETURN_SEPARATE_1ADT_38` | As `SIM_RETURN_SEPARATE_1ADT_36`, in 3.8. | As on `alpha`. | No failed check; the two merged-PDF warnings. |
| `SIM_RETURN_COMBINED_1ADT_38` | As `SIM_RETURN_COMBINED_1ADT_37`, in 3.8. | As on `beta`. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_RETURN_1ADT_38` | As `SIM_REFUND_RETURN_1ADT_36`, in 3.8. | As on `alpha`. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_INBOUND_1ADT_38` | As `SIM_REFUND_INBOUND_1ADT_36`, in 3.8. | As on `alpha`. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_COMBINED_RETURN_1ADT_38` | As `SIM_REFUND_RETURN_1ADT_38`, on a return sold as one offer (`outboundTripIds`), the only model some providers sell. | One offer covering both directions, one ticket per direction; one refund offer per ticket, each confirmed. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_COMBINED_INBOUND_1ADT_38` | As `SIM_REFUND_INBOUND_1ADT_38`, on a return sold as one offer: the inbound ticket alone. | One refund offer for the inbound ticket; the outbound one stays FULFILLED. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_DELETE_1ADT_38` | A one-way ticket: refund offer asked for (10), read (11), then withdrawn (15. DEL) instead of confirmed; the booking is read again (16). | The refund offer is `PROPOSED`; `DELETE` answers 204; the booking keeps its fulfilled ticket. (#611) | No failed check. |
| `SIM_REFUND_ONLY_OFFER_1ADT_38` | A one-way ticket: refund offer asked for and read, then neither confirmed nor withdrawn (no `scenarioAction`); the run ends at 12. | The refund offer stays `PROPOSED` until it expires. (#611) | No failed check. |

### Refund by passenger and by leg (#697)

By default gamma gives one ticket per direction holding every passenger, and an admission covers the whole trip, so a refund by passenger or leg cannot be shown there: a scope by `passengerIds` or `bookingPartIds` is refused (`PARTIAL_REFUND_NOT_SUPPORTED`). Real providers divide a booking otherwise, and gamma (profile `ticketing`) sells two trips the same way: from station `0000096` (trip requirement 10, as trip 1) one ticket per passenger; from station `0000095` (trip requirement 11, as trip 4) one admission per passenger and leg, priced by the leg's share of the travel time, and one ticket per leg. On those bookings a refund scoped within the ticket named is offered.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_REFUND_PAX_2ADT_38` | Two adults, then the last passenger refunded alone (`partialRefundByPax`, `last`): the refund names the ticket that holds that passenger, and only that passenger's parts are refunded. | One ticket per passenger; one refund offer for the second, which becomes `REFUNDED`, the first stays `FULFILLED`. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_LEG_1ADT_38` | A two-leg trip, then the last leg refunded alone (`partialRefundByLeg`, `last`): `bookingPartIds` names that leg's parts. | One admission and one ticket per leg; the refund offer gives back a third of the price (one hour of three) and the first leg's ticket stays `FULFILLED`. | No failed check; the two merged-PDF warnings. |

### Passenger limits (#699)

gamma sells at most 19 passengers in one offer and one booking; a request for more is refused with 400 `VALIDATION_ERROR`. The limit scenarios use passenger lists 19 (19 adults) and 20 (20 adults). In the catalogue their lists are resized at copy time to the provider's own maximum (Test Framework → Passenger Types).

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_MAX_PASSENGERS_38` | Sale for 19 adults, gamma's maximum, every passenger updated after booking. | One offer, booking and ticket for all 19. | No failed check. |
| `SIM_NHF_TOO_MANY_PASSENGERS_38` | Negative test: 20 adults (`passengerLimitExpectRejection`). POST /offers, or else POST /bookings, must refuse them; the scenario ends at the refusal. | POST /offers answers 400 with a Problem. | No failed check; one warning: the Problem has no `pointers`. |
| `SIM_REFUND_PAX_THIRD_19PAX_38` | 19 adults on the trip sold with one ticket per passenger (trip requirement 10), then the last third of them, 7, refunded (`partialRefundPaxSelection: third`): one RefundSpecification per ticket. | Seven refund offers, each confirmed; those seven tickets `REFUNDED`, the other twelve `FULFILLED`. | No failed check; the two merged-PDF warnings. |

### After-sale refusals (#700)

Negative probes sent from the step's own script (the flow of the scenario does not change). gamma refuses a refund or an exchange of a fulfillment that is not valid any more with 409, and answers a second confirmation with the fulfillments it issued the first time.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_NHF_REFUND_AGAIN_38` | A one-way ticket refunded in full; then, at 14, a refund offer asked again for it (`refundAgainProbe`). | 409 `already refunded`, a Problem. | No failed check; one warning: the Problem has no `pointers`. |
| `SIM_NHF_EXCHANGE_REFUNDED_38` | The same refund; then, at 14, an exchange offer asked for the refunded ticket (`exchangeRefundedProbe`). | 409 `only a valid ticket can be exchanged`, a Problem. | No failed check; one warning: the Problem has no `pointers`. |
| `SIM_NHF_CONFIRM_AGAIN_38` | A sale; at 06, POST /fulfillments sent again without an Idempotency-Key (`confirmAgainProbe`). | 200 with the same fulfillments. | No failed check. |

### Names and an empty passenger list (#703)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_ACCENTED_NAMES_38` | Two adults with accented (Czech) and long names (passenger list 21), updated after booking to other accented names; 03 and 04 compare every name read back with the one sent. | The names exactly as sent. | No failed check. |
| `SIM_NHF_NO_PASSENGER_38` | Negative test: POST /offers with an empty `anonymousPassengerSpecifications` list (`emptyPassengersExpectRejection`). | 400 `VALIDATION_ERROR`, a Problem. | No failed check; one warning: the Problem has no `pointers`. |

### Departure dates: the sales horizon and the past (#704)

`gamma` sells trips from station `0000094` up to 90 days ahead
(`salesHorizon` in its profile), never in the past. Only that station, so that
the other scenarios and the simulator's tests, which use fixed dates, keep
their answers whatever the day they run. The scenarios set their own date
with `departureDaysFromToday`.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_AT_SALES_HORIZON_38` | A sale of a departure 90 days from today, the last day of the horizon. | A normal sale. | No failed check. |
| `SIM_NHF_BEYOND_SALES_HORIZON_38` | Negative test: a departure 91 days from today (`departureExpectRejection`). | 200 with no offer and a Problem `SALES_HORIZON_EXCEEDED`. | No failed check. |
| `SIM_NHF_DEPARTURE_IN_PAST_38` | Negative test: a departure yesterday (`departureExpectRejection`). | 400 `DEPARTURE_IN_PAST`, a Problem. | No failed check; one warning: the Problem has no `pointers`. |

### Prices by age (#705)

`gamma` prices trips from station `0000093` by each passenger's age on the
day of travel (`ageTariffs` in its profile): free up to 5 (`YOUNG_CHILD`),
half price up to 14 (`CHILD`), three quarters up to 25 (`YOUTH`), the full
price from 26 (`ADULT`). Each admission names the type in
`appliedPassengerTypes`. Only that station, so that the other scenarios keep
their prices.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_AGE_LIMITS_38` | Three passengers whose dates of birth are worked out from the day of travel (passenger list 22): 14 with the birthday tomorrow (`CHILD`), 15 today (`YOUTH`), 26 today (`ADULT`). The chosen offer must apply each expected type. | Each admission priced and typed by age. | No failed check. |

### Technical cancellation (overrule codes, #596)

`gamma` accepts four overrule codes and refuses any other. A refund with an
accepted code gives everything back, with no fee. The ticket is semi-flexible:
without a code, it would cost a quarter of its price.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_REFUND_OVERRULE_CONNECTION_BROKEN_38` | A refund with overrule code `CONNECTION_BROKEN`: every refund offer has no fee, and together they give back the confirmed price. | One refund offer per ticket, fee 0, the whole price. | No failed check; the two merged-PDF warnings, and two warnings *"Admission part 1 declares refundable=WITH_CONDITION but carries no REFUND afterSalesConditions"*. The simulator does not describe its conditions. |
| `SIM_REFUND_OVERRULE_PAYMENT_FAILURE_38` | As above, with `PAYMENT_FAILURE`. | As above. | As above. |
| `SIM_REFUND_OVERRULE_SALES_STAFF_ERROR_38` | As above, with `SALES_STAFF_ERROR`. | As above. | As above. |
| `SIM_REFUND_OVERRULE_TECHNICAL_FAILURE_38` | As above, with `TECHNICAL_FAILURE`. | As above. | As above. |
| `SIM_REFUND_OVERRULE_REFUSED_38` | Negative test: a refund asked with `STRIKE`, a code gamma does not support, must be refused. The scenario ends at the refund offer request. | `400 OVERRULE_CODE_NOT_SUPPORTED` with a Problem. | No failed check (the refusal is graded); the same four warnings as above. Every provider refuses it since #824 (before, `alpha` accepted any code and this scenario failed there). |
| `SIM_REFUND_COMBINED_OVERRULE_TECHNICAL_FAILURE_38` | As `SIM_REFUND_OVERRULE_TECHNICAL_FAILURE_38`, on a return sold as one offer. | As above. | As `SIM_REFUND_OVERRULE_CONNECTION_BROKEN_38`. |

### Reduction cards (#597)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_CARD_25_1ADT_38` | A passenger with a 25 % card: the card is sent, the chosen offer names it in `appliedPassengerTypes`, and step `01c` (the same request without cards) shows the offer costs 25 % less, the rate the card declares (`percent`, #889). | The card applied: 25 % off, named on the admission. | No failed check. |
| `SIM_SALE_CARD_50_2ADT_38` | Two adults, one with a 50 % card: only that passenger pays less. | 50 % off that passenger's price only. | No failed check. |
| `SIM_SALE_CARD_STUDENT_1YTH_38` | A young traveller with the student card. | 30 % off. | No failed check. |
| `SIM_SALE_CARD_STUDENT_RETURN_1YTH_38` | The student card on a return sold as one offer, one ticket per direction: the card is applied on the outbound and on the return offer, and kept in the booking. | 30 % off, named on the admissions of both directions. | No failed check; the two merged-PDF warnings. |

### Named products (#598)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_PRODUCT_TRAIN_BOUND_1ADT_38` | The offer chosen by its product code `SIM_TRAIN_BOUND`; the booking and each ticket hold that product. | One offer per named product; the train-bound saver is booked. | No failed check. |
| `SIM_SALE_PRODUCT_ALL_DAY_1ADT_38` | The product `SIM_ALL_DAY`, which is not the first fully flexible offer: chosen by its code, not by flexibility. | As above. | No failed check. |
| `SIM_SALE_PRODUCT_FLEXI_SAVER_1ADT_38` | The product named by words of its name, "flexi saver". | As above. | No failed check. |
| `SIM_SALE_PRODUCT_ALL_DAY_RETURN_1ADT_38` | The all-day ticket on a return sold as one offer: the product is chosen on the outbound and on the return offer, and every ticket holds it. | The all-day product offered on both, one ticket per direction. | No failed check; the two merged-PDF warnings. |

### Group tariffs (#599)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_GROUP_WEEKEND_2ADT_2CHD_38` | A COLLECTIVE request for the weekend group product, on a Saturday, for two adults and two children. The chosen offer is one admission for the whole group, naming each passenger's type. Step `01d` compares it with the same request in INDIVIDUAL mode: the group must not cost more. | One COLLECTIVE admission priced as two passengers; one ticket for the whole booking. | No failed check. |
| `SIM_GROUP_WEEKEND_RETURN_1ADT_2CHD_38` | The weekend group as a return in one offer (Saturday out, Sunday back), one ticket for both directions. | One offer covering both trips, one COLLECTIVE admission per direction, one ticket. | No failed check. |
| `SIM_GROUP_6ADT_38` | The group product for six adults, second class: the first passenger at full price, the others reduced. | One COLLECTIVE admission, 60 % for the second and each further passenger. | No failed check. |
| `SIM_GROUP_WEEKEND_6PAX_ABSENT_38` | Negative test: six passengers on a Saturday get no weekend group offer (two to five passengers). The scenario ends after the offer. | Individual offers only, and a `COLLECTIVE_OFFER_NOT_AVAILABLE` Problem saying why. | No failed check (the absence is graded). |
| `SIM_GROUP_WEEKEND_3ADT_ABSENT_38` | Negative test: three adults on a Saturday get no weekend group offer (at most two passengers aged 15 or more). | As above. | No failed check. |

### Travel class per leg (#600)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_CLASS_PER_LEG_1ADT_38` | Trip 4: first class on the InterCity leg, second class on the regional leg, which has no first class. The request asks for both classes, the chosen offer gives each leg its class, and so does the booking. | A second-class admission for the whole trip, plus a first-class upgrade part on the InterCity leg. | No failed check. |
| `SIM_SALE_CLASS_PER_LEG_NOT_OFFERED_1ADT_38` | Trip 4 again, asking first class on the regional leg, which has none (#762). No offer gives each leg its class: the offer step says so in a warning, and the sale goes on with the offer chosen as usual. The booking is held to the classes of that offer. | The same offers as for `SIM_SALE_CLASS_PER_LEG_1ADT_38`: none gives first class on the regional leg. | No failed check; one warning: no offer gives each leg its class. |
| `SIM_SALE_SEAT_PREFERENCE_1ADT_38` | Trip 15: a SuperCity from station 0000092, where gamma's reservations offer seat preferences (#766). The booking asks for a window seat (`placePreferences` `WINDOW`, flow AUTOMATIC_PLACE_SELECTION) in `placeSelections[].accommodations[].placeProperties`. | The reservation part lists the two flows, the preferences (`availablePlacePreferences`) and the same codes in `availablePlaces`; the booked place names `WINDOW`. | No failed check, no warning. |
| `SIM_SALE_SEAT_PREFERENCES_FLOW_2ADT_38` | Trip 15, flow AUTOMATIC_PLACE_SELECTION_PREFERENCES, asking `WINDOW`, `TABLE` and `UPPER_DECK` (#766). GET /availabilities/preferences is asked before the booking. | `UPPER_DECK` is not among the preferences offered; `TABLE` is offered but sold out, so the availability leaves it out; the booked place names `WINDOW`. | No failed check; two warnings: `UPPER_DECK` not listed by the offer, `TABLE` no longer available. Neither is asked. |
| `SIM_SALE_NAMED_PLACE_2ADT_38` | Trip 16: a SuperCity from station 0000091, whose coach gamma shows on the place map (#766). Flow MANUAL_PLACE_SELECTION_WITHOUT_FEE: `POST /availabilities/vehicle-place-map` before the booking, two free seats without fee named in `placeSelections[].places`. | Coach 7: seats 11–30 (11 and 12 taken, 21–24 with a selection fee), compartment C1 (61–64) booked as a whole. The booking gives the seats named, at the offer's price. | No failed check, no warning. |
| `SIM_SALE_NAMED_PLACE_FEE_1ADT_38` | Trip 16, flow MANUAL_PLACE_SELECTION_WITH_FEE: a seat with a selection fee is named. | The booked reservation costs the offer's price plus the fee. | No failed check, no warning. |
| `SIM_SALE_NAMED_COMPARTMENT_2ADT_38` | Trip 16, flow MANUAL_PLACE_SELECTION_WITHOUT_FEE, `namedPlaceKind` `COMPARTMENT`: compartment C1 named in `placeSelections[].compartments`. | The booking gives compartment C1, seats 61–64. | No failed check, no warning. |
| `SIM_SALE_NEARBY_PLACE_2ADT_38` | Trip 16, flow AUTOMATIC_PLACE_SELECTION_NEARBY, `referencePlace` `7/15` (#766): `GET /availabilities/nearby` for place 15 of coach 7 before the booking, which sends it in `placeSelections[].referencePlace`. | The free seats near place 15 are counted; the booking gives the next free seats after it, in coach 7. | No failed check, no warning. |
| `SIM_SALE_NAMED_PLACE_ADD_LATER_2ADT_38` | Trip 17: a EuroCity from station 0000091 (optional reservation, place map), `reservationBookingForm` `ADD_LATER`, flow MANUAL_PLACE_SELECTION_WITHOUT_FEE (#766). Step 09 asks `POST /availabilities/vehicle-place-map` in the BOOKING context, then names two free seats in the offer-parts request. | The map of coach 7 for the booking's reservation; the reservation added gives the seats named, at the offer's price. | No failed check; one warning at 02, as for `SIM_SALE_RESERVATION_ADD_LATER_2ADT_38`: the optional reservation is not in the booking yet. |
| `SIM_SALE_NEARBY_PLACE_ADD_LATER_2ADT_38` | Trip 17, `ADD_LATER`, flow AUTOMATIC_PLACE_SELECTION_NEARBY, `referencePlace` `7/15` (#766). Step 09 asks `GET /availabilities/nearby` in the BOOKING context, then sends the reference place in the offer-parts request. | The free seats near place 15 are counted; the reservation added gives the next free seats after it, in coach 7. | No failed check; one warning at 02, as for `SIM_SALE_RESERVATION_ADD_LATER_2ADT_38`: the optional reservation is not in the booking yet. |
| `SIM_SALE_SEAT_PREFERENCES_ADD_LATER_2ADT_38` | Trip 18: a EuroCity from station 0000092 (optional reservation, seat preferences), `ADD_LATER`, flow AUTOMATIC_PLACE_SELECTION_PREFERENCES asking `WINDOW` (#766). Step 09 asks `GET /availabilities/preferences` in the BOOKING context, then sends the preference in the offer-parts request. | `WINDOW` is available; the reservation added gives a place naming it. | No failed check; one warning at 02, as for `SIM_SALE_RESERVATION_ADD_LATER_2ADT_38`: the optional reservation is not in the booking yet. |
| `SIM_SALE_NEARBY_PLACE_AUTO_2ADT_38` | Trip 16, flow AUTOMATIC_PLACE_SELECTION_NEARBY, `referencePlace` `AUTO` (#776): before the booking, the offers are asked again for the first passenger alone and that passenger is booked with the reservation; the place given is the reference place. `GET /availabilities/nearby` is asked for it, the booking sends it in `placeSelections[].referencePlace`, and the first booking is deleted after the booking is answered. | The first booking gets the first free saloon seat of coach 7; the booking gives the next free seats after it, in coach 7; `DELETE /bookings/{id}` answers 204. | No failed check, no warning. |
| `SIM_SALE_NEARBY_PLACE_AUTO_1ADT_38` | The same for one passenger (#776): the first booking and the scenario's booking are for the same passenger. | As above, one seat. | No failed check, no warning. |
| `SIM_SALE_NEARBY_PLACE_AUTO_ADD_LATER_2ADT_38` | Trip 17, `ADD_LATER`, `referencePlace` `AUTO` (#776): the first booking is made before step 09, for the reservation added after the booking, and deleted once 09 is answered. | As for `SIM_SALE_NEARBY_PLACE_ADD_LATER_2ADT_38`, near the first booking's seat. | No failed check; one warning at 02, as for `SIM_SALE_RESERVATION_ADD_LATER_2ADT_38`: the optional reservation is not in the booking yet. |

### Offer search probes (#780)

Each asks for offers with one option of the offer search criteria alone (`offerSearchProbe` on) and ends after the offer: no offer keeping to the option, or the provider saying it ignored it, fails. Gamma keeps to the travel classes, flexibilities and offer mode asked, gives service class `HIGH` in first class and `STANDARD` in second (`BEST` and `BASIC` are not sold), and sells nothing without an admission. The catalogue makes one such scenario per option value a Test Framework declares, from the first one.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_OFFER_PROBE_TRAVEL_CLASS_FIRST_38` | `travelClasses` `FIRST`. | First-class offers only. | No failed check. |
| `SIM_OFFER_PROBE_SERVICE_CLASS_HIGH_38` | `serviceClassTypes` `HIGH`. | First-class offers, whose service class is `HIGH`. | No failed check. |
| `SIM_OFFER_PROBE_FLEXIBILITY_NON_FLEXIBLE_38` | `flexibilities` `NON_FLEXIBLE`, the flexibility the scenario chooses too. | Non-flexible offers only. | No failed check. |
| `SIM_OFFER_PROBE_OFFER_PARTS_ADMISSION_38` | `requestedOfferParts` `ADMISSION`. | The usual offers: admissions, with their reservation where the train has one. | No failed check. |
| `SIM_OFFER_PROBE_OFFER_MODE_INDIVIDUAL_38` | `offerMode` `INDIVIDUAL`. | Individual offers. | No failed check. |
| `SIM_OFFER_PROBE_COMBINATION_38` | Three options together (#780 part 3): `travelClasses` `FIRST`, `offerMode` `INDIVIDUAL`, `requestedOfferParts` `ADMISSION`; the source of the catalogue's random combinations. | First-class individual offers. | No failed check. |
| `SIM_OFFER_PROBE_PRODUCT_TAG_ADMISSION_POINT2POINT_38` | `productTags` `ADMISSION_POINT2POINT` (#780 PR A). | The usual offers, each product tagged by its type (`productTags`). | No failed check. |
| `SIM_OFFER_PROBE_PRODUCT_SELECTION_TAG_38` | `productSelections` with `productTag` `ADMISSION_POINT2POINT`. | The offers holding a product of that tag: all of them. | No failed check. |
| `SIM_TRIP_PROBE_VIA_38` | Trip search probe (#780 PR B): a via, station `0000050`, 15 minutes (trip 20). | One trip in two legs, changing at `0000050` 15 minutes after arriving. | No failed check. |
| `SIM_TRIP_PROBE_TRANSFER_LIMIT_0_38` | `transferLimit` 0 and `numberOfResults` 1 (trip 21). | One direct trip. | No failed check. |
| `SIM_TRIP_PROBE_NOT_VIA_38` | `notVias` station `0000050` (trip 22). | One direct trip, which does not pass it. | No failed check. |
| `SIM_OFFER_PROBE_NOT_DECLARED_38` | Undeclared option probe (#780 PR C): `serviceClassTypes` `BEST`, `offerOptionExpectRejection` on. | No offer: gamma sells no BEST class. | No failed check. |

### Currencies (#781)

Gamma sells in its own currency, CZK, and in EUR (profile `otherCurrencies`, at a 24th of the CZK price). Without a currency asked, it answers in CZK. A sale keeps its currency through the booking, the refund and the exchange. A currency it does not sell is refused with `400 CURRENCY_NOT_SUPPORTED`. Since #824 alpha and beta do the same with a second currency each: alpha sells EUR and CHF, beta CHF and EUR; on both a CHF price is 1.25 times the EUR one.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_CURRENCY_EUR_REFUND_RETURN_1ADT_38` | A return asked in EUR, booked, confirmed and refunded in full. | Offers, booking and refund offers in EUR. | No failed check. |
| `SIM_CURRENCY_EUR_EXCHANGE_1ADT_38` | A one-way ticket asked in EUR and exchanged; the exchange request carries the sale's criteria, EUR included. | Offers, booking and exchange offers in EUR. | No failed check. |
| `SIM_CURRENCY_DEFAULT_1ADT_38` | No currency asked; the scenario expects the default, CZK (`expectedCurrency`). | Offers in CZK. | No failed check. |
| `SIM_NHF_CURRENCY_NOT_SOLD_38` | Negative test: offers asked in USD (`currencyExpectRejection`). | `400 CURRENCY_NOT_SUPPORTED`, a Problem. | No failed check; the scenario ends after the offer. |

### Seat reservations (#601)

On trip 5, the SuperCity reservation is mandatory and the EuroCity one is
optional. Each is one reservation for all the passengers, on one leg.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_RESERVATION_MANDATORY_2ADT_38` | The mandatory reservation is read from the admission's relation (`minGroupItemsToBeBooked` 1) and booked without being asked. The booking holds it, with its coach and seats. | The mandatory reservation booked, with a coach and one seat per passenger. | No failed check; three warnings *"No booked reservation found for offer reservation[1] … it may be an optional part that was not selected"*, one at each read of the booking (02, 05, 07): the optional EuroCity one, which this scenario does not book. |
| `SIM_SALE_RESERVATION_SELECTION_2ADT_38` | The optional reservation booked too, by `optionalReservationSelections`. | Both reservations booked. | No failed check. |
| `SIM_SALE_RESERVATION_PLACE_SELECTION_2ADT_38` | The reservations booked by `placeSelections` naming the trip and the leg. | Both booked; a place selection naming the wrong leg would be refused. | No failed check. |
| `SIM_SALE_RESERVATION_ADD_LATER_2ADT_38` | The optional reservation added after the booking, by `POST …/booked-offers/{id}/offer-parts` (step 09). | The mandatory one at booking, the optional one added to the pre-booked booking. | No failed check; one warning *"No booked reservation found for offer reservation[1]"*. It comes from the booking step (02), before step 09 adds the reservation; step 09 then checks that it was added. |

### Offers by trip id (#602) and the train filter (#722)

`POST /trips-collection` answers four departures for trip 1 (07:30, 08:00,
09:00, 10:00), each with a train of its own.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_BY_TRIP_ID_1ADT_38` | Step 01 asks the trips first and takes the first leaving at the time asked or later (08:00, not the 07:30 listed first). It then asks the offers with `tripIds`, and every offer must cover that trip. | The four departures; offers for the trip named. | No failed check. |
| `SIM_SALE_BY_TRIP_ID_TRAIN_1ADT_38` | Trip 6 names train 1854, the 09:00 departure and the third trip of the answer: the trip of that train is taken. | As above; the booking is on the 09:00 train. | No failed check. |
| `SIM_SALE_BY_TRIP_ID_UNKNOWN_38` | Negative test: `POST /offers` names a trip id the provider never gave and must be refused. The scenario ends there. | `400 VALIDATION_ERROR` with a Problem naming `tripIds`. | No failed check (the refusal is graded). |
| `SIM_SALE_SEARCH_TRAIN_FILTER_1ADT_38` | Trip 14 turns the train filter on (Trip Search Criteria, #722): `POST /offers` carries train 4711 in `parameters.dataFilter.vehicleFilter`, and the answer must hold a trip of that train. Every other search goes by place and time only. | One trip, of train 4711. | No failed check. |

### Fulfilment documents and refund receipt (#603)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_DOCUMENTS_RETURN_1ADT_38` | A return whose offers ask for `PDF_A4` and `RETAILER_APP`. The booking delivers both media; each document's format fits its medium and its content is that format; there is one PNG per ticket. Step 06b reads each ticket with `GET /fulfillments/{id}`. | In the 3.8 shape: one PDF for the whole booking and one PNG per ticket, in the booking's `fulfillmentDocuments`, each ticket naming its documents in `fulfillmentDocumentRefs`. `GET /fulfillments/{id}` gives the ticket and its two documents, with a `DOCUMENT_COVERS_MORE_FULFILLMENTS` Problem for the merged PDF. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_RECEIPT_RETURN_1ADT_38` | The same booking, refunded in full. The scenario waits for the refund receipt (`refundReceiptMaxWaitMinutes` 2): step 14b reads the booking every 15 seconds until a document of type INFORMATION appears. | The receipt (`PDF_A4`, type INFORMATION) appears in the booking 30 seconds after the refund, and only in `GET /bookings/{id}`. | No failed check; the receipt found after about 30 s; the two merged-PDF warnings. If the receipt does not come within the 2 minutes, the receipt check fails. |
| `SIM_REFUND_COMBINED_RECEIPT_1ADT_38` | As above, on a return sold as one offer. | As above. | As above. |

### Idempotency-Key (#604)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_IDEMPOTENCY_1ADT_38` | `POST /bookings` and `POST /bookings/{id}/fulfillments` carry an `Idempotency-Key`. Steps 02 and 06 send each again with the same key: the same booking, or the same fulfillments, must come back. Step 02 also sends the booking with another key, which must give a new booking. | gamma (profile `idempotency`) keeps each answer per client and key, as it was when first given, and gives it again. The same key with another body is `409 IDEMPOTENCY_KEY_REUSED`. A booking made with a new key is left pre-booked. | No failed check. |

### Exchange (#611)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_EXCHANGE_1ADT_38` | The `04-Exchange` folder end to end on a one-way ticket: exchange offers for the same journey (10), one taken (11), read (12), the booking during the exchange (13), the exchange confirmed (14), the booking after it (15). | gamma (profile `exchange`) gives one exchange offer per offer of the request, priced against the ticket given up: `exchangeFee` by its exchangeability (none when fully flexible), `amountToBePaid` = new price + fee − price given up (else `refundableAmount`). The operation is `PREBOOKED` and the parts `EXCHANGE_ONGOING`; `POST /fulfillments` confirms it: the old part and fulfillment `EXCHANGED`, a new booked offer and fulfillment `FULFILLED`. | No failed check. |
| `SIM_EXCHANGE_DELETE_1ADT_38` | The same exchange, withdrawn before its confirmation (`scenarioAction` DELETE: 16. DEL, then 17). | `DELETE` of the pre-booked operation answers 204 and the parts go back to `FULFILLED`. A confirmed exchange cannot be withdrawn (409). | No failed check. |

### Expiry probes (#611)

These five are negative probes: each waits until a deadline has passed and expects the next request to be refused. They use the trip from station `0000099`, where gamma (profile `shortDeadlines`) makes offers, the booking, refund offers and exchange offers expire after 60 seconds instead of 30 minutes; each scenario waits at most 3 minutes. A run takes a little over a minute each.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_NHF_EXPIRED_OFFER_38` | `expiredOfferTest`: step 02 waits until past the chosen offer's `preBookableUntil`, then books it. | `409 OFFER_EXPIRED`, a Problem. | No failed check: the refusal (4xx) and its Problem body are graded as passing. The scenario ends there. |
| `SIM_NHF_EXPIRED_BOOKING_38` | `expiredBookingTest`: step 06 waits until past the booking's confirmation time limit, then confirms it; 07 reads the booking. | `409 BOOKING_EXPIRED`; the booking read afterwards has its parts `RELEASED`. | No failed check. |
| `SIM_NHF_EXPIRED_REFUND_OFFER_38` | `expiredRefundOfferTest`: a one-way ticket, refund offer asked for; step 13 waits until past its `validUntil`, then confirms it. | `409`, "the refund offer has expired". | No failed check. |
| `SIM_NHF_EXPIRED_CHAIN_SEATMAP_38` | `expiredBookingTest` then `expiredRefundOfferTest` in one scenario (#652): each sub-run sells again, and seat selection is asked for on an offer that has no reservation part. | As the two scenarios above, in turn. | No failed check: two sales, the booking refused at 06, the refund offer refused at 13. Before #652 the run went from 01 straight to `10. POST Refund Offers` with no booking (404). One warning per sale (#766): the offer chosen has no reservation part, so the place choice is not tested. |
| `SIM_NHF_EXPIRED_EXCHANGE_OFFER_38` | `expiredExchangeOfferTest`: a one-way ticket, exchange offers asked for; step 11 waits until past the first one's `preBookableUntil`, then takes it. | `409 OFFER_EXPIRED`. | No failed check. |

### Response variants (#611)

A variant is chosen by a passenger's last name at booking time: `Simvariant-<name>` (passenger lists 11 to 18). It holds for the life of the booking. Every provider (profile `variants`).

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_VARIANT_PER_PASSENGER_2ADT_38` | A sale for two passengers with variant `per-passenger`. | One fulfillment per passenger, and one PDF for the booking. | No failed check; the two merged-PDF warnings. |
| `SIM_VARIANT_PER_PASSENGER_REFUND_PAX_2ADT_38` | The same booking, then the last passenger refunded alone (`partialRefundByPax`, `last`). The refund must name the fulfillment that holds that passenger (#610). | With this variant, a refund scoped by `passengerIds` or `bookingPartIds` within one fulfillment is offered; it refunds those parts, and the fulfillment is `REFUNDED` once all its parts are. | No failed check; the two merged-PDF warnings. The log shows "Partial refund resolved: fulfillmentId=…" naming the second fulfillment. |
| `SIM_VARIANT_REORDERED_2ADT_38` | Variant `reordered`: booked parts and passengers in the reverse order of the offer (#550). | The admissions of each booked offer and the booking's passengers reversed. | No failed check; three WARNINGs that the passengers were re-aligned by externalRef. |
| `SIM_VARIANT_MINIMAL_2ADT_38` | Variant `minimal`: optional members left out. | No `bookingCode`, no `summary` on the booked offers and parts. | No failed check. |
| `SIM_VARIANT_MAIN_PASSENGER_2ADT_38` | Variants `main-passenger-only` and `main-names-only` (passenger list 18), as with some providers: the scenario updates the main passenger only (`passengerUpdateScope` `MAIN`) and reads both back. | A PATCH of another passenger than the first is `400 BOOKING_PASSENGER_PROPERTY_NOT_MODIFIABLE`; only the main passenger's names are kept, no date of birth and no contact. | No failed check; eleven warnings "… not returned by the provider": date of birth, phone and email of the main passenger (each at 03 and at 04), and first name, last name, date of birth, phone and email of the other. Without `passengerUpdateScope` `MAIN`, the PATCH of the second passenger fails, as it would on such a provider. |
| `SIM_VARIANT_IGNORES_PREFERENCES_1ADT_38` | Variant `ignores-place-preferences` (passenger list 23) on trip 15, asking a window seat (#766). | The booking gives the seat without the preference asked. | No failed check; one warning at 07: the reservation does not give the seat preference asked. |
| `SIM_VARIANT_IGNORES_REFERENCE_1ADT_38` | Variant `ignores-reference-place` (passenger list 25) on trip 16, near place `7/15` (#766). | The booking gives the seat in coach 8, not near the reference place. | No failed check; one warning at 07: the reservation is not in the reference place's coach. |
| `SIM_VARIANT_REFUSES_BARE_PLACE_SELECTION_1ADT_38` | Variant `refuses-bare-place-selection` (passenger list 26) on trip 5, the SuperCity with a mandatory reservation, with `mandatoryReservationForm` NONE (#793): the mandatory reservation is named nowhere in the booking request. | The variant refuses a placeSelection asking nothing; the booking, which names none, holds the mandatory reservation. | No failed check; the warnings of `SIM_SALE_RESERVATION_MANDATORY_2ADT_38` about the optional EuroCity reservation, which this scenario does not book. |
| `SIM_VARIANT_ONE_FULFILLMENT_PER_REFUND_1ADT_38` | Variant `one-fulfillment-per-refund-request` (passenger list 27) on the full refund of a return sold as one offer, one ticket per direction (#883). | The variant refuses the refund offer request naming both tickets with 501 `VALUE_NOT_SUPPORTED` and answers one refund offer to a request naming one ticket. | No failed check; the two merged-PDF warnings of `SIM_REFUND_COMBINED_RETURN_1ADT_38`, and one at step 10: the provider refuses a list of fulfillments, so the refund offers are asked one ticket at a time (two more checks, one per request). |

### Fares (#903)

Fare offers for a requested section (fares phase 1a). The trip is trip 24, a specification of the whole trip (InterCity 0000001 to 0000004, regional 0000004 to 0000002), sent with `isPartOfInternationalTrip: true` and `requestedOfferParts` `FARE_ADMISSION`. The section starts at the border station 0000004. Asked for fares with a section, gamma (`fares` in its profile) answers its product offers and one fare offer per cluster (FULL_FLEX, SEMI_FLEX, NON_FLEX, model CLUSTERING), each with one fare per passenger. Each wrong variant is chosen by the station its section starts at (`fares.variants`), since offers are anonymous. Every fare scenario ends after the offer step: booking a fare is #906.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_FARE_SPEC_1ADT_38` | Fares for one adult on a trip specification with a requested section; the semi-flexible fare offer is chosen (`desiredFareCluster`). | Three fare offers next to the product offers; each fare has its regional constraint (entry connection point, route), validity, after-sales conditions, TCOs and covered section. | No failed check and no fare warning; the scenario ends at 01 with the fare offer chosen. |
| `SIM_FARE_SPEC_FREE_CHILD_38` | The same for an adult and a child aged 3 on the day of travel (passenger list 29). | The child's fare is priced 0. | No failed check: every passenger has a fare, the free one included. |
| `SIM_FARE_SRCH_1ADT_38` | Fares asked with search criteria (#904): a search from 0000001 to 0000002, the section the whole trip; the non-flexible fare offer is chosen. | The same fare offers, for the trip the search gives. | No failed check and no fare warning; the scenario ends at 01. |
| `SIM_FARE_TRIPIDS_1ADT_38` | Fares asked by trip id (#904): `POST /trips-collection`, then the offers for the trip chosen, by its id, with the section. | The same fare offers, valid on that trip's day. | No failed check and no fare warning; the trip id checks pass; the scenario ends at 01. |
| `SIM_WRONG_FARE_PASSENGER_WITHOUT_FARE_38` | Two adults; section from station 0000080. Deliberately wrong. | The second passenger has no fare. | Check O7 fails at 01. |
| `SIM_WRONG_FARE_UNKNOWN_CLUSTER_38` | Section from station 0000081. Deliberately wrong. | Reference cluster `GOLD`. | A WARNING of check O10 at 01; no failed check. |
| `SIM_WRONG_FARE_WIDER_CLUSTERS_38` | Section from station 0000082. Deliberately wrong. | Every fare allows all five clusters. | A WARNING of check O11 at 01; no failed check. |
| `SIM_WRONG_FARE_SECTION_GAP_38` | Section from station 0000083. Deliberately wrong. | The fares stop at station 0000079, short of the section's end. | Check O8 (gap) fails at 01. |
| `SIM_WRONG_FARE_OVERLAP_38` | Section from station 0000084. Deliberately wrong. | Two fares per passenger, the second over the start of the section again. | A WARNING of check O8 (overlap) at 01; no failed check. |
| `SIM_WRONG_FARE_UNREQUESTED_38` | `ADMISSION` asked, section from station 0000085. Deliberately wrong. | Fare offers added to the product offers. | Check O14 fails at 01; the sale goes on with the product offers. |

**Negative fare requests (#905).** Each of these sets `expectFares: false`: the answer must hold no fare. OSDM gives fares only when the offer part type list asks for them (N1); what a provider answers to a fare request without a section, on a domestic trip, is the Test Manager's expectation, not an OSDM rule (#242 D4). A scenario that expects no fare ends after the offer step, unless it books a product (`bookMode` PRODUCT). The case of a section equal to the whole trip (#244 case 2) waits for OTST's answer (#242 D5).

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_NHF_FARE_UNASKED_38` | N1: trip 24 with the section from 0000004, `ADMISSION` asked only. | Product offers only. | Check O14 passes; no failed check; the scenario ends at 01. |
| `SIM_NHF_FARE_NO_SECTION_SRCH_38` | N2 and #207: a domestic search from 0000001 to 0000002, `ADMISSION` and `FARE_ADMISSION` asked, no section; `bookMode` PRODUCT. | Product offers only. | Check N passes; the sale goes on with a product offer, booked and fulfilled; no failed check. |
| `SIM_NHF_FARE_NO_SECTION_SPEC_38` | N2: trip 24 sent as domestic (`isPartOfInternationalTrip: false`), `FARE_ADMISSION` asked, no section. | Product offers, and `FARE_ADMISSION` alone reported as ignored (`PARAMETER_NOT_SUPPORTED`). | Check N passes; no failed check; the scenario ends at 01. |
| `SIM_NHF_FARE_EMPTY_SECTIONS_38` | N4: trip 24, `FARE_ADMISSION` asked, `requestedSections` sent as an empty list. | As above: an empty list names no section. | Check N passes; no failed check; the scenario ends at 01. |
| `SIM_WRONG_FARE_WITHOUT_SECTION_38` | `FARE_ADMISSION` asked without a section on trip 31, from station 0000086 (`fares.variants.faresWithoutSection`). Deliberately wrong. | Fare offers for the whole trip all the same. | Check N fails at 01; the scenario ends there. |

### Deliberately wrong answers (#611)

Each of these makes one validator family fail on purpose, so that its FAIL path runs. They are not in the data file's run list. The offer one uses the trip from station `0000098` (`variants.wrongOffersFrom`); the others a passenger list naming the variant.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_WRONG_OFFER_PRICE_38` | Offers. | `offerSummary.minimalPrice` one cent above the sum of the parts. | Fails: "provisionalPrice is not below the offer's minimalPrice", at 02 and 05 (2 failed checks). |
| `SIM_WRONG_BOOKING_PRICE_38` | Booking. | `provisionalPrice` one cent above the sum of the parts. | **No check fails: known gap.** The collection does not compare `provisionalPrice` with the parts. When such a check is added, this scenario must start failing. |
| `SIM_WRONG_FULFILLMENT_STATUS_38` | Fulfillments. | The fulfillments issued say `AVAILABLE`. | Fails: "Fulfillment[0] status comparison", at 06 and 07 (2 failed checks). |
| `SIM_WRONG_REFUND_AMOUNT_38` | Refund. | `refundableAmount` one cent above its breakdown. | Fails: "Refund response bounds", at 10 and 11 (2 failed checks). |
| `SIM_WRONG_EXCHANGE_AMOUNT_38` | Exchange. | `amountToBePaid` one cent off `exchangePrice + exchangeFee − price given up`. | Fails: "amountToBePaid = exchangePrice + exchangeFee - confirmedPrice", for both exchange offers at 10 and for the chosen one at 11 and 12 (4 failed checks). |
| `SIM_WRONG_NAMED_PLACE_38` | Variant `gives-other-place` (passenger list 24) on trip 16, a free seat named (#766). Deliberately wrong. | The booking gives the next seat instead of the one named. | One failed check at 07: the booked reservation does not give the place named. |
| `SIM_WRONG_OFFER_PROBE_IGNORED_38` | Offer search probe (#780), first class asked from station `0000090` (`variants.ignoresOfferOptionsFrom`, trip 19). | The offer search criteria are ignored: second class only. | One failed check at 01: no offer keeps to the travel class asked. |
| `SIM_WRONG_OFFER_PROBE_RESERVATION_ONLY_38` | Offer search probe (#780), reservations only asked (`requestedOfferParts` `RESERVATION`). | Gamma sells nothing without an admission: the usual offers, and a `PARAMETER_NOT_SUPPORTED` problem naming `offerSearchCriteria.requestedOfferParts`. | One failed check at 01: the provider says it ignored the option. |
| `SIM_WRONG_OFFER_PROBE_PRODUCT_TAG_PASS_38` | Offer search probe (#780 PR A), passes asked (`productTags` `ADMISSION_PASS`). | Gamma sells no pass: the usual offers, and a `PARAMETER_NOT_SUPPORTED` problem naming `offerSearchCriteria.productTags`. | One failed check at 01: the provider says it ignored the option. |
| `SIM_WRONG_TRIP_PROBE_VIA_TRANSFER_LIMIT_38` | Trip search probe (#780 PR B), a via and `transferLimit` 0 together (trip 23). | Gamma honours the via: one trip with one transfer. | One failed check at 01: the trip does not keep to the transfer limit. |
| `SIM_WRONG_OFFER_PROBE_NOT_DECLARED_SOLD_38` | Undeclared option probe (#780 PR C) asking `travelClasses` `FIRST`, which gamma sells. | First-class offers only. | One failed check at 01: every offer keeps to the value, so the Test Framework should declare it. |
| `SIM_WRONG_CURRENCY_DEFAULT_38` | No currency asked; the scenario expects EUR as the default (`expectedCurrency`). Deliberately wrong. | Offers in gamma's default, CZK. | One failed check at 01: the offers are not in the currency expected. |
| `SIM_WRONG_CARD_RATE_38` | The 25 % card is declared as taking 30 % off (`percent: 30` on the passenger's card). Deliberately wrong. | The card applied: 25 % off. | One failed check at 01c: the price with the card is not 30 % below the price without it. |

### Injected faults (#833)

Each of these scenarios asks gamma for one fault of the simulator's catalogue
(`simulatorFaults`, sent as the header `X-Simulator-Faults`; `src/osdm/faults.js`
lists them with what OSCAR must report). The fault changes only what the
caller is told, never the booking stored. They fail on purpose and stay out
of the run list. The error faults are seen on the purchaser probe
(`bookingPurchaserMode` `invalid`), which is where a sale is refused.

| Scenario | Fault | What the simulator answers | Expected result |
|---|---|---|---|
| `SIM_FAULT_OFFER_PRICE_BELOW_PARTS_38` | `offer.price-below-parts` | Each offer's `minimalPrice` one unit below the sum of its admissions. | One failed check at 01: "Offer minimalPrice >= sum of admission parts price". |
| `SIM_FAULT_OFFER_TRIP_UNKNOWN_38` | `offer.trip-unknown` | Each offer covers a trip id the answer does not have. | Two failed checks at 01: the selected offer's trip is not among the answer's trips. |
| `SIM_FAULT_BOOKING_CURRENCY_CHANGED_38` | `booking.currency-changed` | The new booking's `provisionalPrice` in EUR, the offer in CZK. | Two failed checks at 02: the currency, and the price compared with the offer's. |
| `SIM_FAULT_BOOKING_PASSENGER_DROPPED_38` | `booking.passenger-dropped` | Two passengers booked (list 2); the answer gives one. | One failed check: the number of passengers at 02. Steps 03 and 04 leave out the passenger the answer lacks, with one WARNING each (#881), and the sale goes on. |
| `SIM_FAULT_BOOKING_NOT_PREBOOKED_38` | `booking.not-prebooked` | The new booking's admissions say `CONFIRMED`. | One failed check at 02: "Status is PREBOOKED for admission[0]". |
| `SIM_FAULT_PASSENGER_NAME_ALTERED_38` | `passenger.name-altered` | The passenger update answers the last name with `-X` added. | One failed check at 03: "Last name is correct". |
| `SIM_FAULT_FULFILLMENT_WRONG_STATUS_38` | `fulfillment.wrong-status` | The confirmation gives fulfilments `REFUNDED`. | One failed check at 06: "Fulfillment[0] status comparison". |
| `SIM_FAULT_ANSWER_HTML_38` | `answer.html` | Every booking read answers HTTP 200 with an HTML "Request Rejected" page. | Two failed checks at 05 (Content-Type, "The answer is a JSON object"), and the scenario stops there. |
| `SIM_FAULT_REFUND_AMOUNT_ABOVE_PAID_38` | `refund.amount-above-paid` | Each refund offer gives back ten times its amount. | Three failed checks: "Refund response bounds" for both refund offers at 10, and at 13 the confirmed amount is not the one proposed. |
| `SIM_FAULT_REFUND_NOT_REFUNDED_38` | `refund.not-refunded` | After the refund, the booking read gives its fulfilments and parts `FULFILLED`. | Nine failed checks at 14: each fulfilment and admission is not REFUNDED. |
| `SIM_FAULT_ERROR_PROBLEM_WITHOUT_CODE_38` | `error.problem-without-code` | The purchaser probe's refusals (400) leave out `code`. | No failed check; four WARNINGs at 14: the refusal names no OSDM problem code. |
| `SIM_FAULT_ERROR_SERVER_ERROR_FOR_REFUSAL_38` | `error.server-error-for-refusal` | The purchaser probe's refusals come as HTTP 500. | Two failed checks at 14: the provider rejects with a client error (4xx). |

### Requested information and purchaser (#611)

gamma (profile `personChecks`) checks passenger and purchaser data when they are updated: a gender outside `MALE`, `FEMALE`, `X`, a date of birth that is no date, an e-mail or phone number of the wrong form, or an empty name is a `400` Problem naming the field, with a pointer. A purchaser written must have a first and a last name. The offers of a trip from station `0000097` (trip requirement 9) ask for each passenger's date of birth and phone number (`requestedInformation`), and so does the booking while one is missing.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_RI_AUTOFEED_1ADT_38` | Offers with `requestedInformation`; the collection checks the expression and supplies what is demanded. | `passengerSpecifications[ANY].dateOfBirth AND passengerSpecifications[ANY].detail.contact.phoneNumber` on each admission. | No failed check; the log says the demand is already met by the scenario's passenger data. |
| `SIM_NHF_RI_OMIT_1ADT_38` | `requestedInformationProbe` omit: a demanded field withheld from the passenger update. | `400 INVALID_PERSON_DATA` naming the field. | No failed check: the refusal is graded as passing; the run ends at step 03. |
| `SIM_NHF_RI_INVALID_1ADT_38` | `requestedInformationProbe` invalid: the passenger update sent six times, one field invalid each time (gender, date of birth, first and last name, e-mail, phone). | Each refused with `400`, the field named. | No failed check: six refusals graded. |
| `SIM_PURCHASER_DEFERRED_1ADT_38` | `bookingPurchaserMode` deferred: the booking made without its purchaser, which is then written (steps 12, 14). | A booking made without a purchaser has none: `GET …/purchaser` is `404`, `POST` creates it. | No failed check. |
| `SIM_NHF_PURCHASER_INVALID_1ADT_38` | `bookingPurchaserMode` invalid: the purchaser written four times, one field missing or invalid each time. | Each refused with `400`, the field named. | No failed check: four refusals graded. |
| `SIM_NHF_PURCHASER_INVALID_AT_BOOKING_1ADT_38` | `bookingPurchaserMode` invalid_at_booking (#899): the booking sent four times with the purchaser, one field missing or invalid each time, then once with the valid purchaser. What OSCAR runs instead of the probe above when the Test Framework says the provider takes no purchaser after the booking. | Each refused with `400`, the field named under `/purchaser/detail`; the last booking is made. | No failed check: four refusals graded, then the sale. |

