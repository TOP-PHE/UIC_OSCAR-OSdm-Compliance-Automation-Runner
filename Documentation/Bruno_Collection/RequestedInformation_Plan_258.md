# OSDM `requestedInformation` Handling — Implementation Plan (#258)

Status: **proposal** · Issue: [#258](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/258)
Decisions locked: **(1) unmet requirement → WARN (informational), not FAIL** · **(2) auto-inject the data → later phase**

---

## 1. Summary

OSDM lets a provider advertise, in a response, *which data must be populated before the
client can proceed to the next step* (provisional booking → confirmation). It does this
through the **`requestedInformation`** field — a boolean expression over passenger
attributes. OSCAR ignores it today. This plan adds, in two shippable increments:

1. **Phase 1 — detect, validate (Layer-1), and surface** what the provider is asking for,
   translated into the exact OSCAR scenario field a tester must fill.
2. **Phase 2 — evaluate** the expression against the data OSCAR is sending and **WARN**
   (precisely, per passenger) when a requirement is unmet, so a later 400 is explained in
   advance rather than discovered as a cryptic failure.

A third, optional phase (auto-inject the demanded data) is explicitly deferred.

---

## 2. What the OSDM spec says

### Placement
`requestedInformation` (`#/components/schemas/RequestedInformation`) is an optional
field — `type: string`, `maxLength: 32768`, `nullable: true` — defined on two response
schemas:

| Schema | Where it appears | OSCAR step |
| --- | --- | --- |
| `AbstractOfferPart` | every `admissionOfferParts` / `reservationOfferParts` / `ancillaryOfferParts` entry of the **offer response** | after `POST /offers` |
| `Booking` | top level of the **post-booking response** | after `POST /bookings` |

### Grammar (ANTLR, from the OSDM "Requested Information – Grammar" page)
```
requested_information : class_index_attribute
                      | requested_information AND requested_information
                      | requested_information OR  requested_information
                      | '(' requested_information ')' ;
class_index_attribute : Attribute '[' Identifier ']' ('.' Attribute)+ ;
Attribute  : [a-zA-Z_]+ ;
Identifier : 'ANY' | <numeric index> ;
```
- Root collection: **`passengerSpecifications`**.
- Index: numeric (`[0]`, `[1]`) selects one passenger; **`[ANY]`** means the requirement
  applies to **every** passenger.
- Operators: `AND`, `OR`, and `( … )` for grouping.

### Semantics
A leaf `passengerSpecifications[i].detail.gender` is **true when that attribute is set**.
The whole expression must evaluate **true** for the next step to be accepted.

### Real examples (verbatim from the spec)
```
passengerSpecifications[0].detail.contact.phoneNumber
passengerSpecifications[1].detail.firstName AND passengerSpecifications[1].detail.lastName
passengerSpecifications[0].detail.firstName AND passengerSpecifications[0].detail.lastName AND (passengerSpecifications[0].detail.contact.email OR passengerSpecifications[0].detail.contact.phoneNumber)
passengerSpecifications[ANY].detail.contact.phoneNumber
```

---

## 3. Current state in OSCAR + integration points

`requestedInformation` currently appears **only** in the bundled spec
(`Bruno_Collection/json_validator/openapi3_0.json`); there is **no handling code**.
The hooks the implementation will use:

| Concern | File · function |
| --- | --- |
| Offer response, per part | `library-bruno/offers.js` · `postOfferResponse` → `validateOfferParts(selectedOffer)` (already iterates all three part arrays) |
| Booking response, top level | `library-bruno/bookings.js` · `postCreateBookingResponse(selectedOffer, jsonData, …)` |
| Layer-1 validation framework | `library-bruno/osdmCompliance.js` (`validateXxx(body)` pattern) |
| Data model OSCAR sent | `library-bruno/scenarioParser.js` env vars `offerPassengerSpecifications`, `bookingPassengerSpecifications`, `passengerAdditionalData` |
| Surface helpers | `displays.js` `validationLogger`, `testCapture.js` `bruTest` |

---

## 4. Design

### New pure module: `library-bruno/requestedInformation.js`
No `bru`/`test` dependencies, so it is unit-testable in the existing Jest harness.

| Export | Purpose |
| --- | --- |
| `parseRequestedInformation(expr)` | recursive-descent parser for the grammar → `{ ok, ast, error }` |
| `describeRequestedInformation(ast)` | human string for the report, e.g. *"passenger 0: first name AND last name AND (email OR phone)"* |
| `evaluateRequestedInformation(ast, dataModel)` | `{ satisfied, unmetLeaves[] }`; resolves each `passengerSpecifications[i].path` against `dataModel`; a leaf is satisfied when the resolved value is non-empty; `[ANY]` ⇒ AND across all passengers |
| `assertRequestedInformationType(expr)` | Layer-1: `string`, length ≤ 32768 |

**Leaf resolution reuses the #231 contact-first / flat-fallback** so `detail.contact.email`
and `detail.email` (and the phone equivalents) both resolve across OSDM 3.0.x and 3.1+.

### Wiring
- **Offer (Phase 1+2):** inside `validateOfferParts`, for each part whose
  `requestedInformation` is non-null → `assertRequestedInformationType` (Layer-1) +
  a tester-facing log line; in Phase 2, `evaluateRequestedInformation` against
  `offerPassengerSpecifications` and WARN on unmet leaves.
- **Booking (Phase 1+2):** inside `postCreateBookingResponse`, the same against
  `jsonData.requestedInformation` and the booking's `passengers`.

---

## 5. Data model & field mapping

OSCAR already authors every attribute the examples reference. The expression leaf maps
1:1 to an existing per-passenger scenario field (confirmed in `datafile.schema.json` and
`scenarioParser.js`):

| OSDM `requestedInformation` leaf | OSCAR scenario passenger field |
| --- | --- |
| `passengerSpecifications[i].type` | `type` |
| `passengerSpecifications[i].dateOfBirth` | `dateOfBirth` |
| `passengerSpecifications[i].gender` | `gender` |
| `passengerSpecifications[i].detail.firstName` | `firstName` |
| `passengerSpecifications[i].detail.lastName` | `lastName` |
| `passengerSpecifications[i].detail.contact.email` *or* `…detail.email` | `email` |
| `passengerSpecifications[i].detail.contact.phoneNumber` *or* `…detail.phoneNumber` | `phoneNumber` |

If a provider ever demands a leaf OSCAR cannot yet author (e.g. a card number, `taxId`,
`residency`), the diagnostic says so explicitly — that becomes a new authoring field
(tracked alongside the request-side issue #227), not silently ignored.

---

## 6. How a tester configures the scenario to provide the data (Phase 1)

**No new configuration object is introduced in Phase 1.** The tester supplies the data
through the *existing* per-passenger fields above, exactly as they already set names and
date of birth today. The new value Phase 1 adds is **guidance**: the WARN/INFO line
translates the raw OSDM expression into a concrete instruction, for example —

> `[WARN] Offer part 'OP-123' requires more passenger data before booking can proceed:
> set **gender** on passenger 0 (OSDM: `passengerSpecifications[0].detail.gender`).`

and for `[ANY]`:

> `[WARN] Provider requires **phone number** for **all** passengers
> (OSDM: `passengerSpecifications[ANY].detail.contact.phoneNumber`).`

So the configuration workflow in Phase 1 is:
1. Run the scenario; OSCAR surfaces which fields the provider demands and on which
   passenger(s).
2. The tester adds those values to the relevant passenger(s) in the scenario / data file
   (the fields already exist in the authoring UI).
3. Re-run; the WARN clears (Phase 2 evaluation confirms the expression is now satisfied).

This keeps the runner **faithful to the data the tester authored** — OSCAR reports what is
needed and the tester decides what to send, rather than the runner inventing values.

### Deferred — Phase 3 auto-inject (not in this work)
A future scenario-level toggle (e.g. *"auto-satisfy requestedInformation"*) could let OSCAR
fill the demanded fields automatically from the authored passenger data or sane defaults,
to drive the flow to completion unattended. This is intentionally out of scope here; it is
the response-side counterpart to request-side issues #227 / #224 and warrants its own
ticket once Phase 1/2 are proven.

---

## 7. Phased delivery

| Increment | Scope | Tests | Release |
| --- | --- | --- | --- |
| **Inc 1 — Phase 1** | `requestedInformation.js` (parse / describe / type-assert); wire detection + Layer-1 + tester-facing surfacing into `validateOfferParts` and `postCreateBookingResponse` | Jest: parser + describe (incl. the 4 spec examples + malformed input) | trio bump |
| **Inc 2 — Phase 2** | `evaluateRequestedInformation` + data-model resolution; WARN on unmet leaves at offer and booking, mapped to the scenario field | Jest: evaluator over the 4 examples × satisfied/unsatisfied/`ANY` | trio bump |
| **Inc 3 — Phase 3 (optional, separate ticket)** | scenario toggle to auto-inject the demanded fields | — | — |

---

## 8. Decisions

1. **Unmet requirement → WARN, not FAIL.** A scenario may legitimately omit an optional
   field, so an unmet `requestedInformation` is *informational*, not a server
   non-conformance. (Possible later refinement: escalate to a test failure only when a
   subsequent booking/confirm actually returns 400 **and** an unmet requirement was
   present — high-signal correlation.)
2. **Auto-inject deferred** to a later, separate phase; the runner stays faithful to
   authored scenario data.

---

## 9. Versioning

Each increment touches `library-bruno`, so it rides the standard release trio
(`Bruno_Collection/VERSION` + `Oscar_Server/package.json` + `compatibility.json`) plus a
CHANGELOG entry, and ships through CI → auto-tag → Watchtower like any collection change.

---

## 10. References

- OSDM — Requested Information Grammar: <https://osdm.io/spec/requested-information-grammar.html>
- OSDM — Processes: <https://osdm.io/spec/processes/>
- OSDM — Offer structure: <https://osdm.io/spec/offer-structure/>
- Bundled spec: `Bruno_Collection/json_validator/openapi3_0.json`
  (`RequestedInformation`, `AbstractOfferPart`, `Booking`)
- Related (request-side): #227 (optional offer params / gender for night trains),
  #224 (optional pax info on booking), #225 (optional booking-request validation)
