# OSCAR — Test Coverage Reference

*Everything in this folder answers one question: **what does OSCAR actually test against an OSDM-conformant provider, and how big are the gaps?***

Numbers in this folder are measured, not eyeballed. They are reproducible from the source scripts; when the underlying Bruno collection or OSDM spec moves, re-run the builders.

---

## Headline (release 2026.123 · server-v1.11.95 · OTST_V2.0.43, against OSDM v3.8.0)

| Axis | Number | What it means |
|---|---|---|
| **Endpoint coverage (breadth)** | **36.2%** | 34 of 94 OSDM v3.8 operations are fired by OSCAR |
| **Field-level coverage (depth)** | **40.9%** | On those 34 operations, 1 534 of 3 750 response fields are asserted |
| **Combined OSDM surface area** | **~14.8%** | breadth × depth — the share of OSDM v3.8 that is both fired AND asserted |

---

## What lives here

| File | Purpose |
|---|---|
| `OSCAR_Test_Coverage_Map.md` | Narrative reference: per-endpoint description of what OSCAR varies in the request + what it asserts in the response. Reads as documentation rather than a matrix. Cited by Tester Guide §4.8 and the deck. |
| `OSCAR_Coverage_Gap_Analysis_v3.8.md` | **Endpoint matrix**: every OSDM v3.8 operation × `[covered / not covered]`, grouped by domain, with the matching Bruno file when covered. Per-domain coverage % + headline summary. |
| `OSCAR_Field_Level_Coverage_v3.8.md` | **Field matrix**: for each covered operation, the list of response-schema fields, marked `asserted` or `not asserted`. Per-domain field-level %. Lists the most-asserted and most-skipped field names across the spec — the latter is the prioritised backlog. |
| `OSCAR_Field_Level_Coverage_v3.8.json` | Machine-readable dump of the field analysis (same data as the `.md`, for downstream tooling). |
| `_build_coverage_matrix.py` | Source script for the endpoint matrix. Re-runnable. |
| `_build_field_level_coverage.py` | Source script for the field analysis. Re-runnable. |
| `OSDM_reference/OSDM-online-api-v3.8.0.yml` | Authoritative OSDM v3.8.0 OpenAPI spec, vendored from `github.com/UnionInternationalCheminsdeFer/OSDM` @ tag `v3.8.1`. The analysis runs offline against this copy so results are deterministic. |

---

## How to regenerate the analysis

Both scripts require Python 3.10+ and `pyyaml` (`pip install pyyaml`). Run from the OSCAR repo root, in any order:

```bash
python Documentation/Test_Coverage/_build_coverage_matrix.py
python Documentation/Test_Coverage/_build_field_level_coverage.py
```

Each script overwrites its own outputs in this folder. Both scripts auto-detect:

- The OSDM spec at `OSDM_reference/OSDM-online-api-v3.8.0.yml` (sibling to the scripts).
- The OSCAR Bruno collection at `<repo-root>/Bruno_Collection/` and the library JS at `<repo-root>/Bruno_Collection/library-bruno/`.

If a Bruno request file is added, removed or renamed, **just re-run** — the numbers update automatically.

---

## How to upgrade to a newer OSDM version

1. Download the target spec from `https://github.com/UnionInternationalCheminsdeFer/OSDM/tree/<tag>/specification/v<version>/` into `OSDM_reference/`.
2. Update the `SPEC` path in both `_build_*.py` files (single line each).
3. Re-run the two scripts. New per-operation rows will surface; covered/not-covered status reshuffles based on the new spec's path shapes.
4. Update this README's "Headline" section and the deck (`Documentation/OSCAR_in_a_nutshell.pptx`) — both are anchored to the run-time numbers.

---

## Methodology — what's measured, what's not

### Endpoint matrix (breadth)

- For each (method, path) operation in OSDM v3.8, OSCAR is **covered** iff at least one Bruno request file targets it.
- Bruno's path templates `{{bookingId}}` are normalised to OpenAPI's `{bookingId}` form for matching.
- Bruno's **version-aware path segments** (e.g. `{{addOfferPartResource}}` → `offer-parts` in OSDM ≥3.7, `reservations` in <3.7) are expanded to all resolutions before matching, so a single Bruno file legitimately credits multiple spec paths it covers under different versions.
- Query strings are stripped before matching.

### Field matrix (depth)

- For each covered operation, the 200/201 success response schema's `$ref` chain is walked to **depth 2** from the response root. `allOf` is merged; `oneOf` / `anyOf` are unioned. Array-of-object payloads contribute their item fields.
- A field is **asserted** iff its name appears in OSCAR's validator code (library-bruno `.js` + all after-response blocks in request `.yml` files) in a **code-property-access shape**:
  - `.fieldName`
  - `["fieldName"]` or `['fieldName']`
  - bare destructure `const { fieldName, ... } = body`
- Generic leaf names (`id`, `type`, `code`, `status`, `name`, `title`, `value`, `amount`, `description`, `url`, `href`) need the **parent.field** dotted form to credit, to avoid false-positives from generic property names appearing everywhere.
- Comments and log strings do not count.

### What is NOT measured here

- **Semantic depth of assertions**: a field marked asserted may be checked with `expect(x).to.exist` OR with a full business-rule expression. We do not distinguish.
- **Negative-test breadth**: the expired-flow family and the `requestedInformation` probes are documented in the coverage map but not aggregated into a single %. They are an orthogonal axis.
- **Webhook coverage**: OSDM publishes a separate webhook spec (`OSDM-online-webhook-v3.8.0.yml`); not analysed.
- **Provider-side conformance**: OSCAR's `||`-fallback patterns (read either `confirmationTimeLimit` or `confirmableUntil`) may credit a field as asserted even when a specific provider returns the other variant. Cross-check against `Documentation/OSDM/OSDM_Spec_Deviations_Observed_*.md` when assessing a single provider.

---

## Honest interpretation

The combined ~15% surface-area number is **the floor of what OSCAR meaningfully tests**. A previous overview deck quoted ~90% happy / 100% non-happy flow; those were wrong by a wide margin — eyeballed, not measured. This folder fixes that.

There are two independent growth axes from here:

- **Breadth** — close the 14 OSDM domains currently at 0% coverage. The lowest-hanging fruit are `Cancel Fulfillments` (4 ops), `Reimbursement Management` (3), `On Hold` (3), `Release` (4), `Bookings` PATCH/DELETE (2), `Bookings Search/Split` (2).
- **Depth** — increase field assertions on the 34 covered operations. The biggest skipped clusters are: the RFC-9457 Problem envelope sub-fields (`problems[].status / .title / .type / .instance` — appear unasserted across 30 ops), the warnings envelope, HATEOAS `_links.href / .rel`, and the financial fields on `bookedOffers[]` (`fares`, `fees`, `vats`, `appliedCurrencyConversion`).

Closing both axes together — one P1 endpoint per sprint + one validator increment — would realistically move the surface-area number from ~15% to ~30% within a few releases. The number you can credibly defend today is **15%**.
