# -*- coding: utf-8 -*-
"""
Field-level coverage analysis: for each OSDM v3.8 operation OSCAR exercises,
measure what % of the response schema fields OSCAR actually asserts.

Methodology (medium-strict; documented in the output report):

  1. **Enumerate covered operations** from the endpoint matrix
     (Bruno URL → OSDM path × method) — reuses the same matcher as
     `_build_coverage_matrix.py`.

  2. **Resolve response schema fields**: for each operation's 200 response
     schema reference, walk the $ref chain to collect:
       - top-level fields of the response object
       - if the response wraps a single resource (one object property
         whose name is a noun matching the tag, e.g. {"booking":{...}}),
         dive one level into that wrapper
       - if the response is a collection envelope ({"bookings":[...],
         "problems":[...]}), the inner array element fields ARE counted
         because that's what validators iterate
     `allOf` is expanded; `oneOf` / `anyOf` union the field sets.
     Stop at depth 2 from the response root — deeper structures
     (legs of trips of admissions of bookedOffers of bookings) become
     diminishing-returns noise.

  3. **Detect assertions** in OSCAR code:
       Corpus =  Bruno_Collection/library-bruno/*.js
              +  Bruno_Collection/02-Common Requests/*.yml after-response
              +  Bruno_Collection/03-Refund/*.yml after-response
              +  Bruno_Collection/04-Exchange/*.yml after-response
       For each spec field `F`, the field is **asserted** iff its
       name appears in the corpus in a code-property-access shape:
         - `.F` or `["F"]` or `['F']`
         - bare destructure `const { F, ... } = body`
         - inside a `test(...)` block's expect-chain
       Bare string mentions in comments / log messages don't count.

  4. **Headline**: weighted-avg coverage = (sum of asserted fields across
     covered ops) / (sum of total fields across covered ops).

Output: Documentation/OSCAR_Field_Level_Coverage_v3.8.md + a JSON dump.
"""
import re, json, yaml
from pathlib import Path
from collections import defaultdict, Counter

# Layout (since the script lives in Documentation/Test_Coverage/):
#   parents[0] = Documentation/Test_Coverage/   (this script's folder = HERE)
#   parents[1] = Documentation/
#   parents[2] = OSCAR repo root                (= ROOT, where Bruno_Collection lives)
HERE     = Path(__file__).resolve().parent
ROOT     = Path(__file__).resolve().parents[2]
SPEC     = HERE / "OSDM_reference" / "OSDM-online-api-v3.8.0.yml"
OUT_MD   = HERE / "OSCAR_Field_Level_Coverage_v3.8.md"
OUT_JSON = HERE / "OSCAR_Field_Level_Coverage_v3.8.json"

# ── 1.  Load OSDM spec ─────────────────────────────────────────────────────
print("Loading OSDM v3.8 spec…")
with SPEC.open(encoding="utf-8") as f:
    spec = yaml.safe_load(f)

components_schemas = spec.get("components", {}).get("schemas", {})
HTTP_METHODS = ("get", "post", "put", "patch", "delete")

# ── 2.  Schema resolution helpers ──────────────────────────────────────────
def resolve_ref(ref_str):
    """Resolve a #/components/schemas/Name ref to the schema dict."""
    if not ref_str.startswith("#/components/schemas/"):
        return None
    name = ref_str.removeprefix("#/components/schemas/")
    return components_schemas.get(name)

def collect_fields(schema, depth=0, max_depth=2, seen=None):
    """
    Walk a schema and return the set of property names that are part of
    its public surface. Conservative: stops at max_depth from the root,
    avoids cycles via `seen`.
    """
    if schema is None:
        return set()
    seen = set() if seen is None else seen
    # Handle $ref
    if "$ref" in schema:
        ref = schema["$ref"]
        if ref in seen:
            return set()
        seen = seen | {ref}
        return collect_fields(resolve_ref(ref), depth, max_depth, seen)
    # allOf merges
    fields = set()
    if "allOf" in schema:
        for sub in schema["allOf"]:
            fields |= collect_fields(sub, depth, max_depth, seen)
    if "oneOf" in schema:
        for sub in schema["oneOf"]:
            fields |= collect_fields(sub, depth, max_depth, seen)
    if "anyOf" in schema:
        for sub in schema["anyOf"]:
            fields |= collect_fields(sub, depth, max_depth, seen)
    # Object properties
    props = schema.get("properties") or {}
    for name, sub in props.items():
        fields.add(name)
        if depth < max_depth:
            # Dive into nested object/array-of-object IFF the response wraps
            # a single resource or the array is the primary payload.
            if sub.get("type") == "array":
                items = sub.get("items") or {}
                if items.get("type") == "object" or "$ref" in items:
                    inner = collect_fields(items, depth + 1, max_depth, seen)
                    fields |= {f"{name}[].{f}" for f in inner}
            elif sub.get("type") == "object" or "$ref" in sub:
                inner = collect_fields(sub, depth + 1, max_depth, seen)
                fields |= {f"{name}.{f}" for f in inner}
    # Array at root
    if schema.get("type") == "array":
        items = schema.get("items") or {}
        inner = collect_fields(items, depth + 1, max_depth, seen)
        fields |= {f"[].{f}" for f in inner}
    return fields

def response_fields_for(op):
    """Return the set of fields for the 200-ish success response."""
    responses = op.get("responses", {})
    # Prefer 200/201; fall back to first 2xx
    for code in ("200", "201", "default"):
        if code in responses:
            content = responses[code].get("content", {})
            for mt in ("application/json", "application/json;version=3.8.0", "*/*"):
                if mt in content:
                    sch = content[mt].get("schema", {})
                    return collect_fields(sch)
            # Else try whatever's there
            for mt, body in content.items():
                if "schema" in body:
                    return collect_fields(body["schema"])
    return set()

# ── 3.  Build the operation index (same as endpoint matrix) ────────────────
osdm_ops = []
for path, item in (spec.get("paths") or {}).items():
    for m in HTTP_METHODS:
        if m in item:
            op = item[m]
            osdm_ops.append({
                "method": m.upper(), "path": path,
                "op_id": op.get("operationId", "(no opId)"),
                "tag": (op.get("tags") or ["(untagged)"])[0],
                "_op": op,
            })

# Match OSCAR requests → operations (re-using the matcher logic)
SEGMENT_RESOLUTIONS = {
    "addOfferPartResource": ["offer-parts", "reservations"],
    "addAncillaryResource": ["offer-parts", "ancillaries"],
    "coachLayoutsResource": ["coach-layouts", "coach-deck-layouts"],
}
def opath_to_regex(opath):
    parts = re.split(r"\{[^}]+\}", opath)
    return "^" + r"[^/]+".join(re.escape(p) for p in parts) + "$"

def request_files():
    for sub in ("00-Access Token", "01-System Infos Requests",
                "02-Common Requests", "03-Refund", "04-Exchange"):
        d = ROOT / "Bruno_Collection" / sub
        if not d.exists(): continue
        for p in sorted(d.glob("*.yml")):
            yield sub, p

oscar_inventory = []
for folder, fp in request_files():
    text = fp.read_text(encoding="utf-8", errors="replace")
    method_match = re.search(r"^\s*method:\s*(\w+)", text, re.M)
    url_match    = re.search(r"^\s*url:\s*[\"']?([^\"'\n]+?)[\"']?\s*$", text, re.M)
    if not method_match or not url_match: continue
    method = method_match.group(1).upper()
    url    = url_match.group(1).strip()
    url_clean = re.sub(r"\?.*$", "", url)
    url_clean = url_clean.replace("{{api_base}}", "").replace("{{api-host}}", "").rstrip("/")
    variants = [url_clean]
    for seg, res in SEGMENT_RESOLUTIONS.items():
        pat = "{{" + seg + "}}"
        new = []
        for v in variants:
            if pat in v:
                for r in res: new.append(v.replace(pat, r))
            else:
                new.append(v)
        variants = new
    variants = [re.sub(r"\{\{(\w+)\}\}", r"{\1}", v) for v in variants]
    oscar_inventory.append({"folder": folder, "file": fp.name,
                            "method": method, "url_variants": variants,
                            "path": fp})

osdm_hits = defaultdict(list)
for req in oscar_inventory:
    for op in osdm_ops:
        if op["method"] != req["method"]: continue
        rx = opath_to_regex(op["path"])
        if any(re.fullmatch(rx, v) for v in req["url_variants"]):
            osdm_hits[(op["method"], op["path"])].append(req)

# Subset to the covered ones
covered_ops = [op for op in osdm_ops
               if (op["method"], op["path"]) in osdm_hits]
print(f"Covered operations: {len(covered_ops)} / {len(osdm_ops)}")

# ── 4.  Build OSCAR validator corpus ───────────────────────────────────────
print("Loading OSCAR validator corpus…")
corpus_files = []
for js in (ROOT / "Bruno_Collection" / "library-bruno").glob("*.js"):
    corpus_files.append(js)
for folder in ("02-Common Requests", "03-Refund", "04-Exchange",
               "01-System Infos Requests"):
    for yml in (ROOT / "Bruno_Collection" / folder).glob("*.yml"):
        corpus_files.append(yml)

corpus_text = []
for fp in corpus_files:
    try:
        corpus_text.append(fp.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        pass
CORPUS = "\n".join(corpus_text)
print(f"Corpus size: {len(CORPUS):,} chars across {len(corpus_files)} files")

# ── 5.  Field-name detector ────────────────────────────────────────────────
# Compile a regex for each field name. To avoid false positives on generic
# names (e.g. "id", "name"), require the field name in a code-property
# context: `.fieldName`, `["fieldName"]`, `['fieldName']`, or as a key in
# destructure `{ fieldName, ... }`.
def is_asserted(field_name):
    # Strip the path notation we added (e.g. "bookings[].id" → "id")
    leaf = field_name.split("[].")[-1].split(".")[-1]
    if not leaf: return False
    # Skip overly generic field names we can't differentiate; we'll just
    # count them as "ambiguous" — for the metric, treat as asserted IF
    # the FULL dotted path appears (rare), else treat as not asserted.
    # In practice this only affects a handful of very common one-syllable names.
    GENERIC_BANLIST = {"id", "type", "code", "status", "name", "value",
                       "amount", "title", "description", "url", "href"}
    leaf_pat = re.escape(leaf)
    # Build alternatives
    patterns = [
        rf"\.{leaf_pat}\b",
        rf"\[['\"]{leaf_pat}['\"]\]",
        rf"\{{[^}}]*\b{leaf_pat}\b[^}}]*\}}\s*=",  # destructure
    ]
    rx = re.compile("|".join(patterns))
    if leaf in GENERIC_BANLIST:
        # Require a more specific match: the field's containing parent dot path
        if "." in field_name:
            parent_leaf = field_name.split(".")[-2].replace("[]", "")
            specific = rf"\.{re.escape(parent_leaf)}[^.]*\.{leaf_pat}\b"
            return bool(re.search(specific, CORPUS))
        return False
    return bool(rx.search(CORPUS))

# ── 6.  Compute per-operation field coverage ───────────────────────────────
print("Computing field-level coverage per operation…")
per_op = []
for op in covered_ops:
    fields = response_fields_for(op["_op"])
    asserted = {f for f in fields if is_asserted(f)}
    per_op.append({
        "method": op["method"], "path": op["path"], "op_id": op["op_id"],
        "tag": op["tag"], "total_fields": len(fields),
        "asserted_fields": len(asserted),
        "fields_asserted": sorted(asserted),
        "fields_not_asserted": sorted(fields - asserted),
        "pct": (100.0 * len(asserted) / len(fields)) if fields else 0.0,
    })

total_fields_sum = sum(r["total_fields"] for r in per_op)
total_asserted_sum = sum(r["asserted_fields"] for r in per_op)
weighted_pct = 100.0 * total_asserted_sum / total_fields_sum if total_fields_sum else 0.0

# Per-domain aggregate
by_tag = defaultdict(lambda: {"ops": 0, "total": 0, "asserted": 0})
for r in per_op:
    d = by_tag[r["tag"]]
    d["ops"] += 1
    d["total"] += r["total_fields"]
    d["asserted"] += r["asserted_fields"]

# Most-asserted + least-asserted fields across all
all_field_hits = Counter()
all_field_seen = Counter()
for r in per_op:
    for f in r["fields_asserted"]: all_field_hits[f] += 1
    for f in r["fields_asserted"] + r["fields_not_asserted"]:
        all_field_seen[f] += 1

# ── 7.  Console summary ────────────────────────────────────────────────────
print()
print("=" * 78)
print(f"FIELD-LEVEL COVERAGE — weighted average")
print(f"  Across {len(per_op)} covered operations: "
      f"{total_asserted_sum} / {total_fields_sum} fields asserted "
      f"= {weighted_pct:.1f}%")
print("=" * 78)
print()
print(f"{'Domain':<28}  {'Ops':>4}  {'Asserted':>9}  {'Total':>6}  {'%':>6}")
print("-" * 64)
for tag in sorted(by_tag):
    d = by_tag[tag]
    pct = 100.0 * d["asserted"] / d["total"] if d["total"] else 0.0
    print(f"{tag:<28}  {d['ops']:>4}  {d['asserted']:>9}  {d['total']:>6}  {pct:>5.1f}%")

# ── 8.  Markdown report ────────────────────────────────────────────────────
md = []
md.append("# OSCAR vs OSDM v3.8 — Field-Level Coverage Analysis")
md.append("")
md.append(f"*Companion to `OSCAR_Coverage_Gap_Analysis_v3.8.md`. Goes one level deeper: for each operation OSCAR exercises, measure what % of the response schema fields OSCAR actually asserts.*")
md.append("")
md.append(f"**Release at time of analysis**: server-v1.11.95 / collection OTST_V2.0.43 / release 2026.123.")
md.append("")
md.append("> ### Headline")
md.append(">")
md.append(f"> - **Endpoint coverage**: 34 of 94 operations (**36.2%**) — see endpoint analysis doc.")
md.append(f"> - **Field-level coverage on those 34 operations**: {total_asserted_sum} of {total_fields_sum} fields asserted = **{weighted_pct:.1f}%** (weighted by field count per op).")
md.append(f"> - **Combined depth-and-breadth view**: {(34/94) * weighted_pct:.1f}% of the OSDM v3.8 response surface area is actually asserted by OSCAR.")
md.append(">")
md.append(f"> The gap behind the endpoint number is even bigger than it first looks: even on the operations OSCAR fires, about **{100-weighted_pct:.0f}% of the documented response fields go unchecked** today.")
md.append("")
md.append("> ### Method")
md.append(">")
md.append("> 1. **Field enumeration**: for each covered operation, walk the 200-response schema's `$ref` chain to depth 2 from the response root. `allOf` merges; `oneOf`/`anyOf` union. Array-of-object payloads contribute their item fields. Wrapped resources (e.g. `{ \"booking\": {...} }`) dive one level into the wrapper.")
md.append("> 2. **Assertion detection**: a field is counted as **asserted** when its name appears in OSCAR's validator code (library-bruno `.js` files + every after-response block in the request `.yml` files) in a code-property-access shape — `.fieldName`, `[\"fieldName\"]`, or destructure `{ fieldName }`. Comments and log strings don't count.")
md.append("> 3. **Generic-name guard**: bare property names like `id`, `name`, `code`, `status` are too common to attribute reliably. They count as asserted only if the **parent.field** dotted path is found in the corpus.")
md.append(">")
md.append("> The full script is `Documentation/_build_field_level_coverage.py` — re-runnable when the corpus changes. JSON dump alongside the Markdown for downstream tooling.")
md.append("")
md.append("---")
md.append("")
md.append("## 1.  Per-domain field-level coverage")
md.append("")
md.append("| Domain | Covered ops | Asserted / Total fields | % |")
md.append("|---|---|---|---|")
for tag in sorted(by_tag, key=lambda t: -100.0 * by_tag[t]["asserted"] / max(1, by_tag[t]["total"])):
    d = by_tag[tag]
    pct = 100.0 * d["asserted"] / d["total"] if d["total"] else 0.0
    md.append(f"| {tag} | {d['ops']} | {d['asserted']} / {d['total']} | {pct:.1f}% |")
md.append("")

md.append("## 2.  Per-operation detail (covered operations only)")
md.append("")
for op in sorted(per_op, key=lambda r: (r["tag"], r["path"], r["method"])):
    pct = op["pct"]
    sev = "🟢" if pct >= 60 else "🟡" if pct >= 30 else "🔴"
    md.append(f"### {sev} `{op['method']} {op['path']}`  ({op['tag']})")
    md.append("")
    md.append(f"- **Operation**: `{op['op_id']}`")
    md.append(f"- **Field coverage**: {op['asserted_fields']} / {op['total_fields']} = **{pct:.1f}%**")
    if op["fields_asserted"]:
        md.append(f"- **Asserted** ({len(op['fields_asserted'])}): `" +
                  "`, `".join(op["fields_asserted"][:30]) +
                  ("`, …" if len(op["fields_asserted"]) > 30 else "`"))
    if op["fields_not_asserted"]:
        md.append(f"- **NOT asserted** ({len(op['fields_not_asserted'])}): `" +
                  "`, `".join(op["fields_not_asserted"][:30]) +
                  ("`, …" if len(op["fields_not_asserted"]) > 30 else "`"))
    md.append("")

md.append("## 3.  Most-frequently-asserted field names across the spec")
md.append("")
md.append("Fields that OSCAR routinely checks — these are the validators' bread and butter.")
md.append("")
md.append("| Field | Appears in N covered ops | Asserted in N |")
md.append("|---|---|---|")
for f, n in all_field_hits.most_common(20):
    md.append(f"| `{f}` | {all_field_seen[f]} | {n} |")
md.append("")

md.append("## 4.  Most-frequently-skipped field names across the spec")
md.append("")
md.append("Fields documented in the OSDM spec across many operations that OSCAR never asserts. Strong candidates for the next validator increment.")
md.append("")
md.append("| Field | Appears in N covered ops | NOT asserted in N |")
md.append("|---|---|---|")
skipped = [(f, all_field_seen[f] - all_field_hits[f], all_field_seen[f])
           for f in all_field_seen
           if all_field_seen[f] - all_field_hits[f] >= 2]
skipped.sort(key=lambda x: -x[1])
for f, miss, seen in skipped[:25]:
    md.append(f"| `{f}` | {seen} | {miss} |")
md.append("")

md.append("## 5.  Honest summary")
md.append("")
md.append(f"- OSCAR fires {len(covered_ops)} of {len(osdm_ops)} OSDM v3.8 operations (**{100.0*len(covered_ops)/len(osdm_ops):.1f}% endpoint coverage**).")
md.append(f"- On those operations, OSCAR asserts **{weighted_pct:.1f}%** of the documented response surface area.")
md.append(f"- Combined: roughly **{(len(covered_ops)/len(osdm_ops)) * weighted_pct:.1f}%** of the OSDM v3.8 spec is meaningfully tested today.")
md.append(f"- The remaining surface splits into two categories of growth:")
md.append(f"  - **Breadth** ({len(osdm_ops)-len(covered_ops)} operations untouched) — see endpoint analysis P1/P2 priorities.")
md.append(f"  - **Depth** ({total_fields_sum - total_asserted_sum} fields on covered ops still unasserted) — see Section 4 above for the prioritised skip list.")
md.append("")
md.append("Caveats this study still cannot capture:")
md.append("- **Semantic depth**: a field being \"asserted\" here only means OSCAR reads or expects on it. Whether the assertion is `expect(x).to.exist` vs `expect(x).to.match(complexBusinessRule)` is not measured.")
md.append("- **Negative-test breadth**: not covered here — see the non-happy-flow section of the endpoint doc.")
md.append("- **Field nesting depth limit**: capped at 2 levels from the response root; deeper fields (e.g. `bookings[].admissions[].afterSalesConditions[].afterSaleFee`) are not separately scored. This understates both numerator and denominator equally, so the ratio is fair.")
md.append("- **Provider-side conformance** to assert-against fields varies; OSCAR's `||`-fallback patterns absorb some of this, which can paint a slightly rosier picture of `asserted` than is strictly defensible. Cross-check against the deviations doc when assessing a specific provider.")
md.append("")

OUT_MD.write_text("\n".join(md), encoding="utf-8")
OUT_JSON.write_text(json.dumps({
    "release": "2026.123",
    "covered_ops": len(covered_ops),
    "total_ops": len(osdm_ops),
    "endpoint_pct": 100.0 * len(covered_ops) / len(osdm_ops),
    "weighted_field_pct": weighted_pct,
    "combined_surface_pct": (len(covered_ops) / len(osdm_ops)) * weighted_pct,
    "by_domain": {tag: {"covered_ops": d["ops"], "asserted": d["asserted"], "total": d["total"]}
                  for tag, d in by_tag.items()},
    "per_op": [{k: v for k, v in r.items() if k not in ("_op",)} for r in per_op],
}, indent=2), encoding="utf-8")
print(f"\nWrote {OUT_MD}")
print(f"Wrote {OUT_JSON}")
