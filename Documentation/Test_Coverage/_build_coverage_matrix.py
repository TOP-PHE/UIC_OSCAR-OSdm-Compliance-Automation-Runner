# -*- coding: utf-8 -*-
"""
Build an OSCAR vs OSDM v3.8 endpoint coverage matrix.

Inputs:
  - Documentation/OSDM_reference/OSDM-online-api-v3.8.0.yml  (official spec)
  - Bruno_Collection/*/*.yml  (OSCAR's request inventory)
  - Bruno_Collection/library-bruno/*.js  (OSCAR's response assertions)

Outputs:
  - Documentation/OSCAR_Coverage_Gap_Analysis_v3.8.md
  - Console summary with defensible coverage %
"""
import re, json, yaml, sys
from pathlib import Path
from collections import defaultdict, OrderedDict

# Layout (since the script lives in Documentation/Test_Coverage/):
#   parents[0] = Documentation/Test_Coverage/   (this script's folder = HERE)
#   parents[1] = Documentation/
#   parents[2] = OSCAR repo root                (= ROOT, where Bruno_Collection lives)
HERE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[2]
SPEC = HERE / "OSDM_reference" / "OSDM-online-api-v3.8.0.yml"
OUT  = HERE / "OSCAR_Coverage_Gap_Analysis_v3.8.md"

# ── 1.  Load OSDM spec ─────────────────────────────────────────────────────
with SPEC.open(encoding="utf-8") as f:
    spec = yaml.safe_load(f)

HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")

osdm_ops = []   # list of dicts
for path, item in (spec.get("paths") or {}).items():
    for m in HTTP_METHODS:
        if m in item:
            op = item[m]
            osdm_ops.append({
                "method": m.upper(),
                "path":   path,
                "op_id":  op.get("operationId", "(no opId)"),
                "tag":    (op.get("tags") or ["(untagged)"])[0],
                "summary": op.get("summary", "").strip(),
            })

# Index by tag
by_tag = defaultdict(list)
for op in osdm_ops:
    by_tag[op["tag"]].append(op)

# ── 2.  Extract OSCAR request inventory ───────────────────────────────────
oscar_inventory = []

def request_files():
    for sub in ("00-Access Token", "01-System Infos Requests",
                "02-Common Requests", "03-Refund", "04-Exchange"):
        d = ROOT / "Bruno_Collection" / sub
        if not d.exists(): continue
        for p in sorted(d.glob("*.yml")):
            yield sub, p

for folder, fp in request_files():
    text = fp.read_text(encoding="utf-8", errors="replace")
    method_match = re.search(r"^\s*method:\s*(\w+)", text, re.M)
    url_match    = re.search(r"^\s*url:\s*[\"']?([^\"'\n]+?)[\"']?\s*$", text, re.M)
    name_match   = re.search(r"^\s*name:\s*(.+?)\s*$", text, re.M)
    if not method_match or not url_match:
        continue
    method = method_match.group(1).upper()
    url    = url_match.group(1).strip()
    # Strip query string + bases
    url_clean = re.sub(r"\?.*$", "", url)
    url_clean = url_clean.replace("{{api_base}}", "").replace("{{api-host}}", "").rstrip("/")

    # Bruno template vars come in TWO flavours:
    #   1. Path PARAMETERS (e.g. {{bookingId}}, {{passengerId}}) → maps to
    #      OpenAPI {bookingId} style.  Match against {.+} in spec.
    #   2. Path SEGMENT CONSTANTS that resolve to a known set at runtime
    #      depending on OSDM version / scenario config. E.g.
    #      {{addOfferPartResource}} → "offer-parts" (v3.7+) or "reservations"
    #      (<v3.7). These must EXPAND to multiple concrete URLs so the
    #      matcher can hit every covered spec path.
    SEGMENT_RESOLUTIONS = {
        "addOfferPartResource":  ["offer-parts", "reservations"],
        "addAncillaryResource":  ["offer-parts", "ancillaries"],
        "coachLayoutsResource":  ["coach-layouts", "coach-deck-layouts"],
    }

    # Identify segment-constant vars in this URL
    variants = [url_clean]
    for seg, resolutions in SEGMENT_RESOLUTIONS.items():
        pat = "{{" + seg + "}}"
        new_variants = []
        for v in variants:
            if pat in v:
                for r in resolutions:
                    new_variants.append(v.replace(pat, r))
            else:
                new_variants.append(v)
        variants = new_variants

    # Now turn the remaining {{xxx}} into {xxx} (path-parameter style).
    variants = [re.sub(r"\{\{(\w+)\}\}", r"{\1}", v) for v in variants]

    oscar_inventory.append({
        "folder": folder,
        "file":   fp.name,
        "name":   (name_match.group(1) if name_match else fp.stem),
        "method": method,
        "url":    url,
        "url_variants": variants,
    })

# ── 3.  Match OSCAR requests → OSDM operations ────────────────────────────
def opath_to_regex(opath):
    # OpenAPI path like /bookings/{bookingId}/refund-offers/{id}
    # → /bookings/[^/]+/refund-offers/[^/]+
    parts = re.split(r"\{[^}]+\}", opath)
    return "^" + r"[^/]+".join(re.escape(p) for p in parts) + "$"

def match_oscar_to_osdm(oscar_url_variants, oscar_method):
    """Return the list of OSDM operations that any of the URL variants hits."""
    candidates = []
    for op in osdm_ops:
        if op["method"] != oscar_method:
            continue
        rx = opath_to_regex(op["path"])
        if any(re.fullmatch(rx, v) for v in oscar_url_variants):
            candidates.append(op)
    return candidates

# Coverage map: OSDM (method, path) → list of OSCAR requests that hit it
osdm_hits = defaultdict(list)
oscar_unmapped = []
for req in oscar_inventory:
    matches = match_oscar_to_osdm(req["url_variants"], req["method"])
    if matches:
        for m in matches:
            osdm_hits[(m["method"], m["path"])].append(req)
    else:
        oscar_unmapped.append(req)

# ── 4.  Per-tag coverage stats ─────────────────────────────────────────────
print("=" * 78)
print(f"OSDM v3.8.1 spec: {len(osdm_ops)} operations across {len(by_tag)} domains.")
print(f"OSCAR Bruno collection: {len(oscar_inventory)} request files.")
print(f"OSCAR-side requests with no OSDM match (non-OSDM hosts, mainly OAuth): "
      f"{len(oscar_unmapped)}")
print("=" * 78)
tag_rows = []
total_ops = 0
total_covered = 0
for tag in sorted(by_tag.keys()):
    ops = by_tag[tag]
    covered = sum(1 for op in ops if (op["method"], op["path"]) in osdm_hits)
    pct = 100.0 * covered / len(ops) if ops else 0.0
    tag_rows.append((tag, covered, len(ops), pct))
    total_ops += len(ops)
    total_covered += covered

# Print summary table
print(f"\n{'Domain':<28}  {'Covered':>9}  {'Total':>6}  {'%':>7}")
print("-" * 60)
for tag, c, t, p in tag_rows:
    print(f"{tag:<28}  {c:>9}  {t:>6}  {p:>6.1f}%")
print("-" * 60)
total_pct = 100.0 * total_covered / total_ops
print(f"{'TOTAL':<28}  {total_covered:>9}  {total_ops:>6}  {total_pct:>6.1f}%")

# ── 5.  Markdown output ────────────────────────────────────────────────────
md = []
md.append("# OSCAR vs OSDM v3.8 — Coverage Gap Analysis")
md.append("")
md.append(f"*Authoritative coverage study against the official OSDM v3.8.0 OpenAPI specification (UIC 90918-10, repo `UnionInternationalCheminsdeFer/OSDM` @ tag `v3.8.1`).*")
md.append("")
md.append(f"**Release at time of analysis**: server-v1.11.95 / collection OTST_V2.0.43 / release 2026.123.")
md.append("")
md.append("> ### Why this document exists")
md.append(">")
md.append("> An earlier overview deck quoted **~90% happy-flow coverage** and **100% non-happy-flow coverage**. Those numbers were eyeballed against an implicit denominator (\"the parts of OSDM OSCAR was built for\"), not measured against the spec. This study fixes that by computing endpoint coverage against the authoritative OSDM v3.8.0 OpenAPI definition.")
md.append(">")
md.append(f"> **Honest headline: {total_pct:.1f}% of OSDM v3.8 operations are exercised by OSCAR today** ({total_covered} of {total_ops}). The 90% figure was wrong.")
md.append("")
md.append("> **Method**. The OSDM spec was downloaded and parsed (`pyyaml`); 94 operations were extracted from the 69 paths × HTTP methods. OSCAR's Bruno request files were enumerated and matched against the OSDM paths (`{{bookingId}}` → `{bookingId}`; Bruno's version-aware path segments such as `{{addOfferPartResource}}` were expanded to both their possible resolutions `[offer-parts, reservations]` so any spec path either form covers is credited). For each OSDM operation, OSCAR is **covered** iff at least one Bruno request file targets the same (method, path) pair. The matching script lives at `Documentation/_build_coverage_matrix.py` so the numbers can be regenerated by anyone.")
md.append("")
md.append("> **What this study does NOT measure** (yet):")
md.append("> - **Field-level assertion depth.** A covered operation may assert only 3 of 30 response fields. The coverage map (`OSCAR_Test_Coverage_Map.md`) describes the validators per endpoint but does not compute a per-field %.")
md.append("> - **Non-happy-flow breadth.** The 6 expired-X timer family is comprehensive within its domain, but other NHF families (authorization scoping, rate limit, idempotency, ETag/If-Match concurrency, schema-violation sweeps outside the requestedInformation probe, boundary conditions, HTTP-level negatives) are largely uncovered. Section 6 below sketches the inventory.")
md.append("> - **Webhook coverage.** OSDM publishes a separate webhook spec (`OSDM-online-webhook-v3.8.0.yml`) — not analysed here.")
md.append("> - **Provider-side semantic compliance.** OSCAR checks that the provider returns a response that LOOKS conformant; it does not exhaustively assert business logic (correct prices, valid fulfillment documents, etc.).")
md.append("")
md.append("---")
md.append("")
md.append("## 1.  Endpoint coverage at a glance")
md.append("")
md.append(f"| Metric | Value |")
md.append(f"|---|---|")
md.append(f"| OSDM v3.8 operations defined | **{total_ops}** |")
md.append(f"| OSDM operations OSCAR exercises | **{total_covered}** |")
md.append(f"| OSDM endpoint coverage | **{total_pct:.1f}%** |")
md.append(f"| OSDM functional domains (tags) | {len(by_tag)} |")
md.append(f"| OSDM domains touched by OSCAR | {sum(1 for _,c,_,_ in tag_rows if c>0)} |")
md.append(f"| OSDM domains fully covered (100%) | {sum(1 for _,c,t,_ in tag_rows if c==t)} |")
md.append(f"| OSDM domains untouched (0%) | {sum(1 for _,c,_,_ in tag_rows if c==0)} |")
md.append(f"| Bruno request files inventoried | {len(oscar_inventory)} |")
md.append("")

# ── 6.  Per-domain table ──────────────────────────────────────────────────
md.append("## 2.  Per-domain breakdown")
md.append("")
md.append("Coverage by OSDM functional domain (`tags` in the OpenAPI spec):")
md.append("")
md.append("| Domain | Covered / Total | % | Status |")
md.append("|---|---|---|---|")
for tag, c, t, p in sorted(tag_rows, key=lambda r: (-r[3], r[0])):
    status = ("✅ Full" if c == t else
              "🟡 Partial" if c > 0 else
              "🔴 None")
    md.append(f"| {tag} | {c} / {t} | {p:.0f}% | {status} |")
md.append("")

# ── 7.  Detailed per-operation table by domain ─────────────────────────────
md.append("## 3.  Detailed operation table")
md.append("")
md.append("Per-operation status across every OSDM v3.8 endpoint. Status keys:")
md.append("- **✅** covered (Bruno request fires this method × path)")
md.append("- **🔴** not covered")
md.append("")
for tag in sorted(by_tag.keys()):
    ops = by_tag[tag]
    md.append(f"### {tag}")
    md.append("")
    md.append("| Status | Method | Path | OSDM operationId | OSCAR file |")
    md.append("|---|---|---|---|---|")
    for op in sorted(ops, key=lambda o: (o["path"], o["method"])):
        hits = osdm_hits.get((op["method"], op["path"]), [])
        if hits:
            files = "<br>".join(f"`{h['folder']}/{h['file']}`" for h in hits)
            status = "✅"
        else:
            files = "—"
            status = "🔴"
        md.append(f"| {status} | `{op['method']}` | `{op['path']}` | `{op['op_id']}` | {files} |")
    md.append("")

# ── 8.  OSCAR-side requests that did not match an OSDM 3.8 operation ──────
md.append("## 4.  OSCAR requests not mapped to an OSDM 3.8 operation")
md.append("")
md.append("Mostly OAuth token endpoints (vendor-specific, outside OSDM scope) plus a few special paths.")
md.append("")
md.append("| File | Method | URL |")
md.append("|---|---|---|")
for r in oscar_unmapped:
    md.append(f"| `{r['folder']}/{r['file']}` | `{r['method']}` | `{r['url']}` |")
md.append("")

# ── 9.  Headline numbers section ──────────────────────────────────────────
covered_tags = [t for t,c,_,_ in tag_rows if c>0]
untouched_tags = [t for t,c,t_total,_ in tag_rows if c==0]
md.append("## 5.  Honest summary numbers")
md.append("")
md.append(f"- **OSDM endpoint coverage: {total_pct:.1f}%** ({total_covered}/{total_ops} operations).")
md.append(f"- **Functional domains untouched: {len(untouched_tags)} / {len(by_tag)}**.")
md.append(f"  - {', '.join(untouched_tags) if untouched_tags else '(none)'}")
md.append("")
md.append("The big gaps (untouched OSDM domains) cluster around:")
for tag in untouched_tags:
    n = len(by_tag[tag])
    md.append(f"  - **{tag}** ({n} operations)")
md.append("")
md.append("Note: an operation marked ✅ above means OSCAR fires the request and asserts SOMETHING. It does NOT mean every response field is asserted. A field-level audit on the covered subset is needed for a complete picture and is the next planned task.")
md.append("")

# ── 11. Non-happy-flow coverage inventory ─────────────────────────────────
md.append("---")
md.append("")
md.append("## 6.  Non-happy-flow coverage — honest inventory")
md.append("")
md.append("The earlier deck claimed **100% NHF coverage** — that was wrong. It was 100% of *one family* (expired-X timers). The actual NHF picture is:")
md.append("")
md.append("### Covered today")
md.append("")
md.append("| Family | What's tested | Source |")
md.append("|---|---|---|")
md.append("| Expired-X timers (6 timers) | Offer / Booking / Add-Reservation / Add-Ancillary / Refund-Offer / Exchange-Offer — wait past deadline, assert 4xx + RFC-9457 Problem | `library-bruno/expiredFlow.js` |")
md.append("| requestedInformation probes (3 modes) | `off` (auto-feed) / `omit` (clear field) / `invalid` (per-field sweep with stringent-vs-lenient grading) | `library-bruno/requestedInformation.js` |")
md.append("| Purchaser modes (4 modes) | `inline` / `deferred` / `omit` / `invalid` — GET-adaptive upsert chooses PATCH or POST | `library-bruno/requestsBuilder.js` |")
md.append("| IROPS overrule codes | `appliedOverruleCode == sent`; refund financial-identity preservation; exchange fee consistency | `refunds.js` / `exchanges.js` |")
md.append("| Auth-failure detection | Access-token endpoint failure → STOP; first 401/403 on downstream → diagnostic + abort | `library-bruno/auth.js` |")
md.append("| Vendor-gap trackable FAILs (3 markers) | OFFER seat map / BOOKING seat map / multi-offer round-trip | `02-Common/02.yml`, `08.yml`, `08b.yml` |")
md.append("")
md.append("### NOT covered today — backlog candidates")
md.append("")
md.append("| Family | What would be tested | Why it matters |")
md.append("|---|---|---|")
md.append("| Authorization scoping | Tester A tries to read/modify Tester B's booking | Multi-tenant safety guarantee |")
md.append("| Rate limiting | Spam endpoint; assert 429 + `Retry-After` honoured | Operational behaviour under load |")
md.append("| Idempotency (`Idempotency-Key`) | Replay same request; assert same response | OSDM-recommended for POST safety |")
md.append("| Concurrent modification (`If-Match` / ETag) | Two clients PATCH same booking concurrently; assert 412 Precondition Failed | Optimistic locking conformance |")
md.append("| Schema-violation sweep beyond requestedInformation | Wrong type / unknown enum / out-of-range value on every documented field | Currently we only sweep the 6 RI passenger fields + 4 purchaser fields |")
md.append("| Boundary conditions | Empty arrays, max-length strings, currency overflow, date-too-far | Robustness against well-formed but extreme inputs |")
md.append("| Cross-resource consistency | Booking references a passengerRef that doesn't exist; an offerId that's already booked | Integrity of identifier graph |")
md.append("| HTTP-level negatives | Wrong `Content-Type`; unsupported HTTP method; missing `Accept` header | Layer-4 conformance |")
md.append("| Currency / locale variants | Same offer in EUR / GBP / CHF; language fallback chains | i18n robustness |")
md.append("| OSDM-spec-defined error responses | Each spec endpoint declares `400/401/403/404/409/410/500` envelopes — we assert RFC-9457 shape on a few, not all | Layer-1 negative compliance |")
md.append("| Webhook delivery | OSCAR doesn't expose a webhook receiver to test the provider's outbound notifications | Whole NHF axis untouched |")
md.append("| On-hold / Release flows (where supported by provider) | Provider rejects fulfillment of a RELEASED booking | OSDM domain tags `On Hold` (3 ops) + `Release` (4 ops) currently 0% covered |")
md.append("")
md.append("**Honest NHF summary**: roughly **6 negative-test families covered**, **11+ families absent**. The expired-flow family is mature; everything else is early-stage or missing. The earlier \"100% NHF\" claim was a per-family overstatement, not a coverage claim.")
md.append("")


# ── 10.  Save ──────────────────────────────────────────────────────────────
OUT.write_text("\n".join(md), encoding="utf-8")
print(f"\nWrote {OUT}")
print(f"Total markdown lines: {len(md)}")
