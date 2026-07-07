# Fare-Based Distribution — Shop / Book Design Proposal (#242)

Status: **PROPOSAL rev 1.1 — awaiting OTST team review.** Nothing in this
document has been implemented. No code, schema, or scenario changes ship
until the team signs off and Patrick gives an explicit OK.

> **rev 1.1 (2026-07-03):** rev 1.0's desk analysis has been replaced with
> the results of three research tracks run at Patrick's request: (a) a
> line-by-line audit of the actual `library-bruno` code, (b) the OSDM
> functional spec on osdm.io ("Constructing Products from Fares" deep-dive)
> plus the `UnionInternationalCheminsdeFer/OSDM` repo's versioned schemas
> v3.2→v3.9, and (c) a scan of every real sandbox test result in
> `OSCAR reports/` (239 files, 4 vendors). The upstream issue
> `OSDM-testing#93` is also now resolved (§3.1). Material changes vs rev
> 1.0 are marked **[rev 1.1]** where the conclusion flipped.

Issues covered: [#242](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/242)
(umbrella), [#205](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/205),
[#207](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/207),
[#243](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/243)–[#248](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/248).
Follow-ons only lightly scoped (§10):
[#206](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/206) (fare refund),
[#255](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/255) (BIKE on a fare reservation).

Primary sources:
- SFR wiki: [Fare based distribution Shop Book Ticket](https://github.com/UnionInternationalCheminsdeFer/OSDM-testing/wiki/Fare-based-distribution-Shop-Book-Ticket) (quoted in full, §2.6)
- OSDM deep-dive: [Constructing Products from Fares](https://osdm.io/spec/constructing-products-from-fares/) + [Data Models](https://osdm.io/spec/models/) ("Offers with Partial Coverage")
- Schemas: `Bruno_Collection/json_validator/openapi3_0.json` (bundled, 3.x) cross-checked against `UnionInternationalCheminsdeFer/OSDM` `specification/schemas/*.yml` (master) and the versioned bundles at tags `v3.2`…`v3.9`
- Upstream: [OSDM-testing#93](https://github.com/UnionInternationalCheminsdeFer/OSDM-testing/issues/93)

---

## 1. Summary

OSCAR today tests only the **Product-based** distribution model. OSDM
defines a second model — **Fare-based distribution** — in which the
provider returns `Fare` building blocks and **the distributor constructs
the distributable product** from them, following combination rules carried
*inside* the fares. The fares arrive in the same `POST /offers` response,
under `Offer.fares[]` (a sibling array of `admissionOfferParts[]` /
`reservationOfferParts[]` / `ancillaryOfferParts[]`), requested via
`offerSearchCriteria.requestedOfferParts: ["FARE_ADMISSION", ...]`.

Three empirical facts now frame this proposal:

1. **OSCAR ignores `Offer.fares[]` entirely today** — and carries dead code
   aimed at field names that don't exist in the spec, plus three concrete
   bugs that would fire the moment a vendor returns fares (§3.2, §3.3).
2. **No tested sandbox has ever returned fare content — but none was ever
   asked.** Across all 239 result files from Bileto, Paxone, Turnit and
   CHAPS, zero fare markers appear; and no OSCAR request has ever sent
   `requestedOfferParts` at all. Vendor fare capability is **untested, not
   disproven**. Bileto is the natural first probe: its serializer already
   emits an empty `"fares": []` container on every booked offer (§4).
3. **The spec is more precise than the SFR** on the two points Patrick
   flagged: assertion depth and combinability. The combination-model
   semantics, the flexibility-cluster ordering rule, the partial-coverage
   no-gap/no-overlap rules, and the "fare fulfillment content is usually
   empty **by design**" statement are all in the osdm.io deep-dive, and
   several rev 1.0 assertions change as a result (§6, §7).

The centerpiece remains **§6 (the assertion list)** and **§7 (how deep
combinability validation should honestly go)**, both now grounded in the
verified spec text and the audited code rather than desk reasoning.

---

## 2. What OSDM says — verified against spec text and versioned schemas

### 2.1 The distribution model: provider sells fares, distributor builds products

From the deep-dive: fares "do not constitute a distributable product. It is
up to the distributor to build the distributable product" — they are
"building blocks for a distributor to form products, product based offers
and transport contracts." The provider states, inside each fare, the rules
under which it may be combined; the distributor applies them. Mixed
requests (fares + products in one offer search) are allowed; **an offer
must include fares for all passengers**; free transport must be expressed
as a zero-price fare, not an absent one.

This is why several "obvious" conformance checks are *not* the provider's
to fail: the correctness of a **combined product** is distributor logic,
outside the provider's response (this becomes Tier C/D in §7).

### 2.2 The `Fare` object (`openapi3_0.json:13044-13188`)

Required: `id`, `type` (`FareType`, x-extensible-enum
`ADMISSION | RESERVATION | ANCILLARY` — per the code-list catalog, **no
provider-specific values allowed** despite the x-extensible-enum marker),
`prices[]` (note: **plural**, multi-currency — Product parts carry a single
`price`; this matters for code reuse, §3.4), `regionalConstraint`,
`travelClass`, `afterSalesCondition` (a **link**, not the Product-style
inline `afterSalesConditions[]` — same reuse caveat), `combinationConstraint[]`
(min 1), `travelValidityConstraint`.

**[rev 1.1] `requiredCards` is version-gated:** required with `minItems: 1`
in OSDM **3.2.0–3.5.x** (a schema-valid 3.5 fare literally cannot say "no
card needed"); **dropped from `required` at 3.6.0** (omit = no card
needed), `minItems: 1` still applying when present. OSCAR tests vendors on
3.5.0–3.9.0, so this assertion must read the scenario's `osdmVersion`.
This resolves rev 1.0's open question §8.2.

Deprecation note for the design horizon: the fare place-related fields
(`availablePlaces`, `placeSelection`, `placeAllocation`,
`availablePreferences`) are deprecated in master/3.10-dev, and
reservation-as-fare is deprecated in favour of a general `Reservation`
with `distributionMode: FARE_MODE`. First-pass scope should not build on
either.

### 2.3 Combination constraints — free string, four documented models

**[rev 1.1]** `FareCombinationModel.model` is **not an enum** — it is a
free string whose schema description says "A distributor needs to support
the following models: SEPARATE_TICKET, SEPARATE_CONTRACT, CLUSTERING,
COMBINING" (identical wording in the 3.5.0 and 3.9.0 bundles). The
deep-dive's own prose drifts between spellings (`CLUSTERING_MODEL`,
`SEPARATE_CONTRACTS`, `SEPARATE_TICKETS`, even "`COMBINATION` model") — a
conformance check must match **leniently** and can never hard-FAIL an
unrecognised value.

Documented semantics ("Fare Combination Rules"):

| Model | Meaning |
|---|---|
| `CLUSTERING` | distributor may apply **its own** standard after-sales rules for the flexibility cluster of the final product (`referenceCluster` + `allowedClusters`) |
| `COMBINING` | distributor **must obey the after-sales fees provided in the fare** |
| `SEPARATE_CONTRACT` | separate contracts, possibly on one fulfillment document; separation "has to be indicated clearly on the ticket"; `allowedCommonContracts` lists providers allowing a common contract |
| `SEPARATE_TICKET` | named in the required-support list but **never formally defined** in the spec text |

"A Fare can have multiple combination constraints. **One of them must
match** to construct a combination."

### 2.4 The flexibility clusters — deep-dive table, not a code list

**[rev 1.1]** Exact spellings (underscores): `BUSINESS`, `FULL_FLEX`,
`SEMI_FLEX`, `NON_FLEX`, `PROMO`. Definitions: BUSINESS =
refundable/exchangeable *after* departure; FULL_FLEX = *before* departure;
SEMI_FLEX = with fee, minimum validity; NON_FLEX = neither; PROMO =
bilateral only. **Ordering rule** (this is the normative teeth for §7
Tier B): a fare "can only be included in a product of the same cluster
model or a cluster model that allows **less** flexibility… a FULL_FLEX
fare might be allowed to be included in a SEMI_FLEX product, but not in a
BUSINESS product."

This list appears **only** in the deep-dive — it is *not* in the
code-list catalog and *not* a schema enum (`referenceCluster` /
`allowedClusters` are plain strings). So: soft check, exact-match on the
five known values, WARNING (never FAIL) on anything else. This resolves
rev 1.0's open question §8.3. Do not confuse with `Offer.flexibility`
(`FULL_FLEXIBLE`/`SEMI_FLEXIBLE`/`NON_FLEXIBLE`) — different field,
different vocabulary.

### 2.5 `requestedSections`, connection points, partial coverage

`requestedSections` (top-level sibling of `tripSearchCriteria` /
`tripIds` / `tripSpecifications` on the offer request,
`openapi3_0.json:15064-15094`): "you pass in the complete trip and use the
requestedSections attribute to define which part(s) you need fares
(including virtual border points)." `Section` =
`{startPlace, startLegId?, endPlace, endLegId?, externalTripRef?}`;
absent → the totality of the trip is priced (the lever for the negative
cases #244/#246/#248).

Virtual border points: fares "often start or end at country borders where
no train station exists" — modelled as `FareConnectionPoint` (station sets
on each side, **UIC code mandatory**, legacy `BORDER_POINT` code
optional). The distributor is "recommended to check the matching of the
connection points… match **without gap**."

**Partial coverage** (osdm.io/spec/models/, "Offers with Partial
Coverage") — the normative basis for coverage assertions: coverage is
declared via `coveredTripLegIndexes`; offers covering the same leg-set
form an `offerCluster`; **no overlap** (a trip leg may be covered by only
one offerCluster within a tripOffer) and **no gap** (every trip leg
covered by ≥1 offer in each TripOffer).

### 2.6 The SFR's scenario + suggested validations (verbatim)

> **Scenario:** offer request with a trip specification, indicate
> `FARE_ADMISSION` in `offerSearchCriteria.offerParts`, set
> `isPartOfInternationalTrip` to `true`, add `requestedSections` from a fare
> connection point to a station. Book → fulfill → get booking → refund
> (offer, get, patch) → get booking again.
>
> **Suggested validations:** one or more fares provided; fares cover the
> requested section; fares cover the requested passengers; a regional
> validity provided; combination constraints with combination model(s)
> provided; after-sales conditions provided; `travelValidityConstraint`
> provided; for rail `involvedTCOs` provided; fare type `ADMISSION`;
> *(fulfillment)* the fulfillment documents are missing or empty.

**[rev 1.1] The last line is spec-sanctioned normal behaviour, not a
deviation**: "The distributor constructs the fulfillment for the product
offer. The booking of the fare returns a fulfillmentId for the fares, but
**usually the content of the fulfillment will be empty**" — non-empty
content only "in special cases… (e.g. proprietary bar codes) based on
bilateral agreements." rev 1.0 proposed handling this via the
Known-Deviation baseline; that was wrong — the assertion inverts (§6.4).

### 2.7 Versions

`FARE_ADMISSION` and the full Fare model are present in **every** version
OSCAR encounters (verified 3.2.0→3.9.0; fares exist since 3.0). The only
material cross-version difference found: the `requiredCards` gating (§2.2).

---

## 3. What the code actually does today (audit results)

Everything in this section is from a line-by-line read of the current
`main`; citations are `Bruno_Collection/library-bruno/` unless noted.

### 3.1 Upstream #93 — resolved, and OSCAR is cleaner than feared

The issue rev 1.0 could not resolve: [OSDM-testing#93](https://github.com/UnionInternationalCheminsdeFer/OSDM-testing/issues/93)
("Numbers of offerParts validation in the offer", Angelo Farruggia, open,
milestone V1.4). The original collection asserted **one offerPart per leg
per passenger** — count-based. Upstream consensus in the comments
(Koseler, Petrak, Farruggia): drop the count logic; check that the
**union of the parts' coverage attributes** covers all legs and all
passengers; and account for OSDM's partial-coverage offers.

**OSCAR's fork does not have the count disease** — no legs×passengers
count assertion exists anywhere (only a descriptive comment in
`partialRefund.js:45`). Current coverage checking is
`assertOfferCoverageIntegrity` (`offers.js:1562-1592`): pure **referential
integrity** (every `tripCoverage` {tripId, legId} pair points at a real
trip/leg). But there is also **no union-completeness check** — nothing
verifies the parts jointly cover all legs/passengers. Net: a clean slate;
the fare coverage check (§6.2) should be built union-based from day one,
per the upstream consensus **and** §2.5's offerCluster no-gap/no-overlap
rules, and can then also serve the Product flow (closing OSCAR's side of
#93 as a by-product).

### 3.2 Where fares land today: ignored — plus dead code aimed at wrong keys

`postOfferResponse` (`offers.js:245`) validates only the three classic
part families (`:327-331`); `selectAndSetOffer` (`:454`) filters on
`reservationOfferParts` only. **No code anywhere reads `Offer.fares[]`.**
Nothing crashes on a fares-carrying offer (all reads are `|| []`-guarded);
a fares-only offer would pass trivially — silently unvalidated.

Worse: `captureExpiredOfferDeadline` (`offers.js:415-418`) scans
`fareAdmissionOfferParts` / `fareReservationOfferParts` /
`fareAncillaryOfferParts` — **keys that do not exist in the spec's Offer
schema** (the spec key is `fares`). Dead code from an earlier aborted
start; never fires; should be removed or re-aimed as part of this work.

### 3.3 Three concrete bugs found (one fires today, fares or not)

| # | Location | Bug | When it fires |
|---|---|---|---|
| B1 | `fulfillments.js:198` | total-price check's test title claims "+ Fees + Fares" but the sum includes only admission+reservation+ancillary env prices → guaranteed spurious FAIL on any fare-carrying booking | first fare booking |
| B2 | `bookings.js:1072` | test **title** eagerly evaluates `fulfillment.bookingParts.map(...)`; `bookingParts` is optional per spec (Fulfillment required = id/status/bookingRef/createdOn) → TypeError **outside** the test kills the whole after-response script | **today**, any vendor omitting `bookingParts` |
| B3 | `bookings.js:1072-1078` | every `fulfillment.bookingParts[].id` must be ∈ `admissionReservationAncillaryBookingPartsIds` — fare part ids are never captured into that list → fare fulfillments FAIL the membership check | first fare fulfillment |

B2 is a pre-existing latent crash independent of fares and is worth fixing
regardless of this proposal's outcome.

### 3.4 Reuse picture — corrected from rev 1.0

**[rev 1.1]** rev 1.0 called `validateOfferParts` (`bookings.js:408-448`)
"the biggest single reuse win." The audit says: **mechanically generic,
admission-flavored in its field list.** It pairs `offerParts[i] ↔
bookedParts[i]` by index (no count/id assertions — ids only harvested),
then checks `exchangeable/refundable` intersection, `isReservationRequired/
offerMode` equality, `status` vs expected, `price.{amount,currency,scale}`,
`validFrom/validUntil`, and afterSalesConditions pairing. For a `Fare`:
nothing crashes, but `prices[]`≠`price` and
`afterSalesCondition`≠`afterSalesConditions[]` mean **everything except
`status` degrades to WARNINGs** (and `status` works — `Fare.status` is
`BookingPartStatus`). Callers hardcode the three families
(`bookings.js:916-918`), so booked fares are never compared at all today.
Reuse therefore = a thin **fare-field adapter** (map `prices[0]`→price
shape, resolve the after-sales link) feeding the existing matcher with a
4th `"fare"` partType — still a reuse win, just not a free one.

Other audited reuse points:

- **Refunds**: the refund request body is `{fulfillmentIds}` populated
  family-agnostically (`bookings.js:1005-1014`), so a fare's fulfillment
  **would flow into POST /refund-offers mechanically** — but all refund
  *validation* is hardcoded three-family (`refunds.js:103-107`,
  `:672-686`, `:738-739`), and `afterSalesRules.js:40-79` reads the
  Product field shapes (degrades safely to "non-permitting", never
  crashes). Fare refunds today would execute **unvalidated** — #206's real
  scope is extending those three lookups plus the same field adapter, not
  a rebuild. rev 1.0's "near-zero new code" was too optimistic; "small,
  bounded new code" is accurate.
- **Schema validation**: nothing comes free. The generic Ajv validator
  exists (`validators.js:151-245`) but its only offer-flow call site is
  **commented out** (`02-Common Requests/01. POST Get Offer.yml:133`);
  `osdmSchema.js` covers System-Information components only. Fare Layer-1
  shape checks need explicit wiring (or hand-written checks in the
  established `osdmCompliance.js` style).
- **Fulfillment documents**: `validateFulfillments` (`bookings.js:970`)
  already treats absent/empty `fulfillmentDocuments` as a DEBUG-level
  "pre-issuance state" — the fare-mode empty-document case (§2.6) passes
  **today** with no change. The fare hazards are B2/B3 above, not the
  document check.
- **Request builder**: `buildOfferCollectionRequest`
  (`requestsBuilder.js:108-142`) emits `tripSpecifications` or
  `tripSearchCriteria` + passengers + `offerSearchCriteria` +
  fulfillment options. Confirmed absent: `requestedSections`, `tripIds`,
  `isPartOfInternationalTrip`. (Curio: a **negative probe** already
  injects `requestedSections` at `02-Common Requests/Post Offer-Req param
  chk.yml:266-268` — the field has been on the wire from OSCAR before,
  never as a feature.)
- Places API typeahead (`attachPlaceAutocomplete`, #450) — reusable as-is
  for the new section start/end place fields.
- The **Test Framework** capability enum already lists the `FARE_*`
  values (`scenarios.js:56-57`); the **scenario-level** picker
  (`WIZ_OFFER_PARTS`, `scenarios.js:3093`) does not — the small unlock
  stands as in rev 1.0.

---

## 4. Sandbox evidence — fare capability is untested, not disproven

Scan of `…/OTST/OSCAR reports/` (all real OSCAR runs; 232 extracted
batch files + 7 loose, none encrypted): **zero fare markers across all
four vendors** — no `FARE_ADMISSION`, `combinationConstraint`,
`referenceCluster`, `regionalConstraint`, `requestedSections`,
`travelValidityConstraint`, `involvedTCOs`, or model names anywhere.

| Vendor | Files | Fare content | Note |
|---|---|---|---|
| Bileto | 74 | **NO — but closest**: `"fares": []` emitted on every `bookedOffers[]` entry (92×); `regionalValidity: null` present on admissions (118×) | serializer knows the container → **best first probe target** |
| Paxone | 124 | NO — 0 markers | |
| Turnit | 22 | NO — 0 markers | |
| CHAPS | 12 | NO — prose-only mention ("differential fare paid on the train") | |

Decisive nuance: **no OSCAR request has ever sent `requestedOfferParts`
at all** (zero occurrences in any request body, any vendor, any batch) —
so no vendor was ever *asked* for fares. Absence of evidence here is
genuinely not evidence of absence. The cheapest possible next step —
before any build — is a **manual probe**: one Bileto (then others) offer
request with `requestedOfferParts: ["FARE_ADMISSION"]` on an
international O/D, and see what comes back (fares? empty? 400? ignored?).
That single data point decides whether Phase 1 tests run against a real
sandbox or ship dormant. (No OBB or Sqills results exist in the reports
folder; their capability is equally unknown.)

---

## 5. Proposed scenario / datafile model (sketch, not final)

Unchanged in substance from rev 1.0; restated with §3's confirmations:

- Scenario-level `requestedOfferParts` gains the `FARE_*` values
  (framework-level enum already has them).
- New boolean `isPartOfInternationalTrip` (SFR step 1; single body field,
  `openapi3_0.json:20392`).
- New repeatable **Requested section** block: start/end place (wired to
  `attachPlaceAutocomplete`), optional `startLegId`/`endLegId`,
  `externalTripRef`. Empty list = whole trip priced.
- `tripIds` as a third request shape (#245/#246), gated behind a
  precursor trip-discovery step.
- Downstream (booking/fulfillment/refund): no new scenario fields — a
  fare offer's `id` books through the existing
  `offers[].offerId/passengerRefs` shape unchanged.

---

## 6. Proposed assertion list (rev 1.1)

Organised by flow step; severity follows the established provider-fairness
posture (#391/#436): hard FAIL only where the spec is unambiguous.

### 6.1 Offer response — structural presence (Layer-1)

Per the `Fare` schema's own `required[]`:

| # | Assertion | Severity |
|---|---|---|
| 1 | each fare has `id`, `type`, `prices[]` (≥1, each amount/currency valid) | FAIL |
| 2 | `regionalConstraint` present with ≥1 `regionalValidities` | FAIL |
| 3 | `travelClass` present | FAIL |
| 4 | `afterSalesCondition` present | FAIL |
| 5 | `combinationConstraint[]` present, ≥1, each entry has a non-empty `model` string | FAIL |
| 5b | **[rev 1.1]** each `model` matches one of the four documented models under **lenient** matching (case/`_MODEL` suffix/plural tolerant, per the spec's own prose drift §2.3) | WARNING when unrecognised — free string, can't hard-fail |
| 6 | `travelValidityConstraint` present with `validityRange` | FAIL |
| 7 | **[rev 1.1]** `requiredCards`: version-gated — `osdmVersion` ≤3.5: required, ≥1 entry each with `type` (FAIL); ≥3.6: optional, but when present ≥1 entry with `type` (FAIL on present-but-malformed only) | FAIL / version-gated |
| 7b | `involvedTCOs` present for rail fares (SFR expectation; spec field optional) | WARNING |

### 6.2 Offer response — coverage & consistency

Grounded in §2.5's normative partial-coverage rules + the upstream #93
union consensus (§3.1):

| # | Assertion | Severity |
|---|---|---|
| 8 | **union-based section coverage**: the fares' `coveredSection`s jointly cover every `requestedSections` entry (or the whole trip when none requested) — never count-based | FAIL |
| 8b | **[rev 1.1]** offerCluster integrity per §2.5: within a trip's offers, no leg covered by two offerClusters (no overlap) and every leg covered by ≥1 offer (no gap) | FAIL |
| 9 | fares cover **all** requested passengers ("an offer must include fares for all passengers", §2.1); free-transport passengers get a zero-price fare, not an absent one | FAIL |
| 10 | `type` is `ADMISSION` for this scenario family | scenario-scoped soft check |
| 11 | **[rev 1.1]** when a model is `CLUSTERING`: `referenceCluster` present and ∈ {`BUSINESS`,`FULL_FLEX`,`SEMI_FLEX`,`NON_FLEX`,`PROMO`} (exact spellings, §2.4) | WARNING on unknown value (deep-dive list, not a schema enum) |
| 12 | negative cases (#244/#246/#248): domestic trip / whole-trip section / empty sections on a section-less itinerary → **zero** fares returned | FAIL (simple absence check) |

### 6.3 Booking response

Via the fare-field adapter + existing matcher (§3.4):

| # | Assertion | Severity |
|---|---|---|
| 13 | every offered fare booked (union/id-based, adapter-fed `validateOfferParts(..., "fare")`) | FAIL |
| 14 | booked fare price ties out to the offered `prices[]` (currency-matched entry) | FAIL |
| 15 | `status` lifecycle correct (`BookingPartStatus`, works unchanged today) | FAIL |
| 16 | `regionalConstraint`/`travelValidityConstraint` structurally present on the booked fare (presence, not byte-equality — providers may re-derive validity at booking; revisit after first live response) | WARNING |

### 6.4 Fulfillment — **[rev 1.1] inverted from rev 1.0**

| # | Assertion | Severity |
|---|---|---|
| 17 | fulfillment created for the fare booking part, `fulfillmentId` returned | FAIL |
| 18 | fulfillment **documents empty/absent = normal fare-mode behaviour** → INFO line ("distributor constructs the ticket"); documents **non-empty** → INFO note "bilateral-agreement fulfillment content present" (never FAIL either way) | INFO |
| — | prerequisite bug fixes B1/B2/B3 (§3.3) — without them a fare fulfillment spuriously fails or crashes the script | pre-work |

rev 1.0 proposed a Known-Deviation baseline entry for empty documents;
withdrawn — the spec says empty is the norm, so no deviation exists to
baseline.

### 6.5 Refund (#206 — scoped, not designed here)

Mechanics already flow (fulfillmentIds are family-agnostic, §3.4); the
work is extending the three hardcoded family-lookups in `refunds.js` and
teaching `afterSalesRules.js` the fare field shapes
(`afterSalesCondition` link, `prices[]`). Small, bounded; deferred to its
own phase.

---

## 7. How deep should combinability validation go?

The four documented models (§2.3) can be "tested" at four depths:

### Tier A — Declared shape (baseline, §6.1 rows 5/5b/11)
The provider said *something* coherent: models present, leniently
recognisable, CLUSTERING entries carry a cluster. Table stakes; checks
presence, not correctness.

### Tier B — Self-consistency within one response **[rev 1.1: now has normative teeth]**
The deep-dive's ordering rule (§2.4) makes this concrete and genuinely
assertable from a **single** provider response, no second vendor needed:

- every `referenceCluster`/`allowedClusters` value ∈ the five known
  clusters (else WARNING, x-extensible-style);
- `allowedClusters` ⊇ nothing *more flexible* than `referenceCluster` —
  a NON_FLEX fare listing BUSINESS in `allowedClusters` contradicts "same
  or less flexibility" (WARNING: contradicts the deep-dive ordering);
- mutual sanity across fares of one response: if fare A (cluster X) allows
  cluster Y and fare B (cluster Y) exists in the same response, flag when
  B's own constraints exclude X entirely — an asymmetry the distributor
  cannot resolve (WARNING + report note, since multi-constraint "one must
  match" semantics can legitimise some asymmetries);
- `COMBINING` fares must carry usable after-sales fee data (the
  distributor is bound to it — its absence makes the model inoperable):
  WARNING when the after-sales link resolves to nothing.

### Tier C — Live combination behaviour, single vendor
Book two fares across a `FareConnectionPoint` and check the booking is
consistent with the declared constraints. **Empirical gate first** (§4):
no current sandbox has demonstrated even single-fare support. The manual
`FARE_ADMISSION` probe (Bileto first) decides whether Tier C is plannable
at all. Deferred pending that data point.

### Tier D — Cross-carrier combination enforcement
Combining fare A (carrier X) with fare B (carrier Y) per
`combinableCarriers`/`allowedCommonContracts` requires **two providers in
one test** — interop/settlement territory, not per-vendor conformance.
Additionally, §2.1 places combined-product correctness on the
**distributor**, which in a fare-mode test is OSCAR itself — the provider
cannot fail a check about logic the spec assigns to the caller.
Recommendation unchanged: explicitly out of OSCAR's scope; flag at UIC
level as an interop-test concern rather than quietly under-delivering.

**Recommendation:** Tier A + Tier B in the first pass (B is now concrete,
§ above); Tier C behind the sandbox probe; Tier D declared out of scope.
Still the section most deserving the team's pushback.

---

## 8. Phased delivery (proposed, pending OK)

0. **Phase 0 — pre-work, independent of fare review:** fix B1/B2/B3
   (§3.3) and remove/re-aim the dead `fare*OfferParts` scan (§3.2). B2 is
   a live crash risk for any vendor omitting `bookingParts` today.
   *Recommended to ship immediately as plain bug fixes — but per the
   review-first instruction, listed here for the explicit OK rather than
   started.*
1. **Phase 0.5 — empirical probe (no code):** manually send one
   `requestedOfferParts: ["FARE_ADMISSION"]` offer request to Bileto
   (then Paxone/Turnit/CHAPS) on an international O/D; record what comes
   back. Decides whether Phase 1 lands runnable or dormant, and whether
   Tier C is worth planning.
2. **Phase 1 — Shop:** `requestedSections` + `isPartOfInternationalTrip`
   scenario fields, scenario-level `FARE_*` unlock, `validateFares()`
   implementing §6.1 + §6.2 (+ Tier B if the team agrees). Covers
   #243/#244/#247/#248.
3. **Phase 2 — `tripIds` request shape** (+ precursor trip discovery).
   Covers #245/#246.
4. **Phase 3 — Book + Fulfillment:** fare-field adapter + `"fare"`
   partType through the booking matcher; fulfillment per §6.4. Covers
   #205/#207 and completes the SFR core scenario.
5. **Phase 4 — Refund (#206):** the bounded `refunds.js`/
   `afterSalesRules.js` extensions (§6.5).
6. **Unphased:** #255 (BIKE passenger type on a fare reservation) — note
   §2.2: reservation-as-fare is deprecated in favour of
   `distributionMode: FARE_MODE`; #255's design should target that form.

---

## 9. Open questions for the OTST team (rev 1.1 — pruned)

Resolved since rev 1.0 and removed: `requiredCards` semantics (→
version-gated, §2.2); cluster-list status (→ deep-dive table, exact
spellings, soft check, §2.4); upstream #93 content (→ resolved, §3.1).

Remaining:

1. **§7 — confirm the Tier line.** Tier A+B first pass, C behind the
   probe, D out of scope: agreed?
2. **Phase 0 timing** — may the three bug fixes (and dead-code removal)
   ship now as ordinary bug PRs, ahead of the fare review outcome? B2 can
   crash a run today.
3. **Phase 0.5 probe** — who runs it, and against which sandboxes beyond
   Bileto? (One manual request per vendor; no OSCAR changes needed.)
4. **Scenario model** — fare scenarios as `SALE`-family with `FARE_*`
   requested parts (no new scenarioType), per §5: confirm.
5. **`SEPARATE_TICKET`** is never defined in the spec text (§2.3) — does
   the team have an agreed operational meaning, or should OSCAR treat it
   as recognised-but-semantics-unchecked?

---

## 10. Out of scope

- Ticket-time/consumption validation (barcode content per IRS 90918-4/-9/-10).
- **#226** (delete exchange → new offer) — unrelated mechanism.
- **#221** / **#227** — explicitly reserved for Patrick's own review.
- Building on the deprecated fare place-selection fields or
  reservation-as-fare (§2.2) — first pass targets the non-deprecated core.
- Any implementation — this document is the proposal under review.

---

## 11. References

- Umbrella [#242](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/242) · pairs [#243](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/243)/[#244](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/244), [#245](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/245)/[#246](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/246), [#247](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/247)/[#248](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/248) · product-comparison [#205](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/205)/[#207](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/207) · follow-ons [#206](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/206), [#255](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/255) · upstream [OSDM-testing#93](https://github.com/UnionInternationalCheminsdeFer/OSDM-testing/issues/93)
- Spec: [Constructing Products from Fares](https://osdm.io/spec/constructing-products-from-fares/) · [Data Models — Offers with Partial Coverage](https://osdm.io/spec/models/) · [Code-list catalog](https://osdm.io/spec/catalog-of-code-lists/) · `UnionInternationalCheminsdeFer/OSDM` `specification/schemas/fare.yml`, `offer.yml` + versioned bundles `v3.2`…`v3.9`
- SFR: [Fare based distribution Shop Book Ticket](https://github.com/UnionInternationalCheminsdeFer/OSDM-testing/wiki/Fare-based-distribution-Shop-Book-Ticket) (§2.6, verbatim)
- Local schema citations: `Bruno_Collection/json_validator/openapi3_0.json` at `main`, 2026-07-03
- Sandbox evidence: `…/projets/OSDM/OTST/OSCAR reports/` — 239 files, Bileto/Paxone/Turnit/CHAPS, 2026-05-24→2026-06-18 (§4)
- Prior OSCAR work built on: #371/#373/#379/#382 (coverage patterns), #388/#390/#391/#392/#397 (refund engine), #398/#401 (Known-Deviation baseline), #450 (Places typeahead)
- Template: `RequestedInformation_Plan_258.md`, `OPT_Place_Selection_Plan_104.md`
