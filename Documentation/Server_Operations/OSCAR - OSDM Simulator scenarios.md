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
  (3.7.0), `_38` → `gamma` (3.8.0). Every new function is on `gamma` only.
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

- **`06b. GET Fulfillment`** reads each ticket of the booking.
  - `gamma` answers it.
  - `alpha` and `beta` answer `501`, which is reported as "not implemented by
    this provider": a passing row, not a failure.
- **On `alpha` and `beta`:** one warning, *"the PDF_A4 medium asked for is
  delivered — 0 document(s)"*. These two providers issue no documents.
- **On `gamma`:**
  - Every booking gets its documents: one PDF for the whole booking, plus a
    PNG per ticket when the scenario asks for `RETAILER_APP`.
  - A booking with two tickets (a return) therefore shows two warnings at
    06b, one per ticket: *"document … covers this fulfillment only — it also
    holds …"*. That is the merged PDF, as ČD delivers it.

## alpha — OSDM 3.6.0

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_SEARCH_1ADT_36` | A sale by search criteria for one adult, passenger details updated after the booking (PATCH, then GET passenger). | One direct trip and three offers (flexible, semi-flexible, saver); the flexible one is booked and confirmed. One ticket. | No failed check. |
| `SIM_SALE_SEARCH_2ADT_SAVER_36` | A sale of the non-flexible offer for two adults, on trip 2. | The saver offer for both passengers, one ticket. | No failed check. |
| `SIM_RETURN_SEPARATE_1ADT_36` | A return in two offers: the inbound request names the outbound offer (`outwardOfferIds`). Both offers booked together. | Inbound offers for the outbound one; one booking, one ticket per direction. | No failed check. |
| `SIM_REFUND_RETURN_1ADT_36` | A full refund of a return: one refund offer per ticket, each confirmed, then the booking read again. | Two refund offers (no fee: flexible); each confirmed refunds its ticket and lowers the confirmed price. | No failed check. |
| `SIM_REFUND_INBOUND_1ADT_36` | A partial refund by fulfillment: the inbound ticket only, named in `fulfillmentIds`. | One refund offer for the inbound ticket; the outbound one stays FULFILLED. | No failed check. |

## beta — OSDM 3.7.0

The same scenarios as `alpha`, plus the return in one offer, which OSDM
defines from 3.7.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_SEARCH_1ADT_37` | As `SIM_SALE_SEARCH_1ADT_36`, in 3.7. | As on `alpha`. | No failed check. |
| `SIM_SALE_SEARCH_2ADT_SAVER_37` | As `SIM_SALE_SEARCH_2ADT_SAVER_36`, in 3.7. | As on `alpha`. | No failed check. |
| `SIM_RETURN_SEPARATE_1ADT_37` | As `SIM_RETURN_SEPARATE_1ADT_36`; from 3.7 the inbound date goes in `offerSearchCriteria.inboundDate`. | As on `alpha`. | No failed check. |
| `SIM_RETURN_COMBINED_1ADT_37` | A return in one offer: the inbound request names the outbound trip (`outboundTripIds`); the offer chosen covers both trips and is booked alone. | Offers covering both trips at a return price; one booking, one ticket per direction. | No failed check. |
| `SIM_REFUND_RETURN_1ADT_37` | As `SIM_REFUND_RETURN_1ADT_36`, in 3.7. | As on `alpha`. | No failed check. |
| `SIM_REFUND_INBOUND_1ADT_37` | As `SIM_REFUND_INBOUND_1ADT_36`, in 3.7. | As on `alpha`. | No failed check. |

## gamma — OSDM 3.8.0

### Sale, return and refund

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_SEARCH_1ADT_38` | As `SIM_SALE_SEARCH_1ADT_36`, in 3.8. | As on `alpha`, with gamma's named products and one PDF for the booking. | No failed check. |
| `SIM_SALE_SEARCH_2ADT_SAVER_38` | As `SIM_SALE_SEARCH_2ADT_SAVER_36`, in 3.8. | The train-bound saver for both passengers. | No failed check. |
| `SIM_RETURN_SEPARATE_1ADT_38` | As `SIM_RETURN_SEPARATE_1ADT_36`, in 3.8. | As on `alpha`. | No failed check; the two merged-PDF warnings. |
| `SIM_RETURN_COMBINED_1ADT_38` | As `SIM_RETURN_COMBINED_1ADT_37`, in 3.8. | As on `beta`. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_RETURN_1ADT_38` | As `SIM_REFUND_RETURN_1ADT_36`, in 3.8. | As on `alpha`. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_INBOUND_1ADT_38` | As `SIM_REFUND_INBOUND_1ADT_36`, in 3.8. | As on `alpha`. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_DELETE_1ADT_38` | A one-way ticket: refund offer asked for (10), read (11), then withdrawn (15. DEL) instead of confirmed; the booking is read again (16). | The refund offer is `PROPOSED`; `DELETE` answers 204; the booking keeps its fulfilled ticket. (#611) | No failed check. |
| `SIM_REFUND_ONLY_OFFER_1ADT_38` | A one-way ticket: refund offer asked for and read, then neither confirmed nor withdrawn (no `scenarioAction`); the run ends at 12. | The refund offer stays `PROPOSED` until it expires. (#611) | No failed check. |

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
| `SIM_REFUND_OVERRULE_REFUSED_38` | Negative test: a refund asked with `STRIKE`, a code gamma does not support, must be refused. The scenario ends at the refund offer request. | `400 OVERRULE_CODE_NOT_SUPPORTED` with a Problem. | No failed check (the refusal is graded); the same four warnings as above. On `alpha`, which accepts any code, this scenario fails, as it should. |

### Reduction cards (#597)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_CARD_25_1ADT_38` | A passenger with a 25 % card: the card is sent, the chosen offer names it in `appliedPassengerTypes`, and step `01c` (the same request without cards) shows the offer costs less. | The card applied: 25 % off, named on the admission. | No failed check. |
| `SIM_SALE_CARD_50_2ADT_38` | Two adults, one with a 50 % card: only that passenger pays less. | 50 % off that passenger's price only. | No failed check. |
| `SIM_SALE_CARD_STUDENT_1YTH_38` | A young traveller with the student card. | 30 % off. | No failed check. |

### Named products (#598)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_PRODUCT_TRAIN_BOUND_1ADT_38` | The offer chosen by its product code `SIM_TRAIN_BOUND`; the booking and each ticket hold that product. | One offer per named product; the train-bound saver is booked. | No failed check. |
| `SIM_SALE_PRODUCT_ALL_DAY_1ADT_38` | The product `SIM_ALL_DAY`, which is not the first fully flexible offer: chosen by its code, not by flexibility. | As above. | No failed check. |
| `SIM_SALE_PRODUCT_FLEXI_SAVER_1ADT_38` | The product named by words of its name, "flexi saver". | As above. | No failed check. |

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

### Seat reservations (#601)

On trip 5, the SuperCity reservation is mandatory and the EuroCity one is
optional. Each is one reservation for all the passengers, on one leg.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_RESERVATION_MANDATORY_2ADT_38` | The mandatory reservation is read from the admission's relation (`minGroupItemsToBeBooked` 1) and booked without being asked. The booking holds it, with its coach and seats. | The mandatory reservation booked, with a coach and one seat per passenger. | No failed check; three warnings *"No booked reservation found for offer reservation[1] … it may be an optional part that was not selected"*, one at each read of the booking (02, 05, 07): the optional EuroCity one, which this scenario does not book. |
| `SIM_SALE_RESERVATION_SELECTION_2ADT_38` | The optional reservation booked too, by `optionalReservationSelections`. | Both reservations booked. | No failed check. |
| `SIM_SALE_RESERVATION_PLACE_SELECTION_2ADT_38` | The reservations booked by `placeSelections` naming the trip and the leg. | Both booked; a place selection naming the wrong leg would be refused. | No failed check. |
| `SIM_SALE_RESERVATION_ADD_LATER_2ADT_38` | The optional reservation added after the booking, by `POST …/booked-offers/{id}/offer-parts` (step 09). | The mandatory one at booking, the optional one added to the pre-booked booking. | No failed check; one warning *"No booked reservation found for offer reservation[1]"*. It comes from the booking step (02), before step 09 adds the reservation; step 09 then checks that it was added. |

### Offers by trip id (#602)

`POST /trips-collection` answers four departures for trip 1 (07:30, 08:00,
09:00, 10:00), each with a train of its own.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_BY_TRIP_ID_1ADT_38` | Step 01 asks the trips first and takes the first leaving at the time asked or later (08:00, not the 07:30 listed first). It then asks the offers with `tripIds`, and every offer must cover that trip. | The four departures; offers for the trip named. | No failed check. |
| `SIM_SALE_BY_TRIP_ID_TRAIN_1ADT_38` | Trip 6 names train 1854, the 09:00 departure and the third trip of the answer: the trip of that train is taken. | As above; the booking is on the 09:00 train. | No failed check. |
| `SIM_SALE_BY_TRIP_ID_UNKNOWN_38` | Negative test: `POST /offers` names a trip id the provider never gave and must be refused. The scenario ends there. | `400 VALIDATION_ERROR` with a Problem naming `tripIds`. | No failed check (the refusal is graded). |

### Fulfilment documents and refund receipt (#603)

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_SALE_DOCUMENTS_RETURN_1ADT_38` | A return whose offers ask for `PDF_A4` and `RETAILER_APP`. The booking delivers both media; each document's format fits its medium and its content is that format; there is one PNG per ticket. Step 06b reads each ticket with `GET /fulfillments/{id}`. | In the 3.8 shape: one PDF for the whole booking and one PNG per ticket, in the booking's `fulfillmentDocuments`, each ticket naming its documents in `fulfillmentDocumentRefs`. `GET /fulfillments/{id}` gives the ticket and its two documents, with a `DOCUMENT_COVERS_MORE_FULFILLMENTS` Problem for the merged PDF. | No failed check; the two merged-PDF warnings. |
| `SIM_REFUND_RECEIPT_RETURN_1ADT_38` | The same booking, refunded in full. The scenario waits for the refund receipt (`refundReceiptMaxWaitMinutes` 2): step 14b reads the booking every 15 seconds until a document of type INFORMATION appears. | The receipt (`PDF_A4`, type INFORMATION) appears in the booking 30 seconds after the refund, and only in `GET /bookings/{id}`. | No failed check; the receipt found after about 30 s; the two merged-PDF warnings. If the receipt does not come within the 2 minutes, the receipt check fails. |

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

These four are negative probes: each waits until a deadline has passed and expects the next request to be refused. They use the trip from station `0000099`, where gamma (profile `shortDeadlines`) makes offers, the booking, refund offers and exchange offers expire after 60 seconds instead of 30 minutes; each scenario waits at most 3 minutes. A run takes a little over a minute each.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_NHF_EXPIRED_OFFER_38` | `expiredOfferTest`: step 02 waits until past the chosen offer's `preBookableUntil`, then books it. | `409 OFFER_EXPIRED`, a Problem. | No failed check: the refusal (4xx) and its Problem body are graded as passing. The scenario ends there. |
| `SIM_NHF_EXPIRED_BOOKING_38` | `expiredBookingTest`: step 06 waits until past the booking's confirmation time limit, then confirms it; 07 reads the booking. | `409 BOOKING_EXPIRED`; the booking read afterwards has its parts `RELEASED`. | No failed check. |
| `SIM_NHF_EXPIRED_REFUND_OFFER_38` | `expiredRefundOfferTest`: a one-way ticket, refund offer asked for; step 13 waits until past its `validUntil`, then confirms it. | `409`, "the refund offer has expired". | No failed check. |
| `SIM_NHF_EXPIRED_EXCHANGE_OFFER_38` | `expiredExchangeOfferTest`: a one-way ticket, exchange offers asked for; step 11 waits until past the first one's `preBookableUntil`, then takes it. | `409 OFFER_EXPIRED`. | No failed check. |

### Response variants (#611)

A variant is chosen by a passenger's last name at booking time: `Simvariant-<name>` (passenger lists 11 to 17). It holds for the life of the booking. gamma only (profile `variants`).

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_VARIANT_PER_PASSENGER_2ADT_38` | A sale for two passengers with variant `per-passenger`. | One fulfillment per passenger, and one PDF for the booking. | No failed check; the two merged-PDF warnings. |
| `SIM_VARIANT_PER_PASSENGER_REFUND_PAX_2ADT_38` | The same booking, then the last passenger refunded alone (`partialRefundByPax`, `last`). The refund must name the fulfillment that holds that passenger (#610). | With this variant, a refund scoped by `passengerIds` or `bookingPartIds` within one fulfillment is offered; it refunds those parts, and the fulfillment is `REFUNDED` once all its parts are. | No failed check; the two merged-PDF warnings. The log shows "Partial refund resolved: fulfillmentId=…" naming the second fulfillment. |
| `SIM_VARIANT_REORDERED_2ADT_38` | Variant `reordered`: booked parts and passengers in the reverse order of the offer (#550). | The admissions of each booked offer and the booking's passengers reversed. | No failed check; three WARNINGs that the passengers were re-aligned by externalRef. |
| `SIM_VARIANT_MINIMAL_2ADT_38` | Variant `minimal`: optional members left out. | No `bookingCode`, no `summary` on the booked offers and parts. | No failed check. |

### Deliberately wrong answers (#611)

Each of these makes one validator family fail on purpose, so that its FAIL path runs. They are not in the data file's run list. The offer one uses the trip from station `0000098` (`variants.wrongOffersFrom`); the others a passenger list naming the variant.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_WRONG_OFFER_PRICE_38` | Offers. | `offerSummary.minimalPrice` one cent above the sum of the parts. | Fails: "provisionalPrice is not below the offer's minimalPrice" (4 failed checks). |
| `SIM_WRONG_BOOKING_PRICE_38` | Booking. | `provisionalPrice` one cent above the sum of the parts. | **No check fails: known gap.** The collection does not compare `provisionalPrice` with the parts. When such a check is added, this scenario must start failing. |
| `SIM_WRONG_FULFILLMENT_STATUS_38` | Fulfillments. | The fulfillments issued say `AVAILABLE`. | Fails: "Fulfillment[0] status comparison" (4 failed checks). |
| `SIM_WRONG_REFUND_AMOUNT_38` | Refund. | `refundableAmount` one cent above its breakdown. | Fails: "Refund response bounds" (4 failed checks). |
| `SIM_WRONG_EXCHANGE_AMOUNT_38` | Exchange. | `amountToBePaid` one cent off `exchangePrice + exchangeFee − price given up`. | Fails: "amountToBePaid = exchangePrice + exchangeFee - confirmedPrice" (7 failed checks). |

### Requested information and purchaser (#611)

gamma (profile `personChecks`) checks passenger and purchaser data when they are updated: a gender outside `MALE`, `FEMALE`, `X`, a date of birth that is no date, an e-mail or phone number of the wrong form, or an empty name is a `400` Problem naming the field, with a pointer. A purchaser written must have a first and a last name. The offers of a trip from station `0000097` (trip requirement 9) ask for each passenger's date of birth and phone number (`requestedInformation`), and so does the booking while one is missing.

| Scenario | What it tests | What the simulator answers | Expected |
|---|---|---|---|
| `SIM_RI_AUTOFEED_1ADT_38` | Offers with `requestedInformation`; the collection checks the expression and supplies what is demanded. | `passengerSpecifications[ANY].dateOfBirth AND passengerSpecifications[ANY].detail.contact.phoneNumber` on each admission. | No failed check; the log says the demand is already met by the scenario's passenger data. |
| `SIM_NHF_RI_OMIT_1ADT_38` | `requestedInformationProbe` omit: a demanded field withheld from the passenger update. | `400 INVALID_PERSON_DATA` naming the field. | No failed check: the refusal is graded as passing; the run ends at step 03. |
| `SIM_NHF_RI_INVALID_1ADT_38` | `requestedInformationProbe` invalid: the passenger update sent six times, one field invalid each time (gender, date of birth, first and last name, e-mail, phone). | Each refused with `400`, the field named. | No failed check: six refusals graded. |
| `SIM_PURCHASER_DEFERRED_1ADT_38` | `bookingPurchaserMode` deferred: the booking made without its purchaser, which is then written (steps 12, 14). | A booking made without a purchaser has none: `GET …/purchaser` is `404`, `POST` creates it. | No failed check. |
| `SIM_NHF_PURCHASER_INVALID_1ADT_38` | `bookingPurchaserMode` invalid: the purchaser written four times, one field missing or invalid each time. | Each refused with `400`, the field named. | No failed check: four refusals graded. |

