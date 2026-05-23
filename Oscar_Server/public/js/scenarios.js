// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// ── Auth guard ────────────────────────────────────────────────────────────────
// Authentication is primarily handled via the oscar_session httpOnly cookie
// set by the server on login. We also keep an oscar_token mirror in
// localStorage so the explicit Authorization: Bearer header below works on
// dev / HTTP environments where the Secure cookie attribute would block the
// cookie. Both paths are accepted by the auth middleware.
const user = JSON.parse(localStorage.getItem('oscar_user') || '{}');
if (!user || !user.email) { window.location.href = '/'; }
const token = localStorage.getItem('oscar_token');
const authHeaders = token ? { Authorization: 'Bearer ' + token } : {};
const isTestManager = user.role === 'test_manager' || user.role === 'administrator';
const isTester = user.role === 'company_user';
// logout() provided by nav.js

// ── Version helper ──────────────────────────────────────────────────────────
function incrementVersion(v) { const [major, minor] = v.split('.').map(Number); return major + '.' + (minor + 1); }

// ── OSDM enum definitions ─────────────────────────────────────────────────────
const ENUMS = {
  scenarioType:       [null, 'SALE', 'REFUND', 'EXCHANGE'],
  scenarioAction:     [null, 'PATCH', 'DELETE'],
  loggingType:        ['INFO', 'DEBUG'],
  desiredFlexibility: ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'],
  overruleCode:       [null, 'PAYMENT_FAILURE', 'DISRUPTION'],
  tripType:           ['SEARCH', 'SPECIFICATION'],
  passengerType:      ['PERSON', 'DOG', 'PET', 'LUGGAGE', 'PRM', 'BICYCLE', 'PRAM',
                       'COMPANION_DOG', 'CAR', 'MOTORCYCLE', 'TRAILER', 'FAMILY_CHILD', 'WHEELCHAIR'],
  gender:             ['X', 'MALE', 'FEMALE'],
  serviceClass:       ['STANDARD', 'BEST', 'HIGH', 'BASIC', 'ANY_CLASS'],
  travelClass:        ['FIRST', 'SECOND', 'ANY_CLASS'],
  requestedOfferParts:['ADMISSION', 'RESERVATION', 'ANCILLARY',
                       'FARE_ADMISSION', 'FARE_RESERVATION', 'FARE_ANCILLARY', 'CONTINUOUS_SERVICE', 'ALL'],
  flexibilities:      ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'],
  offerMode:          ['INDIVIDUAL', 'COLLECTIVE'],
  fulfillmentType:    ['ETICKET', 'CIT_PAPER', 'PASS_CHIP', 'PASS_REFERENCE'],
  fulfillmentMedia:   ['PDF_A4', 'UIC_PDF', 'PKPASS', 'ALLOCATOR_APP', 'RCCST', 'RCT2', 'TICKETLESS'],
};

// Human-readable labels for enums
const LABELS = {
  FULL_FLEXIBLE:   'Full flexible',
  SEMI_FLEXIBLE:   'Semi flexible',
  NON_FLEXIBLE:    'Non flexible',
  PAYMENT_FAILURE: 'Payment failure',
  DISRUPTION:      'Disruption',
  INDIVIDUAL:      'Individual',
  COLLECTIVE:      'Collective',
  RESERVATION:     'Reservation',
  ADMISSION:       'Admission',
  ANCILLARY:       'Ancillary',
  FARE_ADMISSION:  'Fare admission',
  FARE_RESERVATION:'Fare reservation',
  FARE_ANCILLARY:  'Fare ancillary',
  ALL:             'All',
  ETICKET:         'E-ticket',
  CIT_PAPER:       'CIT paper',
  PASS_CHIP:       'Pass chip',
  PASS_REFERENCE:  'Pass reference',
  PDF_A4:          'PDF A4',
  UIC_PDF:         'UIC PDF',
  PKPASS:          'Apple Wallet (pkpass)',
  ALLOCATOR_APP:   'Allocator app',
  RCCST:           'RCCST',
  RCT2:            'RCT2',
  TICKETLESS:      'Ticketless',
  COMPANION_DOG:   'Companion dog',
  FAMILY_CHILD:    'Family child',
  WHEELCHAIR:      'Wheelchair',
  PERSON:          'Person',
  BICYCLE:         'Bicycle',
  PRM:             'PRM (reduced mobility)',
  PRAM:            'Pram',
  LUGGAGE:         'Luggage',
  CAR:             'Car',
  MOTORCYCLE:      'Motorcycle',
  TRAILER:         'Trailer',
  DOG:             'Dog',
  PET:             'Pet',
};

function lbl(val) { return val == null ? '— none —' : (LABELS[val] || val); }
function esc(s) {
  // HTML-context entity encoder for every value interpolated into innerHTML.
  // Escapes the full set incl. single quote (&#39;) so values are safe in BOTH
  // double- and single-quoted attributes and in text content. (Sonar S5696 may
  // still flag innerHTML sinks here — it doesn't recognise this custom encoder
  // as a sanitiser; those alerts are false positives, see issue #82.)
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── State ─────────────────────────────────────────────────────────────────────
/**
 * @type {object|null} state
 * Live working copy of the company's datafile JSON.
 * Shape mirrors the datafile schema:
 *   { scenarios: Scenario[], scenariosToRun: string[], ... }
 * Null until the page has loaded the datafile from the API. All mutation
 * helpers (addScenario, deleteScenario, saveDraft, …) operate on this object
 * and call persistState() to write changes back to the server.
 */
let state = null;  // live copy of the datafile JSON
let dirty = false;

// Apply state to every .save-btn element so the top and bottom "Save & Apply"
// buttons stay in lockstep. Used for dirty flag, in-progress label, and
// final reset. Safe to call with buttons that aren't yet in the DOM.
function setSaveBtnState(disabled, text) {
  document.querySelectorAll('.save-btn').forEach(btn => {
    btn.disabled = !!disabled;
    if (text != null) btn.textContent = text;
  });
}

function markDirty() {
  dirty = true;
  setSaveBtnState(false, '💾 Save & Apply *');
}

// ── Framework gating helpers ─────────────────────────────────────────────────
// Scenario editors historically showed every OSDM-defined enum value for fields
// like flexibility, fulfillment media, passenger category, etc. That let users
// configure scenarios the Test Framework had marked as unsupported (e.g. pick
// an IROPS reason code even when IROPS is not enabled in salesFlows). These
// helpers filter hard-coded enum lists down to what the framework actually
// supports, falling back to the full list when the framework imposes no
// constraint on that particular field (so an under-configured framework
// doesn't leave the UI empty).
function fwFilter(fullList, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return fullList;
  return fullList.filter(v => allowed.includes(v));
}
// IROPS reason codes configured for a given scenario type (REFUND / EXCHANGE).
// Returns [] for SALE or when no codes are configured.
function fwIropsCodesFor(scenarioType) {
  if (!scenarioType || scenarioType === 'SALE') return [];
  const key = String(scenarioType).toLowerCase();
  const fw = (wizData && wizData.framework) || {};
  const codes = fw.iropsCodes && fw.iropsCodes[key];
  return Array.isArray(codes) ? codes : [];
}
// Is IROPS enabled for this scenario type in the framework's salesFlows?
// The gate the wizard uses for the sub-type card (REFUND_IROPS / EXCHANGE_IROPS).
function fwSupportsIrops(scenarioType) {
  if (!scenarioType || scenarioType === 'SALE') return false;
  const fw = (wizData && wizData.framework) || {};
  const flows = Array.isArray(fw.salesFlows) ? fw.salesFlows : [];
  return flows.includes(String(scenarioType).toUpperCase() + '_IROPS');
}

// ── Decode scenario code → human description ──────────────────────────────────
function decodeCode(code) {
  // Only decode codes that follow the OSDM test-suite naming convention
  // (either prefixed with `OTST_` or beginning with an explicit RFND/EXCH/
  // SALE type marker). Custom-renamed codes like `TUR_SALEOPT_RFND` — where
  // the first token is a vendor/project tag we don't recognise — are
  // returned as-is so the human-readable label doesn't silently mislabel
  // them as "Sale" by falling through the default branch. The scenarioType
  // badge displayed alongside the code already conveys the actual type.
  const hadOtstPrefix = /^OTST_/.test(code);
  const parts = code.replace(/^OTST_/, '').split('_');
  if (!hadOtstPrefix && !/^(RFND|EXCH|SALE)$/.test(parts[0])) {
    return code;
  }
  let i = 0;
  let type = '', action = '', tripMode = '', paxParts = [], legs = '', special = [];
  let unrecognized = 0;

  // Type
  if      (parts[i] === 'RFND') { type = 'Refund';   i++; }
  else if (parts[i] === 'EXCH') { type = 'Exchange'; i++; }
  else                          { type = 'Sale';      i++; }

  // Optional action
  if      (parts[i] === 'PATCH') { action = '(PATCH)';  i++; }
  else if (parts[i] === 'DEL')   { action = '(DELETE)'; i++; }

  // Trip mode
  if (parts[i] === 'SRCH' && parts[i+1] === 'CRIT')    { tripMode = 'Search criteria';    i += 2; }
  else if (parts[i] === 'TRIP' && parts[i+1] === 'SPEC'){ tripMode = 'Trip specification'; i += 2; }

  // Passengers and legs
  while (i < parts.length) {
    const p = parts[i];
    const n = parseInt(p, 10);
    if (!isNaN(n) && p.endsWith('ADT')) { paxParts.push(`${n} Adult${n>1?'s':''}`); }
    else if (!isNaN(n) && p.endsWith('CHD')) { paxParts.push(`${n} Child${n>1?'ren':''}`); }
    else if (!isNaN(n) && p.endsWith('LEG')) { legs = `${n} Leg${n>1?'s':''}`; }
    else if (p === 'SEAT')   { special.push('Seat selection'); }
    else if (p === 'CCHTTE' || p === 'COUCHETTE') { special.push('Couchette'); }
    else { unrecognized++; }
    i++;
  }

  // If nothing beyond the bare type marker was recognised yet some tokens
  // were unrecognised, the code does not follow the OSDM naming convention
  // (e.g. a custom rename like `SALE_SEARCH_IC_BAS_AMS_1PAX`). Return it
  // verbatim rather than collapsing it to a misleading bare "Sale" /
  // "Refund" / "Exchange" — same intent as the first-token guard above.
  const decodedSomething = action || tripMode || paxParts.length || legs || special.length;
  if (!decodedSomething && unrecognized > 0) return code;

  let desc = [type, action, tripMode, paxParts.join(' + '), legs].filter(Boolean).join(' — ');
  if (special.length) desc += ' — ' + special.join(', ');
  return desc;
}

function scenarioTypeBadge(sc) {
  const t = (sc.scenarioType || 'SALE').toUpperCase();
  if (t === 'REFUND')   return `<span class="badge badge-refund">Refund</span>`;
  if (t === 'EXCHANGE') return `<span class="badge badge-exchange">Exchange</span>`;
  return `<span class="badge badge-sale">Sale</span>`;
}

// ── Lookup helpers (resolve IDs to objects) ───────────────────────────────────
function getTrip(id)        { return (state.tripRequirements          || []).find(x => x.id === id) || {}; }
function getPassengers(id)  { return (state.passengersList            || []).find(x => x.id === id) || {}; }
function getPurchaser(id)   { return (state.purchaserList             || []).find(x => x.id === id) || {}; }
// getOfferCriteria removed — offerSearchCriteria is now inline on each scenario
function getFulfillment(id) { return (state.requestedFulfillmentOptionsList || []).find(x => x.id === id) || {}; }

// ── Toggle section expand/collapse ───────────────────────────────────────────
function toggleSection(name) {
  const body = document.getElementById('body-' + name);
  const toggle = document.getElementById('toggle-' + name);
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);

  // Auto-render the edit form when opening (skip the extra "Edit" click)
  if (!isOpen) {
    if (name === 'framework' && wizData.framework) renderWizardStep1InSection();
    else if (name === 'data' && wizData.framework)  renderWizardStep2InSection();
  }
}

// ── Load datafile (page init) ────────────────────────────────────────────────
async function loadDatafile() {
  document.getElementById('loading').style.display = '';
  document.getElementById('sections-container').style.display = 'none';
  hidePanels();
  try {
    await refreshAllSections();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('sections-container').style.display = '';
  } catch(e) {
    document.getElementById('loading').innerHTML = '❌ Error: ' + esc(e.message);
  }
}

// ── Refresh all three sections from server ───────────────────────────────────
async function refreshAllSections() {
  // Fetch framework, resources, company profile in parallel
  const [fwRes, resRes, companyRes] = await Promise.all([
    fetch('/v1/company/test-framework', {}).catch(()=>null),
    fetch('/v1/company/test-resources',  {}).catch(()=>null),
    fetch('/v1/company',                 {}).catch(()=>null)
  ]);

  // Check for auth failure
  if (fwRes && fwRes.status === 401) { logout(); return; }

  // Framework
  let framework = null;
  if (fwRes && fwRes.ok) {
    const fwBody = await fwRes.json();
    let cfg = fwBody && fwBody.config;
    if (cfg && cfg.config && typeof cfg.config === 'object' && !Array.isArray(cfg.config)) {
      cfg = cfg.config;
    }
    framework = (cfg && typeof cfg === 'object') ? cfg : null;
  }
  wizData.framework = framework || emptyFramework();

  // Resources
  let resources = [];
  if (resRes && resRes.ok) resources = await resRes.json();
  wizData.resources = resources;

  // Company profile
  if (companyRes && companyRes.ok) wizProfile = await companyRes.json();

  // Datafile
  let datafile = null;
  try {
    const dfRes = await fetch('/v1/company/datafile', {});
    if (dfRes.ok) datafile = await dfRes.json();
  } catch(e) {}

  if (datafile) {
    state = datafile;
    // Normalise scenariosToRun
    const allCodes = (state.scenarios || []).map(s => s.code);
    if (!Array.isArray(state.scenariosToRun)) {
      state.scenariosToRun = allCodes.slice();
      dirty = true;
    } else {
      const cleaned = state.scenariosToRun.filter(c => allCodes.includes(c));
      if (cleaned.length !== state.scenariosToRun.length) {
        state.scenariosToRun = cleaned;
        dirty = true;
      }
    }
    // Legacy scenarios (no salesFlowActions field) predate the booking-flow
    // pills feature and were running every step. Backfill with all-enabled
    // so their UI representation matches their historic test behaviour —
    // without this, loading an old datafile would silently disable steps.
    migrateLegacySalesFlowActions();
    // Backfill an empty offerSearchCriteria object on legacy scenarios so the
    // Bruno parser's legacy fallback (which hard-codes EUR / INDIVIDUAL /
    // [ADMISSION,RESERVATION]) does not fire on scenarios authored in OSCAR.
    // The empty object signals "scenario authored — send only explicit fields".
    migrateMissingOfferSearchCriteria();
    setSaveBtnState(!dirty, dirty ? '💾 Save & Apply *' : '💾 Save & Apply');
  }

  renderFrameworkSection(framework);
  renderTestDataSection(framework, resources);
  renderScenariosSection(framework, resources, datafile);

  // Show/hide download button
  document.getElementById('btn-download').style.display = datafile ? '' : 'none';

  // Tester restrictions: hide upload button and section delete buttons
  if (isTester) {
    // Hide upload datafile button (label wrapping the file input)
    const uploadLabel = document.getElementById('df-upload-input')?.closest('label');
    if (uploadLabel) uploadLabel.style.display = 'none';
    // Hide all section delete buttons
    document.querySelectorAll('#del-framework, #del-data, #del-scenarios').forEach(el => el.style.display = 'none');
  }
}

// ── Section 1: Test Framework ────────────────────────────────────────────────
function renderFrameworkSection(framework) {
  const badge   = document.getElementById('badge-framework');
  const summary = document.getElementById('summary-framework');
  const body    = document.getElementById('body-framework');
  const toggleEl = document.getElementById('toggle-framework');

  // Capture the sub-section open state AND the currently focused input (with
  // caret position) BEFORE the body is wiped. This covers the save flow: user
  // is editing inside the framework card → auto-save fires → refreshAllSections
  // → renderFrameworkSection wipes body. Without capture here, every form
  // re-render resets the sub-section expand state and steals focus from the
  // input the user is typing into.
  const wasOpen = !!(toggleEl && toggleEl.classList.contains('open'));
  const _fwOpenBefore  = wasOpen ? captureFwOpenState() : null;
  const _fwFocusBefore = wasOpen ? captureFwFocus()     : null;

  document.getElementById('del-framework').style.display = (framework && !isTester) ? '' : 'none';

  if (!framework) {
    badge.className = 'config-section-badge warn';
    badge.textContent = '⚠️ Not configured';
    summary.innerHTML = 'No test framework defined. Click to configure your OSDM certification scope.';
    body.innerHTML = `
      <div style="text-align:center;padding:20px">
        <p style="color:#546e7a;font-size:13px;margin-bottom:16px">
          Define the functional scope of your OSDM certification to generate relevant test scenarios.
        </p>
        <button class="btn btn-primary" data-action="create-framework">
          🏗️ Create Test Framework
        </button>
      </div>`;
  } else {
    badge.className = 'config-section-badge ok';
    badge.textContent = '✅ Configured';
    const fw = framework;
    const flows = (fw.salesFlows||[]).join(', ') || 'None';
    const modes = [fw.rail&&fw.rail.enabled?'Rail':'',fw.pt&&fw.pt.enabled?'Urban':'',fw.shared&&fw.shared.enabled?'Shared':''].filter(Boolean).join(', ')||'None';
    const paxTypes = (fw.passengerTypes||[]).length;
    summary.innerHTML = `OSDM v${esc(fw.osdmVersion||'?')} · Flows: ${esc(flows)} · Modes: ${esc(modes)} · ${esc(paxTypes)} passenger type(s)`;
    body.innerHTML = `<div id="framework-form-area"></div>`;
    // If the user was inside the framework form when this refresh fired
    // (auto-save), re-populate the form immediately and restore which
    // sub-sections were expanded. Without this the form would vanish,
    // leaving the user with an empty card until they manually re-toggle.
    if (wasOpen) {
      renderWizardStep1InSection();
      restoreFwOpenState(_fwOpenBefore);
      restoreFwFocus(_fwFocusBefore);
    }
  }
}

// ── Framework sub-section open/collapse preservation ─────────────────────────
// The framework body is entirely re-rendered after each auto-save (e.g. when
// the user changes the Concurrent Session Limit value, or toggles a pill).
// Without help, every sub-section reverts to the open/closed default baked
// into the HTML template, so a sub-section the user had just expanded
// collapses mid-interaction. We identify sub-sections by their header text
// (stable, unique within the framework card) and restore the user's state
// after each re-render. Focus + caret position are preserved the same way
// so typing in an input doesn't jump out after each debounced save.
function captureFwOpenState() {
  const open = new Set();
  document.querySelectorAll('#body-framework .fw-section-head.open').forEach(h => {
    open.add((h.textContent || '').replace(/[▶▼]/g, '').trim());
  });
  return open;
}
function restoreFwOpenState(openSet) {
  if (!openSet || openSet.size === 0) return;
  document.querySelectorAll('#body-framework .fw-section').forEach(sec => {
    const head = sec.querySelector(':scope > .fw-section-head');
    const body = sec.querySelector(':scope > .fw-section-body');
    if (!head || !body) return;
    const label = (head.textContent || '').replace(/[▶▼]/g, '').trim();
    if (openSet.has(label)) {
      head.classList.add('open');
      body.classList.add('open');
    } else {
      head.classList.remove('open');
      body.classList.remove('open');
    }
  });
}
function captureFwFocus() {
  const a = document.activeElement;
  if (!a || !document.getElementById('body-framework') ||
      !document.getElementById('body-framework').contains(a)) return null;
  const action = a.getAttribute && a.getAttribute('data-action');
  if (!action) return null;
  const state = { action, tag: a.tagName };
  if (typeof a.selectionStart === 'number') {
    state.selectionStart = a.selectionStart;
    state.selectionEnd   = a.selectionEnd;
  }
  return state;
}
function restoreFwFocus(state) {
  if (!state) return;
  const el = document.querySelector('#body-framework [data-action="' + state.action + '"]');
  if (!el) return;
  try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
  if (state.selectionStart != null && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(state.selectionStart, state.selectionEnd); } catch (_) {}
  }
}

// Debounced wrapper around saveFrameworkFromSection. On a rapid sequence of
// input events (e.g. typing a multi-digit number) only one PUT fires, 500ms
// after the last keystroke. Prevents a cascade of save-then-rerender cycles
// that would otherwise flicker the form on every character.
let _saveFrameworkDebounce = null;
function saveFrameworkDebounced() {
  if (_saveFrameworkDebounce) clearTimeout(_saveFrameworkDebounce);
  _saveFrameworkDebounce = setTimeout(() => {
    _saveFrameworkDebounce = null;
    saveFrameworkFromSection();
  }, 500);
}

function renderWizardStep1InSection() {
  // Re-use the existing renderWizardStep1 logic but target body-framework
  const targetEl = document.getElementById('body-framework');
  // Preserve sub-section open state across the re-render below.
  const _fwOpenBefore = captureFwOpenState();
  // Ensure section is open
  targetEl.style.display = 'block';
  document.getElementById('toggle-framework').classList.add('open');

  // Render the framework form
  const fw = wizData.framework || emptyFramework();
  // Normalise framework (same as renderWizardStep1)
  const def = emptyFramework();
  if (!fw.osdmVersion) fw.osdmVersion = def.osdmVersion;
  if (typeof fw.concurrentSessionLimit !== 'number') fw.concurrentSessionLimit = 1;
  if (!Array.isArray(fw.salesFlows))    fw.salesFlows    = def.salesFlows;
  if (!fw.iropsCodes)                   fw.iropsCodes    = def.iropsCodes;
  if (!fw.iropsCodes.refund)            fw.iropsCodes.refund   = [...WIZ_IROPS_MANDATORY];
  if (!fw.iropsCodes.exchange)          fw.iropsCodes.exchange = [...WIZ_IROPS_MANDATORY];
  if (!fw.rail   || typeof fw.rail   !== 'object') fw.rail   = def.rail;
  if (!fw.pt     || typeof fw.pt     !== 'object') fw.pt     = def.pt;
  if (!fw.shared || typeof fw.shared !== 'object') fw.shared = def.shared;
  if (!Array.isArray(fw.rail.subModes))    fw.rail.subModes    = def.rail.subModes;
  if (!Array.isArray(fw.rail.ticketTypes)) fw.rail.ticketTypes = def.rail.ticketTypes;
  if (!Array.isArray(fw.pt.subModes))      fw.pt.subModes      = [];
  if (!Array.isArray(fw.shared.subModes))  fw.shared.subModes  = [];
  if (!Array.isArray(fw.serviceClasses))  fw.serviceClasses  = def.serviceClasses;
  if (!Array.isArray(fw.accommodations))  fw.accommodations  = def.accommodations;
  if (!Array.isArray(fw.ancillaries))     fw.ancillaries     = def.ancillaries;
  if (!Array.isArray(fw.passengerTypes))  fw.passengerTypes  = def.passengerTypes;
  if (!fw.passengerAgeRanges || typeof fw.passengerAgeRanges !== 'object') fw.passengerAgeRanges = {};
  if (!fw.offerCriteria || typeof fw.offerCriteria !== 'object') fw.offerCriteria = def.offerCriteria;
  if (!Array.isArray(fw.offerCriteria.serviceClasses))      fw.offerCriteria.serviceClasses      = def.offerCriteria.serviceClasses;
  if (!Array.isArray(fw.offerCriteria.requestedOfferParts)) fw.offerCriteria.requestedOfferParts = def.offerCriteria.requestedOfferParts;
  if (!Array.isArray(fw.offerCriteria.travelClasses))       fw.offerCriteria.travelClasses       = def.offerCriteria.travelClasses;
  if (!Array.isArray(fw.offerCriteria.flexibilities))       fw.offerCriteria.flexibilities       = def.offerCriteria.flexibilities;
  if (!fw.offerCriteria.offerMode)   fw.offerCriteria.offerMode  = def.offerCriteria.offerMode;
  if (!fw.offerCriteria.currency)    fw.offerCriteria.currency   = def.offerCriteria.currency;
  if (fw.offerCriteria.requiresPlaceSelection == null) fw.offerCriteria.requiresPlaceSelection = false;
  if (!fw.placeSelection || typeof fw.placeSelection !== 'object') fw.placeSelection = { seatMap: false, supportedModes: [] };
  if (typeof fw.placeSelection.seatMap !== 'boolean') fw.placeSelection.seatMap = false;
  if (!Array.isArray(fw.placeSelection.supportedModes)) fw.placeSelection.supportedModes = [];
  if (!fw.fulfillment || typeof fw.fulfillment !== 'object') fw.fulfillment = def.fulfillment;
  if (!Array.isArray(fw.fulfillment.media)) fw.fulfillment.media = def.fulfillment.media;
  if (!Array.isArray(fw.fulfillment.types)) fw.fulfillment.types = def.fulfillment.types;
  wizData.framework = fw;

  // We temporarily set wizard-body to target the section, render, then restore
  // Actually, let's just directly build the HTML into the section body
  // Save old wizard-body reference trick: create a temporary div
  const tempDiv = document.createElement('div');
  tempDiv.id = 'wizard-body';
  tempDiv.className = 'wiz-body';
  tempDiv.style.display = 'none';
  document.body.appendChild(tempDiv);

  // Call renderWizardStep1 which writes to wizard-body
  renderWizardStep1();

  // Move the content to section body
  targetEl.innerHTML = tempDiv.innerHTML + `
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #eceff1;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-primary" data-action="save-framework">💾 Save Framework</button>
    </div>`;

  // Clean up temp div
  document.body.removeChild(tempDiv);

  // Restore the open/collapse state captured at the top of this function.
  // Keeps the sub-section the user is currently editing expanded across the
  // re-renders triggered by auto-save, so the UI doesn't "close the window"
  // mid-interaction.
  restoreFwOpenState(_fwOpenBefore);

  // Read-only mode for testers
  if (isTester) {
    const body = document.getElementById('body-framework');
    const banner = document.createElement('div');
    banner.innerHTML = '<div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#e65100">🔒 Test Framework is managed by your Test Manager — read-only for testers.</div>';
    body.prepend(banner.firstChild);
    body.querySelectorAll('input, select, textarea').forEach(el => el.disabled = true);
    body.querySelectorAll('[data-action="save-framework"], [data-action="delete-framework"]').forEach(el => el.style.display = 'none');
    body.querySelectorAll('.pill').forEach(el => el.style.pointerEvents = 'none');
  }
}

async function saveFrameworkFromSection() {
  try {
    const res = await fetch('/v1/company/test-framework', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: wizData.framework })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Failed to save framework: ${err.detail || err.title || res.status}`);
      return;
    }
    showMsg('✅ Test Framework saved successfully.', true);
    await refreshAllSections();
  } catch(e) { alert(`Network error: ${e.message}`); }
}

// ── Delete functions ─────────────────────────────────────────────────────────

// 3) Delete Framework → deletes EVERYTHING (framework + all resources + datafile)
async function deleteFramework() {
  const resources = wizData.resources || [];
  const trains = resources.filter(r => r.resource_type === 'TRAIN');
  const scenCount = state ? (state.scenarios || []).length : 0;

  let msg = '⚠️ Deleting the Test Framework will also delete:\n';
  if (trains.length > 0) msg += `  • ${trains.length} train resource(s)\n`;
  if (scenCount > 0)     msg += `  • ${scenCount} scenario(s) and the data file\n`;
  msg += '\nThis action cannot be undone. Continue?';

  if (!confirm(msg)) return;

  try {
    // Delete datafile if exists
    await fetch('/v1/company/datafile', { method: 'DELETE', }).catch(()=>{});
    // Delete all resources
    for (const r of resources) {
      await fetch(`/v1/company/test-resources/${r.id}`, { method: 'DELETE', }).catch(()=>{});
    }
    // Delete framework
    await fetch('/v1/company/test-framework', { method: 'DELETE', }).catch(()=>{});
    state = null;
    showMsg('✅ Test Framework and all associated data deleted.', true);
    await refreshAllSections();
  } catch(e) { alert(`Error: ${e.message}`); }
}

// 2b) Delete ALL test data → deletes all resources + all scenarios/datafile
async function deleteAllTestData() {
  const resources = wizData.resources || [];
  const trains = resources.filter(r => r.resource_type === 'TRAIN');
  const scenCount = state ? (state.scenarios || []).length : 0;

  let msg = '⚠️ Deleting all test data will delete:\n';
  msg += `  • ${trains.length} train resource(s)\n`;
  if (scenCount > 0) msg += `  • All ${scenCount} scenario(s) and the data file\n`;
  msg += '\nThis action cannot be undone. Continue?';

  if (!confirm(msg)) return;

  try {
    // Delete datafile
    await fetch('/v1/company/datafile', { method: 'DELETE', }).catch(()=>{});
    // Delete all resources
    for (const r of resources) {
      await fetch(`/v1/company/test-resources/${r.id}`, { method: 'DELETE', }).catch(()=>{});
    }
    state = null;
    showMsg('✅ All test data and scenarios deleted.', true);
    await refreshAllSections();
  } catch(e) { alert(`Error: ${e.message}`); }
}

// 2a) Delete a single train resource → warn about impacted scenarios
async function deleteTrainResource(resourceId) {
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const targetTrain = trains.find(t => t.id === resourceId);
  if (!targetTrain) return;

  const td = normalizeTrainData(typeof targetTrain.data === 'string' ? JSON.parse(targetTrain.data) : (targetTrain.data || {}));
  const vehicleNumbers = td.services.map(s => s.vehicleNumber).filter(Boolean);
  const trainLabel = targetTrain.label || vehicleNumbers[0] || resourceId;

  // Find scenarios that reference this train (by matching any of its services'
  // vehicle numbers against a trip/leg).
  let impacted = [];
  if (state && state.scenarios && state.tripRequirements) {
    // Find tripRequirement IDs that match this train's data
    const matchingTripIds = (state.tripRequirements || [])
      .filter(tr => {
        if (tr.tripType === 'SEARCH' && tr.trip) {
          return vehicleNumbers.includes(tr.trip.vehicleNumber);
        }
        if (tr.tripType === 'SPECIFICATION' && tr.legs) {
          return tr.legs.some(l => vehicleNumbers.includes(l.vehicleNumber));
        }
        return false;
      })
      .map(tr => tr.id);

    impacted = (state.scenarios || []).filter(sc =>
      matchingTripIds.includes(sc.tripRequirementId)
    );
  }

  let msg = `Delete train "${trainLabel}"?\n`;
  if (impacted.length > 0) {
    msg += `\n⚠️ The following ${impacted.length} scenario(s) use this train and will also be deleted:\n`;
    impacted.forEach(sc => { msg += `  • ${sc.code}\n`; });
  }
  msg += '\nContinue?';

  if (!confirm(msg)) return;

  try {
    // Delete the resource
    await fetch(`/v1/company/test-resources/${resourceId}`, { method: 'DELETE',
      });
    wizData.resources = (wizData.resources || []).filter(r => r.id !== resourceId);

    // Remove impacted scenarios from datafile
    if (impacted.length > 0 && state) {
      const impactedCodes = new Set(impacted.map(s => s.code));
      state.scenarios = (state.scenarios || []).filter(s => !impactedCodes.has(s.code));
      state.scenariosToRun = (state.scenariosToRun || []).filter(c => !impactedCodes.has(c));
      // Save updated datafile
      await fetch('/v1/company/datafile/json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });
    }

    showMsg(`✅ Train "${trainLabel}" deleted` + (impacted.length > 0 ? ` along with ${impacted.length} scenario(s).` : '.'), true);
    // Re-render sections but keep Test Data open with the train list visible
    await refreshAllSections();
    // Re-open the data section and render the train form inline
    const bodyData = document.getElementById('body-data');
    const toggleData = document.getElementById('toggle-data');
    if (bodyData) { bodyData.style.display = 'block'; toggleData.classList.add('open'); renderWizardStep2InSection(); }
  } catch(e) { alert(`Error: ${e.message}`); }
}

// 1) Delete a single scenario
function deleteScenario(idx) {
  if (!state || !state.scenarios || !state.scenarios[idx]) return;
  const sc = state.scenarios[idx];
  if (!confirm(`Delete scenario "${sc.code}"?`)) return;

  state.scenarios.splice(idx, 1);
  state.scenariosToRun = (state.scenariosToRun || []).filter(c => c !== sc.code);
  markDirty();
  renderAll();
  // Update badge
  const toRun = state.scenariosToRun || [];
  const badge = document.getElementById('badge-scenarios');
  const summary = document.getElementById('summary-scenarios');
  if (state.scenarios.length === 0) {
    badge.className = 'config-section-badge warn';
    badge.textContent = '⚠️ No scenarios';
    summary.innerHTML = 'No scenarios defined. Click to create your first scenario.';
    document.getElementById('del-scenarios').style.display = 'none';
  } else {
    badge.textContent = `✅ ${state.scenarios.length} scenario(s) · ${toRun.length} in run`;
    summary.innerHTML = `${esc(state.scenarios.length)} scenario(s) defined, ${esc(toRun.length)} selected for next run`;
  }
}

// Delete all scenarios (Section 3 header button)
async function deleteAllScenarios() {
  if (!state) return;
  const count = (state.scenarios || []).length;
  if (!confirm(`⚠️ Delete all ${count} scenario(s) and the data file?\n\nThis action cannot be undone.`)) return;

  try {
    await fetch('/v1/company/datafile', { method: 'DELETE', }).catch(()=>{});
    state = null;
    showMsg(`✅ All ${count} scenario(s) deleted.`, true);
    await refreshAllSections();
  } catch(e) { alert(`Error: ${e.message}`); }
}

// ── Section 2: Test Data (Resources) ─────────────────────────────────────────
function renderTestDataSection(framework, resources) {
  const badge   = document.getElementById('badge-data');
  const summary = document.getElementById('summary-data');
  const body    = document.getElementById('body-data');

  const trains = (resources || []).filter(r => r.resource_type === 'TRAIN');
  document.getElementById('del-data').style.display = (trains.length > 0 && !isTester) ? '' : 'none';

  if (!framework) {
    badge.className = 'config-section-badge warn';
    badge.textContent = '⚠️ Not configured';
    summary.innerHTML = 'Configure Test Framework first (Section 1).';
    body.innerHTML = '<div class="prereq-msg">⚠️ Please configure the Test Framework (Section 1) before adding test data.</div>';
    return;
  }

  if (trains.length === 0) {
    badge.className = 'config-section-badge warn';
    badge.textContent = '⚠️ No test data';
    summary.innerHTML = 'No train resources defined. Click to add your first train.';
    body.innerHTML = isTester
      ? `<div style="text-align:center;padding:16px;color:#90a4ae;font-size:13px">No train resources defined yet. Your Test Manager will add them.</div>`
      : `<div style="text-align:center;padding:16px">
        <p style="color:#546e7a;font-size:13px;margin-bottom:16px">
          Register the test trains available in your system under test.
        </p>
        <button class="btn btn-primary" data-action="add-train-section">
          ➕ Add Train
        </button>
      </div>`;
  } else {
    badge.className = 'config-section-badge ok';
    badge.textContent = `✅ ${trains.length} train(s)`;
    summary.innerHTML = `${esc(trains.length)} train resource(s) configured`;
    body.innerHTML = `<div id="resources-form-area"></div>`;
  }
}

function renderWizardStep2InSection() {
  const targetEl = document.getElementById('body-data');
  targetEl.style.display = 'block';
  document.getElementById('toggle-data').classList.add('open');

  const tempDiv = document.createElement('div');
  tempDiv.id = 'wizard-body';
  tempDiv.className = 'wiz-body';
  tempDiv.style.display = 'none';
  document.body.appendChild(tempDiv);

  renderWizardStep2();

  targetEl.innerHTML = tempDiv.innerHTML;
  document.body.removeChild(tempDiv);

  // Read-only mode for testers
  if (isTester) {
    const body = document.getElementById('body-data');
    const banner = document.createElement('div');
    banner.innerHTML = '<div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#e65100">🔒 Test Data is managed by your Test Manager — read-only for testers.</div>';
    body.prepend(banner.firstChild);
    body.querySelectorAll('[data-action="wiz-add-train"], [data-action="wiz-duplicate-train"], [data-action="wiz-save-all-trains"], [data-action="wiz-delete-resource"], [data-action="wiz-edit-train"], [data-action="wiz-add-journey"], [data-action="wiz-duplicate-journey"], [data-action="wiz-delete-journey"]').forEach(el => el.style.display = 'none');
  }
}

// ── Section 3: Test Scenarios ────────────────────────────────────────────────
function renderScenariosSection(framework, resources, datafile) {
  const badge   = document.getElementById('badge-scenarios');
  const summary = document.getElementById('summary-scenarios');
  const body    = document.getElementById('body-scenarios');
  const trains  = (resources || []).filter(r => r.resource_type === 'TRAIN');

  const scenarios = datafile ? (datafile.scenarios || []) : [];
  const toRun = datafile ? (datafile.scenariosToRun || []) : [];
  document.getElementById('del-scenarios').style.display = scenarios.length > 0 ? '' : 'none';

  if (!framework || trains.length === 0) {
    badge.className = 'config-section-badge warn';
    badge.textContent = '⚠️ Not configured';
    const missing = !framework ? 'Test Framework (Section 1)' : 'Test Data (Section 2)';
    summary.innerHTML = `Configure ${esc(missing)} first.`;
    body.innerHTML = `<div class="prereq-msg">⚠️ Please configure ${esc(missing)} before creating scenarios.</div>`;
    return;
  }

  if (scenarios.length === 0) {
    badge.className = 'config-section-badge warn';
    badge.textContent = '⚠️ No scenarios';
    summary.innerHTML = 'No scenarios defined. Click to create your first scenario.';
    body.innerHTML = `
      <div style="text-align:center;padding:16px">
        <p style="color:#546e7a;font-size:13px;margin-bottom:16px">
          Generate test scenarios from your framework and resources.
        </p>
        <button class="btn btn-primary" data-action="open-scenario-creator">
          ⚡ Create Scenario
        </button>
      </div>`;
  } else {
    badge.className = 'config-section-badge ok';
    badge.textContent = `✅ ${scenarios.length} scenario(s) · ${toRun.length} in run`;
    summary.innerHTML = `${esc(scenarios.length)} scenario(s) defined, ${esc(toRun.length)} selected for next run`;

    // Build merged scenario list with checkbox + expandable details
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="card-head-title">📋 Scenarios
            <span style="font-size:11px;font-weight:400;text-transform:none;color:#90a4ae;letter-spacing:0">
              — tick to include in next run · click to view/edit parameters
            </span>
          </span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-secondary" data-action="select-all" data-checked="true">Select All</button>
            <button class="btn btn-sm btn-secondary" data-action="select-all" data-checked="false">Deselect All</button>
          </div>
        </div>
        <div id="scenario-list"></div>
      </div>

      <div style="text-align:center;padding:8px;display:flex;gap:12px;justify-content:center;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" data-action="open-scenario-creator">
          ⚡ Create Scenario
        </button>
        <button class="btn btn-success save-btn" data-action="save-datafile" disabled>💾 Save &amp; Apply</button>
        <button class="btn btn-sm btn-danger" data-action="delete-datafile">🗑 Delete data file</button>
      </div>

      <!-- Scenario creator area (hidden until needed) -->
      <div id="scenario-creator-area"></div>`;

    renderAll();
  }
}

function openScenarioCreator() {
  const area = document.getElementById('scenario-creator-area');
  if (!area) {
    // If no area exists (e.g. 0 scenarios), render into body-scenarios
    const targetEl = document.getElementById('body-scenarios');
    targetEl.style.display = 'block';
    document.getElementById('toggle-scenarios').classList.add('open');
    wizInitScenario();
    renderWizardStep3InSection(targetEl);
    return;
  }
  wizInitScenario();
  renderWizardStep3InSection(area);
  area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderWizardStep3InSection(targetEl) {
  const tempDiv = document.createElement('div');
  tempDiv.id = 'wizard-body';
  tempDiv.className = 'wiz-body';
  tempDiv.style.display = 'none';
  document.body.appendChild(tempDiv);

  renderWizardStep3();

  targetEl.innerHTML = '<div style="margin-top:14px;padding-top:14px;border-top:2px solid #e3eaf5">' +
    '<div style="font-size:14px;font-weight:800;color:#0090D4;margin-bottom:14px">⚡ Create New Scenario</div>' +
    tempDiv.innerHTML + '</div>';
  document.body.removeChild(tempDiv);
}

// ── Handle file upload ───────────────────────────────────────────────────────
async function handleFileUpload(input) {
  if (!input.files || !input.files[0]) return;
  const loadEl = document.getElementById('loading');
  document.getElementById('sections-container').style.display = 'none';
  loadEl.textContent = '⏳ Uploading data file…';
  loadEl.style.display = 'block';

  try {
    // First try to parse the JSON to extract framework/resources
    const fileText = await input.files[0].text();
    let parsed;
    try { parsed = JSON.parse(fileText); } catch(pe) {
      // Not valid JSON — upload as-is via FormData
      parsed = null;
    }

    if (parsed) {
      // Extract and save framework + resources from the datafile
      await extractFromDatafile(parsed);
    }

    // Upload the raw datafile
    const fd = new FormData();
    fd.append('datafile', input.files[0]);
    const res = await fetch('/v1/company/datafile', {
      method: 'POST',
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      loadEl.textContent = `Upload failed: ${data.detail || 'Unknown error'}`;
      return;
    }
    showMsg('✅ Data file uploaded successfully.', true);
    // Reload full state from server
    await loadDatafile();
  } catch(e) {
    document.getElementById('loading').textContent = `Upload error: ${e.message}`;
  }
  input.value = '';
}

// ── Extract framework & resources from uploaded datafile ─────────────────────
async function extractFromDatafile(datafile) {
  try {
    // a) Extract framework
    const osdmVersion = datafile.osdmVersion || (datafile.scenarios && datafile.scenarios[0] && datafile.scenarios[0].osdmVersion) || '3.4';
    const scenarioTypes = [...new Set((datafile.scenarios||[]).map(s => s.scenarioType).filter(Boolean))];
    const salesFlows = [];
    if (scenarioTypes.includes('SALE')) salesFlows.push('SALE');
    if (scenarioTypes.includes('REFUND')) salesFlows.push('REFUND_FULL');
    if (scenarioTypes.includes('EXCHANGE')) salesFlows.push('EXCHANGE_FULL');

    // Extract passenger types from passengersList
    const passengerTypes = [...new Set(
      (datafile.passengersList||[]).flatMap(pl =>
        (pl.passengers||[]).map(p => {
          // TODO: classify ADULT vs CHILD/SENIOR from p.dateOfBirth when
          // age-based passenger types become required by OSDM.
          // For now both branches return ADULT — Sonar S3923 simplified.
          if (p.type === 'PERSON') return 'ADULT';
          return p.type || 'ADULT';
        })
      )
    )];

    const fw = {
      ...emptyFramework(),
      osdmVersion,
      salesFlows: salesFlows.length ? salesFlows : ['SALE'],
      passengerTypes: passengerTypes.length ? passengerTypes : ['ADULT']
    };

    // b) Create train resources from tripRequirements
    const trips = datafile.tripRequirements || [];
    const trainResources = trips.map((trip, idx) => {
      let origin = '', destination = '', departureTime = '', arrivalTime = '', vehicleNumber = '', operatorCode = '';
      let pcRef = '', pcName = '', pcShortName = '';
      const src = (trip.tripType === 'SPECIFICATION' && Array.isArray(trip.legs) && trip.legs.length > 0)
        ? trip.legs[0]
        : (trip.trip || null);
      if (src) {
        origin = src.origin || '';
        destination = src.destination || '';
        departureTime = (src.startDatetime || '').replace(/%TRIP_DATE%T/, '');
        arrivalTime = (src.endDatetime || '').replace(/%TRIP_DATE%T/, '');
        vehicleNumber = src.vehicleNumber || '';
        operatorCode = src.operatorCode || '';
        pcRef = src.productCategoryRef || '';
        pcName = src.productCategoryName || '';
        pcShortName = src.productCategoryShortName || '';
      }

      return {
        label: `Train ${vehicleNumber || ('Trip-' + (idx+1))}`,
        resource_type: 'TRAIN',
        data: {
          originURN: origin,
          destinationURN: destination,
          operatorCode,
          productCategoryRef: pcRef,
          productCategoryName: pcName,
          productCategoryShortName: pcShortName,
          daysOfWeek: [],
          services: (vehicleNumber || departureTime || arrivalTime)
            ? [{ vehicleNumber, departureTime, arrivalTime }]
            : [],
          ticketTypes: [],
          travelClasses: [],
          serviceClasses: [],
          accommodations: [],
          ancillaries: []
        }
      };
    });

    // Dedup key from a train resource's route + its first service (#136).
    const trainDedupKey = (data) => {
      const d = data || {};
      const s = (Array.isArray(d.services) && d.services[0]) || {};
      const veh = s.vehicleNumber || d.vehicleNumber || '';      // legacy fallback
      const dep = s.departureTime || d.departureTime || '';
      const arr = s.arrivalTime || d.arrivalTime || '';
      return `${veh}|${d.originURN||''}|${d.destinationURN||''}|${dep}|${arr}`;
    };

    // Deduplicate trainResources from the datafile itself (same vehicle + route + times)
    const seenTrainKeys = new Set();
    const uniqueTrainResources = [];
    for (const train of trainResources) {
      const key = trainDedupKey(train.data);
      if (!seenTrainKeys.has(key)) {
        seenTrainKeys.add(key);
        uniqueTrainResources.push(train);
      }
    }

    // c) Save framework
    await fetch('/v1/company/test-framework', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: fw })
    }).catch(() => {});

    // d) Save each train resource — skip duplicates
    // Fetch existing resources to compare
    let existingResources = [];
    try {
      const exRes = await fetch('/v1/company/test-resources', {});
      if (exRes.ok) existingResources = await exRes.json();
    } catch(_) {}

    const existingTrains = existingResources.filter(r => r.resource_type === 'TRAIN').map(r => {
      const d = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {});
      return trainDedupKey(d);
    });

    let created = 0, skipped = 0;
    for (const train of uniqueTrainResources) {
      const key = trainDedupKey(train.data);
      if (existingTrains.includes(key)) {
        skipped++;
        continue; // duplicate — skip
      }
      existingTrains.push(key); // prevent duplicates within the same import
      await fetch('/v1/company/test-resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(train)
      }).catch(() => {});
      created++;
    }
    if (skipped > 0) console.log(`[extractFromDatafile] Skipped ${skipped} duplicate train resource(s), created ${created}`);

  } catch(e) {
    console.warn('[extractFromDatafile] Error extracting data:', e);
  }
}

// ── Delete data file ──────────────────────────────────────────────────────────
async function deleteDatafile() {
  if (!confirm('Delete the current test configuration?\n\nThis will remove the data file from the server. This cannot be undone.')) return;
  try {
    const res = await fetch('/v1/company/datafile', { method: 'DELETE',
      });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showMsg(data.detail || 'Delete failed.', false); return; }
    state = null;
    dirty = false;
    hidePanels();
    showMsg('✅ Test configuration deleted.', true);
    await refreshAllSections();
  } catch(e) {
    showMsg(`Error: ${e.message}`, false);
  }
}

// ── Render everything ─────────────────────────────────────────────────────────
function renderAll() {
  const all   = state.scenarios || [];
  const toRun = new Set(state.scenariosToRun || []);
  const listEl = document.getElementById('scenario-list');
  if (!listEl) return;

  if (!all.length) {
    listEl.innerHTML = '<div class="placeholder">No scenarios defined in the data file.</div>';
    return;
  }

  listEl.innerHTML = all.map((sc, idx) => {
    const inRun = toRun.has(sc.code);
    // Ownership / shared badges
    let ownerBadge = '';
    if (sc.shared) {
      ownerBadge = `<span class="badge" style="background:#f3e5f5;color:#6a1b9a;border:1px solid #ce93d8">🔒 Shared</span>`;
      if (sc.created_by) ownerBadge += `<span style="font-size:10px;color:#90a4ae;margin-left:4px">by: ${esc(sc.created_by)}</span>`;
    } else if (sc.created_by === user.email) {
      ownerBadge = `<span class="badge" style="background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7">✏️ Yours</span>`;
    } else if (sc.created_by) {
      ownerBadge = `<span style="font-size:10px;color:#90a4ae">by: ${esc(sc.created_by)}</span>`;
    }
    const versionBadge = sc.version ? `<span style="font-size:10px;color:#78909c;margin-left:4px">v${esc(sc.version)}</span>` : '';
    // Delete button: hide for testers on shared scenarios or scenarios owned by others
    const canDelete = !isTester || (!sc.shared && sc.created_by === user.email);
    // Duplicate button: visible on every scenario the user can meaningfully
    // act on — previously this was gated to "tester + shared scenario" only,
    // which hid the feature from test-managers and owners duplicating their
    // own scenarios. Show it everywhere except when the scenario is shared
    // AND the viewer is a tester — in that case a 📋 pill is shown in its
    // own spot (template-duplicate usage was the original use-case).
    const showDuplicate = true;
    return `
    <div class="scenario-item">
      <div class="scenario-toggle" style="display:flex;align-items:center;gap:10px">
        <input type="checkbox" ${inRun ? 'checked' : ''}
          data-action="toggle-scenario" data-code="${esc(sc.code)}"
          title="${inRun ? 'Remove from run' : 'Add to run'}"
          style="accent-color:#0090D4;width:18px;height:18px;flex-shrink:0;cursor:pointer">
        <div style="flex:1;min-width:0;cursor:pointer" data-action="toggle-detail" data-idx="${esc(idx)}">
          <div style="font-weight:700;color:#1a2e40;font-size:13px">${esc(decodeCode(sc.code))} ${ownerBadge} ${versionBadge}</div>
          <div style="font-size:11px;color:#90a4ae;font-family:'Courier New',monospace">${esc(sc.code)}</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0;align-items:center">
          ${scenarioTypeBadge(sc)}
          ${sc.scenarioAction ? `<span class="badge badge-info">${esc(sc.scenarioAction)}</span>` : ''}
          <span class="badge ${inRun ? 'badge-in-run' : 'badge-not-in-run'}" id="inrun-${esc(sc.code)}"
            style="min-width:62px;text-align:center">
            ${inRun ? '✓ In run' : 'Not in run'}
          </span>
          <span class="toggle-arrow" id="arrow-${esc(idx)}" data-action="toggle-detail" data-idx="${esc(idx)}" style="cursor:pointer;padding:4px">▶</span>
          ${isTestManager ? `<button class="btn btn-sm" data-action="toggle-shared" data-idx="${esc(idx)}" title="${sc.shared ? 'Make private (your use only)' : 'Share with all testers'}" style="font-size:11px;padding:3px 8px;position:relative;z-index:2;${sc.shared ? 'background:#f3e5f5;color:#6a1b9a;border:1px solid #ce93d8' : 'background:#eceff1;color:#78909c;border:1px solid #cfd8dc'}">${sc.shared ? '🔒 Shared' : '🔓 Private'}</button>` : ''}
          ${showDuplicate ? `<button class="btn btn-sm btn-secondary" data-action="duplicate-scenario" data-idx="${esc(idx)}" title="Duplicate this shared scenario as your own">📋 Duplicate</button>` : ''}
          ${canDelete ? `<button class="row-delete-btn" data-action="delete-scenario" data-idx="${esc(idx)}" title="Delete this scenario">🗑</button>` : ''}
        </div>
      </div>
      <div class="scenario-detail" id="detail-${esc(idx)}"></div>
    </div>`;
  }).join('');
}

function toggleScenario(code, checked) {
  if (!state) return;
  const toRun = state.scenariosToRun || [];
  if (checked && !toRun.includes(code)) {
    state.scenariosToRun = [...toRun, code];
  } else if (!checked) {
    state.scenariosToRun = toRun.filter(c => c !== code);
  }
  // Update the in-run badge without full re-render
  const badge = document.getElementById('inrun-' + code);
  if (badge) {
    badge.className = `badge ${checked ? 'badge-in-run' : 'badge-not-in-run'}`;
    badge.textContent = checked ? '✓ In run' : 'Not in run';
  }
  markDirty();
}

function selectAll(checked) {
  if (!state) return;
  state.scenariosToRun = checked ? (state.scenarios || []).map(s => s.code) : [];
  renderAll();
  markDirty();
}

function toggleDetail(idx) {
  const detail = document.getElementById(`detail-${esc(idx)}`);
  const arrow  = document.getElementById(`arrow-${esc(idx)}`);
  const isOpen = detail.classList.contains('open');
  if (!isOpen) {
    // Lazy-render detail content
    if (!detail.dataset.rendered) {
      detail.innerHTML = buildDetailHTML(idx);
      detail.dataset.rendered = '1';
      // Read-only mode for testers viewing shared scenarios
      const sc = state.scenarios[idx];
      if (isTester && sc && sc.shared) {
        const banner = document.createElement('div');
        banner.innerHTML = '<div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#e65100">🔒 This scenario is managed by your Test Manager and cannot be modified.</div>';
        detail.prepend(banner.firstChild);
        detail.querySelectorAll('input, select, textarea').forEach(el => el.disabled = true);
        detail.querySelectorAll('.pill').forEach(el => el.style.pointerEvents = 'none');
        detail.querySelectorAll('[data-action="delete-scenario"]').forEach(el => el.style.display = 'none');
      }
    }
    detail.classList.add('open');
    arrow.classList.add('open');
  } else {
    detail.classList.remove('open');
    arrow.classList.remove('open');
  }
}

// ── Build the detail HTML for one scenario ────────────────────────────────────
function buildDetailHTML(idx) {
  const sc = state.scenarios[idx];
  const trip = getTrip(sc.tripRequirementId);
  const paxGroup = getPassengers(sc.passengersListId);
  const fulfGroup = getFulfillment(sc.requestedFulfillmentOptionsListId);
  const purchGroup = getPurchaser(sc.purchaserListId);

  // Read-only for testers when the scenario is shared by a test-manager.
  const codeReadOnly = isTester && sc.shared;
  return `
  <!-- Scenario params -->
  <div class="param-section">
    <div class="param-section-head" data-action="toggle-param-section">⚙️ Scenario Parameters<span class="ps-arrow open">▶</span></div>
    <div class="param-section-body open">
      <div class="param-grid">
        <div class="param-field" style="grid-column:1/-1">
          <span class="param-label">Scenario code <span class="param-hint">rename — normalised to A-Z 0-9 _ ; must stay unique</span></span>
          <input class="param-input" type="text" value="${esc(sc.code || '')}"
            style="font-family:'Consolas','Monaco','Courier New',monospace;letter-spacing:.5px"
            data-action="set-scenario-code" data-idx="${esc(idx)}" data-orig="${esc(sc.code || '')}"
            ${codeReadOnly ? 'disabled' : ''}>
        </div>
        ${buildSelect(idx, 'scenarioType',       'Scenario Type',        ENUMS.scenarioType)}
        ${(() => {
          // HTTP action (PATCH / DELETE) is only meaningful for after-sales
          // flows. SALE / Offer / Booking / Fulfillment don't have an Action;
          // showing the dropdown there is confusing and lets users save
          // garbage values. Mirrors the wizard which gates wiz-action the
          // same way (see renderWizardStep3, 's3-action-row' section).
          const scType = (state.scenarios[idx] || {}).scenarioType;
          if (scType !== 'REFUND' && scType !== 'EXCHANGE') return '';
          return buildSelect(idx, 'scenarioAction', 'Action', ENUMS.scenarioAction);
        })()}
        ${buildSelect(idx, 'loggingType',        'Logging Level',        ENUMS.loggingType)}
        ${buildSelect(idx, 'desiredFlexibility', 'Desired Flexibility',
          [null, ...fwFilter(ENUMS.desiredFlexibility.filter(v => v != null), (wizData.framework||{}).offerCriteria && wizData.framework.offerCriteria.flexibilities)],
          'Flexibility tier that will be selected from the offer')}
        ${(() => {
          // Hide the Overrule Code selector when the framework does not enable
          // IROPS for this scenario type. Shown only for REFUND / EXCHANGE
          // scenarios whose _IROPS flow is in salesFlows, and the codes
          // offered are intersected with fw.iropsCodes.<type>.
          const scType = (state.scenarios[idx] || {}).scenarioType;
          if (!fwSupportsIrops(scType)) return '';
          const codes = [null, ...fwIropsCodesFor(scType)];
          return buildSelect(idx, 'overruleCode', 'Overrule Code', codes,
            'Reason code used when overruling the refund/exchange policy');
        })()}
        ${buildText(idx,   'osdmVersion',        'OSDM Version',         'e.g. 3.4')}
      </div>
    </div>
  </div>

  <!-- Sales flow actions (SALE scenarios only) -->
  ${buildSalesFlowActionsSection(idx, sc)}

  <!-- Trip requirement -->
  ${buildTripSection(idx, sc, trip)}

  <!-- Offer search criteria -->
  ${buildOfferSection(idx, sc)}

  <!-- Fulfillment options -->
  ${buildFulfillmentSection(idx, sc, fulfGroup)}

  <!-- Passengers -->
  ${buildPassengersSection(idx, sc, paxGroup)}

  <!-- Purchaser -->
  ${buildPurchaserSection(idx, sc, purchGroup)}
  `;
}

// ── Scenario field builders ───────────────────────────────────────────────────

// Catalog of optional intermediate SALE-flow actions a user may opt in to.
// Each pill maps 1:1 to a step the Bruno test collection may execute between
// POST /bookings and POST /fulfillments. The library-bruno side reads these
// flags from the generated data file (via scenarioParser) and decides whether
// to run each step. Scope labels feed the Vendor Capability Matrix.
const SALES_FLOW_ACTIONS = [
  { key: 'patchPassengers', label: 'PATCH passengers', icon: '👤',
    description: 'Change passenger info between booking and fulfillment' },
  { key: 'placeSelection',  label: 'Place selection',  icon: '🪑',
    description: 'Pick specific seats when the offer has reservable parts' },
  { key: 'addAncillary',    label: 'Add ancillary',    icon: '🧳',
    description: 'Add an ancillary item when the offer has ancillaryOfferParts' },
  { key: 'getBooking',      label: 'GET booking',      icon: '🔄',
    description: 'Read the booking back after creation for consistency checks' },
  { key: 'deleteAncillary', label: 'Delete ancillary', icon: '✕',
    description: 'Remove a previously added ancillary (tests the reverse path)' },
];

// Place-selection modes (issue #107). Two genuinely different OSDM mechanisms,
// not "the same call at two times" — so the labels avoid the misleading
// pre/post-booking framing. The Test Framework declares which it supports
// (placeSelection.supportedModes); each scenario picks one from that menu.
const PLACE_SELECTION_MODES = [
  { key: 'SEATMAP_AT_OFFER', label: 'Seat map at offer', icon: '🪑',
    description: 'Traveller picks a seat before the booking is created (the seat may affect the price). Seat map → BookingRequest.placeSelections.' },
  { key: 'ADD_TO_BOOKING',   label: 'Add reservation to a booking', icon: '➕',
    description: 'A seat reservation is added after the booking already exists (e.g. SNCF first-class TGV). Adds an offer part to the booking.' },
];

// Defaults for newly-created scenarios: all actions OFF. The user opts in
// explicitly to each step they want to exercise. Legacy scenarios loaded
// from a data file that pre-dates this feature (no salesFlowActions field)
// are migrated separately by migrateLegacySalesFlowActions() to all-on,
// so their pre-existing behaviour is preserved — only *new* scenarios
// created through the OSCAR UI inherit the all-off default.
function defaultSalesFlowActions() {
  const o = {};
  SALES_FLOW_ACTIONS.forEach(a => { o[a.key] = false; });
  return o;
}

// On data-file load, any scenario missing salesFlowActions is treated as
// legacy: it predates this feature and was exercising every step in the
// library-bruno pipeline. Backfill with all-enabled so the UI displays
// the historic behaviour and nothing silently changes. Called from
// refreshAllSections once the datafile is loaded into state.
function migrateLegacySalesFlowActions() {
  (state && state.scenarios || []).forEach(sc => {
    if (!sc || sc.salesFlowActions && typeof sc.salesFlowActions === 'object') return;
    sc.salesFlowActions = {};
    SALES_FLOW_ACTIONS.forEach(a => { sc.salesFlowActions[a.key] = true; });
  });
}

/**
 * Ensure every scenario has at least an empty `offerSearchCriteria` object.
 *
 * The Bruno test collection (library-bruno/scenarioParser.js) treats a missing
 * `offerSearchCriteria` as "legacy datafile" and injects hard-coded fallback
 * values (currency=EUR, offerMode=INDIVIDUAL, requestedOfferParts=[ADMISSION,
 * RESERVATION]) — which is exactly the behaviour OSDM users do NOT want when
 * they leave criteria blank in the wizard.
 *
 * Per OSDM spec, every offer-search criterion is optional. By guaranteeing the
 * object exists (empty by default), we tell Bruno "this scenario was authored
 * — send only what is explicitly present", which yields a request body with
 * none of those fields. The user's choices in the edit panel populate this
 * object incrementally via setOfferField / toggleOfferArray.
 *
 * Bruno standalone behaviour is unchanged: very old datafiles that genuinely
 * lack the field still hit the legacy fallback.
 */
function migrateMissingOfferSearchCriteria() {
  (state && state.scenarios || []).forEach(sc => {
    if (!sc) return;
    if (!sc.offerSearchCriteria || typeof sc.offerSearchCriteria !== 'object') {
      sc.offerSearchCriteria = {};
    }
  });
}

// Render a "Booking Flow Actions" param-section. Applies to every scenario
// that goes through the common booking flow — SALE exercises it end-to-end,
// REFUND and EXCHANGE run the same booking → fulfilment prelude before
// their dedicated aftersales steps. Hidden only when the scenario type is
// unset (null).
function buildSalesFlowActionsSection(idx, sc) {
  if (!sc.scenarioType) return '';
  const readOnly = isTester && sc.shared;
  const current = (sc && typeof sc.salesFlowActions === 'object' && sc.salesFlowActions)
    ? sc.salesFlowActions : defaultSalesFlowActions();

  // Gate 0 — the Test Framework authorises which optional actions a scenario may
  // select (issue #107). An unsupported action is shown disabled with the reason;
  // it cannot be turned on here.
  const fw = (wizData && wizData.framework) || {};
  const ticketTypes  = (fw.rail && Array.isArray(fw.rail.ticketTypes)) ? fw.rail.ticketTypes : [];
  const hasReservations = ticketTypes.includes('IRT') || ticketTypes.includes('NRT_OPTIONAL_RESERVATION');
  const hasSeatMap      = !!(fw.placeSelection && fw.placeSelection.seatMap);
  const hasAncillaries  = Array.isArray(fw.ancillaries) && fw.ancillaries.length > 0;
  const blockedReasonFor = {
    placeSelection: (hasReservations && hasSeatMap) ? null
      : 'Enable a reservation ticket type + "seat map" in your Test Framework first',
    addAncillary:    hasAncillaries ? null : 'Declare at least one ancillary in your Test Framework first',
    deleteAncillary: hasAncillaries ? null : 'Declare at least one ancillary in your Test Framework first',
  };

  const pills = SALES_FLOW_ACTIONS.map(a => {
    const blocked = blockedReasonFor[a.key] || null;     // null → authorised
    const on = current[a.key] === true && !blocked;       // a disabled action never shows selected
    const disabled = readOnly || !!blocked;
    const style = disabled ? ' style="pointer-events:none;opacity:.45"' : '';
    const title = blocked || a.description;
    return `<div class="pill${on?' selected':''}" data-action="toggle-sales-action" data-idx="${esc(idx)}" data-key="${esc(a.key)}" title="${esc(title)}"${style}>${a.icon} ${esc(a.label)}</div>`;
  }).join('');

  // Seat-selection mode picker — shown when the framework authorises place
  // selection. Limited to the framework's supported modes; single-select.
  let modePickerHtml = '';
  if (!blockedReasonFor.placeSelection) {
    const supported = (fw.placeSelection && Array.isArray(fw.placeSelection.supportedModes)) ? fw.placeSelection.supportedModes : [];
    const offered = PLACE_SELECTION_MODES.filter(m => supported.includes(m.key));
    if (offered.length > 0) {
      const sel = sc.placeSelectionMode || (offered.length === 1 ? offered[0].key : null);
      const modePills = offered.map(m => {
        const style = readOnly ? ' style="pointer-events:none;opacity:.6"' : '';
        return `<div class="pill${sel === m.key ? ' selected' : ''}" data-action="set-place-mode" data-idx="${esc(idx)}" data-val="${esc(m.key)}" title="${esc(m.description)}"${style}>${m.icon} ${esc(m.label)}</div>`;
      }).join('');
      modePickerHtml = `
        <div class="fw-subsection" style="margin-top:12px">
          <div class="fw-subsection-label" style="margin-bottom:6px">Seat-selection mode <span style="font-weight:400;color:#b0bec5;text-transform:none;letter-spacing:0">— applies when "Place selection" is enabled above</span></div>
          <div class="pill-group">${modePills}</div>
        </div>`;
    }
  }

  return `
  <div class="param-section">
    <div class="param-section-head" data-action="toggle-param-section">🛒 Booking Flow Actions <span class="param-hint" style="text-transform:none;letter-spacing:0;font-weight:400;color:#90a4ae">optional steps during the booking → fulfillment phase (applies to SALE, REFUND and EXCHANGE scenarios, which all start with a booking)</span><span class="ps-arrow">▶</span></div>
    <div class="param-section-body">
      <div style="padding:12px 14px">
        <div class="pill-group">${pills}</div>
        ${modePickerHtml}
        <div style="font-size:11px;color:#90a4ae;margin-top:10px;line-height:1.5">
          Enabled steps are attempted in order after the booking is created. If the offer
          doesn't support a step (e.g. no ancillaries in the offer, non-reservable train),
          the test runner logs it as <strong>NOT_APPLICABLE</strong> and continues —
          each attempted action becomes one row in the Vendor Capability Matrix of the
          generated report, so a certifier can see at a glance which sub-flows the vendor
          implements. Greyed-out actions are not enabled in your Test Framework.
        </div>
      </div>
    </div>
  </div>`;
}

function buildSelect(idx, field, label, options, hint) {
  const val = (state.scenarios[idx] || {})[field];
  const hintHtml = hint ? `<span class="param-hint">${esc(hint)}</span>` : '';
  const opts = options.map(o =>
    `<option value="${esc(o == null ? '' : o)}" ${(val == null ? '' : val) === (o == null ? '' : o) ? 'selected' : ''}>${esc(lbl(o))}</option>`
  ).join('');
  return `
  <div class="param-field">
    <span class="param-label">${esc(label)}${hintHtml}</span>
    <select class="param-input param-select"
      data-action="set-scenario" data-idx="${esc(idx)}" data-field="${esc(field)}" data-nullable="true">
      ${opts}
    </select>
  </div>`;
}

function buildText(idx, field, label, placeholder, hint) {
  const val = (state.scenarios[idx] || {})[field] || '';
  const hintHtml = hint ? `<span class="param-hint">${esc(hint)}</span>` : '';
  return `
  <div class="param-field">
    <span class="param-label">${esc(label)}${hintHtml}</span>
    <input class="param-input" type="text" value="${esc(val)}" placeholder="${esc(placeholder||'')}"
      data-action="set-scenario-text" data-idx="${esc(idx)}" data-field="${esc(field)}">
  </div>`;
}

// ── Trip section ──────────────────────────────────────────────────────────────
// Renders a compact "apply test data" dropdown — user picks one of the
// Section-2 train resources, we copy its origin/destination/times/vehicle/
// operator into the scenario's trip (or selected leg). Trip fields stay
// editable afterwards, so the user can tweak any single parameter without
// re-typing the whole set. Returns empty string when no trains are defined.
function buildTripTrainPicker(idx, tIdx, target, trains) {
  if (!trains.length) return '';
  const label = target === 'trip'
    ? 'Apply test data (single trip)'
    : 'Apply to Leg ' + (parseInt(target.slice(5)) + 1);
  return `
  <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#546e7a;margin-bottom:10px">
    <span style="font-weight:600">🚄 ${label}:</span>
    <select class="param-input param-select" style="max-width:280px;font-size:12px"
      data-action="apply-trip-train" data-idx="${esc(idx)}" data-tidx="${esc(tIdx)}" data-target="${esc(target)}">
      <option value="">— pick a service to copy its parameters —</option>
      ${trains.flatMap(t => {
        const d = normalizeTrainData(typeof t.data === 'string' ? JSON.parse(t.data) : (t.data || {}));
        const route = [d.originURN, d.destinationURN].filter(Boolean).join(' → ');
        const svcs = d.services.length ? d.services : [{}];
        return svcs.map((s, si) => {
          const svcLabel = [s.vehicleNumber, s.departureTime].filter(Boolean).join(' ');
          const bits = [t.label || '?', route, svcLabel].filter(Boolean).join(' — ');
          return '<option value="' + esc(t.id) + '::' + si + '">' + esc(bits) + '</option>';
        });
      }).join('')}
    </select>
    <span style="color:#90a4ae;font-size:11px">values fill the fields below; edit any of them afterwards</span>
  </div>`;
}

function buildTripSection(idx, sc, trip) {
  const tIdx = (state.tripRequirements || []).findIndex(t => t.id === sc.tripRequirementId);
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');

  const tripTypeSelect = `
  <div class="param-field">
    <span class="param-label">Trip Type <span class="param-hint">How the origin/destination is specified</span></span>
    <select class="param-input param-select"
      data-action="set-trip-field" data-tidx="${esc(tIdx)}" data-field="tripType">
      ${ENUMS.tripType.map(t => `<option value="${t}" ${trip.tripType===t?'selected':''}>${lbl(t)}</option>`).join('')}
    </select>
  </div>`;

  // Apply-a-Journey picker (#137) — fills all legs from a saved journey.
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const journeyPicker = journeys.length ? `
  <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#546e7a;margin:8px 0 4px">
    <span style="font-weight:600">🧭 Apply a Journey:</span>
    <select class="param-input param-select" style="max-width:340px;font-size:12px"
      data-action="apply-trip-journey" data-idx="${esc(idx)}" data-tidx="${esc(tIdx)}">
      <option value="">— pick a saved journey to fill all legs —</option>
      ${journeys.map(j => `<option value="${esc(j.id)}">${esc(j.label || j.id)} — ${esc(journeySummary(j))}</option>`).join('')}
    </select>
    <span style="color:#90a4ae;font-size:11px">sets SPECIFICATION + fills the legs below</span>
  </div>` : '';

  let inner = '';
  if (trip.tripType === 'SPECIFICATION' && Array.isArray(trip.legs)) {
    inner = trip.legs.map((leg, li) => `
    <div class="sub-card">
      <div class="sub-card-title">Leg ${li+1}</div>
      <div style="padding:0 14px 0">${buildTripTrainPicker(idx, tIdx, 'legs.' + li, trains)}</div>
      <div class="param-grid">
        ${buildTripTextField(tIdx, `legs.${li}.origin`,      'Origin UIC',          leg.origin,      'urn:uic:stn:...')}
        ${buildTripTextField(tIdx, `legs.${li}.destination`, 'Destination UIC',     leg.destination, 'urn:uic:stn:...')}
        ${buildTripTimeField(tIdx, `legs.${li}.startDatetime`, 'Departure <span class="param-hint">HH:MM:SS±HH:MM</span>', leg.startDatetime, '07:00:00+02:00')}
        ${buildTripTimeField(tIdx, `legs.${li}.endDatetime`,   'Arrival <span class="param-hint">HH:MM:SS±HH:MM</span>',   leg.endDatetime,   '09:00:00+02:00')}
        ${buildTripTextField(tIdx, `legs.${li}.vehicleNumber`, 'Vehicle #',         leg.vehicleNumber, '')}
        ${buildTripTextField(tIdx, `legs.${li}.operatorCode`,  'Operator Code',     leg.operatorCode, 'urn:uic:rics:...')}
      </div>
    </div>`).join('');
  } else {
    const t = trip.trip || {};
    inner = `${buildTripTrainPicker(idx, tIdx, 'trip', trains)}
    <div class="param-grid">
      ${buildTripTextField(tIdx, 'trip.origin',      'Origin UIC <span class="param-hint">urn:uic:stn:NNNNNNN</span>',      t.origin,      'urn:uic:stn:...')}
      ${buildTripTextField(tIdx, 'trip.destination', 'Destination UIC <span class="param-hint">urn:uic:stn:NNNNNNN</span>', t.destination, 'urn:uic:stn:...')}
      ${buildTripTimeField(tIdx, 'trip.startDatetime', 'Departure <span class="param-hint">HH:MM:SS±HH:MM — date added automatically</span>', t.startDatetime, '07:00:00+02:00')}
      ${buildTripTimeField(tIdx, 'trip.endDatetime',   'Arrival <span class="param-hint">HH:MM:SS±HH:MM</span>',   t.endDatetime,   '09:00:00+02:00')}
      ${buildTripTextField(tIdx, 'trip.vehicleNumber', 'Vehicle # <span class="param-hint">Train number</span>', t.vehicleNumber, '')}
      ${buildTripTextField(tIdx, 'trip.operatorCode',  'Operator Code <span class="param-hint">urn:uic:rics:NNNN</span>', t.operatorCode,  'urn:uic:rics:...')}
    </div>`;
  }

  return `
  <div class="param-section">
    <div class="param-section-head" data-action="toggle-param-section">🚂 Trip (requirement #${sc.tripRequirementId})<span class="ps-arrow">▶</span></div>
    <div class="param-section-body">
      <div style="padding:12px 14px 4px">${tripTypeSelect}${journeyPicker}</div>
      <div style="padding:0 14px 12px">${inner}</div>
    </div>
  </div>`;
}

// Time field: strips %TRIP_DATE%T for display, re-adds on save
function buildTripTimeField(tIdx, path, label, val, placeholder) {
  const displayVal = (val || '').replace(/%TRIP_DATE%T/g, '');
  return `
  <div class="param-field">
    <span class="param-label">${label}</span>
    <input class="param-input" type="text" value="${esc(displayVal)}" placeholder="${esc(placeholder||'')}"
      data-action="set-trip-time" data-tidx="${esc(tIdx)}" data-path="${path}">
  </div>`;
}

function buildTripTextField(tIdx, path, label, val, placeholder) {
  return `
  <div class="param-field">
    <span class="param-label">${label}</span>
    <input class="param-input" type="text" value="${esc(val||'')}" placeholder="${esc(placeholder||'')}"
      data-action="set-trip-path" data-tidx="${esc(tIdx)}" data-path="${path}">
  </div>`;
}

// Re-render one scenario detail panel in place, preserving which
// param-sections were expanded. Used by handlers that change fields whose
// edits reshape the markup (scenarioType, tripType, purchaser link toggle,
// passenger category, …). Quietly returns if the detail isn't rendered.
function reRenderScenarioDetail(scIdx) {
  const detail = document.getElementById('detail-' + scIdx);
  if (!detail || !detail.dataset.rendered) return;
  const openSections = new Set();
  detail.querySelectorAll('.param-section-head').forEach(h => {
    if (h.nextElementSibling && h.nextElementSibling.classList.contains('open')) {
      openSections.add((h.textContent || '').trim());
    }
  });
  detail.innerHTML = buildDetailHTML(scIdx);
  detail.querySelectorAll('.param-section-head').forEach(h => {
    const label = (h.textContent || '').trim();
    const isOpen = openSections.has(label);
    if (h.nextElementSibling) h.nextElementSibling.classList.toggle('open', isOpen);
    const arrow = h.querySelector('.ps-arrow');
    if (arrow) arrow.classList.toggle('open', isOpen);
  });
}

// ── Passengers section ────────────────────────────────────────────────────────
// Per-passenger "Edit ▾" expand state is kept here (keys "pIdx:pi") so a
// re-render of the scenario detail (e.g. after changing scenario type or
// tripType) doesn't snap open editors closed. Set survives the lifetime of
// the page session; cleared when the user navigates away.
const _paxEditOpen = new Set();

// Renders one free-text row in the Reduction Cards list. Vendor-specific
// codes — no enum lookup; users type whatever their platform accepts.
function buildReductionCardRow(pIdx, pi, ci, code, readOnly) {
  return `
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px" data-pax-reduction-row="${esc(pIdx)}-${esc(pi)}-${esc(ci)}">
    <input class="param-input" type="text" value="${esc(code||'')}" placeholder="e.g. BC_50"
      style="font-family:'Consolas','Monaco','Courier New',monospace;font-size:12px;max-width:260px"
      data-action="set-pax-reduction" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-cidx="${esc(ci)}" ${readOnly?'disabled':''}>
    ${!readOnly ? `<button class="btn btn-sm" data-action="remove-pax-reduction" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-cidx="${esc(ci)}" style="font-size:11px;padding:2px 6px;color:#c62828;background:#ffebee;border:1px solid #ef9a9a" title="Remove">✕</button>` : ''}
  </div>`;
}

// Renders one loyalty-card row: carrier code + card reference. Both are
// free text — vendor-specific formats (e.g. carrier 'FR_SNCF', reference
// '9988-7766-5544'). No validation beyond non-empty.
function buildLoyaltyCardRow(pIdx, pi, ci, card, readOnly) {
  const c = card || {};
  return `
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap" data-pax-loyalty-row="${esc(pIdx)}-${esc(pi)}-${esc(ci)}">
    <label style="display:flex;flex-direction:column;gap:2px;font-size:10px;color:#90a4ae">Carrier code
      <input class="param-input" type="text" value="${esc(c.carrierCode||'')}" placeholder="e.g. FR_SNCF"
        style="font-family:'Consolas','Monaco','Courier New',monospace;font-size:12px;max-width:160px"
        data-action="set-pax-loyalty" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-cidx="${esc(ci)}" data-field="carrierCode" ${readOnly?'disabled':''}>
    </label>
    <label style="display:flex;flex-direction:column;gap:2px;font-size:10px;color:#90a4ae">Card reference
      <input class="param-input" type="text" value="${esc(c.cardReference||'')}" placeholder="e.g. 9988-7766-5544"
        style="font-family:'Consolas','Monaco','Courier New',monospace;font-size:12px;max-width:240px"
        data-action="set-pax-loyalty" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-cidx="${esc(ci)}" data-field="cardReference" ${readOnly?'disabled':''}>
    </label>
    ${!readOnly ? `<button class="btn btn-sm" data-action="remove-pax-loyalty" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-cidx="${esc(ci)}" style="font-size:11px;padding:2px 6px;color:#c62828;background:#ffebee;border:1px solid #ef9a9a;align-self:flex-end" title="Remove">✕</button>` : ''}
  </div>`;
}

function buildPassengersSection(idx, sc, paxGroup) {
  const pIdx = (state.passengersList || []).findIndex(p => p.id === sc.passengersListId);
  const passengers = paxGroup.passengers || [];

  const readOnly = isTester && sc.shared;
  // Infer category from firstName prefix (e.g. "ADULT_Marie") or from stored category field
  function inferCategory(p) {
    if (p.category) return p.category;
    if (p.firstName) {
      const match = p.firstName.match(/^(ADULT|CHILD|YOUTH|SENIOR|YOUNG_CHILD|FAMILY_CHILD|PRM|ACCOMP_PRM)_/i);
      if (match) return match[1].toUpperCase();
    }
    return 'ADULT';
  }

  // Passenger category dropdown is filtered by the framework's passengerTypes.
  // The current category is always preserved in the list even if the framework
  // later restricted it — editing must not silently coerce existing data.
  const FULL_PAX_CATS = ['ADULT','CHILD','YOUTH','SENIOR','YOUNG_CHILD','FAMILY_CHILD','PRM','ACCOMP_PRM',
    'DOG','PET','BICYCLE','LUGGAGE','PRAM','CAR','MOTORCYCLE','TRAILER','WHEELCHAIR'];
  const fwPaxTypes = ((wizData && wizData.framework) || {}).passengerTypes;
  const allowedPaxCats = fwFilter(FULL_PAX_CATS, fwPaxTypes);
  // Collect the current set of family groups in this passenger list, and
  // the canonical lastName for each — that's the lastName any member can
  // be taken to share. The set is computed up-front so every pax's family
  // dropdown sees the same option set.
  const familyGroups = [];   // [{ n: 1, lastName: 'Durand', count: 2 }, …]
  passengers.forEach(p => {
    if (!p || !Number.isInteger(p.familyGroup)) return;
    const existing = familyGroups.find(g => g.n === p.familyGroup);
    if (existing) {
      existing.count++;
      if (!existing.lastName && p.lastName) existing.lastName = p.lastName;
    } else {
      familyGroups.push({ n: p.familyGroup, lastName: p.lastName || '', count: 1 });
    }
  });
  familyGroups.sort((a, b) => a.n - b.n);
  const nextFamilyNum = (familyGroups.length > 0 ? Math.max(...familyGroups.map(g => g.n)) : 0) + 1;

  const rows = passengers.map((p, pi) => {
    const cat = inferCategory(p);
    const isHuman = WIZ_HUMAN_PAX_TYPES.includes(cat);
    const ageRange = isHuman ? (WIZ_PAX_DEFAULT_AGES[cat] || {min:18, max:99}) : null;
    // null / undefined gender = "None" (field omitted from offer request).
    // Only MALE / FEMALE / X are actually observed in vendor responses across
    // the test corpus; OTHER and UNSPECIFIED were removed as speculative.
    const gender  = p.gender || '';
    const famN    = Number.isInteger(p.familyGroup) ? p.familyGroup : null;
    // Always include the current category in the list so existing passenger
    // data remains editable after the framework narrows its pax types.
    const catOptions = allowedPaxCats.includes(cat) ? allowedPaxCats : [cat, ...allowedPaxCats];
    // Gender selector for human pax — values match what vendors actually
    // accept across the test corpus. "None" (empty value) means the gender
    // field is omitted from the offer / booking / PATCH requests entirely,
    // for vendors that treat gender as optional and reject synthetic values.
    const genderSelect = isHuman ? `
    <select class="param-input param-select" style="max-width:130px;font-size:12px"
      data-action="set-pax" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-field="gender" ${readOnly ? 'disabled' : ''}>
      <option value=""       ${!gender           ?'selected':''}>— None (omit) —</option>
      <option value="MALE"   ${gender==='MALE'   ?'selected':''}>Male</option>
      <option value="FEMALE" ${gender==='FEMALE' ?'selected':''}>Female</option>
      <option value="X"      ${gender==='X'      ?'selected':''}>X (legacy)</option>
    </select>` : '';
    const editKey = pIdx + ':' + pi;
    const isEditOpen = _paxEditOpen.has(editKey);
    // Expandable editor — personal details + free-entry reduction cards +
    // free-entry loyalty cards. Vendor-specific codes, so no enum; users add
    // as many rows as they need. Auto-marks dirty via setPaxField.
    const reductionCards = Array.isArray(p.reductionCards) ? p.reductionCards : [];
    const loyaltyCards   = Array.isArray(p.loyaltyCards)   ? p.loyaltyCards   : [];
    const editPanel = `
    <div class="pax-edit-panel" id="pax-edit-${esc(pIdx)}-${esc(pi)}" style="display:${isEditOpen?'block':'none'};padding:12px 16px 16px 40px;background:#fafbfc;border-bottom:1px solid #f0f0f0">
      <!-- Personal details -->
      <div class="param-section" style="margin-bottom:10px">
        <div class="param-section-head" style="font-size:11px">👤 Personal details</div>
        <div style="padding:10px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 16px">
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#546e7a;font-weight:600">First name
            <input class="param-input" type="text" value="${esc(p.firstName||'')}"
              data-action="set-pax-text" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-field="firstName" ${readOnly?'disabled':''}>
          </label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#546e7a;font-weight:600">Last name
            <input class="param-input" type="text" value="${esc(p.lastName||'')}"
              data-action="set-pax-text" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-field="lastName" ${readOnly?'disabled':''}>
          </label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#546e7a;font-weight:600">Date of birth
            <input class="param-input" type="text" value="${esc(p.dateOfBirth||'')}" placeholder="YYYY-MM-DD"
              data-action="set-pax-text" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-field="dateOfBirth" ${readOnly?'disabled':''}>
          </label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#546e7a;font-weight:600">Email
            <input class="param-input" type="email" value="${esc(p.email||'')}"
              data-action="set-pax-text" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-field="email" ${readOnly?'disabled':''}>
          </label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#546e7a;font-weight:600">Phone
            <input class="param-input" type="text" value="${esc(p.phoneNumber||'')}"
              data-action="set-pax-text" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-field="phoneNumber" ${readOnly?'disabled':''}>
          </label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#546e7a;font-weight:600">Family group
            <select class="param-input param-select" data-action="set-pax-family" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" ${readOnly?'disabled':''}>
              <option value="" ${famN==null?'selected':''}>— no family —</option>
              ${familyGroups.map(g => `<option value="${g.n}" ${famN===g.n?'selected':''}>Family ${g.n}${g.lastName ? ' — ' + esc(g.lastName) : ''} (${g.count} member${g.count===1?'':'s'})</option>`).join('')}
              <option value="__new__" ${famN!=null && !familyGroups.some(g => g.n===famN) ? 'selected' : ''}>+ New family (Family ${nextFamilyNum})</option>
            </select>
            <span style="font-size:10px;color:#90a4ae;font-weight:400">Members share the same last name. Edit one member's last name — the others update automatically.</span>
          </label>
        </div>
      </div>
      <!-- Reduction cards — free text, vendor-specific codes -->
      <div class="param-section" style="margin-bottom:10px">
        <div class="param-section-head" style="font-size:11px">🏷️ Reduction cards <span style="font-weight:400;color:#b0bec5;text-transform:none;letter-spacing:0;margin-left:6px">vendor-specific codes — e.g. BC_50, SENIOR, CARTE_LIBERTE</span></div>
        <div style="padding:10px 14px" id="pax-reductions-${esc(pIdx)}-${esc(pi)}">
          ${reductionCards.map((code, ci) => buildReductionCardRow(pIdx, pi, ci, code, readOnly)).join('')}
          ${!readOnly ? `<button class="btn btn-sm btn-secondary" data-action="add-pax-reduction" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" style="font-size:11px;margin-top:6px">➕ Add reduction card</button>` : ''}
        </div>
      </div>
      <!-- Loyalty cards — free-entry carrier code + card reference -->
      <div class="param-section">
        <div class="param-section-head" style="font-size:11px">⭐ Loyalty cards <span style="font-weight:400;color:#b0bec5;text-transform:none;letter-spacing:0;margin-left:6px">carrier code + card reference — vendor-specific format</span></div>
        <div style="padding:10px 14px" id="pax-loyalties-${esc(pIdx)}-${esc(pi)}">
          ${loyaltyCards.map((card, ci) => buildLoyaltyCardRow(pIdx, pi, ci, card, readOnly)).join('')}
          ${!readOnly ? `<button class="btn btn-sm btn-secondary" data-action="add-pax-loyalty" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" style="font-size:11px;margin-top:6px">➕ Add loyalty card</button>` : ''}
        </div>
      </div>
    </div>`;
    return `
  <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:${isEditOpen?'none':'1px solid #f0f0f0'}">
    <span style="font-weight:700;color:#546e7a;font-size:12px;min-width:24px">#${pi+1}</span>
    <select class="param-input param-select" style="max-width:180px;font-size:12px"
      data-action="change-pax-category" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" data-scenidx="${esc(idx)}" ${readOnly ? 'disabled' : ''}>
      ${catOptions.map(c =>
        `<option value="${esc(c)}" ${c===cat?'selected':''}>${c.replace(/_/g,' ')}${allowedPaxCats.includes(c) ? '' : ' (not in framework)'}</option>`
      ).join('')}
    </select>
    ${genderSelect}
    <span style="font-size:12px;color:#78909c" data-pax-display="${esc(pIdx)}-${esc(pi)}">${esc(p.firstName||'')} ${esc(p.lastName||'')}</span>
    ${famN != null ? `<span data-pax-family-badge="${esc(pIdx)}-${esc(pi)}" title="Part of Family ${famN} — shares last name with other family members" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;background:#f3e5f5;color:#6a1b9a;border:1px solid #ce93d8">👪 F${famN}</span>` : `<span data-pax-family-badge="${esc(pIdx)}-${esc(pi)}"></span>`}
    ${ageRange ? `<span style="font-size:11px;color:#90a4ae">age ${ageRange.min}-${ageRange.max}</span>` : ''}
    <button class="btn btn-sm btn-secondary" data-action="toggle-pax-edit" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" style="font-size:11px;padding:2px 8px;margin-left:auto" title="Edit full details, reduction cards, loyalty cards">${isEditOpen ? 'Edit ▴' : 'Edit ▾'}</button>
    ${!readOnly && passengers.length > 1 ? `<button class="btn btn-sm" data-action="remove-pax" data-pidx="${esc(pIdx)}" data-pi="${esc(pi)}" style="font-size:11px;padding:2px 6px;color:#c62828;background:#ffebee;border:1px solid #ef9a9a" title="Remove">✕</button>` : ''}
  </div>
  ${editPanel}`;
  }).join('');

  return `
  <div class="param-section">
    <div class="param-section-head" data-action="toggle-param-section">👥 Passengers (list #${sc.passengersListId} — ${passengers.length} passenger${passengers.length!==1?'s':''})<span class="ps-arrow">▶</span></div>
    <div class="param-section-body">
      <div style="padding:12px 14px">
        ${rows || '<div style="color:#90a4ae;font-size:13px">No passengers defined.</div>'}
        ${!readOnly ? `
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #eceff1;display:flex;gap:8px;align-items:center">
          <select id="add-pax-type-${esc(pIdx)}" class="param-input param-select" style="max-width:180px;font-size:12px">
            ${allowedPaxCats.map(c => `<option value="${esc(c)}">${c.replace(/_/g,' ')}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-primary" data-action="add-pax" data-pidx="${esc(pIdx)}" data-scenidx="${esc(idx)}" style="font-size:12px" ${allowedPaxCats.length===0?'disabled':''}>➕ Add Passenger</button>
          ${allowedPaxCats.length===0 ? '<span style="font-size:11px;color:#e65100">⚠ No passenger types in framework — configure Step 1 first.</span>' : ''}
        </div>` : ''}
      </div>
    </div>
  </div>`;
}

// ── Purchaser section ─────────────────────────────────────────────────────────
// Default purchaser values are prefixed so the user can tell at a glance
// the field is purchaser-specific (and so the code can tell later whether
// to overwrite on link/relink). Starts-with check — if the user typed
// something custom, we leave it alone.
const PURCHASER_DEFAULT_PREFIX = 'Purchaser_';
function isDefaultPurchaserValue(s) {
  return typeof s === 'string' && s.indexOf(PURCHASER_DEFAULT_PREFIX) === 0;
}

function buildPurchaserSection(idx, sc, purchGroup) {
  // Ensure the purchaser list entry exists. Legacy data files, imports, or
  // in-place edits can leave sc.purchaserListId pointing at nothing; the
  // previous render just showed empty inputs and the link-checkbox handler
  // silently bailed out because state.purchaserList[-1] was undefined.
  let prIdx = (state.purchaserList || []).findIndex(p => p.id === sc.purchaserListId);
  if (prIdx === -1) {
    state.purchaserList = state.purchaserList || [];
    const newPurchId = sc.purchaserListId || (Math.max(0, ...state.purchaserList.map(p => p.id || 0)) + 1);
    sc.purchaserListId = newPurchId;
    const newEntry = { id: newPurchId, purchaser: [{}] };
    state.purchaserList.push(newEntry);
    prIdx = state.purchaserList.length - 1;
    purchGroup = newEntry;
    markDirty();
  }
  purchGroup.purchaser = purchGroup.purchaser || [{}];
  if (!purchGroup.purchaser[0]) purchGroup.purchaser[0] = {};
  const purch = purchGroup.purchaser[0];

  const readOnly = isTester && sc.shared;

  // Seed default purchaser values if the record is completely empty. The
  // "Purchaser_" prefix makes it obvious the field is purchaser-specific,
  // and any later link-to-passenger / manual edit overwrites it.
  if (!readOnly && !purch.purchaserFirstName && !purch.purchaserLastName
      && !purch.purchaserEmail && !purch.purchaserPhoneNumber) {
    const fn   = PURCHASER_DEFAULT_PREFIX + randomPick(WIZ_FIRST_NAMES_ANY);
    const ln   = PURCHASER_DEFAULT_PREFIX + randomPick(WIZ_RANDOM_LAST_NAMES);
    const slug = ((wizProfile && (wizProfile.slug || wizProfile.company_name)) || 'company')
                   .toLowerCase().replace(/[^a-z0-9]/g, '');
    purch.purchaserFirstName   = fn;
    purch.purchaserLastName    = ln;
    purch.purchaserEmail       = fn.toLowerCase() + '.' + ln.toLowerCase() + '@' + slug + '.com';
    purch.purchaserPhoneNumber = genPhone();
    markDirty();
  }

  // "Purchaser is one of the passengers" — when enabled, fields mirror the
  // selected passenger's firstName/lastName/email/phone. The stored purchaser
  // values are kept in sync whenever the passenger is edited (see
  // syncPurchaserFromPassenger). At data-file save time the purchaser block
  // carries the materialised values, so downstream consumers don't need to
  // resolve the link.
  const paxList = (state.passengersList || []).find(p => p.id === sc.passengersListId);
  const passengers = (paxList && paxList.passengers) || [];
  const isLinked   = !!purch.isPassenger;
  const linkedRef  = purch.passengerRef || (passengers[0] && passengers[0].reference) || '';

  const linkToggle = `
  <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;cursor:pointer">
    <input type="checkbox" ${isLinked?'checked':''} ${readOnly?'disabled':''}
      style="accent-color:#0090D4;width:16px;height:16px"
      data-action="toggle-purchaser-is-pax" data-idx="${esc(idx)}" data-purch-idx="${esc(prIdx)}">
    <span>Purchaser is one of the passengers</span>
  </label>`;

  const passengerPicker = isLinked ? `
  <div class="param-field" style="max-width:320px;margin-top:8px">
    <span class="param-label">Which passenger?</span>
    <select class="param-input param-select"
      data-action="set-purchaser-passenger" data-idx="${esc(idx)}" data-purch-idx="${esc(prIdx)}" ${readOnly?'disabled':''}>
      ${passengers.map(p => {
        const display = (p.firstName || p.reference || '?') + ' ' + (p.lastName || '') + ' — ' + (p.reference || '');
        return '<option value="' + esc(p.reference||'') + '"' + (p.reference===linkedRef?' selected':'') + '>' + esc(display) + '</option>';
      }).join('') || '<option disabled>No passengers defined</option>'}
    </select>
  </div>` : '';

  // When linked, show the resolved values in disabled fields so the user sees
  // what the data file will contain. Edits are disabled — change the linked
  // passenger's fields instead (edits propagate automatically).
  const disabledAttr = (isLinked || readOnly) ? 'disabled' : '';
  const fieldsGrid = `
  <div class="param-grid" style="padding:12px 14px">
    <div class="param-field">
      <span class="param-label">First Name</span>
      <input class="param-input" type="text" value="${esc(purch.purchaserFirstName||'')}" placeholder="First name"
        data-action="set-purchaser" data-purch-idx="${esc(prIdx)}" data-field="purchaserFirstName" ${disabledAttr}>
    </div>
    <div class="param-field">
      <span class="param-label">Last Name</span>
      <input class="param-input" type="text" value="${esc(purch.purchaserLastName||'')}" placeholder="Last name"
        data-action="set-purchaser" data-purch-idx="${esc(prIdx)}" data-field="purchaserLastName" ${disabledAttr}>
    </div>
    <div class="param-field">
      <span class="param-label">Email</span>
      <input class="param-input" type="email" value="${esc(purch.purchaserEmail||'')}" placeholder="purchaser@company.com"
        data-action="set-purchaser" data-purch-idx="${esc(prIdx)}" data-field="purchaserEmail" ${disabledAttr}>
    </div>
    <div class="param-field">
      <span class="param-label">Phone Number</span>
      <input class="param-input" type="text" value="${esc(purch.purchaserPhoneNumber||'')}" placeholder="+33600000000"
        data-action="set-purchaser" data-purch-idx="${esc(prIdx)}" data-field="purchaserPhoneNumber" ${disabledAttr}>
    </div>
  </div>
  ${isLinked ? '<div style="padding:0 14px 12px;font-size:11px;color:#78909c">These fields mirror the selected passenger. Edit the passenger to change them.</div>' : ''}`;

  return `
  <div class="param-section">
    <div class="param-section-head" data-action="toggle-param-section">💳 Purchaser Information<span class="ps-arrow">▶</span></div>
    <div class="param-section-body">
      <div style="padding:12px 14px 0">${linkToggle}${passengerPicker}</div>
      ${fieldsGrid}
    </div>
  </div>`;
}

// Copy a passenger's core fields into the linked purchaser. Called at link
// time (toggle on or passenger picker change) and from setPaxField whenever
// a passenger bound to a purchaser has its name/email/phone edited.
function syncPurchaserFromPassenger(paxList, pax) {
  if (!paxList || !pax) return;
  (state.scenarios || []).forEach(sc => {
    if (sc.passengersListId !== paxList.id) return;
    const purchList = (state.purchaserList || []).find(p => p.id === sc.purchaserListId);
    if (!purchList) return;
    const p0 = (purchList.purchaser = purchList.purchaser || [{}])[0];
    if (!p0 || !p0.isPassenger || p0.passengerRef !== pax.reference) return;
    p0.purchaserFirstName    = pax.firstName    || '';
    p0.purchaserLastName     = pax.lastName     || '';
    p0.purchaserEmail        = pax.email        || '';
    p0.purchaserPhoneNumber  = pax.phoneNumber  || '';
  });
}

// ── Offer search criteria section (inline on scenario) ───────────────────────
function buildOfferSection(idx, sc) {
  const criteria = sc.offerSearchCriteria || {};

  // Offer search criteria are free request filters: a scenario must be able to
  // request ANY value from the OSDM master list — including travel/service
  // classes or offer parts the train or system-under-test doesn't support — so
  // that non-happy-flow scenarios can be authored (#155). Travel class is test
  // data (per train), not a framework setting; the framework must NOT restrict
  // these options. So each list is the full OSDM enum, unioned with whatever is
  // already selected (a safety net for any custom/out-of-enum value).
  const withSelected = (allowed, selected) =>
    [...new Set([...(allowed || []), ...(Array.isArray(selected) ? selected : [])])];
  const modeList         = withSelected(ENUMS.offerMode,           criteria.offerMode ? [criteria.offerMode] : []);
  const offerPartsList   = withSelected(ENUMS.requestedOfferParts, criteria.requestedOfferParts);
  const serviceClassList = withSelected(ENUMS.serviceClass,        criteria.serviceClass);
  const travelClassList  = withSelected(ENUMS.travelClass,         criteria.travelClass);
  const flexibilityList  = withSelected(ENUMS.flexibilities,       criteria.flexibilities);

  const modeOpts = `<option value="" ${!criteria.offerMode?'selected':''} style="color:#90a4ae">— none —</option>`
    + modeList.map(m =>
    `<option value="${m}" ${criteria.offerMode===m?'selected':''}>${esc(lbl(m))}</option>`).join('');

  return `
  <div class="param-section">
    <div class="param-section-head" data-action="toggle-param-section">🔍 Offer Search Criteria<span class="ps-arrow">▶</span></div>
    <div class="param-section-body">
    <div class="param-grid" style="padding:12px 14px 4px">
      <div class="param-field">
        <span class="param-label">Offer Mode <span class="param-hint">(optional) — how offers are grouped</span></span>
        <select class="param-input param-select"
          data-action="set-offer" data-idx="${esc(idx)}" data-field="offerMode">
          ${modeOpts}
        </select>
      </div>
      <div class="param-field">
        <span class="param-label">Currency <span class="param-hint">(optional) — ISO 4217 code</span></span>
        <input class="param-input" type="text" maxlength="3" value="${esc(criteria.currency||'')}" placeholder="e.g. EUR, CZK, CHF"
          data-action="set-offer-currency" data-idx="${esc(idx)}">
      </div>
    </div>

    <div style="padding:4px 14px 2px;font-size:10px;font-weight:800;color:#90a4ae;text-transform:uppercase;letter-spacing:.4px">
      Requested Offer Parts <span style="font-weight:400;text-transform:none">(optional) — what components to return</span>
    </div>
    <div class="multi-check" id="offer-parts-${esc(idx)}">
      ${offerPartsList.map(p => {
        const checked = (criteria.requestedOfferParts || []).includes(p);
        return `<label class="${checked?'checked':''}">
          <input type="checkbox" ${checked?'checked':''} data-action="toggle-offer-array" data-idx="${esc(idx)}" data-field="requestedOfferParts" data-val="${esc(p)}">
          ${esc(lbl(p))}
        </label>`;
      }).join('')}
    </div>

    <div style="padding:4px 14px 2px;font-size:10px;font-weight:800;color:#90a4ae;text-transform:uppercase;letter-spacing:.4px">
      Service Class <span style="font-weight:400;text-transform:none">(optional)</span>
    </div>
    <div class="multi-check">
      ${serviceClassList.map(c => {
        const checked = (criteria.serviceClass || []).includes(c);
        return `<label class="${checked?'checked':''}">
          <input type="checkbox" ${checked?'checked':''} data-action="toggle-offer-array" data-idx="${esc(idx)}" data-field="serviceClass" data-val="${esc(c)}">
          ${esc(c)}
        </label>`;
      }).join('')}
    </div>

    <div style="padding:4px 14px 2px;font-size:10px;font-weight:800;color:#90a4ae;text-transform:uppercase;letter-spacing:.4px">
      Travel Class <span style="font-weight:400;text-transform:none">(optional)</span>
    </div>
    <div class="multi-check">
      ${travelClassList.map(c => {
        const checked = (criteria.travelClass || []).includes(c);
        return `<label class="${checked?'checked':''}">
          <input type="checkbox" ${checked?'checked':''} data-action="toggle-offer-array" data-idx="${esc(idx)}" data-field="travelClass" data-val="${esc(c)}">
          ${esc(c)}
        </label>`;
      }).join('')}
    </div>

    <div style="padding:4px 14px 2px;font-size:10px;font-weight:800;color:#90a4ae;text-transform:uppercase;letter-spacing:.4px">
      Flexibilities <span style="font-weight:400;text-transform:none">(optional) — accepted flexibility tiers</span>
    </div>
    <div class="multi-check" style="padding-bottom:12px">
      ${flexibilityList.map(f => {
        const checked = (criteria.flexibilities || []).includes(f);
        return `<label class="${checked?'checked':''}">
          <input type="checkbox" ${checked?'checked':''} data-action="toggle-offer-array" data-idx="${esc(idx)}" data-field="flexibilities" data-val="${esc(f)}">
          ${esc(lbl(f))}
        </label>`;
      }).join('')}
    </div>

    <div class="param-grid" style="padding:8px 14px 4px">
      <div class="param-field">
        <span class="param-label">Product Tags <span class="param-hint">(optional) — comma-separated tag list</span></span>
        <input class="param-input" type="text" value="${esc((criteria.productTags||[]).join(', '))}" placeholder="e.g. SEAT_ONLY, SLEEPER"
          data-action="set-offer-tags" data-idx="${esc(idx)}">
      </div>
      <div class="param-field">
        <span class="param-label">Inbound Date <span class="param-hint">(optional) — return trip date</span></span>
        <input class="param-input" type="datetime-local" value="${esc(criteria.inboundDate||'')}"
          data-action="set-offer-inbound" data-idx="${esc(idx)}">
      </div>
    </div>

    <div style="padding:4px 14px 2px;font-size:10px;font-weight:800;color:#90a4ae;text-transform:uppercase;letter-spacing:.4px">
      Product Selections <span style="font-weight:400;text-transform:none">(optional, advanced) — JSON array of product request selections</span>
    </div>
    <div style="padding:4px 14px 12px">
      <textarea class="param-input" rows="2" placeholder='[{"productId":"...","flexibilities":["NON_FLEXIBLE"]}]' style="font-family:monospace;font-size:11px;resize:vertical"
        data-action="set-offer-selections" data-idx="${esc(idx)}">${esc(criteria.productSelections ? JSON.stringify(criteria.productSelections) : '')}</textarea>
    </div>

    </div>
  </div>`;
}

// ── Fulfillment section ───────────────────────────────────────────────────────
function buildFulfillmentSection(idx, sc, fulfGroup) {
  const fIdx = (state.requestedFulfillmentOptionsList || []).findIndex(f => f.id === sc.requestedFulfillmentOptionsListId);
  const opts  = (fulfGroup.requestedFulfillmentOptions || [])[0] || {};
  const fwFul = ((wizData && wizData.framework) || {}).fulfillment || {};
  // Filter the OSDM-defined enums down to what the framework enables. If the
  // framework doesn't specify types/media, the full list is kept so the UI
  // stays usable on under-configured frameworks.
  const typeList   = fwFilter(ENUMS.fulfillmentType,  fwFul.types);
  const mediaList  = fwFilter(ENUMS.fulfillmentMedia, fwFul.media);

  return `
  <div class="param-section">
    <div class="param-section-head" data-action="toggle-param-section">🎫 Fulfillment Options (list #${sc.requestedFulfillmentOptionsListId})<span class="ps-arrow">▶</span></div>
    <div class="param-section-body">
      <div class="param-grid" style="padding:12px 14px">
        <div class="param-field">
          <span class="param-label">Fulfillment Type <span class="param-hint">Ticket delivery mechanism</span></span>
          <select class="param-input param-select"
            data-action="set-fulfill" data-fidx="${fIdx}" data-field="fulfillmentType">
            ${typeList.map(t =>
              `<option value="${t}" ${opts.fulfillmentType===t?'selected':''}>${esc(lbl(t))}</option>`
            ).join('')}
          </select>
        </div>
        <div class="param-field">
          <span class="param-label">Fulfillment Media <span class="param-hint">Output format</span></span>
          <select class="param-input param-select"
            data-action="set-fulfill" data-fidx="${fIdx}" data-field="fulfillmentMedia">
            ${mediaList.map(m =>
              `<option value="${m}" ${opts.fulfillmentMedia===m?'selected':''}>${esc(lbl(m))}</option>`
            ).join('')}
          </select>
        </div>
      </div>
    </div>
  </div>`;
}

// ── State mutation helpers ────────────────────────────────────────────────────

function setScenarioField(idx, field, value) {
  state.scenarios[idx][field] = value === '' ? null : value;
  markDirty();
}

function setTripField(tIdx, field, value) {
  if (tIdx < 0) return;
  state.tripRequirements[tIdx][field] = value;
  markDirty();
}

// Save time field: prepends %TRIP_DATE%T to the time-only value
function setTripTimeFieldByPath(tIdx, path, value) {
  const stored = value ? '%TRIP_DATE%T' + value.replace(/%TRIP_DATE%T/g, '') : '';
  setTripFieldByPath(tIdx, path, stored);
}

function setTripFieldByPath(tIdx, path, value) {
  if (tIdx < 0) return;
  const parts = path.split('.');
  let obj = state.tripRequirements[tIdx];
  for (let i = 0; i < parts.length - 1; i++) {
    const key = isNaN(parts[i]) ? parts[i] : parseInt(parts[i]);
    obj = obj[key];
  }
  const lastKey = isNaN(parts[parts.length-1]) ? parts[parts.length-1] : parseInt(parts[parts.length-1]);
  obj[lastKey] = value;
  markDirty();
}

function setPaxField(pIdx, paxIdx, field, value) {
  if (pIdx < 0) return;
  const paxList = state.passengersList[pIdx];
  if (!paxList || !paxList.passengers || !paxList.passengers[paxIdx]) return;
  // null (from e.g. gender 'None') → delete the property so the data file
  // JSON omits the field entirely rather than carrying an explicit `null`.
  // Matches library-bruno's `!= null` request-builder guards.
  if (value === null) {
    delete paxList.passengers[paxIdx][field];
  } else {
    paxList.passengers[paxIdx][field] = value;
  }
  markDirty();
  // Family sync: editing a family member's lastName propagates to siblings
  // in the same group. "Family" in this model is just a number stamped on
  // each passenger; members with equal familyGroup share one last name.
  if (field === 'lastName') {
    const src = paxList.passengers[paxIdx];
    if (Number.isInteger(src.familyGroup)) {
      paxList.passengers.forEach((sib, si) => {
        if (si === paxIdx || !sib) return;
        if (sib.familyGroup === src.familyGroup && sib.lastName !== value) {
          sib.lastName = value;
          // Live-update the sibling's visible display and any open edit panel input
          const disp = document.querySelector('[data-pax-display="' + pIdx + '-' + si + '"]');
          if (disp) disp.textContent = (sib.firstName || '') + ' ' + (sib.lastName || '');
          const lnInput = document.querySelector(
            'input[data-action="set-pax-text"][data-pidx="' + pIdx + '"][data-pi="' + si + '"][data-field="lastName"]'
          );
          if (lnInput) lnInput.value = value;
        }
      });
    }
  }
  // If any scenario's purchaser is linked to this passenger and the edited
  // field is one of the four mirrored ones, propagate immediately so the
  // stored purchaser never drifts out of sync with the source passenger.
  if (field === 'firstName' || field === 'lastName' || field === 'email' || field === 'phoneNumber') {
    syncPurchaserFromPassenger(paxList, paxList.passengers[paxIdx]);
  }
}

function setPurchaserField(prIdx, field, value) {
  if (prIdx < 0 || !state.purchaserList[prIdx]) return;
  if (!state.purchaserList[prIdx].purchaser) state.purchaserList[prIdx].purchaser = [{}];
  if (!state.purchaserList[prIdx].purchaser[0]) state.purchaserList[prIdx].purchaser[0] = {};
  state.purchaserList[prIdx].purchaser[0][field] = value;
  markDirty();
}

function setOfferField(scIdx, field, value) {
  if (scIdx < 0 || !state.scenarios[scIdx]) return;
  if (!state.scenarios[scIdx].offerSearchCriteria)
    state.scenarios[scIdx].offerSearchCriteria = {};
  // Store null instead of empty string — empty means "don't send this field"
  if (value === '' || value === undefined) {
    delete state.scenarios[scIdx].offerSearchCriteria[field];
  } else {
    state.scenarios[scIdx].offerSearchCriteria[field] = value;
  }
  markDirty();
}

function toggleOfferArray(scIdx, field, value, checked, labelEl) {
  if (scIdx < 0 || !state.scenarios[scIdx]) return;
  if (!state.scenarios[scIdx].offerSearchCriteria)
    state.scenarios[scIdx].offerSearchCriteria = {};
  const crit = state.scenarios[scIdx].offerSearchCriteria;
  if (!crit[field]) crit[field] = [];
  if (checked && !crit[field].includes(value)) crit[field].push(value);
  else if (!checked) crit[field] = crit[field].filter(v => v !== value);
  labelEl.parentElement.classList.toggle('checked', checked);
  markDirty();
}

function setFulfillField(fIdx, field, value) {
  if (fIdx < 0) return;
  if (!state.requestedFulfillmentOptionsList[fIdx].requestedFulfillmentOptions[0])
    state.requestedFulfillmentOptionsList[fIdx].requestedFulfillmentOptions[0] = {};
  state.requestedFulfillmentOptionsList[fIdx].requestedFulfillmentOptions[0][field] = value;
  markDirty();
}

// ── Messages ─────────────────────────────────────────────────────────────────
function showMsg(text, isOk) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (isOk ? 'msg-ok' : 'msg-err');
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ── Save & Apply ──────────────────────────────────────────────────────────────
function hidePanels() {
  document.getElementById('save-confirm').style.display = 'none';
  document.getElementById('save-error').style.display = 'none';
}

function showSaveError(detail) {
  hidePanels();
  document.getElementById('se-detail').textContent = detail;
  document.getElementById('save-error').style.display = 'block';
  document.getElementById('save-error').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showSaveConfirm(data) {
  hidePanels();
  document.getElementById('sc-torun-count').textContent = data.to_run_count;
  document.getElementById('sc-torun-list').innerHTML = (data.to_run || [])
    .map(code => `<li>${esc(code)}</li>`).join('');
  // v1.11.7 — parseServerTs (nav.js) normalises SQLite's TZ-less UTC strings.
  document.getElementById('sc-saved-at').textContent = parseServerTs(data.saved_at).toLocaleString();
  document.getElementById('sc-hash').textContent = (data.hash || '').slice(0, 16) + '…';
  document.getElementById('save-confirm').style.display = 'block';
  document.getElementById('save-confirm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveDatafile() {
  setSaveBtnState(true, '💾 Saving…');
  hidePanels();
  try {
    // Auto-increment version on shared scenarios when test_manager saves
    if (isTestManager && state && state.scenarios) {
      state.scenarios.forEach(sc => {
        if (sc.shared) {
          sc.version = incrementVersion(sc.version || '1.0');
        }
      });
    }

    // 1. Send the updated datafile to the server
    const res = await fetch('/v1/company/datafile/json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (res.status === 401) { logout(); return; }

    let data;
    try { data = await res.json(); } catch(_) { data = {}; }

    if (!res.ok) {
      showSaveError(`Server responded with ${res.status}: ${data.detail || data.title || 'Unknown error'}. Your changes were NOT saved.`);
      return;
    }

    // 2. Verify: re-read the file from the server to confirm it matches
    const verifyRes = await fetch('/v1/company/datafile', {});
    if (!verifyRes.ok) {
      showSaveError(`Save appeared to succeed but verification read failed (${verifyRes.status}). Please reload the page to check.`);
      return;
    }
    const verified = await verifyRes.json();

    // Check scenariosToRun matches what we sent
    // Explicit string compare silences Sonar S2871 (missing compare fn);
    // semantically identical to the default sort for this string-array equality check.
    const byCode = (a, b) => String(a).localeCompare(String(b));
    const sentCodes     = JSON.stringify([...(state.scenariosToRun || [])].sort(byCode));
    const receivedCodes = JSON.stringify([...(verified.scenariosToRun || [])].sort(byCode));
    if (sentCodes !== receivedCodes) {
      showSaveError(
        `Mismatch after save! Sent ${state.scenariosToRun.length} scenario(s) to run, ` +
        `but server has ${verified.scenariosToRun.length}. ` +
        `Please reload and try again.`
      );
      return;
    }

    // 3. All good — update in-memory state from server response and show confirmation
    state = verified;
    dirty = false;
    setSaveBtnState(true, '💾 Save & Apply');

    showSaveConfirm(data);

    // Refresh sections to reflect saved state
    await refreshAllSections();

  } catch(e) {
    showSaveError(`Network error: ${e.message}. Check that the OSCAR server is running.`);
  } finally {
    // Re-enable both save buttons; dirty-flag-derived text is set separately
    // by setSaveBtnState(true, '💾 Save & Apply') in the success path, or
    // left as '💾 Save & Apply *' on error (dirty still true).
    setSaveBtnState(!dirty, dirty ? '💾 Save & Apply *' : '💾 Save & Apply');
  }
}

// ── Download JSON ─────────────────────────────────────────────────────────────
function downloadJson() {
  if (!state) return;
  const blob = new Blob([JSON.stringify(state, null, 4)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'datafile.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Warn on unsaved changes ───────────────────────────────────────────────────
window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Scenario Creation Wizard ──────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

let wizStep = 1;

/**
 * @type {{ framework: object|null, resources: object[] }} wizData
 * Aggregated data loaded at wizard start (step 1).
 *   framework – the company's test-framework configuration row (null if unset).
 *   resources – array of test-resource rows (vendor tags, connection params, …).
 * Populated by loadWizardData() and treated as read-only during subsequent steps.
 */
let wizData = { framework: null, resources: [] };
let wizOrigin = 'nofile'; // 'nofile' | 'mainContent'

/**
 * @type {{ slug: string, company_name: string, email: string, [key: string]: any }} wizProfile
 * Company profile fetched from GET /v1/company at wizard start.
 * Used to pre-fill scenario defaults and validate vendor/project tags.
 */
let wizProfile = {};

/**
 * @type {object} wizScenario
 * Mutable working copy of the scenario being assembled in wizard step 3.
 * Mirrors the Scenario shape in the datafile schema. Fields are populated
 * incrementally as the user completes each wizard sub-step. Committed to
 * state.scenarios[] when the user confirms in the final step.
 */
let wizScenario = {};

const WIZ_IROPS_MANDATORY = [
  'CONNECTION_BROKEN','SALES_STAFF_ERROR','STRIKE','TECHNICAL_FAILURE'
];
const WIZ_IROPS_OPTIONAL = [
  'DISRUPTION','PAYMENT_FAILURE','DELAY_COMPENSATION','DEATH',
  'INABILITY_TO_TRAVEL','JOURNEY_OBSOLETE','CERTIFIED_MEDICAL_CONDITION',
  'EQUIPMENT_FAILURE','PRM_SUPPORT_UNAVAILABLE','STOP_NOT_SERVED',
  'TICKET_NOT_USED','EXTERNAL_COMPENSATION'
];
const WIZ_RAIL_SUBMODES   = ['HIGH_SPEED_TRAIN','INTERCITY','REGIONAL','INTERREGIONAL','NIGHT_TRAIN','URBAN','MOTOR_RAIL'];
const WIZ_PT_SUBMODES     = ['TRAM','UNDERGROUND','BUS'];
const WIZ_SHARED_SUBMODES = ['SHARED_TAXI','TAXI','ON_DEMAND_SERVICE'];
const WIZ_TICKET_TYPES    = [
  {value:'IRT',                      label:'IRT (Integrated Reservation)'},
  {value:'NRT_NO_RESERVATION',       label:'NRT (No Reservation)'},
  {value:'NRT_OPTIONAL_RESERVATION', label:'NRT (Optional Reservation)'},
  {value:'NIGHT_TRAIN',              label:'Night Train'},
  {value:'TOURISTIC',                label:'Touristic Train'}
];
const WIZ_SERVICE_CLASSES = ['BEST','HIGH','STANDARD','BASIC','ANY_CLASS'];
const WIZ_ACCOMMODATIONS  = ['SEAT','COUCHETTE','BERTH','VEHICLE'];
// OSDM AncillaryType example values. AncillaryType is an x-extensible-enum —
// the spec states the listed values are examples, so custom values (e.g. BIKE)
// are valid. These seed the editable ancillary catalog at the Test Framework
// level (issue #130); train resources then pick from framework.ancillaries
// (standard + custom), not from a fixed constant.
const OSDM_ANCILLARY_TYPES = ['PAYMENT_VOUCHER','PRODUCT_ACCESS','MERCHANDISE_PRODUCT','LUGGAGE','LUGGAGE_TRANSFER','ON_BOARD_SERVICE','STATION_SERVICE','FOOD_ON_BOARD','DRINKS_ON_BOARD','WIFI','PARKING'];
const WIZ_PAX_TYPES       = [
  'ADULT','CHILD','YOUTH','SENIOR','YOUNG_CHILD','FAMILY_CHILD',
  'PRM','ACCOMP_PRM','WHEELCHAIR','DOG','PET','BICYCLE',
  'LUGGAGE','PRAM','CAR','MOTORCYCLE','TRAILER'
];
// Human PAX types — the ones that need an age range for dynamic birth-date generation
const WIZ_HUMAN_PAX_TYPES = ['ADULT','CHILD','YOUTH','SENIOR','YOUNG_CHILD','FAMILY_CHILD','PRM','ACCOMP_PRM'];
const WIZ_PAX_DEFAULT_AGES = {
  ADULT:        { min: 26, max: 99 },
  CHILD:        { min: 4,  max: 15 },
  YOUTH:        { min: 12, max: 25 },
  SENIOR:       { min: 60, max: 99 },
  YOUNG_CHILD:  { min: 0,  max: 3  },
  FAMILY_CHILD: { min: 4,  max: 15 },
  PRM:          { min: 18, max: 99 },
  ACCOMP_PRM:   { min: 18, max: 99 }
};
// Offer search criteria
const WIZ_OFFER_PARTS    = ['RESERVATION','ADMISSION','ANCILLARY'];
const WIZ_TRAVEL_CLASSES = ['FIRST','SECOND','THIRD','BUSINESS'];
const WIZ_FLEXIBILITIES  = ['FULL_FLEXIBLE','SEMI_FLEXIBLE','NON_FLEXIBLE'];
const WIZ_OFFER_MODES    = ['INDIVIDUAL','COMBINATION'];
// Fulfillment
const WIZ_FULFIL_MEDIA   = ['PDF_A4','PKPASS','AZTEC_CODE','QR_CODE','NFC'];
const WIZ_FULFIL_TYPES   = ['ETICKET','PAPER_TICKET'];
// Days of week for a train set's timetable services (#136). Stored per service;
// empty = runs every day. Informational today (the offer request still targets a
// specific %TRIP_DATE%), but documents the route's weekly pattern.
const WIZ_DAYS = [
  { value: 'MON', label: 'Mon' }, { value: 'TUE', label: 'Tue' }, { value: 'WED', label: 'Wed' },
  { value: 'THU', label: 'Thu' }, { value: 'FRI', label: 'Fri' }, { value: 'SAT', label: 'Sat' },
  { value: 'SUN', label: 'Sun' }
];
const WIZ_PAX_ABBREV = {
  ADULT:'ADT', CHILD:'CHD', YOUTH:'YTH', SENIOR:'SEN',
  YOUNG_CHILD:'YCH', FAMILY_CHILD:'FCH', PRM:'PRM',
  ACCOMP_PRM:'APR', WHEELCHAIR:'WCH', DOG:'DOG',
  PET:'PET', BICYCLE:'BIC', LUGGAGE:'LUG', PRAM:'PRD',
  CAR:'CAR', MOTORCYCLE:'MOT', TRAILER:'TRL'
};
// Gendered first-name pools. Used (a) to auto-rename when the user flips a
// passenger's gender, (b) to generate sensible names during scenario creation.
// Neutral pool covers OTHER / UNSPECIFIED / X.
const WIZ_FIRST_NAMES_MALE = [
  'Jean','Thomas','Nicolas','Pierre','Paul','Marc','Robert','Hans','Carlos',
  'Luca','Diego','Felix','Liam','Noah','Max','Oliver','Marco','Peter','Stefan','Jan'
];
const WIZ_FIRST_NAMES_FEMALE = [
  'Marie','Sophie','Emma','Laura','Anna','Clara','Julie','Alice','Ingrid',
  'Maria','Lucia','Nora','Ines','Lara','Eva','Chloe','Greta','Elena','Sara','Petra'
];
const WIZ_FIRST_NAMES_ANY = [
  'Alex','Sam','Jordan','Morgan','Noa','Robin','Casey','Taylor','Charlie',
  'Sacha','Dana','Eli','Jamie','Kim','Kai','River','Sidney','Quinn','Reese','Rowan'
];
// Union kept for backward compatibility AND for detecting auto-generated names
// in the rename-on-gender-change hook. If the current firstName is in this
// union we treat it as auto-generated and may replace it; otherwise we assume
// the user typed something intentional and leave it alone.
const WIZ_RANDOM_FIRST_NAMES = [
  ...WIZ_FIRST_NAMES_MALE, ...WIZ_FIRST_NAMES_FEMALE, ...WIZ_FIRST_NAMES_ANY
];
const WIZ_RANDOM_LAST_NAMES = ['Dupont','Martin','Bernard','Dubois','Moreau','Laurent','Simon','Michel',
  'Garcia','Muller','Schmidt','Fischer','Wagner','Klein','Rossi','Bianchi','Novak','Szabo','Jensen','Lund'];
const WIZ_RANDOM_NAMES = WIZ_RANDOM_FIRST_NAMES; // backward compat

function pickFirstNameForGender(gender) {
  if (gender === 'MALE')   return randomPick(WIZ_FIRST_NAMES_MALE);
  if (gender === 'FEMALE') return randomPick(WIZ_FIRST_NAMES_FEMALE);
  // OTHER / UNSPECIFIED / X / anything else → neutral pool
  return randomPick(WIZ_FIRST_NAMES_ANY);
}
function isAutoGeneratedFirstName(name) {
  return !!name && WIZ_RANDOM_FIRST_NAMES.indexOf(name) !== -1;
}
// Map framework pax category → OSDM API passenger type
// Human categories all map to PERSON; age is inferred from dateOfBirth by the API
const WIZ_PAX_TO_OSDM_TYPE = {
  ADULT:'PERSON', CHILD:'PERSON', YOUTH:'PERSON', SENIOR:'PERSON',
  YOUNG_CHILD:'PERSON', FAMILY_CHILD:'FAMILY_CHILD', PRM:'PRM',
  ACCOMP_PRM:'PERSON', WHEELCHAIR:'WHEELCHAIR',
  DOG:'DOG', PET:'PET', BICYCLE:'BICYCLE', LUGGAGE:'LUGGAGE',
  PRAM:'PRAM', CAR:'CAR', MOTORCYCLE:'MOTORCYCLE', TRAILER:'TRAILER'
};

function emptyFramework() {
  return {
    osdmVersion:   '3.4',
    concurrentSessionLimit: 1,
    salesFlows:    ['SALE'],
    iropsCodes:    { refund: [...WIZ_IROPS_MANDATORY], exchange: [...WIZ_IROPS_MANDATORY] },
    rail:          { enabled: true,  subModes: ['HIGH_SPEED_TRAIN','INTERCITY'], ticketTypes: ['IRT','NRT_NO_RESERVATION'] },
    pt:            { enabled: false, subModes: [] },
    shared:        { enabled: false, subModes: [] },
    offerCriteria: {
      serviceClasses:      ['STANDARD'],
      requestedOfferParts: ['RESERVATION','ADMISSION'],
      travelClasses:       ['SECOND'],
      flexibilities:       ['FULL_FLEXIBLE','SEMI_FLEXIBLE','NON_FLEXIBLE'],
      offerMode:           'INDIVIDUAL',
      currency:            'EUR',
      requiresPlaceSelection: false
    },
    // Optional-feature capability (issue #107): does the system offer a graphical
    // seat map, and via which mode(s)? seatMap=false / supportedModes=[] means
    // place selection is not exercised. Authorises the per-scenario opt-in.
    placeSelection: { seatMap: false, supportedModes: [] },
    fulfillment:    { media: ['PDF_A4'], types: ['ETICKET'] },
    serviceClasses:['STANDARD','HIGH'],
    accommodations:['SEAT'],
    ancillaries:   [...OSDM_ANCILLARY_TYPES],
    passengerTypes:['ADULT','CHILD'],
    passengerAgeRanges: {
      ADULT: { min: 26, max: 99 },
      CHILD: { min: 4,  max: 15 }
    }
  };
}

// launchWizard is no longer used — replaced by section-based navigation
// Kept as stub for any residual references
async function launchWizard(startStep) {
  if (startStep === 1) { renderWizardStep1InSection(); toggleSection('framework'); }
  else if (startStep === 2) { renderWizardStep2InSection(); toggleSection('data'); }
  else if (startStep === 3) { openScenarioCreator(); }
}

// renderWizardStep is no longer used — each section renders independently
function renderWizardStep() {
  if (wizStep === 1)      renderWizardStep1();
  else if (wizStep === 2) renderWizardStep2();
  else                    renderWizardStep3();
}

// ── Step 1: Test Framework ────────────────────────────────────────────────────
function renderWizardStep1() {
  // Ensure every expected property exists — guards against partially-saved or
  // legacy double-nested framework objects that survived with missing keys.
  const def = emptyFramework();
  const fw  = wizData.framework || def;
  if (!fw.osdmVersion) fw.osdmVersion = def.osdmVersion;
  if (typeof fw.concurrentSessionLimit !== 'number') fw.concurrentSessionLimit = 1;
  if (!Array.isArray(fw.salesFlows))    fw.salesFlows    = def.salesFlows;
  if (!fw.iropsCodes)                   fw.iropsCodes    = def.iropsCodes;
  if (!fw.iropsCodes.refund)            fw.iropsCodes.refund   = [...WIZ_IROPS_MANDATORY];
  if (!fw.iropsCodes.exchange)          fw.iropsCodes.exchange = [...WIZ_IROPS_MANDATORY];
  if (!fw.rail   || typeof fw.rail   !== 'object') fw.rail   = def.rail;
  if (!fw.pt     || typeof fw.pt     !== 'object') fw.pt     = def.pt;
  if (!fw.shared || typeof fw.shared !== 'object') fw.shared = def.shared;
  if (!Array.isArray(fw.rail.subModes))    fw.rail.subModes    = def.rail.subModes;
  if (!Array.isArray(fw.rail.ticketTypes)) fw.rail.ticketTypes = def.rail.ticketTypes;
  if (!Array.isArray(fw.pt.subModes))      fw.pt.subModes      = [];
  if (!Array.isArray(fw.shared.subModes))  fw.shared.subModes  = [];
  if (!Array.isArray(fw.serviceClasses))  fw.serviceClasses  = def.serviceClasses;
  if (!Array.isArray(fw.accommodations))  fw.accommodations  = def.accommodations;
  if (!Array.isArray(fw.ancillaries))     fw.ancillaries     = def.ancillaries;
  if (!Array.isArray(fw.passengerTypes))  fw.passengerTypes  = def.passengerTypes;
  if (!fw.passengerAgeRanges || typeof fw.passengerAgeRanges !== 'object') fw.passengerAgeRanges = {};
  // Offer criteria
  if (!fw.offerCriteria || typeof fw.offerCriteria !== 'object') fw.offerCriteria = def.offerCriteria;
  if (!Array.isArray(fw.offerCriteria.serviceClasses))      fw.offerCriteria.serviceClasses      = def.offerCriteria.serviceClasses;
  if (!Array.isArray(fw.offerCriteria.requestedOfferParts)) fw.offerCriteria.requestedOfferParts = def.offerCriteria.requestedOfferParts;
  if (!Array.isArray(fw.offerCriteria.travelClasses))       fw.offerCriteria.travelClasses       = def.offerCriteria.travelClasses;
  if (!Array.isArray(fw.offerCriteria.flexibilities))       fw.offerCriteria.flexibilities       = def.offerCriteria.flexibilities;
  if (!fw.offerCriteria.offerMode)   fw.offerCriteria.offerMode  = def.offerCriteria.offerMode;
  if (!fw.offerCriteria.currency)    fw.offerCriteria.currency   = def.offerCriteria.currency;
  if (fw.offerCriteria.requiresPlaceSelection == null) fw.offerCriteria.requiresPlaceSelection = false;
  // Place-selection capability (issue #107)
  if (!fw.placeSelection || typeof fw.placeSelection !== 'object') fw.placeSelection = { seatMap: false, supportedModes: [] };
  if (typeof fw.placeSelection.seatMap !== 'boolean') fw.placeSelection.seatMap = false;
  if (!Array.isArray(fw.placeSelection.supportedModes)) fw.placeSelection.supportedModes = [];
  // Fulfillment
  if (!fw.fulfillment || typeof fw.fulfillment !== 'object') fw.fulfillment = def.fulfillment;
  if (!Array.isArray(fw.fulfillment.media)) fw.fulfillment.media = def.fulfillment.media;
  if (!Array.isArray(fw.fulfillment.types)) fw.fulfillment.types = def.fulfillment.types;
  wizData.framework = fw; // write back the normalised object

  try {

  // Build IROPS panel HTML for one flow type
  function iropsPanelHtml(type) {
    const key   = type.toLowerCase(); // 'refund' | 'exchange'
    const codes = (fw.iropsCodes && fw.iropsCodes[key]) ? fw.iropsCodes[key] : [...WIZ_IROPS_MANDATORY];
    return `
    <div class="irops-panel${fw.salesFlows.includes(type+'_IROPS')?' open':''}" id="irops-${type}">
      <div class="irops-panel-title">⚡ IROPS Reason Codes — ${type[0]+type.slice(1).toLowerCase()}</div>
      <div style="margin-bottom:6px;font-size:11px;color:#f57f17">Mandatory (always included):</div>
      <div class="pill-group">
        ${WIZ_IROPS_MANDATORY.map(c=>`<div class="pill mandatory">✓ ${c.replace(/_/g,' ')}</div>`).join('')}
      </div>
      <div style="margin:10px 0 6px;font-size:11px;color:#78909c">Optional (tick if your system supports it):</div>
      <div class="pill-group">
        ${WIZ_IROPS_OPTIONAL.map(c=>`
          <div class="pill${codes.includes(c)?' selected':''}" data-action="fw-toggle-irops" data-type="${key}" data-code="${esc(c)}">
            ${c.replace(/_/g,' ')}
          </div>`).join('')}
      </div>
    </div>`;
  }

  // Build after-sales options row (Full / Partial / IROPS)
  function afterSalesRow(prefix, emoji, label) {
    const opts = [
      {v:`${prefix}_FULL`,    icon:'💯', lbl:'Full',    desc: prefix==='REFUND'?'100% reimbursement':'Full rebooking'},
      {v:`${prefix}_PARTIAL`, icon:'✂️', lbl:'Partial', desc: prefix==='REFUND'?'Partial amount':'Partial change'},
      {v:`${prefix}_IROPS`,   icon:'⚡', lbl:'IROPS',   desc:'Irregular operations'}
    ];
    return `
    <div class="aftersales-row">
      <div class="aftersales-row-title">${emoji} ${label}</div>
      <div class="aftersales-options">
        ${opts.map(o=>`
        <div class="aftersales-opt${fw.salesFlows.includes(o.v)?' selected':''}" id="aopt-${o.v}" data-action="fw-toggle-aftersales" data-val="${o.v}">
          <div class="aftersales-opt-icon">${o.icon}</div>
          <div class="aftersales-opt-label">${o.lbl}</div>
          <div class="aftersales-opt-desc">${o.desc}</div>
        </div>`).join('')}
      </div>
      ${iropsPanelHtml(prefix)}
    </div>`;
  }

  document.getElementById('wizard-body').innerHTML = `
  <p style="color:#546e7a;font-size:13px;line-height:1.6;margin-bottom:4px">
    Define the functional scope of your OSDM certification. These settings describe what
    your system under test supports and will be used to generate relevant test scenarios.
  </p>

  <!-- ⓪ OSDM Version -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">📌 OSDM Version<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      <div class="param-field" style="max-width:220px">
        <label class="param-label">OSDM Specification version <span class="param-hint">e.g. 3.4</span></label>
        <input class="param-input" value="${fw.osdmVersion||'3.4'}" placeholder="3.4"
          data-action="wiz-osdm-version" style="max-width:120px">
      </div>
    </div>
  </div>

  <!-- Concurrent Session Limit -->
  <div class="fw-section">
    <div class="fw-section-head" data-action="fw-toggle">⚡ Concurrent Session Limit<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body">
      <div style="padding:12px 14px">
        <div class="param-field" style="max-width:280px">
          <label class="param-label">Max concurrent scenarios per company <span class="param-hint">(optional) — applies across all users</span></label>
          <input class="param-input" type="number" min="1" max="10" value="${fw.concurrentSessionLimit || 1}"
            data-action="fw-concurrent-limit" style="width:80px">
          <div style="font-size:11px;color:#90a4ae;margin-top:4px">How many scenarios run simultaneously. Default: 1. Set higher to run multiple scenarios in parallel.</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ① Sales Flows -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">🛒 Sales Flows &amp; After-Sales Operations<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      <div style="margin-bottom:16px">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;cursor:pointer">
          <input type="checkbox" ${fw.salesFlows.includes('SALE')?'checked':''} data-action="fw-toggle-flow" data-key="SALE" style="accent-color:#0090D4;width:16px;height:16px">
          🎫 Sale — search offer, book, fulfil
        </label>
      </div>
      ${afterSalesRow('REFUND',   '↩️', 'Refund — After-sales')}
      ${afterSalesRow('EXCHANGE', '🔄', 'Exchange — After-sales')}
    </div>
  </div>

  <!-- ② Transport Modes -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">🚆 Transport Modes &amp; Train Types<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      <!-- Rail -->
      <div style="margin-bottom:16px">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;cursor:pointer;margin-bottom:8px">
          <input type="checkbox" id="mode-rail" ${fw.rail.enabled?'checked':''} data-action="fw-toggle-mode" data-mode="rail" style="accent-color:#0090D4;width:16px;height:16px">
          🚆 Rail
        </label>
        <div id="rail-detail" style="${fw.rail.enabled?'':'display:none'}">
          <div class="fw-subsection">
            <div class="fw-subsection-label">Sub-modes</div>
            <div class="pill-group">
              ${WIZ_RAIL_SUBMODES.map(m=>`<div class="pill${(fw.rail.subModes||[]).includes(m)?' selected':''}" data-action="fw-pill" data-mode="rail" data-group="subModes" data-val="${m}">${m.replace(/_/g,' ')}</div>`).join('')}
            </div>
          </div>
          <div class="fw-subsection">
            <div class="fw-subsection-label">Ticket types</div>
            <div class="pill-group">
              ${WIZ_TICKET_TYPES.map(t=>`<div class="pill${(fw.rail.ticketTypes||[]).includes(t.value)?' selected':''}" data-action="fw-pill" data-mode="rail" data-group="ticketTypes" data-val="${t.value}" title="${t.label}">${t.label.split('—')[0].trim()}</div>`).join('')}
            </div>
          </div>
        </div>
      </div>
      <!-- Urban Transport -->
      <div style="margin-bottom:16px">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;cursor:pointer;margin-bottom:8px">
          <input type="checkbox" id="mode-pt" ${fw.pt.enabled?'checked':''} data-action="fw-toggle-mode" data-mode="pt" style="accent-color:#0090D4;width:16px;height:16px">
          🚌 Urban Transport (Bus, Tram, Metro)
        </label>
        <div id="pt-detail" style="${fw.pt.enabled?'':'display:none'}">
          <div class="fw-subsection">
            <div class="fw-subsection-label">Sub-modes</div>
            <div class="pill-group">
              ${WIZ_PT_SUBMODES.map(m=>`<div class="pill${(fw.pt.subModes||[]).includes(m)?' selected':''}" data-action="fw-pill" data-mode="pt" data-group="subModes" data-val="${m}">${m.replace(/_/g,' ')}</div>`).join('')}
            </div>
          </div>
        </div>
      </div>
      <!-- Shared Mobility -->
      <div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;cursor:pointer;margin-bottom:8px">
          <input type="checkbox" id="mode-shared" ${fw.shared.enabled?'checked':''} data-action="fw-toggle-mode" data-mode="shared" style="accent-color:#0090D4;width:16px;height:16px">
          🚖 Shared Mobility (Taxi, On-demand)
        </label>
        <div id="shared-detail" style="${fw.shared.enabled?'':'display:none'}">
          <div class="fw-subsection">
            <div class="fw-subsection-label">Sub-modes</div>
            <div class="pill-group">
              ${WIZ_SHARED_SUBMODES.map(m=>`<div class="pill${(fw.shared.subModes||[]).includes(m)?' selected':''}" data-action="fw-pill" data-mode="shared" data-group="subModes" data-val="${m}">${m.replace(/_/g,' ')}</div>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ②-bis Seat selection capability (issue #107) -->
  <div class="fw-section">
    <div class="fw-section-head" data-action="fw-toggle">🪑 Seat Selection<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body">
      <div style="padding:12px 14px">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;cursor:pointer;margin-bottom:6px">
          <input type="checkbox" id="ps-seatmap" ${fw.placeSelection.seatMap?'checked':''} data-action="fw-toggle-seatmap" style="accent-color:#0090D4;width:16px;height:16px">
          Does the system offer a graphical seat map?
        </label>
        <div style="font-size:11px;color:#90a4ae;margin-bottom:10px;line-height:1.5">
          Tick this if travellers can pick a specific seat. Then choose <strong>when</strong> it happens — a scenario can only use a mode you enable here.
        </div>
        <div id="place-selection-detail" style="${fw.placeSelection.seatMap?'':'display:none'}">
          <div class="fw-subsection">
            <div class="fw-subsection-label">Supported seat-selection modes</div>
            <div class="pill-group">
              ${PLACE_SELECTION_MODES.map(m=>`<div class="pill${(fw.placeSelection.supportedModes||[]).includes(m.key)?' selected':''}" data-action="fw-pill" data-mode="placeSelection" data-group="supportedModes" data-val="${esc(m.key)}" title="${esc(m.description)}">${m.icon} ${esc(m.label)}</div>`).join('')}
            </div>
            <div style="font-size:11px;color:#90a4ae;margin-top:8px;line-height:1.5">
              🪑 <strong>Seat map at offer</strong> — traveller picks a seat before booking (e.g. a seat that affects the price).<br>
              ➕ <strong>Add reservation to a booking</strong> — seat reservation added after the booking exists (e.g. SNCF first-class TGV).
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ③ Passenger Types + age limits -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">👥 Passenger Types<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      <div class="fw-subsection-label" style="margin-bottom:8px">Select supported passenger types</div>
      <div class="pill-group" style="margin-bottom:16px">
        ${WIZ_PAX_TYPES.map(p=>`<div class="pill${(fw.passengerTypes||[]).includes(p)?' selected':''}" data-action="fw-pax-type" data-val="${esc(p)}">${p.replace(/_/g,' ')}</div>`).join('')}
      </div>
      <div class="fw-subsection">
        <div class="fw-subsection-label" style="margin-bottom:8px">
          Age limits per passenger type
          <span style="font-weight:400;color:#b0bec5;text-transform:none;letter-spacing:0"> — used to generate valid birth dates in test data; first name prefixed with type (e.g. ADULT_Marie)</span>
        </div>
        <div class="pax-age-table">
          ${WIZ_HUMAN_PAX_TYPES.map(p => {
            const sel   = (fw.passengerTypes||[]).includes(p);
            const dflt  = WIZ_PAX_DEFAULT_AGES[p] || { min: 0, max: 99 };
            const range = (fw.passengerAgeRanges && fw.passengerAgeRanges[p]) ? fw.passengerAgeRanges[p] : dflt;
            return `<div class="pax-age-row" id="pax-age-${esc(p)}" style="${sel?'':'display:none'}">
              <span class="pax-age-label">${p.replace(/_/g,' ')}</span>
              <label class="pax-age-pair">Min age
                <input type="number" min="0" max="120" value="${range.min}" data-action="fw-pax-age" data-paxtype="${esc(p)}" data-bound="min">
              </label>
              <label class="pax-age-pair">Max age
                <input type="number" min="0" max="120" value="${range.max}" data-action="fw-pax-age" data-paxtype="${esc(p)}" data-bound="max">
              </label>
            </div>`;
          }).join('')}
        </div>
        ${WIZ_HUMAN_PAX_TYPES.every(p=>!(fw.passengerTypes||[]).includes(p))
          ? '<div style="color:#90a4ae;font-size:12px;padding:6px 0">Select a human passenger type above to configure its age range.</div>'
          : ''}
      </div>
    </div>
  </div>

  <!-- ④ Ancillaries catalog (issue #130) -->
  <div class="fw-section">
    <div class="fw-section-head" data-action="fw-toggle">🧳 Ancillaries<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body">
      <div style="padding:12px 14px">
        <div class="fw-subsection-label" style="margin-bottom:8px">Ancillaries the platform supports — standard (OSDM) plus any custom ones. Train resources pick from this catalog.</div>
        <div class="pill-group">
          ${OSDM_ANCILLARY_TYPES.map(a=>`<div class="pill${(fw.ancillaries||[]).includes(a)?' selected':''}" data-action="fw-ancillary" data-val="${esc(a)}">${esc(a.replace(/_/g,' '))}</div>`).join('')}
        </div>
        ${(fw.ancillaries||[]).filter(a => !OSDM_ANCILLARY_TYPES.includes(a)).length
          ? `<div class="fw-subsection" style="margin-top:10px"><div class="fw-subsection-label">Custom</div><div class="pill-group">${(fw.ancillaries||[]).filter(a => !OSDM_ANCILLARY_TYPES.includes(a)).map(a=>`<div class="pill selected" data-action="fw-remove-ancillary" data-val="${esc(a)}" title="Click to remove">${esc(a)} ✕</div>`).join('')}</div></div>`
          : ''}
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
          <input class="param-input" id="fw-custom-ancillary" placeholder="Add custom — e.g. BIKE" style="max-width:240px" maxlength="40">
          <button class="btn btn-small btn-secondary" data-action="fw-add-ancillary">+ Add</button>
        </div>
        <div style="font-size:11px;color:#90a4ae;margin-top:6px;line-height:1.5">OSDM <code>AncillaryType</code> is an extensible code list — custom values are spec-valid.</div>
      </div>
    </div>
  </div>
  `;

  } catch(e) {
    document.getElementById('wizard-body').innerHTML = `
      <div class="msg msg-err" style="display:block;margin:0">
        ⚠️ Error rendering Test Framework form: <code>${e.message}</code><br>
        <small>Please reload the page (Ctrl+Shift+R) and try again.</small>
      </div>`;
    console.error('[wizard] renderWizardStep1 error:', e);
  }
}

// ── Step 1 helpers ────────────────────────────────────────────────────────────
function fwToggle(headEl) {
  headEl.classList.toggle('open');
  headEl.nextElementSibling.classList.toggle('open');
}

function fwToggleFlow(key, checked) {
  const fw = wizData.framework;
  if (checked && !fw.salesFlows.includes(key)) fw.salesFlows.push(key);
  else if (!checked) fw.salesFlows = fw.salesFlows.filter(f => f !== key);
}

function fwToggleAfterSales(key) {
  const fw  = wizData.framework;
  const el  = document.getElementById(`aopt-${key}`);
  const was = el.classList.contains('selected');
  el.classList.toggle('selected', !was);
  if (!was) { if (!fw.salesFlows.includes(key)) fw.salesFlows.push(key); }
  else      { fw.salesFlows = fw.salesFlows.filter(f => f !== key); }
  if (key.endsWith('_IROPS')) {
    const prefix = key.split('_')[0];
    const panel  = document.getElementById(`irops-${prefix}`);
    if (panel) panel.classList.toggle('open', !was);
  }
}

function fwToggleIrops(type, code, el) {
  const fw = wizData.framework;
  if (!fw.iropsCodes) fw.iropsCodes = { refund: [...WIZ_IROPS_MANDATORY], exchange: [...WIZ_IROPS_MANDATORY] };
  if (!fw.iropsCodes[type]) fw.iropsCodes[type] = [...WIZ_IROPS_MANDATORY];
  const was = el.classList.contains('selected');
  el.classList.toggle('selected', !was);
  if (!was) { if (!fw.iropsCodes[type].includes(code)) fw.iropsCodes[type].push(code); }
  else      { fw.iropsCodes[type] = fw.iropsCodes[type].filter(c => c !== code); }
}

function fwToggleMode(mode, enabled) {
  wizData.framework[mode].enabled = enabled;
  const d = document.getElementById(`${mode}-detail`);
  if (d) d.style.display = enabled ? '' : 'none';
}

// Seat-selection capability toggle (issue #107). seatMap=true reveals the
// supported-modes picker; the modes themselves use the generic fw-pill handler
// (placeSelection.supportedModes). When off, the modes are kept but hidden —
// consumers always check seatMap first.
function fwToggleSeatMap(enabled) {
  const fw = wizData.framework;
  if (!fw.placeSelection || typeof fw.placeSelection !== 'object') fw.placeSelection = { seatMap: false, supportedModes: [] };
  fw.placeSelection.seatMap = enabled;
  const d = document.getElementById('place-selection-detail');
  if (d) d.style.display = enabled ? '' : 'none';
}

function fwTogglePill(el, modeKey, subKey, value) {
  const arr = wizData.framework[modeKey][subKey] || [];
  const idx = arr.indexOf(value);
  if (idx === -1) { arr.push(value); el.classList.add('selected'); }
  else            { arr.splice(idx,1); el.classList.remove('selected'); }
  wizData.framework[modeKey][subKey] = arr;
}

function fwToggleSimplePill(el, key, value) {
  const arr = wizData.framework[key] || [];
  const idx = arr.indexOf(value);
  if (idx === -1) { arr.push(value); el.classList.add('selected'); }
  else            { arr.splice(idx,1); el.classList.remove('selected'); }
  wizData.framework[key] = arr;
}

// ── Offer criteria helpers ────────────────────────────────────────────────────
function fwToggleOfferPill(el, subKey, value) {
  const oc  = wizData.framework.offerCriteria;
  if (!oc[subKey]) oc[subKey] = [];
  const arr = oc[subKey];
  const idx = arr.indexOf(value);
  if (idx === -1) { arr.push(value); el.classList.add('selected'); }
  else            { arr.splice(idx,1); el.classList.remove('selected'); }
}

function fwSetOfferMode(value) {
  wizData.framework.offerCriteria.offerMode = value;
  document.querySelectorAll('.offer-mode-pill').forEach(p =>
    p.classList.toggle('selected', p.dataset.val === value));
}

function fwToggleFulfilPill(el, subKey, value) {
  const f   = wizData.framework.fulfillment;
  if (!f[subKey]) f[subKey] = [];
  const arr = f[subKey];
  const idx = arr.indexOf(value);
  if (idx === -1) { arr.push(value); el.classList.add('selected'); }
  else            { arr.splice(idx,1); el.classList.remove('selected'); }
}

// ── Ancillary catalog helpers (issue #130) ───────────────────────────────────
// framework.ancillaries is the editable catalog the platform supports (OSDM
// standard + custom). Train resources pick from it. Custom add/remove re-render
// the framework section so the new/removed pill shows immediately.
function fwAddCustomAncillary() {
  const input = document.getElementById('fw-custom-ancillary');
  if (!input) return;
  // Normalise to an UPPER_SNAKE code (OSDM AncillaryType is a string code list).
  const code = (input.value || '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!code) return;
  const fw = wizData.framework;
  if (!Array.isArray(fw.ancillaries)) fw.ancillaries = [];
  if (!fw.ancillaries.includes(code)) fw.ancillaries.push(code);
  input.value = '';
  saveFrameworkDebounced();
  renderWizardStep1InSection();
}
function fwRemoveAncillary(value) {
  const fw = wizData.framework;
  if (!Array.isArray(fw.ancillaries)) return;
  fw.ancillaries = fw.ancillaries.filter(a => a !== value);
  saveFrameworkDebounced();
  renderWizardStep1InSection();
}

// ── Passenger type + age-range helpers ───────────────────────────────────────
function fwTogglePaxType(el, value) {
  fwToggleSimplePill(el, 'passengerTypes', value);
  const isNowSelected = el.classList.contains('selected');
  const ageRow = document.getElementById(`pax-age-${value}`);
  if (ageRow) {
    ageRow.style.display = isNowSelected ? '' : 'none';
    if (isNowSelected && WIZ_PAX_DEFAULT_AGES[value]) {
      const fw = wizData.framework;
      if (!fw.passengerAgeRanges) fw.passengerAgeRanges = {};
      if (!fw.passengerAgeRanges[value])
        fw.passengerAgeRanges[value] = { ...WIZ_PAX_DEFAULT_AGES[value] };
    }
  }
}

function fwSetPaxAge(type, bound, value) {
  const fw = wizData.framework;
  if (!fw.passengerAgeRanges) fw.passengerAgeRanges = {};
  if (!fw.passengerAgeRanges[type]) fw.passengerAgeRanges[type] = { ...WIZ_PAX_DEFAULT_AGES[type] };
  fw.passengerAgeRanges[type][bound] = parseInt(value, 10) || 0;
}

// ── Step 2: Test Resources ────────────────────────────────────────────────────
function renderWizardStep2() {
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');

  const trainItems = trains.map((t, tidx) => {
    const d = normalizeTrainData(typeof t.data === 'string' ? JSON.parse(t.data) : (t.data || {}));
    const route = [d.originURN, d.destinationURN].filter(Boolean).join(' → ') || '';
    const svc = d.services || [];
    const svcSummary = svc.length === 0 ? 'no services'
      : svc.length === 1 ? (svc[0].vehicleNumber || '1 service')
      : `${svc.length} services`;
    const classes = (d.travelClasses || []).join(', ') || '';
    const sub = [route, svcSummary, classes].filter(Boolean).join('  ·  ');
    return `
    <div class="train-item">
      <div class="train-row" data-action="toggle-train-detail" data-tidx="${esc(tidx)}">
        <div style="flex:1;min-width:0">
          <div class="train-row-label">${esc(t.label || '—')}</div>
          <div class="train-row-sub">${esc(sub)}</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0;align-items:center">
          <span class="toggle-arrow" id="train-arrow-${esc(tidx)}">▶</span>
          <button class="btn btn-sm btn-secondary" data-action="wiz-duplicate-train" data-tidx="${esc(tidx)}" title="Duplicate this train (copy then edit the vehicle # / times)" style="font-size:11px;padding:3px 8px">🗐 Duplicate</button>
          <button class="row-delete-btn" data-action="wiz-delete-resource" data-id="${esc(t.id)}" title="Delete this train">🗑</button>
        </div>
      </div>
      <div class="train-detail" id="train-detail-${esc(tidx)}"></div>
    </div>`;
  }).join('');

  // Journeys (#137) — reusable multi-leg itineraries chaining train sets.
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const journeyItems = journeys.map((j, jidx) => `
    <div class="train-item">
      <div class="train-row" data-action="toggle-journey-detail" data-jidx="${esc(jidx)}">
        <div style="flex:1;min-width:0">
          <div class="train-row-label">${esc(j.label || '—')}</div>
          <div class="train-row-sub">${esc(journeySummary(j))}</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0;align-items:center">
          <span class="toggle-arrow" id="journey-arrow-${esc(jidx)}">▶</span>
          <button class="btn btn-sm btn-secondary" data-action="wiz-duplicate-journey" data-jidx="${esc(jidx)}" title="Duplicate this journey" style="font-size:11px;padding:3px 8px">🗐 Duplicate</button>
          <button class="row-delete-btn" data-action="wiz-delete-journey" data-id="${esc(j.id)}" title="Delete this journey">🗑</button>
        </div>
      </div>
      <div class="train-detail" id="journey-detail-${esc(jidx)}"></div>
    </div>`).join('');

  document.getElementById('wizard-body').innerHTML = `
  <p style="color:#546e7a;font-size:13px;line-height:1.6;margin-bottom:4px">
    Register the test trains available in your system under test.
    These resources will be referenced when generating test scenarios.
  </p>

  <!-- Train Resources -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">🚆 Train Resources<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      ${trains.length === 0
        ? '<div style="color:#90a4ae;font-size:13px;padding:8px 0 12px">No trains configured yet — click Add Train to get started.</div>'
        : `<div id="train-list">${trainItems}</div>`}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" data-action="wiz-add-train">➕ Add Train</button>
        ${trains.length > 0 ? '<button class="btn btn-secondary btn-sm" data-action="wiz-save-all-trains" title="Save every train you have open/edited in one go">💾 Save all trains</button>' : ''}
      </div>
    </div>
  </div>

  <!-- Journeys (multi-leg) -->
  <div class="fw-section">
    <div class="fw-section-head" data-action="fw-toggle">🧭 Journeys <span style="font-size:10px;font-weight:400;color:#90a4ae;margin-left:8px">— reusable multi-leg itineraries</span><span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body">
      <p style="color:#90a4ae;font-size:12px;margin:0 0 8px">Chain train sets into a multi-leg journey (e.g. Basel → Amsterdam → Paris). A scenario can then apply the whole journey at once instead of typing each leg.</p>
      ${journeys.length === 0
        ? '<div style="color:#90a4ae;font-size:13px;padding:4px 0 12px">No journeys yet — click Add Journey to chain train sets together.</div>'
        : `<div id="journey-list">${journeyItems}</div>`}
      <div style="margin-top:12px">
        <button class="btn btn-secondary btn-sm" data-action="wiz-add-journey">➕ Add Journey</button>
      </div>
    </div>
  </div>
  `;
}

// ── Train timetable (#136) ────────────────────────────────────────────────
// A train set is a route (origin/destination/operator/product/classes/...)
// plus a list of *services* — the individual trains that run that route at
// different hours/days (e.g. Sqills IC BAS→AMS = OSDM_200/202/204/206). Legacy
// train sets stored a single service as top-level vehicleNumber/departureTime/
// arrivalTime; normalizeTrainData() migrates those into services[0] on read so
// the rest of the UI can assume the array. Idempotent.
function normalizeTrainData(d) {
  d = d || {};
  if (!Array.isArray(d.services)) {
    d.services = (d.vehicleNumber || d.departureTime || d.arrivalTime)
      ? [{ vehicleNumber: d.vehicleNumber || '', departureTime: d.departureTime || '', arrivalTime: d.arrivalTime || '' }]
      : [];
  }
  // Operating days live at the set level (#141) — all services share one
  // calendar. Migrate from a per-service daysOfWeek (the Phase 2 shape).
  if (!Array.isArray(d.daysOfWeek)) {
    const fromSvc = d.services.find(s => s && Array.isArray(s.daysOfWeek) && s.daysOfWeek.length);
    d.daysOfWeek = fromSvc ? fromSvc.daysOfWeek.slice() : [];
  }
  d.services = d.services.map(s => ({
    vehicleNumber: (s && s.vehicleNumber) || '',
    departureTime: (s && s.departureTime) || '',
    arrivalTime:   (s && s.arrivalTime) || ''
  }));
  // Product category as OSDM ref/name/shortName (#141). Migrate the earlier
  // single `productCategory` text field into the ref so saved sets keep working.
  if (d.productCategoryRef == null)       d.productCategoryRef = d.productCategory || '';
  if (d.productCategoryName == null)      d.productCategoryName = '';
  if (d.productCategoryShortName == null) d.productCategoryShortName = '';
  return d;
}

// Parse a vendor service token, e.g. the Sqills form
// "OSDM_202|OSDM_IC|2026-06-01T09:10:00+02:00|2026-06-01T16:35:00+02:00|8500010|8400058".
// Returns a service (+ route hints) or null if it doesn't have enough parts.
function parseServiceToken(tok) {
  const p = String(tok || '').trim().split('|');
  if (p.length < 4 || !p[0].trim()) return null;
  const timeOf = (iso) => { const i = String(iso).indexOf('T'); return (i >= 0 ? iso.slice(i + 1) : iso).trim(); };
  const stnUrn = (s) => { s = String(s || '').trim(); return s ? (/^urn:/i.test(s) ? s : `urn:uic:stn:${s}`) : ''; };
  return {
    vehicleNumber: p[0].trim(),
    productCategory: (p[1] || '').trim(),
    departureTime: timeOf(p[2]),
    arrivalTime: timeOf(p[3]),
    originURN: stnUrn(p[4]),
    destinationURN: stnUrn(p[5])
  };
}

// One <tr> for a service row in the timetable table. Operating days are set
// once for the whole set (#141), so a service row is just vehicle + times.
function trainServiceRowHtml(s) {
  s = s || {};
  return `<tr class="svc-row">
    <td style="padding:3px 6px"><input class="param-input" data-svc-field="vehicleNumber" value="${esc(s.vehicleNumber || '')}" placeholder="OSDM_202" style="min-width:90px"></td>
    <td style="padding:3px 6px"><input class="param-input" data-svc-field="departureTime" value="${esc(s.departureTime || '')}" placeholder="09:10:00+02:00" style="min-width:130px"></td>
    <td style="padding:3px 6px"><input class="param-input" data-svc-field="arrivalTime" value="${esc(s.arrivalTime || '')}" placeholder="16:35:00+02:00" style="min-width:130px"></td>
    <td style="padding:3px 6px"><button class="row-delete-btn" data-action="train-remove-service" title="Remove this service">🗑</button></td>
  </tr>`;
}

// Read the current service rows out of an expanded train detail panel's
// timetable table (DOM is the source of truth until Save, like the other
// train fields). Returns [] when the panel/table isn't present.
function readTrainServiceRows(tidx) {
  const tbody = document.getElementById(`tf-${tidx}-services`);
  if (!tbody) return [];
  return [...tbody.querySelectorAll('tr.svc-row')].map(row => {
    const val = (f) => { const el = row.querySelector(`[data-svc-field="${f}"]`); return el ? el.value.trim() : ''; };
    return {
      vehicleNumber: val('vehicleNumber'),
      departureTime: val('departureTime'),
      arrivalTime:   val('arrivalTime')
    };
  });
}

// Re-render only the timetable <tbody> from a services array — preserves the
// route fields above (which are untouched DOM-only inputs).
function reRenderTrainServices(tidx, services) {
  const tbody = document.getElementById(`tf-${tidx}-services`);
  if (tbody) tbody.innerHTML = (services || []).map(trainServiceRowHtml).join('');
}

function trainAddService(tidx) {
  const rows = readTrainServiceRows(tidx);
  rows.push({ vehicleNumber: '', departureTime: '', arrivalTime: '' });
  reRenderTrainServices(tidx, rows);
}

function trainRemoveService(tidx, rowEl) {
  const rows = readTrainServiceRows(tidx);
  const tr = rowEl && rowEl.closest('tr.svc-row');
  const tbody = document.getElementById(`tf-${tidx}-services`);
  if (tr && tbody) {
    const i = [...tbody.querySelectorAll('tr.svc-row')].indexOf(tr);
    if (i >= 0) rows.splice(i, 1);
  }
  reRenderTrainServices(tidx, rows);
}

// Parse the paste box (one token per line or comma-separated) and append the
// resulting services; fill empty route fields (origin/destination) from the
// first token as a convenience.
function trainPasteServices(tidx) {
  const box = document.getElementById(`tf-${tidx}-paste`);
  if (!box) return;
  const tokens = String(box.value || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  const parsed = tokens.map(parseServiceToken).filter(Boolean);
  if (parsed.length === 0) return;
  const rows = readTrainServiceRows(tidx);
  parsed.forEach(p => rows.push({ vehicleNumber: p.vehicleNumber, departureTime: p.departureTime, arrivalTime: p.arrivalTime }));
  reRenderTrainServices(tidx, rows);
  // Fill empty route inputs from the first token.
  const first = parsed[0];
  const setIfEmpty = (field, v) => {
    if (!v) return;
    const el = document.querySelector(`#train-detail-${tidx} [data-tfield="${field}"]`);
    if (el && !el.value.trim()) el.value = v;
  };
  setIfEmpty('originURN', first.originURN);
  setIfEmpty('destinationURN', first.destinationURN);
  box.value = '';
}

// ── Build the detail HTML for one train resource ─────────────────────────────
function buildTrainDetailHTML(tidx) {
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const t = trains[tidx];
  if (!t) return '';
  const d = normalizeTrainData(typeof t.data === 'string' ? JSON.parse(t.data) : (t.data || {}));
  const fw = wizData.framework;

  // Build pill HTML with pre-selected state
  function pills(items, field) {
    const vals = d[field] || [];
    return items.map(v => {
      const label = typeof v === 'object' ? (v.label || v.value) : String(v).replace(/_/g, ' ');
      const value = typeof v === 'object' ? v.value : v;
      const sel = vals.includes(value) ? ' selected' : '';
      return `<div class="pill${sel}" data-val="${esc(value)}" data-action="pill-toggle">${esc(label)}</div>`;
    }).join('');
  }

  const ttItems = (fw.rail.ticketTypes || []).map(v => ({
    value: v,
    label: (WIZ_TICKET_TYPES.find(x => x.value === v)?.label.split('—')[0].trim()) || v
  }));

  return `
  <div class="param-section" style="margin-top:8px">
    <div class="param-section-head" data-action="toggle-param-section">⚙️ Train Details<span class="ps-arrow open">▶</span></div>
    <div class="param-section-body open">
    <div style="padding:12px 14px">
      <p style="color:#90a4ae;font-size:11px;margin:0 0 10px">A train set is a <b>route</b> (below) plus a <b>timetable</b> of services (the trains that run it at different hours). Add the individual departures in the Services section.</p>
      <div class="train-form-grid">
        <!-- Row 1: Label | Operator Code -->
        <div class="param-field">
          <label class="param-label">Label <span class="param-hint">(short display name)</span></label>
          <input class="param-input" data-action="train-field" data-tidx="${esc(tidx)}" data-tfield="label" value="${esc(t.label || '')}" placeholder="e.g. Sqills IC BAS/AMS">
          <span class="field-error" id="tf-${esc(tidx)}-label-err"></span>
        </div>
        <div class="param-field">
          <label class="param-label">Operator Code <span class="param-hint">(urn:uic:rics:NNNN)</span></label>
          <input class="param-input" data-action="train-field" data-tidx="${esc(tidx)}" data-tfield="operatorCode" value="${esc(d.operatorCode || '')}" placeholder="urn:uic:rics:1184">
          <span class="field-error" id="tf-${esc(tidx)}-operatorCode-err"></span>
        </div>
        <!-- Row 2: Origin URN | Destination URN -->
        <div class="param-field">
          <label class="param-label">Origin station URN</label>
          <input class="param-input" data-action="train-field" data-tidx="${esc(tidx)}" data-tfield="originURN" value="${esc(d.originURN || '')}" placeholder="urn:uic:stn:8500010">
          <span class="field-error" id="tf-${esc(tidx)}-originURN-err"></span>
        </div>
        <div class="param-field">
          <label class="param-label">Destination station URN</label>
          <input class="param-input" data-action="train-field" data-tidx="${esc(tidx)}" data-tfield="destinationURN" value="${esc(d.destinationURN || '')}" placeholder="urn:uic:stn:8400058">
          <span class="field-error" id="tf-${esc(tidx)}-destinationURN-err"></span>
        </div>
        <!-- Row 3: Product category ref | short name -->
        <div class="param-field">
          <label class="param-label">Product category ref <span class="param-hint">(urn:uic:sbc:… — sent in the request)</span></label>
          <input class="param-input" data-action="train-field" data-tidx="${esc(tidx)}" data-tfield="productCategoryRef" value="${esc(d.productCategoryRef || '')}" placeholder="urn:uic:sbc:SQILLS_HS">
          <span class="field-error" id="tf-${esc(tidx)}-productCategoryRef-err"></span>
        </div>
        <div class="param-field">
          <label class="param-label">Product category short name <span class="param-hint">(optional)</span></label>
          <input class="param-input" data-action="train-field" data-tidx="${esc(tidx)}" data-tfield="productCategoryShortName" value="${esc(d.productCategoryShortName || '')}" placeholder="Sqills High Speed train">
          <span class="field-error" id="tf-${esc(tidx)}-productCategoryShortName-err"></span>
        </div>
        <!-- Row 4: Product category name (full width, optional) -->
        <div class="param-field" style="grid-column:1/-1">
          <label class="param-label">Product category name <span class="param-hint">(optional)</span></label>
          <input class="param-input" data-action="train-field" data-tidx="${esc(tidx)}" data-tfield="productCategoryName" value="${esc(d.productCategoryName || '')}" placeholder="Sqills High Speed train" style="max-width:360px">
          <span class="field-error" id="tf-${esc(tidx)}-productCategoryName-err"></span>
        </div>
      </div>
    </div>
    </div>
  </div>
  <div class="param-section" style="margin-top:8px">
    <div class="param-section-head" data-action="toggle-param-section">🕑 Services (timetable)<span class="ps-arrow open">▶</span></div>
    <div class="param-section-body open">
    <div style="padding:12px 14px">
      <div class="fw-subsection" style="margin-bottom:12px">
        <div class="fw-subsection-label">Operating days <span class="param-hint">(empty = daily — applies to every service in this set)</span></div>
        <div class="pill-group" id="tf-${esc(tidx)}-days">${WIZ_DAYS.map(dy => `<div class="pill${(d.daysOfWeek || []).includes(dy.value) ? ' selected' : ''}" data-action="pill-toggle" data-val="${esc(dy.value)}">${esc(dy.label)}</div>`).join('')}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap">
        <input class="param-input" id="tf-${esc(tidx)}-paste" placeholder="Paste service tokens, one per line — OSDM_202|OSDM_IC|2026-06-01T09:10:00+02:00|2026-06-01T16:35:00+02:00|8500010|8400058" style="flex:1;min-width:260px;font-size:11px;font-family:'Consolas','Monaco','Courier New',monospace">
        <button class="btn btn-secondary btn-sm" data-action="train-paste-service" data-tidx="${esc(tidx)}" title="Parse the pasted tokens into service rows">📥 Add from tokens</button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="text-align:left;color:#90a4ae;font-size:11px">
          <th style="padding:3px 6px">Vehicle #</th><th style="padding:3px 6px">Departure (HH:MM:SS±HH:MM)</th><th style="padding:3px 6px">Arrival</th><th></th>
        </tr></thead>
        <tbody id="tf-${esc(tidx)}-services">${(d.services.length ? d.services : [{}]).map(trainServiceRowHtml).join('')}</tbody>
      </table>
      <div style="margin-top:10px">
        <button class="btn btn-secondary btn-sm" data-action="train-add-service" data-tidx="${esc(tidx)}">➕ Add service</button>
      </div>
      <span class="field-error" id="tf-${esc(tidx)}-services-err"></span>
    </div>
    </div>
  </div>
  <div class="param-section" style="margin-top:8px">
    <div class="param-section-head" data-action="toggle-param-section">🚃 Service Configuration<span class="ps-arrow">▶</span></div>
    <div class="param-section-body">
    <div style="padding:12px 14px">
      <div class="fw-subsection">
        <div class="fw-subsection-label">Applicable ticket types</div>
        <div class="pill-group" id="tf-${esc(tidx)}-ticketTypes">${pills(ttItems, 'ticketTypes')}</div>
      </div>
      <div class="fw-subsection" style="margin-top:10px">
        <div class="fw-subsection-label">Travel classes on this train</div>
        <div class="pill-group" id="tf-${esc(tidx)}-travelClasses">${pills(WIZ_TRAVEL_CLASSES, 'travelClasses')}</div>
      </div>
      <div class="fw-subsection" style="margin-top:10px">
        <div class="fw-subsection-label">Service classes on this train</div>
        <div class="pill-group" id="tf-${esc(tidx)}-serviceClasses">${pills(WIZ_SERVICE_CLASSES, 'serviceClasses')}</div>
      </div>
      <div class="fw-subsection" style="margin-top:10px">
        <div class="fw-subsection-label">Accommodation types</div>
        <div class="pill-group" id="tf-${esc(tidx)}-accommodations">${pills(WIZ_ACCOMMODATIONS, 'accommodations')}</div>
      </div>
      <div class="fw-subsection" style="margin-top:10px">
        <div class="fw-subsection-label">Ancillaries available</div>
        <div class="pill-group" id="tf-${esc(tidx)}-ancillaries">${pills([...new Set([...(fw.ancillaries || []), ...(d.ancillaries || [])])], 'ancillaries')}</div>
      </div>
    </div>
    </div>
  </div>
  <div class="param-section" style="margin-top:8px">
    <div class="param-section-head" data-action="toggle-param-section">🎟 Fulfillment<span class="ps-arrow">▶</span></div>
    <div class="param-section-body">
    <div style="padding:12px 14px">
      <div class="fw-subsection">
        <div class="fw-subsection-label">Fulfillment type</div>
        <div class="pill-group" id="tf-${esc(tidx)}-fulfillmentTypes">${pills(WIZ_FULFIL_TYPES, 'fulfillmentTypes')}</div>
      </div>
      <div class="fw-subsection" style="margin-top:10px">
        <div class="fw-subsection-label">Fulfillment media</div>
        <div class="pill-group" id="tf-${esc(tidx)}-fulfillmentMedia">${pills(WIZ_FULFIL_MEDIA, 'fulfillmentMedia')}</div>
      </div>
    </div>
    </div>
  </div>
  <div style="padding:0 14px">
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn-primary btn-sm" data-action="wiz-save-train" data-tidx="${esc(tidx)}">💾 Save Train</button>
      </div>
    </div>
  </div>`;
}

// ── Toggle train detail (expand/collapse, mirrors toggleDetail) ──────────────
function toggleTrainDetail(tidx) {
  const detail = document.getElementById('train-detail-' + tidx);
  const arrow  = document.getElementById('train-arrow-' + tidx);
  if (!detail) return;
  const isOpen = detail.classList.contains('open');
  if (!isOpen) {
    if (!detail.dataset.rendered) {
      detail.innerHTML = buildTrainDetailHTML(tidx);
      detail.dataset.rendered = '1';
    }
    detail.classList.add('open');
    if (arrow) arrow.classList.add('open');
  } else {
    detail.classList.remove('open');
    if (arrow) arrow.classList.remove('open');
  }
}

function getSelectedPills(containerId) {
  return [...document.querySelectorAll(`#${containerId} .pill.selected`)].map(p => p.dataset.val).filter(Boolean);
}

// ── Read form values from an expanded train detail panel ─────────────────────
function readTrainDetailFields(tidx) {
  const detail = document.getElementById('train-detail-' + tidx);
  if (!detail) return null;
  const field = (f) => {
    const el = detail.querySelector(`[data-tfield="${esc(f)}"]`);
    return el ? el.value.trim() : '';
  };
  return {
    label:         field('label'),
    originURN:     field('originURN'),
    destinationURN:field('destinationURN'),
    operatorCode:  field('operatorCode'),
    productCategoryRef:       field('productCategoryRef'),
    productCategoryName:      field('productCategoryName'),
    productCategoryShortName: field('productCategoryShortName'),
    daysOfWeek:    getSelectedPills(`tf-${esc(tidx)}-days`),
    services:      readTrainServiceRows(tidx),
    ticketTypes:       getSelectedPills(`tf-${esc(tidx)}-ticketTypes`),
    travelClasses:     getSelectedPills(`tf-${esc(tidx)}-travelClasses`),
    serviceClasses:    getSelectedPills(`tf-${esc(tidx)}-serviceClasses`),
    accommodations:    getSelectedPills(`tf-${esc(tidx)}-accommodations`),
    ancillaries:       getSelectedPills(`tf-${esc(tidx)}-ancillaries`),
    fulfillmentTypes:  getSelectedPills(`tf-${esc(tidx)}-fulfillmentTypes`),
    fulfillmentMedia:  getSelectedPills(`tf-${esc(tidx)}-fulfillmentMedia`)
  };
}

function wizValidateTrain(tidx) {
  const URN_RE  = /^urn:uic:stn:\d+$/i;
  const RICS_RE = /^urn:uic:rics:\d+$/i;
  const TIME_RE = /^\d{2}:\d{2}:\d{2}[+\-]\d{2}:\d{2}$/;
  const detail = document.getElementById('train-detail-' + tidx);
  if (!detail) return false;
  const checks = [
    { tfield: 'label',          test: v => v.length > 0,            msg: 'Label is required.' },
    { tfield: 'originURN',      test: v => !v || URN_RE.test(v),   msg: 'Must be urn:uic:stn:XXXXXXX (digits only after last colon).' },
    { tfield: 'destinationURN', test: v => !v || URN_RE.test(v),   msg: 'Must be urn:uic:stn:XXXXXXX (digits only after last colon).' },
    { tfield: 'operatorCode',   test: v => !v || RICS_RE.test(v),  msg: 'Must be urn:uic:rics:NNNN (e.g. urn:uic:rics:1184) or leave empty.' }
  ];
  // Clear previous state (route fields + services)
  checks.forEach(c => {
    const el  = detail.querySelector(`[data-tfield="${c.tfield}"]`);
    const err = document.getElementById(`tf-${esc(tidx)}-${c.tfield}-err`);
    if (el)  el.classList.remove('invalid');
    if (err) { err.textContent = ''; err.classList.remove('show'); }
  });
  const svcErr = document.getElementById(`tf-${esc(tidx)}-services-err`);
  if (svcErr) { svcErr.textContent = ''; svcErr.classList.remove('show'); }
  let ok = true;
  checks.forEach(c => {
    const el  = detail.querySelector(`[data-tfield="${c.tfield}"]`);
    const err = document.getElementById(`tf-${esc(tidx)}-${c.tfield}-err`);
    if (!el) return;
    const val = el.value.trim();
    if (!c.test(val)) {
      el.classList.add('invalid');
      if (err) { err.textContent = c.msg; err.classList.add('show'); }
      ok = false;
    }
  });

  // Services (timetable): at least one, each with a vehicle # and valid times.
  const services = readTrainServiceRows(tidx);
  let svcMsg = '';
  if (services.length === 0) {
    svcMsg = 'Add at least one service (the train that runs this route).';
  } else {
    for (let i = 0; i < services.length; i++) {
      const s = services[i];
      if (!s.vehicleNumber) { svcMsg = `Service ${i + 1}: vehicle number is required.`; break; }
      if (s.departureTime && !TIME_RE.test(s.departureTime)) { svcMsg = `Service ${i + 1}: departure must be HH:MM:SS±HH:MM (e.g. 09:10:00+02:00).`; break; }
      if (s.arrivalTime && !TIME_RE.test(s.arrivalTime)) { svcMsg = `Service ${i + 1}: arrival must be HH:MM:SS±HH:MM (e.g. 16:35:00+02:00).`; break; }
    }
  }
  if (svcMsg) {
    if (svcErr) { svcErr.textContent = svcMsg; svcErr.classList.add('show'); }
    ok = false;
  }
  return ok;
}

async function wizSaveTrain(tidx, opts = {}) {
  if (!wizValidateTrain(tidx)) return null;
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const t = trains[tidx];
  if (!t) return;
  const fields = readTrainDetailFields(tidx);
  if (!fields) return;
  const label = fields.label;
  const data = {
    originURN:        fields.originURN,
    destinationURN:   fields.destinationURN,
    operatorCode:     fields.operatorCode,
    productCategoryRef:       fields.productCategoryRef,
    productCategoryName:      fields.productCategoryName,
    productCategoryShortName: fields.productCategoryShortName,
    daysOfWeek:       fields.daysOfWeek,
    services:         fields.services,
    ticketTypes:      fields.ticketTypes,
    travelClasses:    fields.travelClasses,
    serviceClasses:   fields.serviceClasses,
    accommodations:   fields.accommodations,
    ancillaries:      fields.ancillaries,
    fulfillmentTypes: fields.fulfillmentTypes,
    fulfillmentMedia: fields.fulfillmentMedia
  };
  const isNew = !t.id || t._unsaved;
  try {
    const url    = isNew ? '/v1/company/test-resources' : `/v1/company/test-resources/${t.id}`;
    const method = isNew ? 'POST' : 'PUT';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, resource_type: 'TRAIN', data })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Failed to save train: ${err.detail || err.title || res.status}`);
      return;
    }
    const saved = await res.json();
    // Replace the local entry with the server's authoritative version. Both
    // new (unsaved) and existing trains are already in wizData.resources —
    // wizAddTrain pushes the placeholder before opening the editor, and
    // existing trains are loaded into the array by refreshAllSections. So
    // for both paths we locate the row by reference and swap it. (Previous
    // logic referenced an undeclared `wizEditingId` variable, which caused
    // a ReferenceError on every save — "Network error: wizEditingId is not
    // defined" — even though the actual HTTP call had succeeded.)
    const targetIdx = wizData.resources.findIndex(r => r === t);
    if (targetIdx !== -1) wizData.resources[targetIdx] = saved;
    else wizData.resources.push(saved);
    // Save-all reads + persists several panels, then re-renders once itself.
    if (opts.rerender === false) return saved;
    showMsg(`✅ Train "${label}" saved.`, true);
    // Re-render the Test Data section locally (no server round-trip) and re-open
    // the saved panel — so saving a train no longer collapses it / wipes the
    // list (#141). refreshAllSections() is unnecessary here: a resource save
    // doesn't touch the framework, scenarios or datafile.
    renderTestDataSection(wizData.framework, wizData.resources);
    renderWizardStep2InSection();
    reopenTrainById(saved.id);
    return saved;
  } catch(e) { alert(`Network error: ${e.message}`); return null; }
}

// Re-open a train's detail panel by resource id after a list re-render.
function reopenTrainById(id) {
  if (id == null) return;
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const tidx = trains.findIndex(r => String(r.id) === String(id));
  if (tidx < 0) return;
  const detail = document.getElementById('train-detail-' + tidx);
  if (detail && !detail.classList.contains('open')) toggleTrainDetail(tidx);
}

// Save every train whose detail panel is open/edited (rendered), in one go.
// Validates all first so a bad field blocks the batch before anything is sent.
async function wizSaveAllTrains() {
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const targets = [];
  trains.forEach((t, tidx) => {
    const detail = document.getElementById('train-detail-' + tidx);
    if (detail && detail.dataset.rendered) targets.push(tidx);
  });
  if (targets.length === 0) { showMsg('Open the train(s) you want to save first (click a row to expand).', false); return; }
  for (const tidx of targets) {
    if (!wizValidateTrain(tidx)) { showMsg('Fix the highlighted train fields, then Save all.', false); return; }
  }
  const savedIds = [];
  for (const tidx of targets) {
    const r = await wizSaveTrain(tidx, { rerender: false });
    if (r) savedIds.push(r.id);
  }
  renderTestDataSection(wizData.framework, wizData.resources);
  renderWizardStep2InSection();
  savedIds.forEach(reopenTrainById);
  showMsg(`✅ Saved ${savedIds.length} train${savedIds.length !== 1 ? 's' : ''}.`, true);
}

// ── Add a new unsaved train and expand it ────────────────────────────────────
function wizAddTrain() {
  const newTrain = { id: null, _unsaved: true, label: '', resource_type: 'TRAIN', data: {} };
  wizData.resources.push(newTrain);
  // Re-render, then expand the new (last) train
  renderWizardStep2InSection();
  // Re-open the data section
  const bodyData = document.getElementById('body-data');
  const toggleData = document.getElementById('toggle-data');
  if (bodyData) { bodyData.style.display = 'block'; toggleData.classList.add('open'); }
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const newIdx = trains.length - 1;
  toggleTrainDetail(newIdx);
  const detail = document.getElementById('train-detail-' + newIdx);
  if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Duplicate an existing train into a new unsaved copy and expand it ─────────
// Deep-clones the source train's data + label into a fresh unsaved placeholder
// (mirrors wizAddTrain) so the user can tweak the vehicle # / times before
// saving — the common "same route, different hour" case. The copy gets a
// unique "(copy)" label and is persisted as a brand-new resource on Save Train.
function wizDuplicateTrain(tidx) {
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const src = trains[tidx];
  if (!src) return;
  const srcData = typeof src.data === 'string' ? JSON.parse(src.data) : (src.data || {});

  // Unique "(copy)" label so the list stays readable and Save doesn't collide.
  const existing = new Set(trains.map(t => t.label).filter(Boolean));
  const base = `${src.label || 'Train'} (copy)`;
  let newLabel = base;
  for (let n = 2; existing.has(newLabel); n++) newLabel = `${base} ${n}`;

  const copy = {
    id: null,
    _unsaved: true,
    label: newLabel,
    resource_type: 'TRAIN',
    data: JSON.parse(JSON.stringify(srcData))
  };
  wizData.resources.push(copy);

  // Re-render and expand the new (last) train — same flow as wizAddTrain.
  renderWizardStep2InSection();
  const bodyData = document.getElementById('body-data');
  const toggleData = document.getElementById('toggle-data');
  if (bodyData) { bodyData.style.display = 'block'; toggleData.classList.add('open'); }
  const newTrains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const newIdx = newTrains.length - 1;
  toggleTrainDetail(newIdx);
  const detail = document.getElementById('train-detail-' + newIdx);
  if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function wizDeleteResource(id) {
  // Handle unsaved trains (no id yet) — just remove from local array
  if (!id || id === 'null') {
    const unsaved = wizData.resources.find(r => r._unsaved && !r.id);
    if (unsaved) {
      wizData.resources = wizData.resources.filter(r => r !== unsaved);
      renderWizardStep2InSection();
      const bodyData = document.getElementById('body-data');
      const toggleData = document.getElementById('toggle-data');
      if (bodyData) { bodyData.style.display = 'block'; toggleData.classList.add('open'); }
    }
    return;
  }
  // Delegate to deleteTrainResource which checks for impacted scenarios
  await deleteTrainResource(id);
}

// ── Journeys (#137) ───────────────────────────────────────────────────────
// A Journey is a reusable multi-leg itinerary: an ordered list of legs, each
// referencing a train set (#136) + a chosen service from its timetable. A
// scenario can apply a journey to fill its trip legs once, instead of typing
// every leg by hand. Stored as a JOURNEY test-resource: data = { legs: [
// { trainResourceId, serviceIndex } ] }.
function stnShort(urn) { return String(urn || '').split(':').pop() || ''; }

// Resolve one journey leg → { train, d (normalized data), svc (chosen service) }.
function journeyResolveLeg(leg) {
  if (!leg) return null;
  const train = (wizData.resources || []).find(r => String(r.id) === String(leg.trainResourceId) && r.resource_type === 'TRAIN');
  if (!train) return null;
  const d = normalizeTrainData(typeof train.data === 'string' ? JSON.parse(train.data) : (train.data || {}));
  const svc = d.services[leg.serviceIndex] || d.services[0] || {};
  return { train, d, svc };
}

function journeyData(j) {
  if (!j) return { legs: [] };
  const data = typeof j.data === 'string' ? (() => { try { return JSON.parse(j.data || '{}'); } catch (_) { return {}; } })() : (j.data || {});
  if (!Array.isArray(data.legs)) data.legs = [];
  return data;
}

// Human summary of a journey: "BAS → AMS → PAR · 2 legs · 1 transfer".
function journeySummary(j) {
  const legs = journeyData(j).legs;
  if (!legs.length) return 'no legs yet';
  const stops = [];
  legs.forEach((leg, i) => {
    const r = journeyResolveLeg(leg);
    const o = r ? stnShort(r.d.originURN) : '?';
    const dst = r ? stnShort(r.d.destinationURN) : '?';
    if (i === 0) stops.push(o || '?');
    stops.push(dst || '?');
  });
  const transfers = Math.max(0, legs.length - 1);
  return `${stops.join(' → ')}  ·  ${legs.length} leg${legs.length > 1 ? 's' : ''}  ·  ${transfers} transfer${transfers !== 1 ? 's' : ''}`;
}

// Resolve a journey into scenario trip legs (origin/destination/times/vehicle).
function journeyToTripLegs(j) {
  return journeyData(j).legs.map(leg => {
    const r = journeyResolveLeg(leg);
    if (!r) return null;
    const { d, svc } = r;
    const out = {};
    if (d.originURN)      out.origin        = d.originURN;
    if (d.destinationURN) out.destination   = d.destinationURN;
    if (svc.departureTime) out.startDatetime = '%TRIP_DATE%T' + svc.departureTime;
    if (svc.arrivalTime)   out.endDatetime   = '%TRIP_DATE%T' + svc.arrivalTime;
    if (svc.vehicleNumber) out.vehicleNumber = svc.vehicleNumber;
    if (d.operatorCode)    out.operatorCode  = d.operatorCode;
    if (d.productCategoryRef)       out.productCategoryRef       = d.productCategoryRef;
    if (d.productCategoryName)      out.productCategoryName      = d.productCategoryName;
    if (d.productCategoryShortName) out.productCategoryShortName = d.productCategoryShortName;
    return out;
  }).filter(Boolean);
}

// Continuity check (#145): a journey's legs must chain — each leg should start
// where the previous ended, and depart after the previous arrives. Returns a
// list of human warnings (soft — overnight connections are legitimately
// possible, so this guides rather than blocks). Times are "HH:MM:SS±HH:MM" on a
// shared trip date, so a fixed-date parse compares them correctly.
function journeyContinuityWarnings(j) {
  const legs = journeyData(j).legs;
  const ms = (t) => { if (!t) return NaN; const d = new Date('2000-01-01T' + t); return d.getTime(); };
  const warns = [];
  for (let i = 1; i < legs.length; i++) {
    const prev = journeyResolveLeg(legs[i - 1]);
    const cur  = journeyResolveLeg(legs[i]);
    if (!prev || !cur) continue;
    if (prev.d.destinationURN && cur.d.originURN && prev.d.destinationURN !== cur.d.originURN) {
      warns.push(`Leg ${i + 1} starts at ${stnShort(cur.d.originURN)} but leg ${i} ends at ${stnShort(prev.d.destinationURN)} — the legs don't connect.`);
    }
    const arr = ms(prev.svc.arrivalTime), dep = ms(cur.svc.departureTime);
    if (!isNaN(arr) && !isNaN(dep) && dep < arr) {
      warns.push(`Leg ${i + 1} departs ${cur.svc.departureTime} before leg ${i} arrives ${prev.svc.arrivalTime} — pick a later service (or ignore if it's an overnight connection).`);
    }
  }
  return warns;
}

// <select> of every train set × service for one journey leg.
function journeyLegPickerHtml(jidx, li, leg) {
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const sel = leg && leg.trainResourceId !== '' && leg.trainResourceId != null
    ? `${leg.trainResourceId}::${leg.serviceIndex || 0}` : '';
  const opts = ['<option value="">— pick a service for this leg —</option>'];
  trains.forEach(t => {
    const d = normalizeTrainData(typeof t.data === 'string' ? JSON.parse(t.data) : (t.data || {}));
    const route = [d.originURN, d.destinationURN].filter(Boolean).map(stnShort).join('→');
    (d.services.length ? d.services : [{}]).forEach((s, si) => {
      const v = `${t.id}::${si}`;
      // Identify the leg by its *service* (route · vehicle · departure→arrival),
      // not the train-set label — a set holds several services, so leading with
      // the set name was misleading (#141). The set name trails as context.
      const times = [s.departureTime, s.arrivalTime].filter(Boolean).join('→');
      const svc = [route, s.vehicleNumber, times].filter(Boolean).join(' · ');
      const lbl = svc ? `${svc}  ·  ${t.label || '?'}` : (t.label || '?');
      opts.push(`<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>${esc(lbl)}</option>`);
    });
  });
  return `<select class="param-input param-select" data-action="journey-leg-pick" data-jidx="${esc(jidx)}" data-li="${esc(li)}" style="min-width:300px;font-size:12px">${opts.join('')}</select>`;
}

// The legs + summary body of a journey detail (re-rendered on leg edits; the
// label input lives outside this container so unsaved edits survive).
function journeyBodyHtml(jidx) {
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const j = journeys[jidx];
  if (!j) return '';
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  const legs = journeyData(j).legs;
  const legsHtml = legs.length ? legs.map((leg, li) => `
    <div class="sub-card" style="display:flex;gap:8px;align-items:center;padding:8px 12px;margin-bottom:6px">
      <span style="font-weight:700;color:#455a64;min-width:46px">Leg ${li + 1}</span>
      ${journeyLegPickerHtml(jidx, li, leg)}
      <div style="display:flex;gap:3px;margin-left:auto">
        <button class="btn btn-sm btn-secondary" data-action="journey-move-leg" data-jidx="${esc(jidx)}" data-li="${esc(li)}" data-dir="-1" title="Move up"${li === 0 ? ' disabled' : ''}>▲</button>
        <button class="btn btn-sm btn-secondary" data-action="journey-move-leg" data-jidx="${esc(jidx)}" data-li="${esc(li)}" data-dir="1" title="Move down"${li === legs.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="row-delete-btn" data-action="journey-remove-leg" data-jidx="${esc(jidx)}" data-li="${esc(li)}" title="Remove this leg">🗑</button>
      </div>
    </div>`).join('') : '<div style="color:#90a4ae;font-size:12px;padding:6px 0">No legs yet — chain the train sets this journey runs over.</div>';
  const warns = journeyContinuityWarnings(j);
  const warnHtml = warns.length
    ? `<div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:11px;color:#e65100">⚠ ${warns.map(esc).join('<br>')}</div>`
    : '';
  return `
    <div style="font-size:11px;color:#78909c;margin-bottom:8px">🧭 ${esc(journeySummary(j))}</div>
    ${warnHtml}
    ${trains.length === 0
      ? '<div style="color:#e65100;font-size:12px">⚠️ Define train sets first — a journey chains existing train sets.</div>'
      : legsHtml}
    <div style="margin-top:10px">
      <button class="btn btn-secondary btn-sm" data-action="journey-add-leg" data-jidx="${esc(jidx)}"${trains.length === 0 ? ' disabled' : ''}>➕ Add leg</button>
    </div>
    <span class="field-error" id="jf-${esc(jidx)}-legs-err"></span>`;
}

function buildJourneyDetailHTML(jidx) {
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const j = journeys[jidx];
  if (!j) return '';
  return `
  <div class="param-section" style="margin-top:8px">
    <div class="param-section-head" data-action="toggle-param-section">🧭 Journey<span class="ps-arrow open">▶</span></div>
    <div class="param-section-body open">
    <div style="padding:12px 14px">
      <div class="param-field" style="margin-bottom:12px">
        <label class="param-label">Label <span class="param-hint">(short display name)</span></label>
        <input class="param-input" data-action="journey-label" data-jidx="${esc(jidx)}" value="${esc(j.label || '')}" placeholder="e.g. Basel → Paris via Amsterdam">
        <span class="field-error" id="jf-${esc(jidx)}-label-err"></span>
      </div>
      <div id="journey-body-${esc(jidx)}">${journeyBodyHtml(jidx)}</div>
      <div style="margin-top:14px">
        <button class="btn btn-primary btn-sm" data-action="wiz-save-journey" data-jidx="${esc(jidx)}">💾 Save Journey</button>
      </div>
    </div>
    </div>
  </div>`;
}

function reRenderJourneyBody(jidx) {
  const body = document.getElementById('journey-body-' + jidx);
  if (body) body.innerHTML = journeyBodyHtml(jidx);
}

function toggleJourneyDetail(jidx) {
  const detail = document.getElementById('journey-detail-' + jidx);
  const arrow  = document.getElementById('journey-arrow-' + jidx);
  if (!detail) return;
  if (!detail.classList.contains('open')) {
    if (!detail.dataset.rendered) {
      detail.innerHTML = buildJourneyDetailHTML(jidx);
      detail.dataset.rendered = '1';
    }
    detail.classList.add('open');
    if (arrow) arrow.classList.add('open');
  } else {
    detail.classList.remove('open');
    if (arrow) arrow.classList.remove('open');
  }
}

function wizAddJourney() {
  wizData.resources.push({ id: null, _unsaved: true, label: '', resource_type: 'JOURNEY', data: { legs: [] } });
  renderWizardStep2InSection();
  const bodyData = document.getElementById('body-data');
  const toggleData = document.getElementById('toggle-data');
  if (bodyData) { bodyData.style.display = 'block'; toggleData.classList.add('open'); }
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const newIdx = journeys.length - 1;
  toggleJourneyDetail(newIdx);
  const detail = document.getElementById('journey-detail-' + newIdx);
  if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function wizDuplicateJourney(jidx) {
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const src = journeys[jidx];
  if (!src) return;
  const existing = new Set(journeys.map(x => x.label).filter(Boolean));
  const base = `${src.label || 'Journey'} (copy)`;
  let newLabel = base;
  for (let n = 2; existing.has(newLabel); n++) newLabel = `${base} ${n}`;
  wizData.resources.push({
    id: null, _unsaved: true, label: newLabel, resource_type: 'JOURNEY',
    data: JSON.parse(JSON.stringify(journeyData(src)))
  });
  renderWizardStep2InSection();
  const bodyData = document.getElementById('body-data');
  const toggleData = document.getElementById('toggle-data');
  if (bodyData) { bodyData.style.display = 'block'; toggleData.classList.add('open'); }
  const after = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  toggleJourneyDetail(after.length - 1);
}

function journeyAddLeg(jidx) {
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const j = journeys[jidx];
  if (!j) return;
  j.data = journeyData(j);
  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');
  if (trains.length === 0) return;
  // Default the new leg to the first train's first service so it is valid.
  j.data.legs.push({ trainResourceId: trains[0].id, serviceIndex: 0 });
  reRenderJourneyBody(jidx);
}

function journeyRemoveLeg(jidx, li) {
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const j = journeys[jidx];
  if (!j) return;
  j.data = journeyData(j);
  if (li >= 0 && li < j.data.legs.length) j.data.legs.splice(li, 1);
  reRenderJourneyBody(jidx);
}

function journeyMoveLeg(jidx, li, dir) {
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const j = journeys[jidx];
  if (!j) return;
  j.data = journeyData(j);
  const to = li + dir;
  if (to < 0 || to >= j.data.legs.length) return;
  const tmp = j.data.legs[li];
  j.data.legs[li] = j.data.legs[to];
  j.data.legs[to] = tmp;
  reRenderJourneyBody(jidx);
}

function journeySetLeg(jidx, li, value) {
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const j = journeys[jidx];
  if (!j) return;
  j.data = journeyData(j);
  const [trainResourceId, svcIdxStr] = String(value || '').split('::');
  if (!trainResourceId) { j.data.legs[li] = { trainResourceId: '', serviceIndex: 0 }; }
  else {
    const parsedId = /^\d+$/.test(trainResourceId) ? parseInt(trainResourceId, 10) : trainResourceId;
    j.data.legs[li] = { trainResourceId: parsedId, serviceIndex: parseInt(svcIdxStr, 10) || 0 };
  }
  reRenderJourneyBody(jidx);
}

async function wizSaveJourney(jidx) {
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const j = journeys[jidx];
  if (!j) return;
  const detail = document.getElementById('journey-detail-' + jidx);
  const labelEl = detail && detail.querySelector('[data-action="journey-label"]');
  const label = labelEl ? labelEl.value.trim() : (j.label || '');
  const legs = journeyData(j).legs.filter(l => l && l.trainResourceId !== '' && l.trainResourceId != null);

  const labelErr = document.getElementById(`jf-${jidx}-label-err`);
  const legsErr  = document.getElementById(`jf-${jidx}-legs-err`);
  if (labelErr) { labelErr.textContent = ''; labelErr.classList.remove('show'); }
  if (legsErr)  { legsErr.textContent = '';  legsErr.classList.remove('show'); }
  let ok = true;
  if (!label) { if (labelErr) { labelErr.textContent = 'Label is required.'; labelErr.classList.add('show'); } ok = false; }
  if (legs.length === 0) { if (legsErr) { legsErr.textContent = 'Add at least one leg (a train set + service).'; legsErr.classList.add('show'); } ok = false; }
  if (!ok) return;

  const data = { legs };
  const isNew = !j.id || j._unsaved;
  try {
    const url    = isNew ? '/v1/company/test-resources' : `/v1/company/test-resources/${j.id}`;
    const method = isNew ? 'POST' : 'PUT';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, resource_type: 'JOURNEY', data })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Failed to save journey: ${err.detail || err.title || res.status}`);
      return;
    }
    const saved = await res.json();
    const idx = wizData.resources.findIndex(r => r === j);
    if (idx !== -1) wizData.resources[idx] = saved; else wizData.resources.push(saved);
    showMsg(`✅ Journey "${label}" saved.`, true);
    // Local re-render + re-open (keep the panel expanded after save, #141).
    renderTestDataSection(wizData.framework, wizData.resources);
    renderWizardStep2InSection();
    reopenJourneyById(saved.id);
  } catch (e) { alert(`Network error: ${e.message}`); }
}

// Re-open a journey's detail panel by resource id after a list re-render.
function reopenJourneyById(id) {
  if (id == null) return;
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const jidx = journeys.findIndex(r => String(r.id) === String(id));
  if (jidx < 0) return;
  const detail = document.getElementById('journey-detail-' + jidx);
  if (detail && !detail.classList.contains('open')) toggleJourneyDetail(jidx);
}

async function wizDeleteJourney(id) {
  // Unsaved journey (no id) — drop locally.
  if (!id || id === 'null') {
    const unsaved = wizData.resources.find(r => r._unsaved && !r.id && r.resource_type === 'JOURNEY');
    if (unsaved) {
      wizData.resources = wizData.resources.filter(r => r !== unsaved);
      renderWizardStep2InSection();
      const bodyData = document.getElementById('body-data');
      const toggleData = document.getElementById('toggle-data');
      if (bodyData) { bodyData.style.display = 'block'; toggleData.classList.add('open'); }
    }
    return;
  }
  const j = (wizData.resources || []).find(r => String(r.id) === String(id) && r.resource_type === 'JOURNEY');
  if (!j) return;
  // Journeys are copied into a scenario's legs at apply-time (not referenced),
  // so deleting one cannot orphan a scenario — a plain confirm is enough.
  if (!confirm(`Delete journey "${j.label || id}"?`)) return;
  try {
    const res = await fetch(`/v1/company/test-resources/${id}`, { method: 'DELETE' });
    if (!res.ok) { alert(`Failed to delete journey: ${res.status}`); return; }
    wizData.resources = wizData.resources.filter(r => r !== j);
    await refreshAllSections();
  } catch (e) { alert(`Network error: ${e.message}`); }
}

// ── Wizard navigation (now section-local) ─────────────────────────────────────
async function wizNext() {
  // No longer used for modal navigation — kept for compatibility
  if (wizStep === 1) {
    await saveFrameworkFromSection();
  }
}

function wizBack() {
  // No longer used — navigation is per-section
}

function wizClose() {
  // No longer used — sections are always visible
}

function wizShowDone() {
  // No longer used — scenario creation feedback is inline
}

// ── Step 3: Scenario Creation ─────────────────────────────────────────────────

function wizInitScenario() {
  const fw = wizData.framework || emptyFramework();
  const sf = fw.salesFlows || ['SALE'];

  // First available type
  const firstType = sf.includes('SALE') ? 'SALE'
    : sf.some(f => f.startsWith('REFUND'))   ? 'REFUND'
    : sf.some(f => f.startsWith('EXCHANGE')) ? 'EXCHANGE'
    : 'SALE';

  // Initial pax counts
  const passengers = {};
  (fw.passengerTypes || ['ADULT']).forEach(t => { passengers[t] = 0; });
  if (passengers.ADULT !== undefined) passengers.ADULT = 1;

  wizScenario = {
    type:               firstType,
    subType:            null,
    action:             'PATCH',
    desiredFlexibility: (fw.offerCriteria && fw.offerCriteria.flexibilities && fw.offerCriteria.flexibilities[0]) || 'FULL_FLEXIBLE',
    customCode:         '',    // optional user-typed name that overrides the auto-generated scenario code
    passengerGender:    {},    // per-type default gender applied at generation: { ADULT: 'X'|'MALE'|'FEMALE', ... }
    overruleCode:       null,
    trainResourceId:    null,
    journeyResourceId:  null,   // #143 — when set, the scenario is a multi-leg journey
    tripType:           'SPECIFICATION',
    originURN:          '',
    destinationURN:     '',
    passengers,
    // Per OSDM spec, every offer-search criterion is OPTIONAL. The wizard
    // pre-fills only from the company's Test Framework defaults — if the
    // framework leaves a field empty, we leave it empty here too, so the
    // generated scenario sends nothing for it (and the vendor applies its
    // own server-side default). Users can still type/tick values in the
    // wizard to override.
    requestedOfferParts: (fw.offerCriteria && fw.offerCriteria.requestedOfferParts) ? [...fw.offerCriteria.requestedOfferParts] : [],
    serviceClasses:      (fw.offerCriteria && fw.offerCriteria.serviceClasses)      ? [...fw.offerCriteria.serviceClasses]      : [],
    travelClasses:       (fw.offerCriteria && fw.offerCriteria.travelClasses)       ? [...fw.offerCriteria.travelClasses]       : [],
    flexibilities:       (fw.offerCriteria && fw.offerCriteria.flexibilities)       ? [...fw.offerCriteria.flexibilities]       : [],
    offerMode:           (fw.offerCriteria && fw.offerCriteria.offerMode)           || '',
    currency:            (fw.offerCriteria && fw.offerCriteria.currency)            || '',
    fulfillmentTypes:    (fw.fulfillment && fw.fulfillment.types) ? [...fw.fulfillment.types] : ['ETICKET'],
    fulfillmentMedia:    (fw.fulfillment && fw.fulfillment.media) ? [...fw.fulfillment.media] : ['PDF_A4']
  };
}

function renderWizardStep3() {
  const fw = wizData.framework || emptyFramework();
  const sf = fw.salesFlows || ['SALE'];
  const sc = wizScenario;

  const hasType = {
    SALE:     true,    // SALE is always available — it's the basic booking flow
    REFUND:   sf.some(f => f.startsWith('REFUND')),
    EXCHANGE: sf.some(f => f.startsWith('EXCHANGE'))
  };

  const trains = (wizData.resources || []).filter(r => r.resource_type === 'TRAIN');

  // Sub-type options (Full/Partial/IROPS) for REFUND/EXCHANGE
  const subTypeOpts = sc.type !== 'SALE' ? `
  <div class="fw-subsection-label" style="margin-bottom:8px">Operation type</div>
  <div class="sub-type-row">
    ${[
      {v:'FULL',    icon:'💯', lbl:'Full',    desc: sc.type==='REFUND'?'Full reimbursement':'Full rebooking'},
      {v:'PARTIAL', icon:'✂️', lbl:'Partial', desc: sc.type==='REFUND'?'Partial amount':'Partial change'},
      {v:'IROPS',   icon:'⚡', lbl:'IROPS',   desc:'Irregular operations'}
    ].filter(o => sf.includes(`${sc.type}_${o.v}`))
     .map(o => `<div class="sub-type-opt${sc.subType===o.v?' selected':''}" data-action="wiz-sub-type" data-val="${o.v}">
        <div>${o.icon}</div>
        <div style="font-size:12px;font-weight:700;color:#1a2e40;margin-top:4px">${o.lbl}</div>
        <div style="font-size:10px;color:#90a4ae;margin-top:2px">${o.desc}</div>
      </div>`).join('')}
  </div>` : '';

  // Action selector (only for REFUND/EXCHANGE)
  const actionRow = sc.type !== 'SALE' ? `
  <div class="s3-action-row">
    <span style="font-size:12px;font-weight:700;color:#455a64;text-transform:uppercase;letter-spacing:.3px">HTTP Action:</span>
    ${['PATCH','DELETE'].map(a =>
      `<div class="pill${sc.action===a?' selected':''}" data-action="wiz-action" data-val="${a}">${a}</div>`).join('')}
  </div>` : '';

  // Train dropdown
  const trainOpts = trains.length === 0
    ? '<option value="">— No trains defined — go to Step 2 first —</option>'
    : ['<option value="">— Select a train —</option>',
        ...trains.map(t => {
          const d = normalizeTrainData(typeof t.data === 'string' ? JSON.parse(t.data) : (t.data || {}));
          const route = [d.originURN, d.destinationURN].filter(Boolean).join('→');
          const hint = route || `${d.services.length} svc`;
          return `<option value="${esc(t.id)}" ${sc.trainResourceId===t.id?'selected':''}>${esc(t.label||t.id)}${hint?' ('+esc(hint)+')':''}</option>`;
        })].join('');

  // Selected train detail card
  let trainDetail = '';
  if (sc.trainResourceId) {
    const tr = trains.find(t => t.id === sc.trainResourceId);
    if (tr) {
      const d = normalizeTrainData(typeof tr.data === 'string' ? JSON.parse(tr.data) : (tr.data || {}));
      const svcList = d.services.length
        ? d.services.map(s => `${esc(s.vehicleNumber||'?')} ${esc(s.departureTime||'')}→${esc(s.arrivalTime||'')}`).join('<br>')
        : '—';
      trainDetail = `<div class="train-sel-detail open" style="margin-top:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
          <div><span class="param-label">Route</span><br><code style="font-size:11px">${esc(d.originURN||'?')} → ${esc(d.destinationURN||'?')}</code></div>
          <div><span class="param-label">Services (${d.services.length})</span><br><code style="font-size:11px">${svcList}</code></div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#78909c">
          Travel classes: ${(d.travelClasses||[]).join(', ')||'—'} &nbsp;·&nbsp;
          Service classes: ${(d.serviceClasses||[]).join(', ')||'—'}
        </div>
      </div>`;
    }
  }

  // Journey selector (#143) — pick a saved multi-leg journey instead of a single
  // train. When set, the scenario is generated as a SPECIFICATION from the
  // journey's legs, and the single-train controls below are hidden.
  const journeys = (wizData.resources || []).filter(r => r.resource_type === 'JOURNEY');
  const journeyOpts = ['<option value="">— none (use a single train below) —</option>',
    ...journeys.map(j => `<option value="${esc(j.id)}" ${String(sc.journeyResourceId) === String(j.id) ? 'selected' : ''}>${esc(j.label || j.id)} — ${esc(journeySummary(j))}</option>`)
  ].join('');
  const selJourney = sc.journeyResourceId ? journeys.find(j => String(j.id) === String(sc.journeyResourceId)) : null;
  const journeyLegList = selJourney ? journeyData(selJourney).legs.map((leg, i) => {
    const r = journeyResolveLeg(leg);
    return r ? `${i + 1}. ${esc(stnShort(r.d.originURN))}→${esc(stnShort(r.d.destinationURN))} ${esc(r.svc.vehicleNumber || '')}` : `${i + 1}. ?`;
  }).join(' &nbsp; ') : '';
  const journeyDetail = selJourney ? `<div class="train-sel-detail open" style="margin-top:10px">
      <div style="font-size:12px"><span class="param-label">Journey (multi-leg → SPECIFICATION)</span><br><code style="font-size:11px">🧭 ${esc(journeySummary(selJourney))}</code></div>
      <div style="margin-top:6px;font-size:11px;color:#78909c">Legs: ${journeyLegList}</div>
    </div>` : '';

  // Passenger counters — each human type also gets a default-gender picker.
  // The chosen gender is applied to every passenger of that type when the
  // scenario is generated. Per-passenger gender can still be refined later
  // in the scenario detail row.
  const paxRows = Object.entries(sc.passengers).map(([type, count]) => {
    const isHuman = WIZ_HUMAN_PAX_TYPES.includes(type);
    const range = isHuman
      ? ((fw.passengerAgeRanges && fw.passengerAgeRanges[type]) || WIZ_PAX_DEFAULT_AGES[type] || {min:18,max:99})
      : null;
    const ageHint = range ? `Age ${range.min}–${range.max}` : '&nbsp;';
    const abbr = WIZ_PAX_ABBREV[type] || type.slice(0,3);
    // Default to an empty string ("None") when the user hasn't picked a
    // value — the gender field is then omitted entirely from requests,
    // rather than sending an unvalidated default. Existing stored values
    // (MALE, FEMALE, X) still match their corresponding option.
    const g = (sc.passengerGender && sc.passengerGender[type]) || '';
    const genderSelect = isHuman ? `
      <select class="param-input param-select" style="max-width:130px;font-size:12px;margin-right:6px"
        data-action="wiz-pax-gender" data-type="${type}" title="Default gender applied to every ${type.replace(/_/g,' ')} generated — 'None' omits the field from offer requests">
        <option value=""       ${!g                ?'selected':''}>— None (omit) —</option>
        <option value="MALE"   ${g==='MALE'        ?'selected':''}>Male</option>
        <option value="FEMALE" ${g==='FEMALE'      ?'selected':''}>Female</option>
        <option value="X"      ${g==='X'           ?'selected':''}>X (legacy)</option>
      </select>` : '';
    return `<div class="pax-counter-row">
      <span class="pax-counter-label">${type.replace(/_/g,' ')} <small style="font-weight:400;color:#90a4ae;letter-spacing:0">(${abbr})</small></span>
      <span class="pax-counter-age">${ageHint}</span>
      <div class="pax-counter-ctrl">
        ${genderSelect}
        <button class="pax-counter-btn" data-action="wiz-pax" data-type="${type}" data-delta="-1">−</button>
        <span class="pax-counter-val" id="pax-val-${type}">${count}</span>
        <button class="pax-counter-btn" data-action="wiz-pax" data-type="${type}" data-delta="1">+</button>
      </div>
    </div>`;
  }).join('');

  // Offer search criteria are free request filters — a scenario must be able to
  // request ANY OSDM master-list value (incl. travel/service classes the train
  // or system-under-test doesn't support), so non-happy-flow scenarios can be
  // authored (#155). Options are the full enum; the train/framework values are
  // only defaults (seeded into sc.* elsewhere), never a restriction. Union with
  // whatever's already selected as a safety net.
  const availSC = [...new Set([...WIZ_SERVICE_CLASSES, ...(sc.serviceClasses || [])])];
  const availTC = [...new Set([...WIZ_TRAVEL_CLASSES,  ...(sc.travelClasses  || [])])];

  document.getElementById('wizard-body').innerHTML = `
  <p style="color:#546e7a;font-size:13px;line-height:1.6;margin-bottom:4px">
    Configure the scenario parameters. The full data file entry will be generated automatically and added to your test configuration.
  </p>

  <!-- A. Scenario Definition -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">🎯 Scenario Definition<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      <div class="fw-subsection-label" style="margin-bottom:10px">Scenario type</div>
      <div class="scen-type-cards">
        <div class="scen-type-card${sc.type==='SALE'?' selected':''}${!hasType.SALE?' disabled':''}" data-action="wiz-scen-type" data-val="SALE">
          <div class="scen-type-card-icon">🎫</div>
          <div class="scen-type-card-label">Sale</div>
          <div class="scen-type-card-desc">Search, book &amp; fulfil</div>
        </div>
        <div class="scen-type-card${sc.type==='REFUND'?' selected':''}${!hasType.REFUND?' disabled':''}" data-action="wiz-scen-type" data-val="REFUND">
          <div class="scen-type-card-icon">↩️</div>
          <div class="scen-type-card-label">Refund</div>
          <div class="scen-type-card-desc">After-sales reimbursement</div>
        </div>
        <div class="scen-type-card${sc.type==='EXCHANGE'?' selected':''}${!hasType.EXCHANGE?' disabled':''}" data-action="wiz-scen-type" data-val="EXCHANGE">
          <div class="scen-type-card-icon">🔄</div>
          <div class="scen-type-card-label">Exchange</div>
          <div class="scen-type-card-desc">After-sales rebooking</div>
        </div>
      </div>
      ${subTypeOpts}
      ${actionRow}
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">
        <div class="param-field" style="min-width:180px">
          <label class="param-label">Desired flexibility</label>
          <select class="param-input param-select" data-action="wiz-flexibility">
            ${fwFilter(WIZ_FLEXIBILITIES, fw.offerCriteria && fw.offerCriteria.flexibilities).map(f=>`<option value="${esc(f)}" ${sc.desiredFlexibility===f?'selected':''}>${f.replace(/_/g,' ')}</option>`).join('')}
          </select>
        </div>
        ${(() => {
          // Overrule code: only meaningful when the scenario is IROPS. Shown
          // only when the user has picked the IROPS sub-type (which itself is
          // gated by fw.salesFlows including REFUND_IROPS / EXCHANGE_IROPS).
          // Options come from fw.iropsCodes.<type> — not the former hard-coded
          // pair of PAYMENT_FAILURE / DISRUPTION.
          if (sc.subType !== 'IROPS') return '';
          const codes = fwIropsCodesFor(sc.type);
          return `
        <div class="param-field" style="min-width:180px">
          <label class="param-label">Overrule code <span class="param-hint">(IROPS reason)</span></label>
          <select class="param-input param-select" data-action="wiz-overrule">
            <option value="">— none —</option>
            ${codes.map(c => `<option value="${esc(c)}" ${sc.overruleCode===c?'selected':''}>${c.replace(/_/g,' ')}</option>`).join('')}
          </select>
          ${codes.length === 0 ? '<div style="font-size:11px;color:#e65100;margin-top:4px">⚠ No IROPS codes configured in Framework Step 1.</div>' : ''}
        </div>`;
        })()}
      </div>
      <div class="code-preview">
        <span class="code-preview-label">Scenario code:</span>
        <span id="s3-code-preview" style="letter-spacing:.5px">${esc(wizGenCode())}</span>
      </div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <label class="param-label" style="margin:0;min-width:120px">Custom name <span class="param-hint">(optional)</span></label>
        <input class="param-input" type="text" id="wiz-custom-code-input"
          style="flex:1;min-width:240px;font-family:'Consolas','Monaco','Courier New',monospace;letter-spacing:.5px"
          placeholder="Leave empty to use the auto-generated code above"
          value="${esc(sc.customCode || '')}"
          data-action="wiz-custom-code">
      </div>
      <div style="font-size:11px;color:#90a4ae;margin-top:4px;padding-left:130px">
        When filled, this overrides the auto-generated code. Input is normalised to uppercase and underscores.
      </div>
    </div>
  </div>

  <!-- B. Train / Trip -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">🚆 Train / Trip Selection<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      ${journeys.length ? `
      <div class="param-field" style="margin-bottom:12px">
        <label class="param-label">Select a Journey <span class="param-hint">(multi-leg — overrides the single train below)</span></label>
        <select class="param-input param-select" data-action="wiz-select-journey">${journeyOpts}</select>
        ${journeyDetail}
      </div>` : ''}
      ${sc.journeyResourceId ? '' : `
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;flex-wrap:wrap">
        <div>
          <div class="param-label" style="margin-bottom:4px">Trip search mode</div>
          <div style="display:flex;gap:6px">
            <div class="pill${sc.tripType==='SPECIFICATION'?' selected':''}" data-action="wiz-trip-type" data-val="SPECIFICATION" title="Use exact train details (vehicle number, times, route)">📋 SPECIFICATION</div>
            <div class="pill${sc.tripType==='SEARCH'?' selected':''}" data-action="wiz-trip-type" data-val="SEARCH" title="Search by origin/destination/date — train used for route data only">🔍 SEARCH</div>
          </div>
        </div>
        <div style="font-size:11px;color:#90a4ae;max-width:340px;line-height:1.5;align-self:flex-end;padding-bottom:2px">
          ${sc.tripType==='SPECIFICATION'
            ? '📋 <b>SPECIFICATION</b>: exact trip (vehicle, route, times) sent to the API'
            : '🔍 <b>SEARCH</b>: origin/destination/date criteria sent — API finds matching trips'}
        </div>
      </div>
      <div class="param-field">
        <label class="param-label">Select train resource <span class="param-hint">(provides route &amp; time data)</span></label>
        <select class="param-input param-select" id="s3-train-sel" data-action="wiz-select-train">
          ${trainOpts}
        </select>
      </div>
      ${trainDetail}
      ${trains.length===0?`<div style="margin-top:10px;font-size:12px;color:#e65100">⚠️ No trains defined. <a href="#" data-action="goto-section2" style="color:#0090D4">Go to Section 2</a> to add trains first.</div>`:''}

      ${(() => {
        // Determine if the selected train already provides both URNs
        const selTrain = sc.trainResourceId ? trains.find(t => t.id === sc.trainResourceId) : null;
        const td = selTrain ? (typeof selTrain.data==='string'?JSON.parse(selTrain.data):selTrain.data||{}) : {};
        const trainHasOrigin      = !!(td.originURN);
        const trainHasDestination = !!(td.destinationURN);
        const trainHasRoute       = trainHasOrigin && trainHasDestination;

        if (trainHasRoute) {
          // Route is already shown in the train detail card above — no need for extra inputs
          return '';
        }

        // No train selected, or train is missing URN(s): show editable fields
        const needsOrigin      = !trainHasOrigin;
        const needsDestination = !trainHasDestination;
        const isSearch         = sc.tripType === 'SEARCH';

        return `<div style="margin-top:12px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:10px 12px">
          <div style="font-size:11px;color:#e65100;font-weight:700;margin-bottom:8px">
            ⚠ ${selTrain ? 'Selected train has incomplete route data — enter the missing station URN(s)' : 'No train selected — enter station URNs manually'}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            ${needsOrigin ? `<div class="param-field">
              <label class="param-label">Origin station URN${isSearch?' <span style="color:#c62828">*</span>':''}</label>
              <input class="param-input" id="s3-originURN"
                placeholder="urn:uic:stn:8500010"
                value="${esc(sc.originURN||'')}"
                data-action="wiz-origin-urn">
              ${isSearch && !sc.originURN ? '<span style="font-size:10px;color:#e65100">Required for SEARCH</span>' : ''}
            </div>` : `<div></div>`}
            ${needsDestination ? `<div class="param-field">
              <label class="param-label">Destination station URN${isSearch?' <span style="color:#c62828">*</span>':''}</label>
              <input class="param-input" id="s3-destinationURN"
                placeholder="urn:uic:stn:8400058"
                value="${esc(sc.destinationURN||'')}"
                data-action="wiz-dest-urn">
              ${isSearch && !sc.destinationURN ? '<span style="font-size:10px;color:#e65100">Required for SEARCH</span>' : ''}
            </div>` : `<div></div>`}
          </div>
        </div>`;
      })()}
      `}
    </div>
  </div>

  <!-- C. Passengers -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">👥 Passengers<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      <div style="font-size:12px;color:#78909c;margin-bottom:10px">
        First names are prefixed with the passenger type (e.g. <code>ADULT_Marie</code>).
        Date of birth is generated from configured age ranges.
      </div>
      <div class="pax-counter-rows">
        ${paxRows || '<div style="color:#90a4ae;font-size:13px">No passenger types configured in the Test Framework.</div>'}
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid #f0f0f0">
        <div class="fw-subsection-label" style="margin-bottom:8px">👤 Purchaser (auto-generated)</div>
        <div style="font-size:12px;color:#546e7a;background:#f5f8ff;border:1px solid #e3eaf5;border-radius:6px;padding:10px 12px">
          <strong>First name:</strong> Purchaser &nbsp;·&nbsp;
          <strong>Last name:</strong> ${esc(wizProfile.company_name||wizProfile.slug||'Company')} &nbsp;·&nbsp;
          <strong>Email:</strong> ${esc(wizProfile.email||(user&&user.email)||'tester@example.com')}
        </div>
      </div>
    </div>
  </div>

  <!-- D. Offer Search Criteria -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">🔍 Offer Search Criteria<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px">
        <div class="param-field" style="min-width:110px">
          <label class="param-label">Currency</label>
          <input class="param-input" value="${esc(sc.currency||'EUR')}" placeholder="EUR" maxlength="3" style="width:80px;text-transform:uppercase"
            data-action="wiz-currency">
        </div>
        <div class="param-field" style="min-width:160px">
          <label class="param-label">Offer mode <span class="param-hint">(optional)</span></label>
          <select class="param-input param-select" data-action="wiz-offer-mode">
            <option value="" ${!sc.offerMode?'selected':''} style="color:#90a4ae">— none —</option>
            ${WIZ_OFFER_MODES.map(m=>`<option value="${m}" ${sc.offerMode===m?'selected':''}>${m}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="fw-subsection-label" style="margin-bottom:8px">Requested offer parts</div>
      <div class="pill-group" style="margin-bottom:14px">
        ${[...new Set([...WIZ_OFFER_PARTS, ...(sc.requestedOfferParts||[])])].map(p=>`<div class="pill${(sc.requestedOfferParts||[]).includes(p)?' selected':''}" data-action="wiz-scen-array" data-field="requestedOfferParts" data-val="${esc(p)}">${esc(p)}</div>`).join('')}
      </div>
      <div class="fw-subsection-label" style="margin-bottom:8px">Service class</div>
      <div class="pill-group" style="margin-bottom:14px">
        ${availSC.length
          ? availSC.map(c=>`<div class="pill${(sc.serviceClasses||[]).includes(c)?' selected':''}" data-action="wiz-scen-array" data-field="serviceClasses" data-val="${esc(c)}">${c.replace(/_/g,' ')}</div>`).join('')
          : '<span style="font-size:12px;color:#b0bec5">No service classes available — define them in Step 1 or select a train.</span>'}
      </div>
      <div class="fw-subsection-label" style="margin-bottom:8px">Travel class</div>
      <div class="pill-group" style="margin-bottom:14px">
        ${availTC.map(c=>`<div class="pill${(sc.travelClasses||[]).includes(c)?' selected':''}" data-action="wiz-scen-array" data-field="travelClasses" data-val="${esc(c)}">${esc(c)}</div>`).join('')}
      </div>
      <div class="fw-subsection-label" style="margin-bottom:8px">Flexibilities</div>
      <div class="pill-group">
        ${[...new Set([...WIZ_FLEXIBILITIES, ...(sc.flexibilities||[])])].map(f=>`<div class="pill${(sc.flexibilities||[]).includes(f)?' selected':''}" data-action="wiz-scen-array" data-field="flexibilities" data-val="${esc(f)}">${f.replace(/_/g,' ')}</div>`).join('')}
      </div>
    </div>
  </div>

  <!-- E. Fulfillment -->
  <div class="fw-section">
    <div class="fw-section-head open" data-action="fw-toggle">🎟 Fulfillment<span class="fw-toggle-icon">▶</span></div>
    <div class="fw-section-body open">
      <div class="fw-subsection-label" style="margin-bottom:8px">Fulfillment type</div>
      <div class="pill-group" style="margin-bottom:14px">
        ${fwFilter(WIZ_FULFIL_TYPES, fw.fulfillment && fw.fulfillment.types).map(t=>`<div class="pill${(sc.fulfillmentTypes||[]).includes(t)?' selected':''}" data-action="wiz-scen-array" data-field="fulfillmentTypes" data-val="${t}">${t.replace(/_/g,' ')}</div>`).join('')}
      </div>
      <div class="fw-subsection-label" style="margin-bottom:8px">Fulfillment media</div>
      <div class="pill-group">
        ${fwFilter(WIZ_FULFIL_MEDIA, fw.fulfillment && fw.fulfillment.media).map(m=>`<div class="pill${(sc.fulfillmentMedia||[]).includes(m)?' selected':''}" data-action="wiz-scen-array" data-field="fulfillmentMedia" data-val="${m}">${m.replace(/_/g,' ')}</div>`).join('')}
      </div>
    </div>
  </div>

  <!-- Generate -->
  <div style="background:#f5f8ff;border:1px solid #e3eaf5;border-radius:8px;padding:20px;text-align:center">
    <div style="font-size:13px;color:#546e7a;margin-bottom:14px">
      Ready? Click below to generate the scenario and add it to your data file.
    </div>
    ${isTestManager ? `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:12px;justify-content:center">
      <input type="checkbox" id="wiz-shared-checkbox" style="accent-color:#6a1b9a;width:16px;height:16px">
      🔒 Share this scenario with all testers (they can use it but cannot modify it)
    </label>
    ` : ''}
    <button class="btn btn-success" data-action="wiz-generate" id="s3-gen-btn">
      ⚡ Generate &amp; Add Scenario
    </button>
    <div id="s3-gen-status" style="margin-top:12px;font-size:12px"></div>
  </div>
  `;
}

// ── Step 3 interaction helpers ────────────────────────────────────────────────

function reRenderStep3InSection() {
  // Re-render step 3 form into whichever section container it lives in
  const area = document.getElementById('scenario-creator-area');
  if (area && area.innerHTML) {
    renderWizardStep3InSection(area);
  } else {
    const bodyEl = document.getElementById('body-scenarios');
    if (bodyEl) renderWizardStep3InSection(bodyEl);
  }
}

function wizSetScenType(type) {
  wizScenario.type    = type;
  wizScenario.subType = null;
  // Changing the top-level type resets the sub-type, so any stale overrule
  // code carried over from a previous IROPS selection must go too (it would
  // otherwise persist invisibly into a SALE or non-IROPS scenario).
  wizScenario.overruleCode = null;
  if (type === 'SALE') { wizScenario.action = null; }
  else if (!wizScenario.action) { wizScenario.action = 'PATCH'; }
  reRenderStep3InSection();
}

function wizSetSubType(subType) {
  wizScenario.subType = wizScenario.subType === subType ? null : subType;
  // When the user leaves IROPS, any previously selected overrule code is no
  // longer applicable — clear it so we don't persist stale reason codes on
  // a FULL/PARTIAL scenario.
  if (wizScenario.subType !== 'IROPS') {
    wizScenario.overruleCode = null;
  }
  // The overrule-code dropdown is conditionally rendered (subType === 'IROPS'),
  // so a full re-render is required to show/hide it. Pill-only class updates
  // worked before the gating was introduced; they no longer do.
  reRenderStep3InSection();
}

function wizSetAction(action) {
  wizScenario.action = action;
  document.querySelectorAll('.s3-action-row .pill').forEach(p => {
    p.classList.toggle('selected', p.textContent.trim() === action);
  });
  wizUpdateCodePreview();
}

function wizSetTripType(tripType) {
  wizScenario.tripType = tripType;
  reRenderStep3InSection();
}

function wizSelectTrain(id) {
  // HTML select values are always strings; parse to number for integer IDs so that
  // r.id === sc.trainResourceId strict equality works (SQLite IDs are numbers).
  const parsed = id && /^\d+$/.test(id) ? parseInt(id, 10) : (id || null);
  wizScenario.trainResourceId = parsed;
  // Update offer criteria arrays from train data if available
  if (parsed) {
    const tr = (wizData.resources||[]).find(r => r.id === parsed);
    if (tr) {
      const d = typeof tr.data==='string' ? JSON.parse(tr.data) : (tr.data||{});
      if (d.serviceClasses && d.serviceClasses.length) wizScenario.serviceClasses = [...d.serviceClasses];
      if (d.travelClasses  && d.travelClasses.length)  wizScenario.travelClasses  = [...d.travelClasses];
      // Pre-fill origin/destination URNs from train resource (user can still override)
      if (d.originURN)      wizScenario.originURN      = d.originURN;
      if (d.destinationURN) wizScenario.destinationURN = d.destinationURN;
    }
  }
  reRenderStep3InSection();
}

// #143 — pick a saved multi-leg Journey for a new scenario. A journey is always
// a SPECIFICATION; selecting one supersedes the single-train selection.
function wizSelectJourney(id) {
  const parsed = id && /^\d+$/.test(id) ? parseInt(id, 10) : (id || null);
  wizScenario.journeyResourceId = parsed;
  if (parsed) {
    wizScenario.tripType = 'SPECIFICATION';
    wizScenario.trainResourceId = null;
  }
  reRenderStep3InSection();
}

function wizAdjustPax(type, delta) {
  const cur = wizScenario.passengers[type] || 0;
  wizScenario.passengers[type] = Math.max(0, cur + delta);
  const el = document.getElementById(`pax-val-${type}`);
  if (el) el.textContent = wizScenario.passengers[type];
  wizUpdateCodePreview();
}

function wizToggleScenArray(field, value, el) {
  if (!wizScenario[field]) wizScenario[field] = [];
  const arr = wizScenario[field];
  const idx = arr.indexOf(value);
  if (idx === -1) { arr.push(value); el.classList.add('selected'); }
  else            { arr.splice(idx, 1); el.classList.remove('selected'); }
}

function wizUpdateCodePreview() {
  const el = document.getElementById('s3-code-preview');
  if (el) el.textContent = wizGenCode();
}

// Normalise a user-typed scenario name into a safe code: uppercase, strip
// anything outside [A-Z0-9_], collapse consecutive underscores, trim leading /
// trailing underscores. Keeps the scenario code usable as a folder / filename
// component without forcing the user to type in that format.
function wizNormaliseCustomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function wizGenCode() {
  const sc = wizScenario;
  if (!sc || !sc.type) return '— configure above —';

  // Custom name takes precedence when the user has typed one. Normalised to
  // the same A-Z0-9_ shape the auto-generator produces, so nothing downstream
  // has to special-case it.
  if (sc.customCode) {
    const normalised = wizNormaliseCustomCode(sc.customCode);
    if (normalised) return normalised;
  }

  const slug    = ((wizProfile.slug||'XXX').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,3)).padEnd(3,'X');
  const typeMap = { SALE:'SALE', REFUND:'RFND', EXCHANGE:'XCH' };
  const typePart = typeMap[sc.type] || sc.type;
  const actionPart = sc.type !== 'SALE' && sc.action ? sc.action : null;

  // Passenger counts per type
  const paxParts = [];
  Object.entries(sc.passengers || {}).forEach(([type, count]) => {
    if (count > 0) {
      paxParts.push(`${count}${WIZ_PAX_ABBREV[type] || type.slice(0,3)}`);
    }
  });
  const paxStr = paxParts.length > 0 ? paxParts.join('_') : '1PAX';
  // TODO: encode actual leg count once multi-leg scenarios are supported.
  // Currently always 1 — Sonar S3923 simplified.
  const legStr = '1LEG';

  return [slug, typePart, actionPart, paxStr, legStr].filter(Boolean).join('_');
}

function randomPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function genPhone() { return '+' + Array.from({length:10}, () => Math.floor(Math.random()*10)).join(''); }

function genDateOfBirth(minAge, maxAge) {
  const today   = new Date();
  const minYear = today.getFullYear() - maxAge;
  const maxYear = today.getFullYear() - minAge;
  const year  = minYear + Math.floor(Math.random() * (maxYear - minYear + 1));
  const month = 1 + Math.floor(Math.random() * 12);
  const day   = 1 + Math.floor(Math.random() * 28); // safe for all months
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function wizGenPassengers() {
  const fw    = wizData.framework || emptyFramework();
  const sc    = wizScenario;
  const passengers = [];
  let refNum = 1;

  Object.entries(sc.passengers || {}).forEach(([category, count]) => {
    for (let i = 0; i < count; i++) {
      // OSDM type: ADULT/CHILD/YOUTH/etc. → PERSON (age differentiated by dateOfBirth)
      const osdmType   = WIZ_PAX_TO_OSDM_TYPE[category] || 'PERSON';
      const isHuman    = WIZ_HUMAN_PAX_TYPES.includes(category);
      const firstName  = randomPick(WIZ_RANDOM_FIRST_NAMES);
      const lastName   = randomPick(WIZ_RANDOM_LAST_NAMES);
      const companySlug = (wizProfile.slug || wizProfile.company_name || 'company').toLowerCase().replace(/[^a-z0-9]/g, '');
      const paxEmail   = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${companySlug}.com`;
      const paxPhone   = genPhone();

      const pax = {
        reference:   `PAX${refNum++}`,       // required by schema
        type:        osdmType,
        phoneNumber: paxPhone,
        email:       paxEmail
      };

      if (isHuman) {
        // Apply the per-type default gender chosen in the wizard. Empty
        // string or null means "None" — omit the gender field entirely so
        // library-bruno's passenger-spec builders don't include it in the
        // offer / booking / PATCH requests (they already skip null fields
        // via their existing `!= null` guards). Otherwise use the chosen
        // value for both gender and updateGender so aftersales PATCH flows
        // stay consistent.
        const rawDefault = sc.passengerGender && sc.passengerGender[category];
        const defaultGender = rawDefault || null;
        pax.firstName   = firstName;
        pax.lastName    = lastName;
        if (defaultGender) pax.gender = defaultGender;   // omitted when null
        const range = (fw.passengerAgeRanges && fw.passengerAgeRanges[category])
          || WIZ_PAX_DEFAULT_AGES[category] || { min: 18, max: 99 };
        pax.dateOfBirth       = genDateOfBirth(range.min, range.max);
        // Update fields — needed for PATCH passenger requests in aftersales scenarios
        const updFirstName    = randomPick(WIZ_RANDOM_FIRST_NAMES);
        const updLastName     = randomPick(WIZ_RANDOM_LAST_NAMES);
        pax.updateFirstName   = updFirstName;
        pax.updateLastName    = updLastName;
        pax.updateDateOfBirth = genDateOfBirth(range.min, range.max);
        pax.updatePhoneNumber = genPhone();
        pax.updateEmail       = `${updFirstName.toLowerCase()}.${updLastName.toLowerCase()}@${companySlug}.com`;
        if (defaultGender) pax.updateGender = defaultGender;  // omitted when null
      }
      passengers.push(pax);
    }
  });

  const purchFirstName = randomPick(WIZ_RANDOM_FIRST_NAMES);
  const purchLastName  = randomPick(WIZ_RANDOM_LAST_NAMES);
  const purchSlug      = (wizProfile.slug || wizProfile.company_name || 'company').toLowerCase().replace(/[^a-z0-9]/g, '');
  const purchaser = {
    firstName: purchFirstName,
    lastName:  purchLastName,
    email:     `${purchFirstName.toLowerCase()}.${purchLastName.toLowerCase()}@${purchSlug}.com`,
    phone:     genPhone()
  };

  return { passengers, purchaser };
}

async function wizGenerateScenario() {
  const sc = wizScenario;
  const fw = wizData.framework || emptyFramework();

  if (!sc.type) { alert('Please select a scenario type.'); return; }
  const totalPax = Object.values(sc.passengers || {}).reduce((s, n) => s + n, 0);
  if (totalPax === 0) { alert('Please add at least one passenger.'); return; }

  const btn      = document.getElementById('s3-gen-btn');
  const statusEl = document.getElementById('s3-gen-status');
  if (btn)      { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
  if (statusEl) statusEl.innerHTML = '';

  try {
    const code = wizGenCode();

    // ── 1. Load existing data file first (needed to compute sequential integer IDs) ──
    let dataFile = null;
    try {
      const dfRes = await fetch('/v1/company/datafile', {});
      if (dfRes.ok) dataFile = await dfRes.json();
    } catch(_) {}

    if (!dataFile) {
      dataFile = {
        osdmVersion:    fw.osdmVersion || '3.4',
        collection:     'OTST_V2.0.1_RFND_EXCH_ALL',
        scenariosToRun: [],
        scenarios:      [],
        tripRequirements: [],
        passengersList:   [],
        purchaserList:    [],
        requestedFulfillmentOptionsList: []
      };
    }

    // ── 2. Sequential INTEGER IDs — required by OSDM data file schema ────────────
    let nextId = (() => {
      const ids = [
        ...(dataFile.scenarios||[]).flatMap(s => [
          s.tripRequirementId, s.passengersListId, s.purchaserListId,
          s.requestedFulfillmentOptionsListId]),
        ...(dataFile.tripRequirements||[]).map(t => t.id),
        ...(dataFile.passengersList||[]).map(p => p.id),
        ...(dataFile.purchaserList||[]).map(p => p.id),
        ...(dataFile.requestedFulfillmentOptionsList||[]).map(f => f.id),
      ].filter(id => typeof id === 'number' && !isNaN(id));
      return (ids.length > 0 ? Math.max(...ids) : 0) + 1;
    })();
    const tripId      = nextId++;
    const paxListId   = nextId++;
    const purchListId = nextId++;
    const fulfListId  = nextId++;

    // ── 3. Generate passengers (with OSDM types + required fields) ───────────────
    const { passengers, purchaser } = wizGenPassengers();

    // ── 4. Trip requirement ───────────────────────────────────────────────────────
    // Each leg/trip needs productCategoryRef/Name/ShortName (Bruno library reads .length on these)
    // Trip data comes from the selected train resource (if any); tripType is user-chosen.
    let tripReq;
    const trainRes = sc.trainResourceId
      ? (wizData.resources||[]).find(r => r.id === sc.trainResourceId)
      : null;
    const d = trainRes ? normalizeTrainData(typeof trainRes.data==='string'?JSON.parse(trainRes.data):trainRes.data||{}) : {};
    // A train set may carry several services (timetable, #136); the wizard uses
    // the first one. Per-service selection is available in the trip editor's
    // "Apply test data" picker.
    const svc0 = (d.services && d.services[0]) || {};

    // #143 — a selected Journey supersedes the single train: build a multi-leg
    // SPECIFICATION from its legs (origin/dest/times/vehicle/operator + product
    // category resolved per leg from each train set).
    const journey = sc.journeyResourceId
      ? (wizData.resources||[]).find(r => String(r.id) === String(sc.journeyResourceId) && r.resource_type === 'JOURNEY')
      : null;

    // Resolve origin/destination: wizard override → train resource → framework → empty
    const resolvedOrigin      = sc.originURN      || d.originURN      || fw.originURN      || '';
    const resolvedDestination = sc.destinationURN || d.destinationURN || fw.destinationURN || '';

    // Validate: SEARCH requires non-empty origin and destination (a journey carries its own legs)
    if (!journey && sc.tripType === 'SEARCH' && (!resolvedOrigin || !resolvedDestination)) {
      const missing = [!resolvedOrigin && 'Origin', !resolvedDestination && 'Destination'].filter(Boolean).join(' and ');
      if (statusEl) statusEl.innerHTML = `<span style="color:#c62828">⚠ SEARCH mode requires ${esc(missing)} station URN(s). Please fill them in the Train/Trip section above.</span>`;
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Generate & Add Scenario'; }
      return;
    }

    if (journey) {
      const journeyLegs = journeyToTripLegs(journey);
      if (journeyLegs.length === 0) {
        if (statusEl) statusEl.innerHTML = `<span style="color:#c62828">⚠ The selected journey has no legs. Add legs to it under Test Data → Journeys.</span>`;
        if (btn) { btn.disabled = false; btn.textContent = '⚡ Generate & Add Scenario'; }
        return;
      }
      tripReq = { id: tripId, tripType: 'SPECIFICATION', legs: journeyLegs };
    } else if (sc.tripType === 'SPECIFICATION') {
      tripReq = {
        id: tripId,
        tripType: 'SPECIFICATION',
        legs: [{
          origin:                   resolvedOrigin,
          destination:              resolvedDestination,
          startDatetime:            `%TRIP_DATE%T${svc0.departureTime || '07:00:00+01:00'}`,
          endDatetime:              `%TRIP_DATE%T${svc0.arrivalTime   || '09:00:00+01:00'}`,
          productCategoryRef:       d.productCategoryRef       || '',
          productCategoryName:      d.productCategoryName      || '',
          productCategoryShortName: d.productCategoryShortName || '',
          vehicleNumber:            svc0.vehicleNumber || '',
          operatorCode:             d.operatorCode  || ''
        }]
      };
    } else {
      // SEARCH — use resolved origin/destination/times
      tripReq = {
        id: tripId,
        tripType: 'SEARCH',
        trip: {
          origin:                   resolvedOrigin,
          destination:              resolvedDestination,
          startDatetime:            svc0.departureTime  ? `%TRIP_DATE%T${svc0.departureTime}` : '%TRIP_DATE%T07:00:00+01:00',
          endDatetime:              svc0.arrivalTime    ? `%TRIP_DATE%T${svc0.arrivalTime}`   : '%TRIP_DATE%T09:00:00+01:00',
          productCategoryRef:       d.productCategoryRef       || '',
          productCategoryName:      d.productCategoryName      || '',
          productCategoryShortName: d.productCategoryShortName || '',
          vehicleNumber:            svc0.vehicleNumber || '',
          operatorCode:             d.operatorCode  || ''
        }
      };
    }

    // ── 5. Scenario object — keep null fields present (required by schema) ───────
    const scenario = {
      collection:          'OTST_V2.0.1_RFND_EXCH_ALL',
      loggingType:         'INFO',
      code,
      scenarioType:        sc.type,
      scenarioAction:      sc.type !== 'SALE' ? (sc.action || 'PATCH') : null,
      osdmVersion:         fw.osdmVersion || '3.4',
      desiredFlexibility:  sc.desiredFlexibility || 'FULL_FLEXIBLE',
      overruleCode:        sc.overruleCode || null,
      // Booking-flow action map for every scenario that has a booking phase
      // (SALE runs it stand-alone; REFUND and EXCHANGE run it as a prelude to
      // their aftersales operations). library-bruno reads the flags in
      // scenarioParser and decides which steps to execute between POST
      // /bookings and POST /fulfillments. All-enabled by default; users
      // narrow via the pills in the detail panel.
      salesFlowActions: defaultSalesFlowActions(),
      // Seat-selection mode (issue #107) — null until the author enables Place
      // selection and picks a framework-supported mode in the detail panel.
      placeSelectionMode: null,
      ...(sc.type === 'REFUND' ? { refundDate: null } : {}),
      tripRequirementId:                tripId,
      passengersListId:                 paxListId,
      purchaserListId:                  purchListId,
      requestedFulfillmentOptionsListId:fulfListId,
      shared: isTestManager ? (document.getElementById('wiz-shared-checkbox')?.checked || false) : false,
      created_by: user.email || '',
      version: '1.0',
      // Offer search criteria — inline on scenario.
      //
      // Per OSDM spec, every offer-search criterion is OPTIONAL. The Bruno
      // collection respects this: when offerSearchCriteria is present (even
      // empty), each field is only sent if explicitly set. We therefore
      // include ONLY fields the user actually picked in the wizard. An empty
      // object is intentional — it tells Bruno "scenario was authored, send
      // nothing in offer criteria". (Without the object, Bruno hits its
      // legacy fallback and injects EUR / INDIVIDUAL / [ADMISSION,RESERVATION]
      // for backward compat with very old datafiles.)
      offerSearchCriteria: (function buildCriteria() {
        const c = {};
        if (Array.isArray(sc.requestedOfferParts) && sc.requestedOfferParts.length) c.requestedOfferParts = sc.requestedOfferParts;
        if (sc.currency)                                                              c.currency            = sc.currency;
        if (Array.isArray(sc.serviceClasses) && sc.serviceClasses.length)             c.serviceClass        = sc.serviceClasses;
        if (Array.isArray(sc.travelClasses)  && sc.travelClasses.length)              c.travelClass         = sc.travelClasses;
        if (Array.isArray(sc.flexibilities)  && sc.flexibilities.length)              c.flexibilities       = sc.flexibilities;
        if (sc.offerMode)                                                             c.offerMode           = sc.offerMode;
        return c;
      })()
      // Note: purchaserListId is NOT in scenario (purchaserList is referenced separately)
    };

    // ── 6. Ancillary list objects ─────────────────────────────────────────────────
    const passengersList = { id: paxListId, passengers };
    // purchaserList uses Bruno-expected field names
    const purchaserList  = {
      id: purchListId,
      purchaser: [{
        purchaserFirstName:   purchaser.firstName,
        purchaserLastName:    purchaser.lastName,
        purchaserPhoneNumber: purchaser.phone,
        purchaserEmail:       purchaser.email
      }]
    };
    const requestedFulfillmentOptionsList = {
      id: fulfListId,
      requestedFulfillmentOptions: (sc.fulfillmentTypes||['ETICKET']).map(type => ({
        fulfillmentType:  type,
        fulfillmentMedia: (sc.fulfillmentMedia||['PDF_A4'])[0] || 'PDF_A4'
      }))
    };

    // ── 7. Duplicate-code guard ───────────────────────────────────────────────────
    if ((dataFile.scenarios||[]).some(s => s.code === code)) {
      if (!confirm(`Scenario code "${code}" already exists in the data file. Add a duplicate anyway?`)) {
        if (btn) { btn.disabled = false; btn.textContent = '⚡ Generate & Add Scenario'; }
        return;
      }
    }

    // ── 8. Append ─────────────────────────────────────────────────────────────────
    (dataFile.scenarios                       = dataFile.scenarios                       || []).push(scenario);
    (dataFile.scenariosToRun                  = dataFile.scenariosToRun                  || []).push(code);
    (dataFile.tripRequirements                = dataFile.tripRequirements                || []).push(tripReq);
    (dataFile.passengersList                  = dataFile.passengersList                  || []).push(passengersList);
    (dataFile.purchaserList                   = dataFile.purchaserList                   || []).push(purchaserList);
    (dataFile.requestedFulfillmentOptionsList = dataFile.requestedFulfillmentOptionsList || []).push(requestedFulfillmentOptionsList);

    // ── 9. Save ───────────────────────────────────────────────────────────────────
    const saveRes = await fetch('/v1/company/datafile/json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dataFile)
    });

    if (!saveRes.ok) {
      const err = await saveRes.json().catch(() => ({}));
      throw new Error(err.detail || err.title || `HTTP ${saveRes.status}`);
    }

    // ── 10. Success — auto-refresh so the new scenario appears immediately ─────
    await refreshAllSections();

    if (statusEl) {
      statusEl.innerHTML =
        `<span style="color:#2e7d32;font-weight:700">✅ Scenario <code>${esc(code)}</code> added and saved!</span>
        &nbsp;·&nbsp;
        <a href="#" data-action="create-another" style="color:#0090D4;font-size:12px">
          ➕ Create another</a>`;
    }
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Generate & Add Scenario'; }

  } catch(e) {
    if (statusEl) statusEl.innerHTML = `<span style="color:#c62828">⚠️ Error: ${esc(e.message)}</span>`;
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Generate & Add Scenario'; }
  }
}

// ── Event Delegation ─────────────────────────────────────────────────────────
// Single delegation block for all data-action handlers (replaces inline handlers)

function findAction(target) {
  let el = target;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.action) return el;
    el = el.parentElement;
  }
  return null;
}

document.body.addEventListener('click', function(e) {
  const el = findAction(e.target);
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    // ── Static / section actions ──────────────────────────────────────────────
    case 'download-json':
      downloadJson(); break;
    case 'save-datafile':
      saveDatafile(); break;
    case 'toggle-section':
      toggleSection(el.dataset.section); break;
    case 'toggle-param-section': {
      const body  = el.nextElementSibling;
      const arrow = el.querySelector('.ps-arrow');
      if (body) body.classList.toggle('open');
      if (arrow) arrow.classList.toggle('open');
      break;
    }
    case 'delete-framework':
      e.stopPropagation(); deleteFramework(); break;
    case 'delete-all-test-data':
      e.stopPropagation(); deleteAllTestData(); break;
    case 'delete-all-scenarios':
      e.stopPropagation(); deleteAllScenarios(); break;
    case 'create-framework':
      wizData.framework = emptyFramework(); renderWizardStep1InSection(); toggleSection('framework'); break;
    case 'save-framework':
      saveFrameworkFromSection(); break;
    case 'add-train-section':
      renderWizardStep2InSection(); toggleSection('data'); break;
    case 'open-scenario-creator':
      openScenarioCreator(); break;
    case 'select-all':
      selectAll(el.dataset.checked === 'true'); break;
    case 'delete-datafile':
      deleteDatafile(); break;

    // ── Scenario list actions ─────────────────────────────────────────────────
    case 'toggle-detail':
      toggleDetail(parseInt(el.dataset.idx)); break;
    case 'delete-scenario':
      e.stopPropagation(); deleteScenario(parseInt(el.dataset.idx)); break;
    case 'add-pax': {
      e.stopPropagation();
      const pIdx = parseInt(el.dataset.pidx);
      const scIdx = parseInt(el.dataset.scenidx);
      const typeSelect = document.getElementById(`add-pax-type-${esc(pIdx)}`);
      const category = typeSelect ? typeSelect.value : 'ADULT';
      const osdmType = WIZ_PAX_TO_OSDM_TYPE[category] || 'PERSON';
      const isHuman = WIZ_HUMAN_PAX_TYPES.includes(category);
      const paxList = state.passengersList[pIdx];
      if (!paxList || !paxList.passengers) break;
      const companySlug = (wizProfile.slug || wizProfile.company_name || 'company').toLowerCase().replace(/[^a-z0-9]/g, '');
      const fn = randomPick(WIZ_RANDOM_FIRST_NAMES);
      const ln = randomPick(WIZ_RANDOM_LAST_NAMES);
      const ageRange = WIZ_PAX_DEFAULT_AGES[category] || { min: 18, max: 99 };
      // Newly-added passenger has no gender by default ("None"). The user
      // explicitly picks one via the dropdown in the row — at which point
      // set-pax sets the field. Omitting from the initial object means the
      // data file JSON does not carry `gender: "X"` until the user asks for it.
      const newPax = {
        reference: `PAX${paxList.passengers.length + 1}`,
        type: osdmType,
        category: category,
        firstName: fn,
        lastName: ln,
        dateOfBirth: isHuman ? genDateOfBirth(ageRange.min, ageRange.max) : '',
        email: `${fn.toLowerCase()}.${ln.toLowerCase()}@${companySlug}.com`,
        phoneNumber: genPhone(),
        updateFirstName: randomPick(WIZ_RANDOM_FIRST_NAMES),
        updateLastName: randomPick(WIZ_RANDOM_LAST_NAMES),
        updateDateOfBirth: isHuman ? genDateOfBirth(ageRange.min, ageRange.max) : '',
        updatePhoneNumber: genPhone(),
        updateEmail: `updated@${companySlug}.com`
      };
      paxList.passengers.push(newPax);
      markDirty();
      // Re-render the detail for this scenario
      const detail = document.getElementById(`detail-${esc(scIdx)}`);
      if (detail && detail.innerHTML) {
        detail.innerHTML = buildDetailHTML(scIdx);
        // Re-open the passengers section
        detail.querySelectorAll('.param-section-body').forEach(b => b.classList.remove('open'));
        detail.querySelectorAll('.ps-arrow').forEach(a => a.classList.remove('open'));
        const sections = detail.querySelectorAll('.param-section-head');
        sections.forEach(h => {
          if (h.textContent.includes('Passengers')) {
            h.nextElementSibling?.classList.add('open');
            h.querySelector('.ps-arrow')?.classList.add('open');
          }
        });
      }
      break;
    }
    case 'change-pax-category': {
      // Handled in change delegation below
      break;
    }
    case 'toggle-pax-edit': {
      e.stopPropagation();
      const tpIdx = parseInt(el.dataset.pidx);
      const tpPi  = parseInt(el.dataset.pi);
      const key   = tpIdx + ':' + tpPi;
      const panel = document.getElementById('pax-edit-' + tpIdx + '-' + tpPi);
      const row   = panel && panel.previousElementSibling;
      const nowOpen = _paxEditOpen.has(key) ? false : true;
      if (nowOpen) _paxEditOpen.add(key); else _paxEditOpen.delete(key);
      if (panel) panel.style.display = nowOpen ? 'block' : 'none';
      if (el)    el.textContent = nowOpen ? 'Edit ▴' : 'Edit ▾';
      if (row)   row.style.borderBottom = nowOpen ? 'none' : '1px solid #f0f0f0';
      break;
    }
    case 'add-pax-reduction': {
      e.stopPropagation();
      const arIdx = parseInt(el.dataset.pidx);
      const arPi  = parseInt(el.dataset.pi);
      const arList = state.passengersList[arIdx];
      const arPax  = arList && arList.passengers && arList.passengers[arPi];
      if (!arPax) break;
      if (!Array.isArray(arPax.reductionCards)) arPax.reductionCards = [];
      arPax.reductionCards.push('');
      markDirty();
      // Append the new row just before the "+ Add" button so indexes stay contiguous.
      const container = document.getElementById('pax-reductions-' + arIdx + '-' + arPi);
      if (container) {
        const tmp = document.createElement('div');
        tmp.innerHTML = buildReductionCardRow(arIdx, arPi, arPax.reductionCards.length - 1, '', false);
        const newRow = tmp.firstElementChild;
        const addBtn = container.querySelector('[data-action="add-pax-reduction"]');
        container.insertBefore(newRow, addBtn);
        // Focus the new input so the user can start typing immediately.
        const input = newRow.querySelector('input[data-action="set-pax-reduction"]');
        if (input) input.focus();
      }
      break;
    }
    case 'remove-pax-reduction': {
      e.stopPropagation();
      const rrIdx = parseInt(el.dataset.pidx);
      const rrPi  = parseInt(el.dataset.pi);
      const rrCi  = parseInt(el.dataset.cidx);
      const rrList = state.passengersList[rrIdx];
      const rrPax  = rrList && rrList.passengers && rrList.passengers[rrPi];
      if (!rrPax || !Array.isArray(rrPax.reductionCards)) break;
      rrPax.reductionCards.splice(rrCi, 1);
      markDirty();
      // Rebuild the card list for this passenger to keep data-cidx values
      // contiguous with the underlying array indices.
      const container = document.getElementById('pax-reductions-' + rrIdx + '-' + rrPi);
      if (container) {
        container.innerHTML = rrPax.reductionCards.map((code, ci) =>
          buildReductionCardRow(rrIdx, rrPi, ci, code, false)
        ).join('') + `<button class="btn btn-sm btn-secondary" data-action="add-pax-reduction" data-pidx="${rrIdx}" data-pi="${rrPi}" style="font-size:11px;margin-top:6px">➕ Add reduction card</button>`;
      }
      break;
    }
    case 'add-pax-loyalty': {
      e.stopPropagation();
      const alIdx = parseInt(el.dataset.pidx);
      const alPi  = parseInt(el.dataset.pi);
      const alList = state.passengersList[alIdx];
      const alPax  = alList && alList.passengers && alList.passengers[alPi];
      if (!alPax) break;
      if (!Array.isArray(alPax.loyaltyCards)) alPax.loyaltyCards = [];
      alPax.loyaltyCards.push({ carrierCode: '', cardReference: '' });
      markDirty();
      const container = document.getElementById('pax-loyalties-' + alIdx + '-' + alPi);
      if (container) {
        const tmp = document.createElement('div');
        tmp.innerHTML = buildLoyaltyCardRow(alIdx, alPi, alPax.loyaltyCards.length - 1, {}, false);
        const newRow = tmp.firstElementChild;
        const addBtn = container.querySelector('[data-action="add-pax-loyalty"]');
        container.insertBefore(newRow, addBtn);
        const input = newRow.querySelector('input[data-field="carrierCode"]');
        if (input) input.focus();
      }
      break;
    }
    case 'remove-pax-loyalty': {
      e.stopPropagation();
      const rlIdx = parseInt(el.dataset.pidx);
      const rlPi  = parseInt(el.dataset.pi);
      const rlCi  = parseInt(el.dataset.cidx);
      const rlList = state.passengersList[rlIdx];
      const rlPax  = rlList && rlList.passengers && rlList.passengers[rlPi];
      if (!rlPax || !Array.isArray(rlPax.loyaltyCards)) break;
      rlPax.loyaltyCards.splice(rlCi, 1);
      markDirty();
      const container = document.getElementById('pax-loyalties-' + rlIdx + '-' + rlPi);
      if (container) {
        container.innerHTML = rlPax.loyaltyCards.map((card, ci) =>
          buildLoyaltyCardRow(rlIdx, rlPi, ci, card, false)
        ).join('') + `<button class="btn btn-sm btn-secondary" data-action="add-pax-loyalty" data-pidx="${rlIdx}" data-pi="${rlPi}" style="font-size:11px;margin-top:6px">➕ Add loyalty card</button>`;
      }
      break;
    }
    case 'remove-pax': {
      e.stopPropagation();
      const rpIdx = parseInt(el.dataset.pidx);
      const rpPi = parseInt(el.dataset.pi);
      const rpList = state.passengersList[rpIdx];
      if (!rpList || !rpList.passengers || rpList.passengers.length <= 1) break;
      if (!confirm(`Remove passenger ${rpPi + 1}?`)) break;
      rpList.passengers.splice(rpPi, 1);
      // When a passenger is removed, drop its stale Edit-open entry so the
      // remaining passengers don't inherit an expanded state at their index.
      _paxEditOpen.delete(rpIdx + ':' + rpPi);
      // Re-number references
      rpList.passengers.forEach((p, i) => p.reference = `PAX${i + 1}`);
      markDirty();
      // Find which scenario detail is open and re-render
      document.querySelectorAll('.scenario-detail').forEach(det => {
        if (det.innerHTML && det.id.startsWith('detail-')) {
          const sIdx = parseInt(det.id.replace('detail-', ''));
          const sc = state.scenarios[sIdx];
          if (sc && sc.passengersListId === rpList.id) {
            det.innerHTML = buildDetailHTML(sIdx);
            det.querySelectorAll('.param-section-body').forEach(b => b.classList.remove('open'));
            det.querySelectorAll('.ps-arrow').forEach(a => a.classList.remove('open'));
            det.querySelectorAll('.param-section-head').forEach(h => {
              if (h.textContent.includes('Passengers')) {
                h.nextElementSibling?.classList.add('open');
                h.querySelector('.ps-arrow')?.classList.add('open');
              }
            });
          }
        }
      });
      break;
    }
    case 'toggle-shared': {
      e.stopPropagation();
      const sIdx = parseInt(el.dataset.idx);
      const sc = state.scenarios[sIdx];
      if (sc) {
        sc.shared = !sc.shared;
        if (sc.shared && !sc.created_by) sc.created_by = user.email || '';
        if (sc.shared && !sc.version) sc.version = '1.0';
        markDirty();
        renderAll();
      }
      break;
    }
    case 'toggle-sales-action': {
      e.stopPropagation();
      const tsaIdx = parseInt(el.dataset.idx);
      const key = el.dataset.key;
      const sc = state.scenarios[tsaIdx];
      if (!sc || !key) break;
      if (!sc.salesFlowActions || typeof sc.salesFlowActions !== 'object') {
        sc.salesFlowActions = defaultSalesFlowActions();
      }
      // Explicit flip: true ↔ false. Anything else (undefined, null) is
      // treated as false for the toggle purpose and becomes true.
      sc.salesFlowActions[key] = sc.salesFlowActions[key] !== true;
      el.classList.toggle('selected', sc.salesFlowActions[key]);
      markDirty();
      break;
    }
    case 'set-place-mode': {
      // Single-select seat-selection mode (issue #107). Constrained at render
      // time to the framework's supported modes.
      e.stopPropagation();
      const spmIdx = parseInt(el.dataset.idx);
      const spmSc = state.scenarios[spmIdx];
      if (!spmSc) break;
      spmSc.placeSelectionMode = el.dataset.val;
      const grp = el.parentElement;
      if (grp) grp.querySelectorAll('.pill').forEach(p => p.classList.toggle('selected', p === el));
      markDirty();
      break;
    }
    case 'duplicate-scenario': {
      e.stopPropagation();
      const dupIdx = parseInt(el.dataset.idx);
      const original = state.scenarios[dupIdx];
      if (!original) break;

      const copy = JSON.parse(JSON.stringify(original));
      // Unique scenario code — keep appending _COPY / _COPY_COPY until we
      // find one not already used. Prevents silent duplicate collisions
      // that would then break scenariosToRun indexing.
      let newCode = original.code + '_COPY';
      while (state.scenarios.some(s => s.code === newCode)) newCode += '_COPY';
      copy.code = newCode;
      copy.shared = false;
      copy.created_by = user.email || '';
      copy.version = '1.0';

      // Allocate a fresh numeric id for each referenced list and deep-clone
      // the source list record. Without this the copy would point at the
      // same trip / passengers / purchaser / fulfillment records as the
      // original, so editing one would silently mutate the other — a
      // classic aliasing bug in the earlier duplicate implementation.
      const maxId = (arr) => (arr && arr.length)
        ? Math.max(...arr.map(x => x && typeof x.id === 'number' ? x.id : 0))
        : 0;
      let nextId = Math.max(
        maxId(state.tripRequirements),
        maxId(state.passengersList),
        maxId(state.purchaserList),
        maxId(state.requestedFulfillmentOptionsList)
      ) + 1;

      function cloneListEntry(arrName, sourceId) {
        const arr = state[arrName] = state[arrName] || [];
        const src = arr.find(x => x && x.id === sourceId);
        if (!src) return null;
        const clone = JSON.parse(JSON.stringify(src));
        clone.id = nextId++;
        arr.push(clone);
        return clone.id;
      }

      const newTripId  = cloneListEntry('tripRequirements',  original.tripRequirementId);
      const newPaxId   = cloneListEntry('passengersList',    original.passengersListId);
      const newPurchId = cloneListEntry('purchaserList',     original.purchaserListId);
      const newFulfId  = cloneListEntry('requestedFulfillmentOptionsList', original.requestedFulfillmentOptionsListId);
      if (newTripId  != null) copy.tripRequirementId                 = newTripId;
      if (newPaxId   != null) copy.passengersListId                  = newPaxId;
      if (newPurchId != null) copy.purchaserListId                   = newPurchId;
      if (newFulfId  != null) copy.requestedFulfillmentOptionsListId = newFulfId;

      state.scenarios.push(copy);
      markDirty();
      renderAll();
      break;
    }

    // ── Framework wizard (Step 1) ─────────────────────────────────────────────
    // All fw-* actions that mutate wizData.framework trigger saveFrameworkDebounced()
    // so the state is persisted without the user needing to click "💾 Save Framework".
    // The fw-toggle action (expand/collapse header) is the only exception — it's
    // purely visual and never touches the model.
    case 'fw-toggle':
      fwToggle(el); break;
    case 'fw-toggle-irops':
      fwToggleIrops(el.dataset.type, el.dataset.code, el); saveFrameworkDebounced(); break;
    case 'fw-toggle-aftersales':
      fwToggleAfterSales(el.dataset.val); saveFrameworkDebounced(); break;
    case 'fw-pill':
      fwTogglePill(el, el.dataset.mode, el.dataset.group, el.dataset.val); saveFrameworkDebounced(); break;
    case 'fw-pax-type':
      fwTogglePaxType(el, el.dataset.val); saveFrameworkDebounced(); break;
    case 'fw-ancillary':
      fwToggleSimplePill(el, 'ancillaries', el.dataset.val); saveFrameworkDebounced(); break;
    case 'fw-remove-ancillary':
      fwRemoveAncillary(el.dataset.val); break;
    case 'fw-add-ancillary':
      fwAddCustomAncillary(); break;

    // ── Pill toggle (simple self-toggle) ──────────────────────────────────────
    case 'pill-toggle':
      el.classList.toggle('selected'); break;

    // ── Train resource actions (Step 2) ───────────────────────────────────────
    case 'toggle-train-detail':
      toggleTrainDetail(parseInt(el.dataset.tidx)); break;
    case 'wiz-delete-resource':
      e.stopPropagation(); wizDeleteResource(el.dataset.id); break;
    case 'wiz-add-train':
      wizAddTrain(); break;
    case 'wiz-duplicate-train':
      e.stopPropagation(); wizDuplicateTrain(parseInt(el.dataset.tidx)); break;
    case 'wiz-save-train':
      wizSaveTrain(parseInt(el.dataset.tidx)); break;
    case 'wiz-save-all-trains':
      wizSaveAllTrains(); break;
    case 'train-add-service':
      trainAddService(parseInt(el.dataset.tidx)); break;
    case 'train-remove-service': {
      const _tb = el.closest('tbody');
      const _m = _tb && /^tf-(\d+)-services$/.exec(_tb.id || '');
      if (_m) trainRemoveService(parseInt(_m[1], 10), el);
      break;
    }
    case 'train-paste-service':
      trainPasteServices(parseInt(el.dataset.tidx)); break;

    // ── Journey actions (Step 2, #137) ────────────────────────────────────────
    case 'toggle-journey-detail':
      toggleJourneyDetail(parseInt(el.dataset.jidx)); break;
    case 'wiz-add-journey':
      wizAddJourney(); break;
    case 'wiz-duplicate-journey':
      e.stopPropagation(); wizDuplicateJourney(parseInt(el.dataset.jidx)); break;
    case 'wiz-delete-journey':
      e.stopPropagation(); wizDeleteJourney(el.dataset.id); break;
    case 'wiz-save-journey':
      wizSaveJourney(parseInt(el.dataset.jidx)); break;
    case 'journey-add-leg':
      journeyAddLeg(parseInt(el.dataset.jidx)); break;
    case 'journey-remove-leg':
      journeyRemoveLeg(parseInt(el.dataset.jidx), parseInt(el.dataset.li)); break;
    case 'journey-move-leg':
      journeyMoveLeg(parseInt(el.dataset.jidx), parseInt(el.dataset.li), parseInt(el.dataset.dir)); break;

    // ── Scenario creation (Step 3) ────────────────────────────────────────────
    case 'wiz-scen-type':
      wizSetScenType(el.dataset.val); break;
    case 'wiz-sub-type':
      wizSetSubType(el.dataset.val); break;
    case 'wiz-action':
      wizSetAction(el.dataset.val); break;
    case 'wiz-trip-type':
      wizSetTripType(el.dataset.val); break;
    case 'wiz-pax':
      wizAdjustPax(el.dataset.type, parseInt(el.dataset.delta)); break;
    case 'wiz-scen-array':
      wizToggleScenArray(el.dataset.field, el.dataset.val, el); break;
    case 'wiz-generate':
      wizGenerateScenario(); break;
    case 'goto-section2':
      e.preventDefault(); renderWizardStep2InSection(); toggleSection('data'); break;
    case 'refresh-sections':
      e.preventDefault(); refreshAllSections(); break;
    case 'create-another':
      e.preventDefault(); wizInitScenario(); reRenderStep3InSection(); break;
  }
});

// ── Change event delegation (selects and checkboxes) ─────────────────────────
document.body.addEventListener('change', function(e) {
  const el = findAction(e.target);
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'file-upload':
      handleFileUpload(el); break;
    case 'fw-concurrent-limit': {
      // Fires on blur / Enter / spinner click. If the user left the input
      // empty or out-of-range (allowed transiently by the input handler),
      // snap the visible value back to the stored model value so no phantom
      // empty / invalid state lingers. A valid value is left alone — it was
      // already saved (or will be by the debounced auto-save below).
      const raw = (el.value || '').trim();
      const n = parseInt(raw, 10);
      if (raw === '' || !Number.isFinite(n) || n < 1 || n > 10) {
        el.value = wizData.framework.concurrentSessionLimit || 1;
      }
      break;
    }
    case 'set-scenario-code': {
      // Rename an existing scenario. Fires on blur / Enter to avoid renaming
      // mid-keystroke (which would flash the list header and race with typing).
      const sci = parseInt(el.dataset.idx);
      const scToRename = state.scenarios[sci];
      if (!scToRename) break;
      const origCode = el.dataset.orig || scToRename.code;
      const normalised = wizNormaliseCustomCode(el.value);
      // Empty → revert to original (can't have a scenario without a code).
      if (!normalised) {
        el.value = origCode;
        break;
      }
      if (normalised === origCode) {
        el.value = normalised;
        break;
      }
      // Reject duplicates — two scenarios with the same code would collide
      // in scenariosToRun and in the data file's code index.
      const dup = state.scenarios.some((x, i) => i !== sci && x.code === normalised);
      if (dup) {
        alert('Another scenario already uses the code "' + normalised + '". Pick a different one.');
        el.value = origCode;
        break;
      }
      scToRename.code = normalised;
      // scenariosToRun references the old code string — keep the run-list in
      // sync so the checkbox state survives the rename.
      if (Array.isArray(state.scenariosToRun)) {
        const ri = state.scenariosToRun.indexOf(origCode);
        if (ri !== -1) state.scenariosToRun[ri] = normalised;
      }
      el.value = normalised;
      el.dataset.orig = normalised;
      markDirty();
      // Update just the header row's displayed code (human + raw) without
      // a full renderAll() that would collapse the detail panel.
      const detailWrap = document.getElementById('detail-' + sci);
      const rowHeader = detailWrap && detailWrap.previousElementSibling;
      if (rowHeader) {
        const human = rowHeader.querySelector('div[data-action="toggle-detail"] > div:first-child');
        const raw   = rowHeader.querySelector('div[data-action="toggle-detail"] > div:nth-child(2)');
        if (raw)   raw.textContent   = normalised;
        if (human) {
          // Preserve trailing ownership/version badges by only rewriting the
          // leading text node. Simpler: rebuild with decodeCode + existing badges.
          const badgeHtml = human.innerHTML.replace(/^[^<]*/, '');
          human.innerHTML = esc(decodeCode(normalised)) + ' ' + badgeHtml;
        }
      }
      // Toggle-scenario checkbox uses the code as identifier — refresh its
      // data-code so toggling the run flag after a rename still works.
      const checkbox = rowHeader && rowHeader.querySelector('input[data-action="toggle-scenario"]');
      if (checkbox) checkbox.dataset.code = normalised;
      // in-run badge element id includes the code — rename its id as well.
      const inrun = document.getElementById('inrun-' + origCode);
      if (inrun) inrun.id = 'inrun-' + normalised;
      break;
    }
    case 'toggle-scenario':
      e.stopPropagation(); toggleScenario(el.dataset.code, el.checked); break;
    case 'set-scenario': {
      const scIdx = parseInt(el.dataset.idx);
      const field = el.dataset.field;
      const newVal = el.dataset.nullable === 'true'
        ? (el.value === '' ? null : el.value)
        : el.value;
      setScenarioField(scIdx, field, newVal);
      // scenarioType drives visibility of the Overrule Code field (IROPS),
      // and its allowed values. If the user flips REFUND → EXCHANGE (or the
      // other way) and the new type doesn't support IROPS or doesn't allow
      // the previously selected code, clear the stale overruleCode and
      // re-render the detail so the UI matches the model.
      if (field === 'scenarioType') {
        const sc = state.scenarios[scIdx];
        if (sc) {
          const codesForNew = fwIropsCodesFor(newVal);
          const typeSupports = fwSupportsIrops(newVal);
          if (!typeSupports || !codesForNew.includes(sc.overruleCode)) {
            sc.overruleCode = null;
          }
          // OSDM: SALE scenarios have no after-sales action. A stale PATCH
          // or DELETE carried over from a REFUND/EXCHAGE flow would otherwise
          // persist into the saved datafile.
          if (newVal === 'SALE' || newVal == null) {
            sc.scenarioAction = null;
          }
        }
        const detail = document.getElementById('detail-' + scIdx);
        if (detail && detail.dataset.rendered) {
          // Preserve which param-section headers were open so the user isn't
          // bounced back to the default section layout.
          const openSections = new Set();
          detail.querySelectorAll('.param-section-head').forEach(h => {
            if (h.nextElementSibling && h.nextElementSibling.classList.contains('open')) {
              openSections.add((h.textContent || '').trim());
            }
          });
          detail.innerHTML = buildDetailHTML(scIdx);
          detail.querySelectorAll('.param-section-head').forEach(h => {
            const label = (h.textContent || '').trim();
            if (openSections.has(label)) {
              h.nextElementSibling && h.nextElementSibling.classList.add('open');
              const arrow = h.querySelector('.ps-arrow');
              if (arrow) arrow.classList.add('open');
            } else {
              h.nextElementSibling && h.nextElementSibling.classList.remove('open');
              const arrow = h.querySelector('.ps-arrow');
              if (arrow) arrow.classList.remove('open');
            }
          });
        }
      }
      break;
    }
    case 'set-trip-field': {
      const tIdxF = parseInt(el.dataset.tidx);
      setTripField(tIdxF, el.dataset.field, el.value);
      // tripType drives whether we render legs[] (SPECIFICATION) or a single
      // trip{} block (SEARCH). Switching between them leaves a stale UI
      // unless we re-render the scenario details that reference this trip.
      if (el.dataset.field === 'tripType') {
        const trip = state.tripRequirements[tIdxF];
        document.querySelectorAll('.scenario-detail').forEach(det => {
          if (!det.dataset.rendered) return;
          const sIdx = parseInt(det.id.replace('detail-', ''));
          const sc = state.scenarios[sIdx];
          if (!sc || sc.tripRequirementId !== trip.id) return;
          // Preserve which param sections were open
          const openSections = new Set();
          det.querySelectorAll('.param-section-head').forEach(h => {
            if (h.nextElementSibling && h.nextElementSibling.classList.contains('open')) {
              openSections.add((h.textContent || '').trim());
            }
          });
          det.innerHTML = buildDetailHTML(sIdx);
          det.querySelectorAll('.param-section-head').forEach(h => {
            const label = (h.textContent || '').trim();
            const isOpen = openSections.has(label);
            h.nextElementSibling && h.nextElementSibling.classList.toggle('open', isOpen);
            const arrow = h.querySelector('.ps-arrow');
            if (arrow) arrow.classList.toggle('open', isOpen);
          });
        });
      }
      break;
    }
    case 'set-pax-family': {
      const sfpIdx = parseInt(el.dataset.pidx);
      const sfpPi  = parseInt(el.dataset.pi);
      const sfpList = state.passengersList[sfpIdx];
      const sfpPax  = sfpList && sfpList.passengers && sfpList.passengers[sfpPi];
      if (!sfpPax) break;
      const raw = el.value;
      let nextGroup;
      if (raw === '' || raw == null) {
        nextGroup = null;
      } else if (raw === '__new__') {
        const usedNumbers = sfpList.passengers
          .map(p => p && Number.isInteger(p.familyGroup) ? p.familyGroup : null)
          .filter(n => n != null);
        nextGroup = usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;
      } else {
        const n = parseInt(raw, 10);
        nextGroup = Number.isInteger(n) ? n : null;
      }
      sfpPax.familyGroup = nextGroup;
      // Joining a family: adopt the family's current lastName (taken from
      // any existing member — first one found wins). This makes the very
      // name-sharing semantics visible immediately.
      if (nextGroup != null) {
        const sibling = sfpList.passengers.find((q, qi) =>
          qi !== sfpPi && q && q.familyGroup === nextGroup && q.lastName);
        if (sibling && sibling.lastName !== sfpPax.lastName) {
          sfpPax.lastName = sibling.lastName;
        }
      }
      markDirty();
      // Sync any linked purchaser if the lastName changed above
      syncPurchaserFromPassenger(sfpList, sfpPax);
      // Re-render the whole detail panel so the Family dropdown options,
      // member counts, and compact-row badges all reflect the new state.
      document.querySelectorAll('.scenario-detail').forEach(det => {
        if (!det.dataset.rendered) return;
        const scIdx = parseInt(det.id.replace('detail-', ''));
        const sc = state.scenarios[scIdx];
        if (sc && sc.passengersListId === sfpList.id) {
          reRenderScenarioDetail(scIdx);
        }
      });
      break;
    }
    case 'journey-leg-pick':
      journeySetLeg(parseInt(el.dataset.jidx), parseInt(el.dataset.li), el.value); break;
    case 'apply-trip-train': {
      const atScIdx = parseInt(el.dataset.idx);
      const atTIdx  = parseInt(el.dataset.tidx);
      const target  = el.dataset.target; // "trip" or "legs.<n>"
      const raw = el.value; // "<trainId>::<serviceIndex>"
      if (!raw) break;
      const [trainId, svcIdxStr] = String(raw).split('::');
      const svcIdx = parseInt(svcIdxStr, 10) || 0;
      const train = (wizData.resources || []).find(r => String(r.id) === String(trainId));
      if (!train) break;
      const data = normalizeTrainData(typeof train.data === 'string'
        ? JSON.parse(train.data) : (train.data || {}));
      const svc = data.services[svcIdx] || data.services[0] || {};
      const tripReq = state.tripRequirements[atTIdx];
      if (!tripReq) break;
      // Resolve the target sub-object (trip block or leg N) and populate its
      // scalar fields from the train set's route + the chosen service.
      // Preserve any field neither defines — the user may have typed into it.
      let t;
      if (target === 'trip') {
        tripReq.trip = tripReq.trip || {};
        t = tripReq.trip;
      } else {
        const legIdx = parseInt(target.slice(5), 10); // "legs.3" → 3
        tripReq.legs = tripReq.legs || [];
        tripReq.legs[legIdx] = tripReq.legs[legIdx] || {};
        t = tripReq.legs[legIdx];
      }
      if (data.originURN)      t.origin         = data.originURN;
      if (data.destinationURN) t.destination    = data.destinationURN;
      if (svc.departureTime)   t.startDatetime  = '%TRIP_DATE%T' + svc.departureTime;
      if (svc.arrivalTime)     t.endDatetime    = '%TRIP_DATE%T' + svc.arrivalTime;
      if (svc.vehicleNumber)   t.vehicleNumber  = svc.vehicleNumber;
      if (data.operatorCode)   t.operatorCode   = data.operatorCode;
      // Product category (#141) — carried into the request's service.productCategory.
      if (data.productCategoryRef)       t.productCategoryRef       = data.productCategoryRef;
      if (data.productCategoryName)      t.productCategoryName      = data.productCategoryName;
      if (data.productCategoryShortName) t.productCategoryShortName = data.productCategoryShortName;
      markDirty();
      // Reset the dropdown to its placeholder so it reads as "apply again"
      // next time (avoids users wondering whether the select remembered
      // their last pick).
      el.value = '';
      reRenderScenarioDetail(atScIdx);
      break;
    }
    case 'apply-trip-journey': {
      const ajScIdx = parseInt(el.dataset.idx);
      const ajTIdx  = parseInt(el.dataset.tidx);
      const jid = el.value;
      if (!jid) break;
      const journey = (wizData.resources || []).find(r => String(r.id) === String(jid) && r.resource_type === 'JOURNEY');
      if (!journey) break;
      const tripReq = state.tripRequirements[ajTIdx];
      if (!tripReq) break;
      const legs = journeyToTripLegs(journey);
      if (legs.length === 0) break;
      // A journey is an explicit multi-leg itinerary → SPECIFICATION.
      tripReq.tripType = 'SPECIFICATION';
      tripReq.legs = legs;
      markDirty();
      el.value = '';
      reRenderScenarioDetail(ajScIdx);
      break;
    }
    case 'toggle-purchaser-is-pax': {
      const tpScIdx = parseInt(el.dataset.idx);
      const tpPrIdx = parseInt(el.dataset.purchIdx);
      const tpPurchList = state.purchaserList[tpPrIdx];
      if (!tpPurchList) break;
      const p0 = (tpPurchList.purchaser = tpPurchList.purchaser || [{}])[0];
      p0.isPassenger = !!el.checked;
      if (p0.isPassenger) {
        // When turning the link ON, default the passengerRef to the first
        // passenger if not already set, then copy its values into the
        // purchaser fields so the UI shows the resolved values immediately.
        const sc = state.scenarios[tpScIdx];
        const paxList = sc && (state.passengersList || []).find(p => p.id === sc.passengersListId);
        const passengers = (paxList && paxList.passengers) || [];
        if (!p0.passengerRef || !passengers.some(p => p.reference === p0.passengerRef)) {
          p0.passengerRef = (passengers[0] && passengers[0].reference) || '';
        }
        const linked = passengers.find(p => p.reference === p0.passengerRef);
        if (linked) syncPurchaserFromPassenger(paxList, linked);
      }
      markDirty();
      reRenderScenarioDetail(tpScIdx);
      break;
    }
    case 'set-purchaser-passenger': {
      const ppScIdx = parseInt(el.dataset.idx);
      const ppPrIdx = parseInt(el.dataset.purchIdx);
      const ppPurchList = state.purchaserList[ppPrIdx];
      if (!ppPurchList) break;
      const pp0 = (ppPurchList.purchaser = ppPurchList.purchaser || [{}])[0];
      pp0.passengerRef = el.value;
      const sc = state.scenarios[ppScIdx];
      const paxList = sc && (state.passengersList || []).find(p => p.id === sc.passengersListId);
      const passengers = (paxList && paxList.passengers) || [];
      const linked = passengers.find(p => p.reference === el.value);
      if (linked) syncPurchaserFromPassenger(paxList, linked);
      markDirty();
      reRenderScenarioDetail(ppScIdx);
      break;
    }
    case 'set-pax': {
      const spxIdx = parseInt(el.dataset.pidx);
      const spxPi  = parseInt(el.dataset.pi);
      const spxField = el.dataset.field;
      // Gender 'None' (empty value) means the field is omitted from the
      // generated request — store null rather than "" so the data file
      // doesn't carry an empty string, and library-bruno's `!= null`
      // guards skip the field cleanly.
      const rawValue = (spxField === 'gender' && el.value === '') ? null : el.value;
      setPaxField(spxIdx, spxPi, spxField, rawValue);
      // When the user flips gender (and it's now a real value, not None),
      // auto-swap the first name to one that matches — but ONLY if the
      // current name looks like one we generated (leave user-typed names
      // alone). 'None' keeps the current name as-is (no gendered pool to
      // pick from).
      if (spxField === 'gender' && rawValue) {
        const pxList = state.passengersList[spxIdx];
        const pxPax  = pxList && pxList.passengers && pxList.passengers[spxPi];
        if (pxPax) {
          if (isAutoGeneratedFirstName(pxPax.firstName)) {
            pxPax.firstName = pickFirstNameForGender(rawValue);
            // Sync the edit-panel firstName input if it's currently rendered.
            const fnInput = document.querySelector(
              'input[data-action="set-pax-text"][data-pidx="' + spxIdx + '"][data-pi="' + spxPi + '"][data-field="firstName"]'
            );
            if (fnInput) fnInput.value = pxPax.firstName;
          }
          if (isAutoGeneratedFirstName(pxPax.updateFirstName)) {
            pxPax.updateFirstName = pickFirstNameForGender(rawValue);
          }
          // Update the compact "firstName lastName" span on the row header.
          const disp = document.querySelector('[data-pax-display="' + spxIdx + '-' + spxPi + '"]');
          if (disp) disp.textContent = (pxPax.firstName || '') + ' ' + (pxPax.lastName || '');
        }
      }
      break;
    }
    case 'change-pax-category': {
      const cpIdx = parseInt(el.dataset.pidx);
      const cpPi = parseInt(el.dataset.pi);
      const cpScIdx = parseInt(el.dataset.scenidx);
      const newCat = el.value;
      const cpList = state.passengersList[cpIdx];
      if (!cpList || !cpList.passengers[cpPi]) break;
      const pax = cpList.passengers[cpPi];
      pax.category = newCat;
      pax.type = WIZ_PAX_TO_OSDM_TYPE[newCat] || 'PERSON';
      const isH = WIZ_HUMAN_PAX_TYPES.includes(newCat);
      if (isH) {
        const ar = WIZ_PAX_DEFAULT_AGES[newCat] || {min:18, max:99};
        pax.dateOfBirth = genDateOfBirth(ar.min, ar.max);
        if (pax.updateDateOfBirth) pax.updateDateOfBirth = genDateOfBirth(ar.min, ar.max);
      }
      markDirty();
      // Re-render the detail
      const det = document.getElementById(`detail-${esc(cpScIdx)}`);
      if (det && det.innerHTML) {
        det.innerHTML = buildDetailHTML(cpScIdx);
        det.querySelectorAll('.param-section-head').forEach(h => {
          if (h.textContent.includes('Passengers')) {
            h.nextElementSibling?.classList.add('open');
            h.querySelector('.ps-arrow')?.classList.add('open');
          }
        });
      }
      break;
    }
    case 'set-offer':
      setOfferField(parseInt(el.dataset.idx), el.dataset.field, el.value || null); break;
    case 'toggle-offer-array':
      toggleOfferArray(parseInt(el.dataset.idx), el.dataset.field, el.dataset.val, el.checked, el); break;
    case 'set-fulfill':
      setFulfillField(parseInt(el.dataset.fidx), el.dataset.field, el.value); break;

    // ── Framework wizard change handlers ──────────────────────────────────────
    // Checkbox toggles save immediately (binary state, no mid-edit concern).
    // The number input (fw-pax-age) uses the same empty/out-of-range guard
    // as fw-concurrent-limit: snap the visible value back to the stored one
    // so the user can't leave the field in a broken state.
    case 'fw-toggle-flow':
      fwToggleFlow(el.dataset.key, el.checked); saveFrameworkDebounced(); break;
    case 'fw-toggle-mode':
      fwToggleMode(el.dataset.mode, el.checked); saveFrameworkDebounced(); break;
    case 'fw-toggle-seatmap':
      fwToggleSeatMap(el.checked); saveFrameworkDebounced(); break;
    case 'fw-pax-age': {
      const raw = (el.value || '').trim();
      const n = parseInt(raw, 10);
      if (raw === '' || !Number.isFinite(n) || n < 0 || n > 120) {
        const ranges = wizData.framework && wizData.framework.passengerAgeRanges;
        const stored = ranges && ranges[el.dataset.paxtype] && ranges[el.dataset.paxtype][el.dataset.bound];
        if (typeof stored === 'number') el.value = stored;
        break;
      }
      fwSetPaxAge(el.dataset.paxtype, el.dataset.bound, n);
      saveFrameworkDebounced();
      break;
    }

    // ── Step 3 change handlers ────────────────────────────────────────────────
    case 'wiz-select-train':
      wizSelectTrain(el.value); break;
    case 'wiz-select-journey':
      wizSelectJourney(el.value); break;
    case 'wiz-flexibility':
      wizScenario.desiredFlexibility = el.value; wizUpdateCodePreview(); break;
    case 'wiz-overrule':
      wizScenario.overruleCode = el.value || null; break;
    case 'wiz-offer-mode':
      wizScenario.offerMode = el.value; break;
    case 'wiz-pax-gender': {
      // Default gender applied to every passenger of this type when the
      // scenario is generated. Per-passenger refinement is still possible
      // afterwards via the detail row's gender selector.
      if (!wizScenario.passengerGender) wizScenario.passengerGender = {};
      wizScenario.passengerGender[el.dataset.type] = el.value;
      break;
    }
  }
});

// ── Input event delegation (text inputs) ─────────────────────────────────────
document.body.addEventListener('input', function(e) {
  const el = findAction(e.target);
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'set-scenario-text':
      setScenarioField(parseInt(el.dataset.idx), el.dataset.field, el.value); break;
    case 'set-trip-time':
      setTripTimeFieldByPath(parseInt(el.dataset.tidx), el.dataset.path, el.value); break;
    case 'set-trip-path':
      setTripFieldByPath(parseInt(el.dataset.tidx), el.dataset.path, el.value); break;
    case 'set-pax-input':
      setPaxField(parseInt(el.dataset.pidx), parseInt(el.dataset.pi), el.dataset.field, el.value); break;
    case 'set-pax-text': {
      // Free-text fields in the per-passenger editor (firstName, lastName,
      // dateOfBirth, email, phoneNumber). Updates the model on every
      // keystroke — no re-render, so focus/caret stay put while typing.
      const sptIdx = parseInt(el.dataset.pidx);
      const sptPi  = parseInt(el.dataset.pi);
      const sptField = el.dataset.field;
      setPaxField(sptIdx, sptPi, sptField, el.value);
      // Keep the compact row-header display in sync when the user edits
      // firstName or lastName from inside the Edit panel — no waiting for
      // a re-render, so the change is immediately visible in the row above.
      if (sptField === 'firstName' || sptField === 'lastName') {
        const pxList = state.passengersList[sptIdx];
        const pxPax  = pxList && pxList.passengers && pxList.passengers[sptPi];
        const disp = document.querySelector('[data-pax-display="' + sptIdx + '-' + sptPi + '"]');
        if (pxPax && disp) disp.textContent = (pxPax.firstName || '') + ' ' + (pxPax.lastName || '');
      }
      break;
    }
    case 'set-pax-reduction': {
      const spIdx = parseInt(el.dataset.pidx);
      const spPi  = parseInt(el.dataset.pi);
      const spCi  = parseInt(el.dataset.cidx);
      const spList = state.passengersList[spIdx];
      const spPax  = spList && spList.passengers && spList.passengers[spPi];
      if (!spPax) break;
      if (!Array.isArray(spPax.reductionCards)) spPax.reductionCards = [];
      spPax.reductionCards[spCi] = el.value;
      markDirty();
      break;
    }
    case 'set-pax-loyalty': {
      const slIdx = parseInt(el.dataset.pidx);
      const slPi  = parseInt(el.dataset.pi);
      const slCi  = parseInt(el.dataset.cidx);
      const field = el.dataset.field;
      const slList = state.passengersList[slIdx];
      const slPax  = slList && slList.passengers && slList.passengers[slPi];
      if (!slPax) break;
      if (!Array.isArray(slPax.loyaltyCards)) slPax.loyaltyCards = [];
      if (!slPax.loyaltyCards[slCi] || typeof slPax.loyaltyCards[slCi] !== 'object') {
        slPax.loyaltyCards[slCi] = { carrierCode: '', cardReference: '' };
      }
      slPax.loyaltyCards[slCi][field] = el.value;
      markDirty();
      break;
    }
    case 'set-offer-currency':
      el.value = el.value.toUpperCase();
      setOfferField(parseInt(el.dataset.idx), 'currency', el.value); break;
    case 'set-offer-tags': {
      const tags = el.value.split(',').map(t => t.trim()).filter(Boolean);
      setOfferField(parseInt(el.dataset.idx), 'productTags', tags.length > 0 ? tags : null);
      break;
    }
    case 'set-offer-inbound':
      setOfferField(parseInt(el.dataset.idx), 'inboundDate', el.value || null); break;
    case 'set-offer-selections': {
      try {
        const parsed = el.value.trim() ? JSON.parse(el.value.trim()) : null;
        setOfferField(parseInt(el.dataset.idx), 'productSelections', parsed);
      } catch (_) { /* invalid JSON — don't save until valid */ }
      break;
    }
    case 'set-purchaser':
      setPurchaserField(parseInt(el.dataset.purchIdx), el.dataset.field, el.value); break;

    // ── Framework wizard input handlers ───────────────────────────────────────
    case 'wiz-osdm-version': {
      const v = el.value.trim();
      // Skip empty (mid-edit): saving an empty string would then be read back
      // as a falsy osdmVersion and replaced with the default, losing the user
      // previous value without intent. The next re-render (any other action)
      // will snap the displayed value back to the stored one.
      if (!v) break;
      wizData.framework.osdmVersion = v;
      saveFrameworkDebounced();
      break;
    }
    case 'fw-concurrent-limit': {
      // Treat empty / out-of-range input as a mid-edit transient state: don't
      // touch the model and don't trigger a save. Otherwise the user deleting
      // "1" to type "10" would see an immediate save of 1 (clamped default),
      // followed by a re-render that overwrites the input they were about to
      // finish typing — an endless loop from their perspective.
      const raw = (el.value || '').trim();
      if (raw === '' || !/^\d+$/.test(raw)) break;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 10) break;
      wizData.framework.concurrentSessionLimit = n;
      // Debounced auto-save: one PUT 500ms after the last keystroke rather
      // than one per character. renderFrameworkSection preserves the open
      // sub-section state AND the caret position in the focused input so
      // the re-render is invisible to the user.
      saveFrameworkDebounced();
      break;
    }

    // ── Step 3 input handlers ─────────────────────────────────────────────────
    case 'wiz-currency':
      el.value = el.value.toUpperCase();
      wizScenario.currency = el.value; break;
    case 'wiz-origin-urn':
      wizScenario.originURN = el.value.trim(); break;
    case 'wiz-dest-urn':
      wizScenario.destinationURN = el.value.trim(); break;
    case 'wiz-custom-code':
      // Store the raw text so the input isn't fighting the user while they
      // type (otherwise lowercase letters would vanish mid-stroke). The
      // normalised form is computed in wizGenCode at render time.
      wizScenario.customCode = el.value;
      wizUpdateCodePreview();
      break;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadDatafile();
