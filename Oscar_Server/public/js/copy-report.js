// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// ── The report of a copy from the scenario catalogue (#681, part 3) ──────────
// One implementation for the copy page (before the copy, as scenarios are
// ticked) and for the server (in the copy's answer): which of the ticked
// reference scenarios are ready to run, which are to complete first and why,
// and which the Test Framework refuses. The scenarios are the preview's
// (`missing`, `toComplete` from #612 and #681 part 2).
//
// Loaded by scenarios.html before scenario-copy.js (browser global
// OscarCopyReport) and required by the server and the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OscarCopyReport = api;
}(globalThis, function () {
  'use strict';

  const arr = (v) => (Array.isArray(v) ? v : []);

  /**
   * { ready: [code], toComplete: [{ code, reasons }], refused: [{ code, missing }] }.
   * `refused` holds every scenario the framework does not allow, ticked or
   * not: none can be ticked, and the person should see what they are missing.
   */
  function copyReport(scenarios, codes) {
    const ticked = new Set(arr(codes));
    const report = { ready: [], toComplete: [], refused: [] };
    for (const s of arr(scenarios)) {
      if (!s || typeof s.code !== 'string') continue;
      if (arr(s.missing).length) { report.refused.push({ code: s.code, missing: arr(s.missing) }); continue; }
      if (!ticked.has(s.code)) continue;
      if (arr(s.toComplete).length) report.toComplete.push({ code: s.code, reasons: arr(s.toComplete) });
      else report.ready.push(s.code);
    }
    return report;
  }

  /**
   * The report as sentences, the first one the summary. `runsAll` says that
   * the run list of the person copying is "ALL": a scenario to complete would
   * then run, and fail, before it is completed.
   */
  function reportLines(report, runsAll) {
    const ready = arr(report?.ready);
    const toComplete = arr(report?.toComplete);
    const refused = arr(report?.refused);
    const lines = [`${ready.length} ready to run · ${toComplete.length} to complete first · ${refused.length} not allowed by the Test Framework`];
    for (const t of toComplete) lines.push(`${t.code}: ${arr(t.reasons).join('; ')}`);
    if (runsAll && toComplete.length) {
      lines.push(`Your run list is ALL: ${toComplete.map(t => t.code).join(', ')} will run, and fail, until completed. Untick them in Test Config or complete them first.`);
    }
    return lines;
  }

  return { copyReport, reportLines };
}));
