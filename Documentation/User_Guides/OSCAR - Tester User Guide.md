# OSCAR — Tester User Guide

*How to point OSCAR at an OSDM provider and build, run, and read a conformance test.*

> Reflects collection **OTST_V2.0.40** / server **1.11.92** / release **2026.120**.
> Labels in **bold** match the on‑screen controls. When the UI and this guide
> disagree, the UI wins — please open an issue so we can update the guide.

---

## Table of contents

1. [Concepts & roles](#1-concepts--roles)
2. [One‑time setup](#2-one-time-setup)
3. [Provider setup — Framework, Test data & Discovery](#3-provider-setup--framework-test-data--discovery)
   - 3.1 Test Framework (capabilities) · 3.2 Train sets · 3.3 Journeys · 3.4 Timetable Discovery
4. [Authoring a scenario](#4-authoring-a-scenario)
5. [Running tests](#5-running-tests)
6. [Reading the report](#6-reading-the-report)
7. [Reference tables](#7-reference-tables)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Concepts & roles

**What OSCAR does.** OSCAR drives a provider's OSDM API through realistic
sale / refund / exchange flows and checks each response against the OSDM spec.
A run produces a **report**: a tree of pass/fail **assertions** plus the full
**HTTP traffic** (every request and response).

**The hierarchy.** Everything hangs off four nested things — learn these names,
the rest of the guide uses them:

```
Company  ──►  Test Framework  ──►  Scenario(s)  ──►  Run  ──►  Report
(the           (what the           (one concrete    (one        (assertions
 provider +     vendor CAN do —     test: an O&D,    execution)   + HTTP
 api_base)      the "menu")         a date, options)              traffic)
```

- **Company** — the provider under test. Holds the `api_base` (the OSDM API
  root URL) and the per‑company **concurrency limit**.
- **Test Framework** — declares the vendor's **capabilities** (ticket types,
  seat‑map support, ancillaries, offer criteria…). It is the *menu*: it
  **gates** what a scenario is allowed to switch on.
- **Scenario** — one concrete test you author from that menu.
- **Run** — one execution of one or more scenarios.
- **Report** — the result.

**Roles** (set by an administrator; they decide what you can see and do):

| Role | What it is | Sees |
|---|---|---|
| `company_user` *(tester)* | Day‑to‑day tester for one company. Keeps **their own** OSDM credentials. | Their own runs in their company. |
| `test_manager` | Company lead. | **All** of the company's runs/reports; can **share** a report with the certifier. |
| `certification_user` *(certifier)* | UIC‑side reviewer, no company of their own. | Only the reports a `test_manager` has **explicitly shared**. |
| `administrator` | Platform operations & security. | Manages users/companies/config. **Does not read test data** (privacy‑strict, issue #60). |

If you are a tester, you live mostly in sections **3–6** below.

---

## 2. One‑time setup

Do these once before your first run.

1. **Sign in** to the OSCAR web app with the account your administrator created.
2. **Set your OSDM credentials** (Profile / API config). Credentials are
   **per‑user**: each tester authenticates to the company's OSDM API with their
   own client id / secret (or token). OSCAR requests the access token for you at
   run time when the sandbox needs one — you don't paste a token by hand.
3. **Confirm the company `api_base`** points at the right sandbox (e.g.
   `https://osdm-5.platform.bileto.zone/api`). This is company‑level config; a
   `test_manager`/admin sets it.
4. **Pick the environment / sandbox** for the run (e.g. Bileto, Sqills,
   Benerail, …). The collection auto‑selects the matching access‑token request
   for that sandbox.

> **Credentials never leave the server in the clear.** OSDM credentials and the
> framework/data are encrypted at rest; auth request/response bodies are redacted
> in every report.

---

## 3. Provider setup — Framework, Test data & Discovery

Everything in this section is the **provider setup** a `test_manager` does
**once** (and revises as they learn the vendor): the **capabilities** the vendor
supports, and the **trains/journeys** to test against. Scenarios (§4) are then
authored *on top of* this. Plain testers (`company_user`) consume this setup —
the train/journey/discovery edit controls are hidden from them.

### 3.1 Test Framework (capabilities)

The framework tells OSCAR **what the vendor can do**. It does **not** run
anything — it defines the menu that scenario authoring is limited to.

| Capability | Field | What it means / gates |
|---|---|---|
| **Ticket types** | `rail.ticketTypes` | `IRT`, `NRT_OPTIONAL_RESERVATION`, … Declaring a reservation‑bearing type is what makes **place selection** available to scenarios. |
| **Graphical seat map?** | **Seat Selection** → *“Does the system offer a graphical seat map?”* (`placeSelection.seatMap`) | Tick if travellers can pick a specific seat. Off ⇒ scenarios cannot pick seats at all. |
| **Supported seat‑selection modes** | the pills revealed under the box (`placeSelection.supportedModes`) | Tick **🪑 Seat map at offer** and/or **➕ Add reservation to a booking** — declare the one(s) this vendor actually supports. A scenario's mode picker (§4.6) offers **exactly** these and nothing else. |
| **Offer criteria** | `offerCriteria.{serviceClasses, travelClasses, requestedOfferParts, flexibilities, offerMode, currency}` | The allowed values a scenario's offer search may use. |
| **Fulfillment** | `fulfillment.{media, types}` | Allowed fulfilment media/types (e.g. `PDF_A4` / `ETICKET`). |
| **Ancillaries** | `ancillaries[]` | The catalog of ancillary types the vendor sells. Declaring ≥1 enables the **Add ancillary** action. Defined once, reusable per train (issue #130). |
| **Passenger types & ages** | `passengerTypes`, `passengerAgeRanges` | e.g. `ADULT 26–99`, `CHILD 4–15`. |
| **Concurrency limit** | per‑company | Max parallel runs OSCAR fires at this vendor. Lower it if the vendor is fragile under load (see §8). |

**The golden rule:** *a scenario can only switch on what the framework
authorises.* If a control is greyed out during scenario authoring, the reason is
almost always "enable it in the Test Framework first."

### 3.2 Test data — train sets (routes + timetables)

A scenario doesn't carry its own train — it **references** one of the **train
sets** you define here (the **🚆 Train Resources** section). A train set is:

- a **route** — **Label** (short display name, e.g. *"Sqills IC BAS/AMS"*),
  **Operator Code** (`urn:uic:rics:NNNN`), **Origin / Destination station URN**,
  and optional **Product category** (ref / name / short name);
- a **Services (timetable)** — one or more individual departures that run that
  route, each with a **vehicle number** and **departure / arrival** times;
- **Operating days** — set‑level (applies to every service in the set);
  **empty = daily**. Lets you model "runs Mon–Fri only", etc.

Controls:

| Button | Does |
|---|---|
| **➕ Add Train** | Create a new train set and fill the route + services by hand. |
| **🗐 Duplicate** | Copy an existing set, then tweak the vehicle # / times — the fast way to add a sibling departure or a near‑identical route. |
| **💾 Save all trains** | Persist every set you've opened/edited in one go. |

A scenario then points at a set via its **Trip** (requirement) — `tripType`
**SEARCH** (let the vendor find the train from O&D + date) or **SPECIFICATION**
(pin the exact train/legs).

### 3.3 Journeys (multi‑leg)

The **🧭 Journeys** section chains train sets into a **reusable multi‑leg
itinerary** (e.g. *Basel → Amsterdam → Paris*). Build it once with **➕ Add
Journey** (or **🗐 Duplicate**), and a scenario can then **Apply a Journey** to
fill **all** its legs at once instead of typing each leg. Ideal for testing
multi‑leg / connection offers consistently.

### 3.4 Timetable Discovery

Don't know which trains a sandbox actually runs? Use **🔍 Discover timetable**
(in the Train Resources section) to reverse‑engineer them:

1. Enter an **Origin** and **Destination** (UIC URN or bare code — both work).
2. Set **Days to scan** (1–14, default **7**).
3. Click **Discover**.

OSCAR queries the sandbox server‑side (`POST /offers`, with a `/trips-collection`
fallback) across the next N days, harvests every train it offers, and
**creates/updates the train sets** accordingly — including the **travel/service
classes and ancillaries** the vendor actually returns, and splitting sets by
**operating‑days pattern** (so a weekday‑only train and a daily train become
separate sets). **Your manual edits are preserved** — discovery merges, it never
clobbers. It's the fastest way to seed a brand‑new provider's test data.

> Discovery and train/journey editing are `test_manager` actions; they're hidden
> for plain testers.

---

## 4. Authoring a scenario

A scenario is built in the **Scenarios** section. The good news (issue #172):
**only three things are required** — everything else is optional and defaults
sensibly.

### 4.1 The minimal scenario

| Required | Notes |
|---|---|
| **Origin** | A station reference. UIC URNs (`urn:uic:stn:…`) and vendor URNs (`urn:x_<vendor>:stn:…`) are both accepted. |
| **Destination** | As above. |
| **Departure date** | Resolved dynamically at run time (`%TRIP_DATE%`), so a saved scenario never goes stale. |

That alone is a valid **SALE** search. Add the options below only when you want
to exercise them.

### 4.2 Scenario type

| Type | Flow exercised |
|---|---|
| **SALE** | Offer → booking → (optional steps) → fulfillment. The default. |
| **REFUND** | Sale, then refund‑offer → refund. Needs an `overruleCode` (`PAYMENT_FAILURE` / `DISRUPTION`). |
| **EXCHANGE** | Sale, then exchange‑offer → exchange operation. |

### 4.3 Offer criteria (optional)

Narrow what you ask the vendor for. Each value is constrained to what the
framework authorised.

- **Currency** (e.g. `EUR`) — *recommended even though optional*: some strict
  vendors `400`/`500` on an empty `offerSearchCriteria` with no currency.
- **Service class** — `STANDARD`, `BEST`, `HIGH`, `BASIC`, `ANY_CLASS`.
- **Travel class** — `FIRST`, `SECOND`, `ANY_CLASS`.
- **Requested offer parts** — `ADMISSION`, `RESERVATION`, `ANCILLARY`, `FARE_*`,
  `CONTINUOUS_SERVICE`, `ALL`. (Include `RESERVATION` if you intend to pick seats.)
- **Flexibility** — `FULL_FLEXIBLE`, `SEMI_FLEXIBLE`, `NON_FLEXIBLE`.
- **Offer mode** — `INDIVIDUAL`, `COLLECTIVE`. The OSDM spec defines:
  - `INDIVIDUAL` — each passenger gets their **own** admission/reservation (N admissions for N passengers). Refund of a **single passenger** is possible.
  - `COLLECTIVE` — the admissions/reservations are **shared across the group** (one admission with N `passengerRefs`). The group is **atomic** — you cannot refund an individual passenger; the whole booking moves together.
  - If a provider does **not support** the requested mode, the spec mandates that it **fall back** to the supported mode and emit a **warning** in the response.
  - With only **one passenger**, `COLLECTIVE` is semantically degenerate ("collective of one"). Depending on the provider, OSCAR may see the request **accepted as-is**, **silently fallen back to INDIVIDUAL** (with a warning), or **rejected** with an error (e.g. minimum group size). Today OSCAR doesn't constrain or fully assert this — see #222 for the broader test build-out.

### 4.4 Return trip (optional)

Leave empty for a **one‑way**. To make it a **return**, set:

- **Return offset (days)** — `0` = same day, `1`, `2`, … Default suggestion is
  **2** (covers night trains). The return date is derived as *outbound departure
  date + offset*, so it tracks the dynamic departure date.
- **Return time** (optional `HH:MM`) — overrides the time‑of‑day; otherwise the
  outbound departure time is mirrored.

Under the hood this becomes `returnSearchParameters.inwardReturnDate` and triggers
the **two‑step return** (outbound offer → inward offer → round‑trip booking). If a
vendor rejects a combined two‑offer booking, OSCAR automatically falls back to two
separate bookings and records a trackable finding (issue #180).

### 4.5 Sales‑flow actions (optional opt‑in steps)

These are extra steps inserted into a **SALE** flow. **All default OFF** — opt in
to each one you want to test. An action that the framework doesn't authorise is
shown disabled with the reason.

| Action | Icon | What it does | Requires |
|---|---|---|---|
| **PATCH passengers** | 👤 | Updates passenger details between booking and fulfillment. | — |
| **Place selection** | 🪑 | Picks specific seats (see §4.6). | A reservation ticket type **+** the graphical seat map ticked in the framework (§3). |
| **Add ancillary** | 🧳 | Adds an ancillary offer part to the booking. | ≥1 ancillary in the framework. |
| **GET booking** | 🔄 | Reads the booking back for a consistency check. | — |
| **Delete ancillary** | ✕ | Removes a previously added ancillary (reverse path). | ≥1 ancillary. |

### 4.6 Seat‑selection mode (when Place selection is on)

This is where the **Test Framework** and the **scenario** connect. It's a
two‑place setup — declare the capability once on the framework, then pick from it
on each scenario:

**In the Test Framework → 🪑 Seat Selection (§3):**
1. Tick **“Does the system offer a graphical seat map?”** (`placeSelection.seatMap`).
2. Under **Supported seat‑selection modes**, tick the option(s) the vendor
   really supports — **🪑 Seat map at offer** and/or **➕ Add reservation to a
   booking** (one or both).

**In the scenario (here):**
3. Turn on the **Place selection** sales‑flow action (§4.5).
4. Pick **one** mode from the **Seat‑selection mode** picker — it shows
   **exactly** the option(s) you ticked in step 2, nothing else.

> If the framework lists only one mode, the scenario pre‑selects it — **still
> click the pill so the choice is saved**. An unsaved/stale value can silently
> run the other flow (this is the cause of "I chose *Seat map at offer* but the
> offer‑time step never ran"; see §8).

The two modes — the same labels appear in the framework and the scenario:

| Mode (`placeSelectionMode`) | Label (UI) | When the seat is chosen |
|---|---|---|
| `SEATMAP_AT_OFFER` | **🪑 Seat map at offer** | *Before* the booking. OSCAR `GET`s the offer‑time seat map, picks an available seat per passenger, and carries it into the `POST /bookings`. The seat may affect the price. |
| `ADD_TO_BOOKING` | **➕ Add reservation to a booking** | *After* the booking. A reservation offer part is added to the existing booking (e.g. SNCF first‑class TGV). |

**Adaptive behaviour (issues #182/#184/#186/#188):**
- `SEATMAP_AT_OFFER` is the discovery‑friendly choice: it tries the offer‑time
  map and, **if that fails, automatically falls back** to the after‑booking path.
  So for an unknown vendor, authorise *both* modes in the framework and choose
  `SEATMAP_AT_OFFER`.
- The seat picked is **availability‑aware** (occupied/reserved places are
  skipped) and **one seat per passenger**. There is intentionally **no
  "seat‑passengers‑together"** optimisation yet.
- A reservation must exist in the offer for a seat map to apply. If it doesn't,
  the seat‑map step is skipped cleanly ("not applicable") rather than erroring.

### 4.7 Passengers & fulfillment (optional)

- **Passengers** — type (`PERSON`, `BICYCLE`, `DOG`, `PRM`, …), date of birth,
  and optional patch values (name/email/phone) used by the PATCH‑passengers step.
- **Fulfillment** — media (`PDF_A4`, `UIC_PDF`, …) and type (`ETICKET`, …),
  constrained to the framework's `fulfillment`.

> **Passenger reference format (since server‑v1.11.98).** The wizard generates
> passenger references as 5‑digit zero‑padded strings (`"00001"`, `"00002"`,
> …) — these become the OSDM `externalRef` on every passenger‑bearing call.
> OSDM v3.8 permits any non‑null string, but at least one production provider
> (Paxone) enforces a numeric / zero‑padded shape and rejects `"PAX1"`-style
> references with a catch‑all `Schema validation error`. **Scenarios authored
> before v1.11.98** still carry the old `PAX1`, `PAX2`, … format in their
> data file and will continue to fail on Paxone. Two paths to fix them:
> (1) **re‑author the scenario** in the wizard — passengers regenerate with
> the new format; or (2) **hand‑edit the data file** — rename every `PAXn`
> to its zero‑padded equivalent. The reference appears in three places per
> scenario: `passengersList[].passengers[].reference`,
> `bookingPassengerReferences` (flat array of strings), and any echoed
> `externalRef` inside `offerPassengerSpecifications` /
> `bookingPassengerSpecifications` if you materialised those fields by hand.
> Bileto, Sqills, Turnit and Benerail accept both formats and are unaffected.

### 4.8 Non Happy Flow customisation — negative tests and conformance probes

These probes drive a scenario into a **non‑happy** path and assert the provider
**rejects** it in a conformant way (typically `4xx` + an RFC‑9457 `Problem`
body). They all default OFF — a saved scenario keeps behaving as before until
you opt in.

**Wizard layout (since server‑v1.11.100).** The NHF section is organised into
two collapsible sub‑groups, each with a badge showing how many of its probes
are currently armed:

```
▼ Non Happy Flow customisation        — N probes armed
    ▶ ⏰ Expiry timers                  — N of 6 armed
         (Expired offer / booking / add‑res / add‑anc / refund‑offer / exchange‑offer)
    ▶ 🪪 Field‑shape & payload probes  — N of 2 armed
         (RequestedInfo probe, Passenger external‑ref format)
```

Each sub‑group auto‑expands when anything inside it is armed and auto‑collapses
when it isn't. Manual toggles are preserved across re‑renders.

`requestedInformationProbe` lives in this section since **v1.11.100** — it was
previously rendered in the SCENARIO PARAMETERS panel, but the Tester Guide
always classified it as NHF; the wizard now matches.

#### Passenger external‑ref format probe (`passengerExternalRefFormat`)

Override the default `00001`-style passenger reference with a custom
printf‑style pattern, applied at scenario‑parse time and propagated through
every downstream call (offer, booking, refund, exchange). Designed to
document provider variance — at the time of writing, **Paxone rejects
`PAX1`‑style refs with a catch‑all `Schema validation error`** while Bileto,
Sqills, Turnit and Benerail accept any non‑empty string per OSDM v3.8 spec.

| Pattern (wizard input) | Generated refs for a 3‑pax scenario |
|---|---|
| *(empty — default)* | `"00001"`, `"00002"`, `"00003"` |
| `PAX%04d` | `"PAX0001"`, `"PAX0002"`, `"PAX0003"` |
| `ABC-%03d-XYZ` | `"ABC-001-XYZ"`, `"ABC-002-XYZ"`, `"ABC-003-XYZ"` |
| `%d` | `"1"`, `"2"`, `"3"` (no padding) |
| `%05d` | `"00001"`, `"00002"`, `"00003"` (same as default) |

The pattern must contain a `%d` or `%0Nd` placeholder. Without one, the
probe is ignored at runtime and a `[WARNING]` is logged — the run continues
with the default refs.

The wizard renders a **live preview** under the input box so you can see
what the first three passenger refs will look like before saving.

#### Passenger `requestedInformation` probe (`requestedInformationProbe`) — #258

OSDM lets a provider demand additional passenger info (a `requestedInformation`
block in the offer/booking response). OSCAR auto‑feeds the demanded fields on
the happy path. This probe lets you also test the **negative** path:

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Auto‑feed the demanded fields so the happy flow completes. |
| **`omit`** | **Withhold** required fields → assert the provider rejects with a conformant `Problem`. |
| **`invalid`** | Send **invalid values** (per passenger field, one at a time) → assert the provider rejects with a conformant `Problem`. |

> **Provider‑fair severity.** Only the genuinely strict fields (`gender` enum,
> `dateOfBirth` format) are hard FAILs when the provider *accepts* invalid
> input. Free‑form fields (`firstName`, `lastName`, `email`, `phoneNumber`) are
> WARN‑level because OSDM doesn't constrain their content.

#### Purchaser placement & probe (`bookingPurchaserMode`) — #258 / #203

Where (and whether) the purchaser is supplied for a booking. Covers both the
happy path and the negative path in one field.

| Mode | What OSCAR does |
|---|---|
| **`inline`** *(default)* | Purchaser is sent in the `POST /bookings` request. Historic behaviour. |
| **`deferred`** | Omit purchaser at booking, then upsert it afterwards via the dedicated endpoint. OSCAR does a **GET first** and chooses `PATCH /bookings/{id}/purchaser` (purchaser already present and empty) or `POST` (none yet). Also exercises any purchaser `requestedInformation` raised by the booking. |
| **`omit`** | Never supply a purchaser → assert that bookings missing the purchaser are still acceptable (purchaser is optional per OSDM `BookingRequest`). |
| **`invalid`** | Omit at booking, then `POST` an **invalid** purchaser → assert the provider rejects with a conformant `Problem`. Iterates one field at a time (`firstName`/`lastName`/`email`/`phoneNumber`). |

#### Expired‑booking test (`expiredBookingTest`) — #204

Asserts that a booking left to expire **cannot be fulfilled**.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | After the booking is created, **wait until 15 s past** the booking's effective confirmation deadline. The deadline is resolved in this order: **(1)** `booking.confirmationTimeLimit` (OSDM‑standard at the booking level); else **(2)** `booking.confirmableUntil` (Bileto puts it here at the booking level); else **(3)** the **earliest** `bookedOffers[].{admissions \| reservations \| ancillaries}[].confirmableUntil` — Paxone exposes the deadline only here, which is in fact OSDM's own placement for that field. Then `POST /fulfillments`. The fulfillment **MUST be rejected** (`4xx` + `Problem`) — a hard FAIL if the provider fulfills an expired booking. The follow‑up `GET /bookings` must show admissions/reservations **EXPIRED / RELEASED / CANCELLED** (a `404` purge is accepted). |

**Max wait (`expiredBookingMaxWaitMinutes`)** — optional per‑scenario timer
shown next to the **Expired‑booking test** dropdown. Integer minutes, 1–60.
When set, OSCAR uses this as the wait budget for **this scenario** instead of
the server's `RUN_TIMEOUT_MS`, and the runner **auto‑extends the worker
SIGTERM** to cover it. Use it when the provider's deadline is longer than
the server default (Bileto / Paxone are ~15 min → set **20**). Leave empty
to use the server default. The server clamps the effective timeout at
`RUN_HARD_MAX_TIMEOUT_MS` (default 30 min); raise that env var if you ever
need to test providers with deadlines longer than ~25 min.

> **Run‑budget guard.** If waiting until the deadline would exceed the run's
> `RUN_TIMEOUT_MS` (default 10 min), the test **skips with a `[WARNING]`** that
> tells you the minimum seconds to raise the timeout to — instead of being
> killed mid‑wait. For a provider whose `confirmationTimeLimit` exceeds ~9 min,
> raise `RUN_TIMEOUT_MS` on the server before running.

**Automatic OAuth token refresh.** Long‑running scenarios (and long batches)
used to fail at the very end with a provider `403 "not authenticated"` because
the access token issued at run start outlived its TTL during the wait.
OSCAR now refreshes the token automatically — you don't have to configure
anything, but it's worth knowing the layers so the log lines make sense:

- **Per‑scenario** — `01. POST Get Offer` checks at the start of every scenario
  whether the cached token needs renewing (cheap cache hit when it doesn't).
- **After the expired‑booking wait** — `06. POST Obtaining Fulfillments` forces
  a fresh token just before the late `POST /fulfillments`, so the wait can't
  outrun the token.
- **Background watchdog** — the runner ticks every 5 min while the run is in
  flight (operator‑tunable via `TOKEN_WATCHDOG_INTERVAL_MS`, see the Server
  Admin Guide) to keep the cached token warm under long runs.

If you ever **do** see a `401`/`403` from the provider, OSCAR explicitly flags
it as an auth failure — *not* a booking‑expiry rejection — with a
`[WARNING] … this is likely a token problem (refresh failed), not a
booking‑expiry rejection`. So you'll never mis‑read an auth error as a test
pass.

#### Expired‑offer test (`expiredOfferTest`)

Asserts that an offer left to expire **cannot be booked**. Same pattern as the
expired‑booking test above, one step earlier in the flow.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | After the offer is selected, **wait until 15 s past** the earliest `OfferPart.validUntil` from the chosen offer (scanned across admission / reservation / ancillary parts and the fare‑* equivalents). Then `POST /bookings`. The booking **MUST be rejected** (`4xx` + `Problem`) — a hard FAIL if the provider accepts a booking against an expired offer. The post‑booking happy path (passenger PATCH, GET, fulfillments) is then **skipped** for this scenario because no booking was created. |

**Max wait (`expiredOfferMaxWaitMinutes`)** — optional per‑scenario timer
shown next to the **Expired‑offer test** dropdown. Same semantics as
`expiredBookingMaxWaitMinutes`: integer 1–60 minutes; OSCAR uses it as the
wait budget for this scenario instead of the server's `RUN_TIMEOUT_MS`, and
the runner auto‑extends the worker SIGTERM to cover it (clamped at
`RUN_HARD_MAX_TIMEOUT_MS`). Typical: **15** (most provider offer windows are
≤ 15 min). Leave empty to use the server default.

> **Same run‑budget guard, same WARNING.** If waiting until the deadline
> exceeds the run's budget, the test **skips with a `[WARNING]`** that tells
> you the minimum minutes to raise the **Max wait** to. The token‑refresh
> safety net described above applies identically — no `401`/`403` mis‑reads.

> **Combining multiple timers on one scenario auto-expands into sub-runs.**
> Each enabled timer kills the flow at a different request, so OSCAR runs the
> scenario **N times** when N timers are armed — one pass per timer, in flow
> order: Offer → Booking → AddReservation → AddAncillary → RefundOffer →
> ExchangeOffer. Each sub-run's assertions are prefixed
> `[NHF_<3-letter>_<scenario_code>]` in the report — `OTO` (offer), `BTO`
> (booking), `ARO` (add-reservation), `ATO` (add-ancillary), `RTO` (refund),
> `ETO` (exchange). A leading `NHF_` on the scenario code is stripped so you
> don't get `NHF_BTO_NHF_…`. The worker SIGTERM budget is the **sum** of the
> enabled Max waits, clamped at `RUN_HARD_MAX_TIMEOUT_MS` (default 30 min);
> raise that env var if you arm 3+ timers with long waits.

#### Expired post-booking add-reservation test (`expiredAddReservationOfferTest`)

Asserts that an offer-part **cannot be added** to an existing booking once its
`validUntil` has passed.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | Just before `09. POST Add Reservation to Booking` fires, OSCAR waits until 15 s past the `validUntil` of the specific `reservationOfferPart` that 09 is about to send. Then fires 09. The **POST must be rejected** (`4xx` + `Problem`). The downstream post-booking happy path (Add Ancillary / PATCH passenger / GET passenger) is **skipped** because the reservation was not added. |

Only meaningful when the scenario uses **Place selection** in **ADD_TO_BOOKING** mode (enable it in the **Booking Flow Actions** section). When the offer carries no `validUntil` on its reservation parts the test skips with a `[WARNING]`.

**Max wait (`expiredAddReservationOfferMaxWaitMinutes`)** — same semantics as `expiredOfferMaxWaitMinutes`. Typical: 15.

#### Expired post-booking add-ancillary test (`expiredAddAncillaryOfferTest`)

Asserts that an ancillary offer-part **cannot be added** to an existing booking once its `validUntil` has passed.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | Just before `10. POST Add Ancillary to Booking` fires, OSCAR waits until 15 s past the **earliest** `validUntil` across the ancillary offer-parts that 10 will send. The deadline is sourced from `11. additional-offers` (primary — booking-specific add-ancillary offers) or the original offer's `ancillaryOfferParts` (fallback). Then fires 10. The **POST must be rejected** (`4xx` + `Problem`). The downstream PATCH/GET passenger chain is **skipped**. |

Only meaningful when **Add ancillary** is enabled in the **Booking Flow Actions** section. If `11. additional-offers` returns nothing addable, the test skips with a `[WARNING]`.

**Max wait (`expiredAddAncillaryOfferMaxWaitMinutes`)** — same semantics.

#### Expired refund-offer test (`expiredRefundOfferTest`)

Asserts that a refund offer **cannot be confirmed** once its `validUntil` has passed.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | After `10. POST Refund Offers` returns the proposed refund, OSCAR waits until 15 s past `refundOffers[0].validUntil`. Then fires `13. PATCH Refund Offer` with `status: "CONFIRMED"`. The **PATCH must be rejected** (`4xx` + `Problem`). The downstream `14. GET Booking after Patch Refund` / `15. DEL Refund Offer` / `16. GET Booking after Delete Refund` steps are **skipped**. |

**REFUND scenarios only** — the field is shown in the wizard only when `scenarioType = REFUND`. There is no separate "refund confirmation" timeout because OSDM refund execution is synchronous (no PREBOOKED→CONFIRMED holding state).

**Max wait (`expiredRefundOfferMaxWaitMinutes`)** — same semantics. Typical refund-offer windows are similar to sale offers (~15 min) — set 20.

#### Expired exchange-offer test (`expiredExchangeOfferTest`)

Asserts that an exchange offer **cannot be turned into a booking** once its
**`preBookableUntil`** has passed.

> **Spec naming quirk.** Every other expired-X test waits past a `validUntil`. The exchange flow waits past **`preBookableUntil`** — same semantic ("the latest moment this offer can still be accepted"), but the OSDM spec uses a different field name on `ExchangeOffer` for it. See [OSDM Spec Deviations #25](../OSDM/OSDM_Spec_Deviations_Observed_2026-05-28.md) for the cross-resource naming inconsistency this surfaces.

| Mode | What OSCAR does |
|---|---|
| **`off`** *(default)* | Normal flow. |
| **`on`** | After `10. POST Exchange Offers` returns the proposed exchange, OSCAR waits until 15 s past `exchangeOffers[0].preBookableUntil`. Then fires `11. POST Exchange Operations`. The **POST must be rejected** (`4xx` + `Problem`). The downstream `GET booking before fulfillment` / `POST fulfillments` chain is **skipped**. |

**EXCHANGE scenarios only.** No separate "exchange confirmation" timeout is needed — accepting an exchange creates a **new booking** with its own `confirmationTimeLimit`, which is already covered by `expiredBookingTest` running on a post-exchange leg.

**Max wait (`expiredExchangeOfferMaxWaitMinutes`)** — same semantics.

#### Auto-expansion: multi-timer scenarios → one sub-run per timer

When a scenario has **2 or more** expired-X timers enabled, OSCAR doesn't try
to run them all in one pass (impossible — each one kills the flow at a
different request). Instead it **auto-expands** the scenario into **N
sub-runs**, one per armed timer, executed sequentially in the order the
timers fire in the flow:

1. **Offer** (`OTO`) — `expiredOfferTest`
2. **Booking** (`BTO`) — `expiredBookingTest`
3. **Add-reservation** (`ARO`) — `expiredAddReservationOfferTest`
4. **Add-ancillary** (`ATO`) — `expiredAddAncillaryOfferTest`
5. **Refund-offer** (`RTO`) — `expiredRefundOfferTest`
6. **Exchange-offer** (`ETO`) — `expiredExchangeOfferTest`

**How to read the report.** Each sub-run's Bruno assertions are prefixed with
`[NHF_<3-letter>_<scenario_code>]`. For a scenario named `SC_PARIS_LYON` with
`expiredOfferTest` + `expiredBookingTest` both on, you'll see two distinct
sub-runs' assertions interleaved in the report:

```
[NHF_OTO_SC_PARIS_LYON] Expired offer: POST /bookings is rejected with a client error...
[NHF_OTO_SC_PARIS_LYON] Expired offer: error body is an RFC-9457 Problem...
[NHF_BTO_SC_PARIS_LYON] Expired booking: fulfillment is rejected with a client error...
[NHF_BTO_SC_PARIS_LYON] Expired booking: error body is an RFC-9457 Problem...
[NHF_BTO_SC_PARIS_LYON] Expired booking: admissions/reservations are EXPIRED/RELEASED/CANCELLED...
```

If your scenario code already starts with `NHF_`, the prefix isn't doubled:
`NHF_SC_FOO` + `OTO` → `[NHF_OTO_SC_FOO]`, not `[NHF_OTO_NHF_SC_FOO]`.

**Gating skips.** Timers that can't physically fire on the scenario are
silently dropped from the queue (with a `[WARNING]` log line so you know):

- `expiredRefundOfferTest` on a SALE scenario → skipped, REFUND only
- `expiredExchangeOfferTest` on a SALE scenario → skipped, EXCHANGE only
- `expiredAddReservationOfferTest` without `salesFlow_placeSelection` +
  `placeSelectionMode=ADD_TO_BOOKING` → skipped
- `expiredAddAncillaryOfferTest` without `salesFlow_addAncillary` → skipped

**Wait-budget math.** The worker SIGTERM budget for a scenario is the **sum**
of its enabled Max waits (each + 60 s buffer for the request and assertions
that follow). Three timers at 15 min each = ~46 min total, which would
exceed the default `RUN_HARD_MAX_TIMEOUT_MS` of 30 min — the runner clamps
and emits a clear `[WARNING]`. Either raise `RUN_HARD_MAX_TIMEOUT_MS` on the
server, or lower the per-timer Max waits.

**Backwards compatibility.** Single-timer scenarios behave identically to
before — same assertion names (no `NHF_…` prefix), same flow, same budget.
The auto-expansion mechanism only kicks in when the per-scenario queue has
2+ entries.

### 4.9 Partial refund (`partialRefundByLeg` / `partialRefundByPax`) — issue #218

For **REFUND** scenarios only. Scopes the refund-offer request to a subset of
the booking via OSDM's `RefundOfferRequest.refundSpecifications[]` (each entry
carries a `fulfillmentId` plus optional `bookingPartIds[]` for the per-leg axis
and `passengerIds[]` for the per-passenger axis).

| Field | Values | What it scopes |
|---|---|---|
| **`partialRefundByLeg`** | `off` / `on` | When on, the refund covers only one *leg* of a multi-leg booking (i.e. one of the admissions plus its linked reservations and ancillaries). |
| **`partialRefundLegSelection`** | `first` / `last` / `outbound` / `inbound` | Which leg. `outbound` / `inbound` only appear in the wizard for return-trip scenarios; on a one-way trip OSCAR falls back to `first`. |
| **`partialRefundByPax`** | `off` / `on` | When on, the refund covers only one passenger of a multi-passenger booking. |
| **`partialRefundPaxSelection`** | `first` / `last` | Which passenger (by booking-order). |

Both axes can be combined — `byLeg=on` + `byPax=on` refunds one passenger on one leg.

#### Setup-time validation (wizard)

The wizard blocks save with an inline warning when:

- `partialRefundByPax` is on but the resolved `passengersList` has fewer than 2 passengers
- `partialRefundByLeg` is on, the trip is a `SPECIFICATION` trip, and that trip has fewer than 2 legs
- `partialRefundLegSelection` is `outbound` / `inbound` but the trip isn't a return-trip → OSCAR auto-falls-back to `first`

`SEARCH`-mode trips can't be statically checked at authoring time (the offer is only known at run time) — the wizard shows an info note instead.

#### Runtime degradation (offer-time)

In `10. POST Refund Offers`'s before-request, OSCAR looks at the actual booking just retrieved by `07. GET Booking after Fulfillments` and resolves the scope:

- Per-leg requires the booking to have **≥ 2 admissions**. If the SEARCH-mode offer returned only 1 leg, the test **degrades** with `[WARNING] Partial refund degraded to full: booking has fewer than 2 admissions — leg-partial-refund requires a multi-leg booking.`
- Per-pax requires the booking to have **≥ 2 passengers** in `bookedOffer.passengerRefs` (with fallback to `booking.passengers[].id`).
- If either degradation fires, OSCAR sets `__partialRefundDegradedToFull=true` and the request is sent without `refundSpecifications` → a full refund happens, the regular full-refund assertions still fire, but the partial-scope assertions skip.

#### Assertions

When partial refund is armed AND not degraded:

| Assertion | Replaces |
|---|---|
| `refundFee + refundableAmount < confirmedPrice` (strict-less) | The standard full-refund `=` identity (which would fail by design) |
| `refundOfferBreakdownItems[].bookingParts[] ⊆ requested bookingPartIds` | (additional structural check; logs INFO when the response omits a breakdown) |

When partial refund is degraded: the standard full-refund financial-identity check fires unchanged.

> **One scenario, one shape today.** A scenario can either run a full refund OR a partial refund. To test "first-leg refund AND second-leg refund AND full refund" on the same booking, duplicate the scenario in the wizard with different `partialRefund*` settings — same auto-expansion pattern as the expired-X family, except today it's scenario-level (no `NHF_*` prefix for partial refunds).

### 4.10 Logging verbosity (`loggingType`, optional)

Per‑scenario verbosity for the execution log embedded in the report. Affects
log volume only — never assertion outcomes.

| Value | When to use |
|---|---|
| **`FULL`** | Maximum detail (default for new scenarios). Use for first‑time debugging or when reporting a bug. |
| **`INFO`** | Steps + key counts; skips the bulky per‑offer dumps. Recommended for routine runs. |
| **`DEBUG`** | INFO + the `[DEBUG]` traces the framework emits. |
| **`ERROR`** | Errors and warnings only — quietest. |

---

## 5. Running tests

- **Run one scenario** or **Run the collection** (all scenarios in
  `scenariosToRun`, from the top). A run starts at `GET /versions`, which also
  resets all per‑run state.
- **Concurrency** — OSCAR can run several sessions in parallel up to the global
  limit **and** the per‑company limit (the lower wins). If a vendor misbehaves
  under parallel load, set that company's limit to **1** to serialise.
- You'll get a **run** in the dashboard with a live status; when it finishes the
  **report** and a downloadable **JSON results** artifact are attached.

---

## 6. Reading the report

The run detail page has two collapsible cards (everything starts collapsed):

### Assertions
Two levels: **main area (suite)** → **endpoint (request)** → individual
assertions, with pass/fail counts at each level. Filters let you show all /
failed only.

- A green count = conformant. A red **N failed** on an otherwise `200` request
  means **OSDM compliance assertions** failed — i.e. the *response* deviates from
  the spec. That's a **finding about the vendor**, not an OSCAR error.
- Watch for the deliberately **trackable** assertions:
  - `[OSDM] Vendor serves a pre-booking (OFFER-context) seat map`
  - `[OSDM] Vendor serves a post-booking (BOOKING-context) seat map`
  - `[OSDM] Vendor supports booking multiple offers (round trip) in one booking`

  These are written to **fail loudly** when a vendor lacks an optional capability,
  so you can filter the report for "what this vendor can't do." A matching
  `⚠️ [VENDOR GAP]` line appears in the execution log. The flow still completes
  via the adaptive fallback.
- A **passing** row named `… not implemented by this provider (auto-detected)`
  on one of the optional, read-only steps — the System-Information catalogs
  (`01-System Infos Requests`), `04. GET Passenger`, `11. GET Refund Offer`,
  `12. GET Exchange Offer` — means the vendor answered that endpoint with a
  "not implemented" signal (501, an OSDM Problem `OPERATION_NOT_PERMITTED`, or
  a bare 404) or with a bare 403/405/500. That is **not a failure**: OSDM makes
  those endpoints optional. The execution log carries the detail — an `[INFO]`
  line for the clean signals, a `[WARNING]` line for a bare 403/405/500 (by the
  HTTP standard those codes mean something else; the line asks the vendor to
  answer 404 or 501 with a Problem body instead). A `401` on the same step is a
  token problem and still fails. In **Report Builder**, the Vendor Capability
  Matrix shows these same steps as `NOT_IMPLEMENTED` rather than `ERROR` — read
  it as the list of what the vendor supports and what it doesn't.
- After a **confirmed refund** (`14. GET Booking after Patch Refund`) or a
  **completed exchange** (`15. GET Booking after Fulfillment`), the booking
  check looks for `confirmedPrice`, not `provisionalPrice` — OSDM defines the
  confirmed price as the confirmed parts minus the confirmed refunds, and
  nothing is pre-booked any more at that point. An `[INFO]` line shows the
  confirmed price before and after the operation; whether it *should* drop by
  the refunded amount is still being clarified with the OSDM test-scenario
  team, so it is shown, not asserted.

### HTTP Traffic — Request & Response
Same suite → endpoint structure. Click any endpoint to lazily load its full
request body + response body (pretty‑printed) and headers. Use this to confirm
exactly what OSCAR sent (e.g. that `resourceId` resolved, or that
`placeSelections.places[]` has the right shape).

**HTTP status vs. assertion failures are different things.** A request can be
`200` (HTTP OK) and still have failed assertions (spec deviations), and vice‑versa.

---

## 7. Reference tables

### 7.1 Scenario parameters → where they go

| Parameter | Values | Affects request |
|---|---|---|
| Scenario type | `SALE` / `REFUND` / `EXCHANGE` | Which flow runs |
| Origin / Destination | station URN | `POST /offers` trip |
| Departure date | dynamic (`%TRIP_DATE%`) | `POST /offers` `departureTime` |
| Return offset (days) + return time | `0,1,2…` + `HH:MM` | `returnSearchParameters.inwardReturnDate` |
| Currency | `EUR`, … | `offerSearchCriteria.currency` |
| Service class | `STANDARD` `BEST` `HIGH` `BASIC` `ANY_CLASS` | `offerSearchCriteria` |
| Travel class | `FIRST` `SECOND` `ANY_CLASS` | `offerSearchCriteria` |
| Requested offer parts | `ADMISSION` `RESERVATION` `ANCILLARY` `FARE_*` `CONTINUOUS_SERVICE` `ALL` | `offerSearchCriteria` |
| Flexibility | `FULL_FLEXIBLE` `SEMI_FLEXIBLE` `NON_FLEXIBLE` | `offerSearchCriteria` |
| Offer mode | `INDIVIDUAL` `COLLECTIVE` | `offerSearchCriteria` |
| Overrule code | `PAYMENT_FAILURE` `DISRUPTION` | refund/exchange request |
| Sales‑flow actions | patchPassengers, placeSelection, addAncillary, getBooking, deleteAncillary | inserts the matching step |
| Seat‑selection mode | `SEATMAP_AT_OFFER` / `ADD_TO_BOOKING` | seat‑map step + `placeSelections` |
| Passenger type | `PERSON` `BICYCLE` `DOG` `PRM` … | passenger specs |
| Fulfillment type / media | `ETICKET`… / `PDF_A4`… | `requestedFulfillmentOptions` |
| `requestedInformationProbe` | `off` / `omit` / `invalid` | passenger‑info auto‑feed *or* a negative probe (§4.8) |
| `bookingPurchaserMode` | `inline` / `deferred` / `omit` / `invalid` | where the purchaser is sent + negative probe (§4.8) |
| `expiredBookingTest` | `off` / `on` | wait past the effective confirmation deadline (booking‑root `confirmationTimeLimit` / `confirmableUntil`, or the earliest part‑level `confirmableUntil`), assert rejection (§4.8) |
| `expiredBookingMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget for `expiredBookingTest`; auto‑extends the worker SIGTERM, clamped at `RUN_HARD_MAX_TIMEOUT_MS` (§4.8) |
| `expiredOfferTest` | `off` / `on` | wait past the earliest `OfferPart.validUntil`, assert `POST /bookings` is rejected (§4.8) |
| `expiredOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget for `expiredOfferTest`; auto‑extends the worker SIGTERM, clamped at `RUN_HARD_MAX_TIMEOUT_MS` (§4.8) |
| `expiredAddReservationOfferTest` | `off` / `on` | wait past the reservation-part `validUntil`, assert `09. POST Add Reservation` is rejected (§4.8). ADD_TO_BOOKING scenarios only |
| `expiredAddReservationOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget (§4.8) |
| `expiredAddAncillaryOfferTest` | `off` / `on` | wait past the earliest ancillary-part `validUntil`, assert `10. POST Add Ancillary` is rejected (§4.8). Add-ancillary scenarios only |
| `expiredAddAncillaryOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget (§4.8) |
| `expiredRefundOfferTest` | `off` / `on` | wait past `RefundOffer.validUntil`, assert `13. PATCH Refund Offer` is rejected (§4.8). REFUND scenarios only |
| `expiredRefundOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget (§4.8) |
| `expiredExchangeOfferTest` | `off` / `on` | wait past `ExchangeOffer.preBookableUntil` *(spec-naming quirk)*, assert `11. POST Exchange Operations` is rejected (§4.8). EXCHANGE scenarios only |
| `expiredExchangeOfferMaxWaitMinutes` | `1`–`60` (optional) | per‑scenario wait budget (§4.8) |
| `partialRefundByLeg` | `off` / `on` | scope refund to one leg via `RefundSpecification.bookingPartIds` (§4.9). REFUND scenarios only |
| `partialRefundLegSelection` | `first` / `last` / `outbound` / `inbound` | which leg (§4.9) |
| `partialRefundByPax` | `off` / `on` | scope refund to one passenger via `RefundSpecification.passengerIds` (§4.9). REFUND scenarios only |
| `partialRefundPaxSelection` | `first` / `last` | which passenger (§4.9) |
| `loggingType` | `FULL` / `INFO` / `DEBUG` / `ERROR` | execution‑log verbosity (§4.10) |

### 7.2 Sale‑flow step → OSDM request

| Step (collection) | OSDM call |
|---|---|
| `01 POST Get Offer` | `POST /offers` |
| `01b POST Get Return Offer` | `POST /offers` (inward leg) |
| `08 GET Place Maps` | `GET /availabilities/place-map?contextType=OFFER` |
| `08b GET Place Map Post-Booking` | `GET /availabilities/place-map?contextType=BOOKING` |
| `02 POST Create Booking` | `POST /bookings` |
| `09 POST Add Reservation` | `POST /bookings/{id}/booked-offers/{id}/{offer-parts\|reservations}` |
| `03 PATCH Multi Passenger` | `PATCH …/passengers` |
| `06 POST Fulfillments` | `POST /fulfillments` |

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `400 "Invalid request content"` on `POST /offers` | `offerSearchCriteria: {}` empty (no currency) on a strict vendor | Add a **currency** to the scenario's offer criteria. |
| `400` with `resourceId=%7B%7BreservationId%7D%7D` in the place‑map URL | The offer had **no reservation part**, so `reservationId` was empty | Use a train/class that includes a reservation; or expect the seat map to be skipped as "not applicable". |
| `400 "Invalid request content"` on `POST /bookings` after a seat pick | Malformed `placeSelections.places[]` | Should be fixed (OSDM `SelectedPlace = {coachNumber, placeNumber, passengerRef}`). If it recurs, capture the booking body and report it. |
| Intermittent `500`, same request sometimes works | Vendor **fragile under parallel load** | Lower the company **concurrency limit** to 1. |
| `501 parameter_not_supported` | Vendor conformantly **declines an optional capability** (e.g. no BOOKING‑context map) | Expected; the adaptive fallback continues. It's a capability finding, not a bug. |
| A step **passes** with `… not implemented by this provider (auto-detected)` plus an `[INFO]` or `[WARNING]` line | The vendor doesn't implement an **optional** endpoint (System-Info catalogs, GET Passenger, GET Refund/Exchange Offer) | Expected — nothing to fix in OSCAR. If the line is a `[WARNING]` (bare 403/405/500), ask the vendor to answer 404 or 501 with an OSDM Problem body. A `401` on the same step is a token problem and still fails. |
| `confirmedPrice missing` at booking stage REFUNDED / EXCHANGED | The vendor's booking omits `confirmedPrice` after a refund or exchange | A conformance finding: OSDM keeps `confirmedPrice` (confirmed parts minus confirmed refunds) on the booking at that stage; `provisionalPrice` is no longer expected there. |
| Seat map step (`08`) **missing** from the report on a `SEATMAP_AT_OFFER` scenario | The scenario's **mode wasn't actually saved** (stale value), so it ran `ADD_TO_BOOKING` | Open the scenario, click the **Seat map at offer** pill, save, re‑run. |
| Many "failed" assertions on `200` responses | OSDM **compliance** deviations in the vendor's responses | These are the conformance findings — review them; they're the point of the tool. |

---

## Glossary

- **OSDM** — Open Sales and Distribution Model (the rail retailing API standard).
- **Offer / Booking / Fulfillment** — the three OSDM sale stages.
- **Admission / Reservation / Ancillary** — kinds of *offer part* (the ticket,
  the seat, the extras).
- **Trackable assertion** — a deliberately‑failing check used to flag a vendor
  capability gap so it's easy to filter in the report.
- **Adaptive fallback** — OSCAR automatically takes an alternate path when a
  vendor rejects the spec‑preferred one (e.g. seat after booking; two bookings
  for a round trip).
