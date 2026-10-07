// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * esc.js — the one HTML escaper for every page (tracker S11 / S11a, v1.11.215).
 *
 * Tenant-controlled strings (api_base, scenario_code, submitted_by,
 * env_name_used, company names, …) are rendered on pages a certifier of ANOTHER
 * tenant opens — the dashboard, the report builder, compare. Interpolating them
 * raw into innerHTML is stored cross-tenant XSS. Every page used to carry its
 * own copy of an escaper, in three different rule sets (some missed `"`, some
 * missed `'`); this is the single definition they now all share.
 *
 * It escapes the five characters that matter in both HTML-text and
 * double/single-quoted attribute contexts, so one function is safe for a value
 * dropped into text OR into `title="…"`. null / undefined become '' (never the
 * string "null"), matching the editor's expectations.
 *
 * It is written as chained `.replace(/…/g, …)` on purpose, NOT `replaceAll`:
 * CodeQL's XSS data-flow analysis recognises this shape as a sanitiser, and
 * stops recognising it when the chain becomes `replaceAll` (observed on #526 —
 * three escaped values were then reported as reaching innerHTML). Do not
 * "modernise" it.
 *
 * Loaded before every other page script (so the global exists first) and also
 * require()-able in Node for the jsdom/vm regression tests, the same dual-mode
 * shape as scenario-access.js.
 */

(function attachEsc(root) {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const api = { esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node (tests)
  if (root) {
    root.esc = esc;              // the name every page calls
    root.OscarEsc = api;         // namespaced handle, parity with OscarScenarioAccess
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
