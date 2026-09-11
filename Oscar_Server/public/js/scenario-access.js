// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// ── Who may change which scenario in Test Config (#515) ──────────────────────
// The server is the authority: since v1.11.197 a tester's Save & Apply keeps
// changes to their OWN, non-shared scenarios only (mergeTesterSave in
// src/utils/datafileOwnership.js) and discards the rest. This file lets the
// editor apply the same rule up front, so a tester is never offered an edit
// the save would throw away.
//
// Loaded by scenarios.html before scenarios.js (browser global
// OscarScenarioAccess) and required by tests/unit/scenario-access.test.js,
// which pins isOwnedBy / isVisibleTo to the server's functions of the same
// name. Keep the two in step; that test fails if they drift.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OscarScenarioAccess = api;
}(globalThis, function () {
  'use strict';

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const normEmail = e => String(e == null ? '' : e).trim().toLowerCase();

  // Same rule as isOwnedBy() in src/utils/datafileOwnership.js.
  function isOwnedBy(sc, email) {
    const me = normEmail(email);
    return isObj(sc) && !sc.shared && me !== '' && normEmail(sc.created_by) === me;
  }

  // Same rule as isVisibleTo() in src/utils/datafileOwnership.js.
  function isVisibleTo(sc, email) {
    if (!isObj(sc)) return false;
    return isOwnedBy(sc, email) || !!sc.shared || normEmail(sc.created_by) === '';
  }

  // A tester (company_user) may change only the scenarios they own. Test
  // Managers are not restricted, and neither is any other role here: the
  // server refuses an administrator's or a certifier's save outright.
  function isReadOnlyFor(sc, viewer) {
    return !!viewer && viewer.role === 'company_user' && !isOwnedBy(sc, viewer.email);
  }

  // What a read-only scenario card still answers. Each of these changes only
  // what is shown, or (the run-list tick) the viewer's personal run list, which
  // is stored per user and is not part of the scenario. Every other data-action
  // on such a card is refused. Default-deny: a control added later stays locked
  // on read-only cards until someone decides it is safe and adds it here.
  const READ_ONLY_CARD_ACTIONS = Object.freeze([
    'toggle-detail',          // open / close the card
    'toggle-param-section',   // expand / collapse a section
    'toggle-pax-edit',        // show a passenger's details (the fields stay disabled)
    'duplicate-scenario',     // make an editable copy of your own
    'toggle-scenario',        // tick / untick for your own runs
  ]);

  function isAllowedOnReadOnlyCard(action) {
    return READ_ONLY_CARD_ACTIONS.includes(action);
  }

  // Is this data-action, on the card of scenario `sc`, refused for `viewer`?
  function isCardActionLocked(action, sc, viewer) {
    return isReadOnlyFor(sc, viewer) && !isAllowedOnReadOnlyCard(action);
  }

  return Object.freeze({
    isOwnedBy,
    isVisibleTo,
    isReadOnlyFor,
    READ_ONLY_CARD_ACTIONS,
    isAllowedOnReadOnlyCard,
    isCardActionLocked,
  });
}));
