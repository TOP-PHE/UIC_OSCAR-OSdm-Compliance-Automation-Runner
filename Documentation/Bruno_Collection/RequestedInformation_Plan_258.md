# OSDM `requestedInformation` Handling — Implementation Plan (#258)

Status: **SHIPPED** (passenger + purchaser) · Issues: [#258](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/258) (closed), [#203](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/203) (closed)
Original decisions: **(1) unmet requirement → WARN (informational), not FAIL** · **(2) auto-inject the data → later phase** — both later revised (see §11).

> **§1–§10 below are the original proposal** (kept for the design rationale). **§11 is the
> as-built record** of everything actually shipped, including the purchaser support and the
> revised decisions (auto-feed is now ON, negative probes added). Read §11 first for the
> current behaviour.

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

---

## 11. As-built (shipped) — current behaviour

This section supersedes the proposal where they differ. Everything here is live.

### 11.1 Passenger side (#258)

Delivered in phases on `library-bruno/requestedInformation.js` (a pure, unit-tested module):

| Phase | What shipped |
| --- | --- |
| **1 — surface** | recursive-descent parser for the grammar, human-readable describer, leaf→scenario-field mapping, Layer-1 type check (string, ≤ 32768). Wired into `offers.js` (per offer part) and `bookings.js` (booking level). |
| **2 — evaluate** | `evaluateRequestedInformation(ast, model)` against the data OSCAR will send; per-passenger unmet reporting; `[ANY]` ⇒ AND over all passengers; #231 contact-first/flat-fallback so `detail.contact.email` ↔ `detail.email` both resolve. |
| **3a — auto-feed (decision revised)** | **Auto-feed is now ON by default.** Instead of only WARNing, OSCAR auto-provides the demanded mappable fields from the scenario data / sane samples so the happy flow completes unattended, and the report states *what* was requested, *at which step*, and *what was supplied*. (Revises original decision #2.) |
| **3b — static assertions** | grammar parse (FAIL), passenger-index-in-range (FAIL), unknown-attribute (WARN). |
| **3c — negative probe** | scenario field **`requestedInformationProbe`** = `off` (default) / `omit` / `invalid`. `omit` withholds a demanded field; `invalid` sends a malformed value. The PATCH-passenger step then grades the provider's rejection with `validateProblemResponse()` (Group N): N1 = 4xx client error, N2 = RFC-9457 `Problem` body, N3 = field pointer (WARN, recommended). |

### 11.2 Purchaser side (#258 root-awareness + #203)

OSDM `BookingRequest.required = [offers, passengerSpecifications]` — **purchaser is optional**,
and the spec points to `requestedInformation` as the mechanism to request it. The published
grammar only standardises `passengerSpecifications`, but its root token is generic, so a
provider may emit a `purchaser[…]` demand. Support shipped as:

- **Root-aware engine.** A leaf's *root* selects its subject: `passengerSpecifications[i]`
  (indexed passenger) vs **`purchaser[…]`** (the single purchaser object — **index ignored**).
  Each kind has its own evaluation subject, report label (`the purchaser`) and
  auto-feed/probe channel. New: `buildPurchaserModelFromAdditionalData`,
  `applyPurchaserAutoFeed`, `rootKind`, `staticIssues.unknownRoots`. Passenger behaviour
  unchanged; full unit coverage added.
- **Scenario field `bookingPurchaserMode`** (`inline` | `deferred` | `omit` | `invalid`):

  | Mode | Behaviour |
  | --- | --- |
  | `inline` *(default)* | purchaser sent in the `POST /bookings` request — historic behaviour, byte-identical |
  | `deferred` | purchaser **omitted** at booking, then set afterwards (happy path) — triggers/satisfies any purchaser `requestedInformation` |
  | `omit` | never supplied (observe the provider's demand / rejection) |
  | `invalid` | omitted at booking, then a **deliberately invalid** purchaser is sent → provider must reject (RFC-9457 `Problem`, graded) |

- **Create-or-update (upsert) flow — closes #203.** Rather than guess POST vs PATCH, the
  deferred/invalid flow **probes first**:

  ```
  04. GET Passenger
     └─▶ 12. GET Booking Purchaser        (getBookingPurchaser)
            ├─ 2xx  (purchaser exists) ─▶ 13. PATCH Booking Purchaser  (patchBookingPurchaser — update)
            └─ 404 / none              ─▶ 14. POST Booking Purchaser   (postBookingPurchaser — create)
                                              └─▶ 05. GET Booking before Fulfillments
  ```

  This handles **both** provider styles — those that materialise an empty purchaser on the
  booking (PATCH; e.g. **Bileto**) and those that don't (POST) — without hardcoding a method.
  Shared body in `requestsBuilder.buildBookingPurchaserBody()`; `requestsBuilder` gates the
  inline purchaser on the mode; `bookings.js` routes purchaser leaves to the purchaser
  channel; the smart-run filter (`opencollection.yml`) gates each step (the two write steps
  run only for the method the GET probe selected). All inert when `inline`/`omit`.

### 11.3 OSDM field-constraint findings (what "invalid" can mean)

A negative `invalid` probe is only meaningful where the **schema actually constrains the
value**. From the bundled spec (`openapi3_0.json`):

| Field | OSDM schema | Is a bad value a true violation? |
| --- | --- | --- |
| `detail.firstName` / `detail.lastName` (`PersonDetail`) | bare `type: string` — **no `pattern` / `maxLength` / `format`** | **No.** Special chars (`#`, `%`, `§`), accents, hyphens, apostrophes are all valid names (spec example: `"Diaz Lopez"`). A conformant provider should **accept** them. |
| `email` (`ContactDetail`) | bare `type: string` — **no `format: email`** | Not a *schema* violation. `not-an-email` tests **semantic** validation (good practice, not OSDM-mandated). |
| `phoneNumber` | bare `type: string` | Same — semantic only. |
| `gender` | `enum: [MALE, FEMALE, X]` | **Yes** — `"ZZZ"` is a hard enum violation. |
| `dateOfBirth` | `format: date` | **Yes** — `"not-a-date"` is a hard format violation. |

Consequences, reflected in the code:
- `invalidValueForField()` returns **`null` for names/`type`** → the probe **omits** them
  rather than inventing spec-valid "garbage". It only fabricates invalid values for
  `gender` / `dateOfBirth` (hard violations) and `email` / `phoneNumber` (semantic).
- The **purchaser's `PersonDetail` has neither `gender` nor `dateOfBirth`** — only names +
  email/phone (all unconstrained strings). So for the purchaser the only practical invalid
  value is `email = not-an-email` (a semantic check).
- For `requestedInformation` itself, the spec only requires a demanded field to be
  **populated** to proceed — a *malformed-but-present* value is still "populated". So the
  strongest spec-grounded negative test is **`omit`** (missing required → must reject);
  **`invalid`** is a softer "does the provider validate values" probe. *(Open option: grade
  `invalid` as a hard FAIL only for enum/format fields and a WARN for unconstrained strings.)*

### 11.4 Bug fixes along the way

- **#208 (token-cache fingerprint) regression** — the `users.cached_token_cred_fp` column
  ALTER was added to an already-applied migration (v12), so the version-gated runner never
  created it on existing DBs → the cache-persist `UPDATE` threw `no such column` and failed
  **every** `oauth2` run (valid creds included). Fixed by a new migration **v20** + making
  cache persistence best-effort (a fetched token is returned even if the cache write fails).
- **`invalid`-purchaser sent valid data** — `buildBookingPurchaserBody()` corrupted the
  email only when it was empty, so a scenario purchaser with a valid email passed through
  unchanged. `invalid` mode now **overwrites** the email with `not-an-email`.

### 11.5 Authoring & schema

- `scenarios.js`: dropdowns for `requestedInformationProbe` (`off`/`omit`/`invalid`) and
  `bookingPurchaserMode` (`inline`/`deferred`/`omit`/`invalid`); wizard defaults.
- `datafile.schema.json`: both fields documented with their enums.
- `scenarioParser.js`: both fields → env vars; per-scenario reset of the purchaser channel
  (`purchaserAdditionalData`, `requestedInfoPurchaserProbeTargets`, `__purchaserStepDone`,
  `__purchaserWriteMethod`).

### 11.6 Release history (all collection changes → trio bump + CI → auto-tag → Watchtower)

| Release | Server | Collection | What |
| --- | --- | --- | --- |
| (3a/3b) | — | — | auto-feed + static assertions |
| (3c) | — | — | negative probe + `validateProblemResponse` |
| **2026.98** | 1.11.70 | OTST_V2.0.24 | root-aware engine + `bookingPurchaserMode` + first purchaser step |
| **2026.99** | 1.11.71 | OTST_V2.0.24 | #208 migration regression hotfix (server-only) |
| **2026.100** | 1.11.72 | OTST_V2.0.25 | deferred purchaser step → PATCH (quick fix) |
| **2026.101** | 1.11.73 | OTST_V2.0.26 | **GET-adaptive upsert** (GET probe → PATCH/POST) |
| **2026.102** | 1.11.74 | OTST_V2.0.27 | `invalid` mode forces a bad email |

### 11.7 Key files

`library-bruno/requestedInformation.js` (engine), `library-bruno/requestsBuilder.js`
(`buildBookingPurchaserBody`), `library-bruno/bookings.js` (booking-level RI + purchaser
channel), `library-bruno/offers.js` (offer-part RI), `02-Common Requests/{12 GET, 13 PATCH,
14 POST} Booking Purchaser.yml` + `04. GET Passenger.yml` (routing), `opencollection.yml`
(smart-run gates), `scenarios.js` + `datafile.schema.json` + `scenarioParser.js` (authoring),
`Oscar_Server/src/db/db.js` (#208 migration v20) + `worker/access-token.js`.
Tests: `Oscar_Server/tests/unit/bruno-requestedinformation.test.js`,
`tests/unit/access-token.test.js`.
