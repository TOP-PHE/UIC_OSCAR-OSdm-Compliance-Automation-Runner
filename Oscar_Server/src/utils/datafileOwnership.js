// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafileOwnership.js — what a tester may see and change in the company
 * datafile (S3, second half; v1.11.197).
 *
 * One datafile holds every scenario of a company. Until v1.11.197 a tester's
 * Save & Apply replaced the whole file, so it could rewrite or delete shared
 * scenarios and other testers' private ones; the editor showed those read-only,
 * but only in the browser. Decided by the maintainer on 2026-09-11: a tester
 * saves their own tests without affecting any other stored test, sees their
 * own tests and the shared ones, and the shared ones are read-only.
 *
 * Rules, for a tester (company_user) — Test Managers are not filtered:
 *
 *   owned   = not shared, and created_by is this tester's email
 *   visible = owned, OR shared, OR no created_by at all (a company scenario from
 *             before ownership existed — kept visible so old datafiles don't
 *             suddenly go empty for testers)
 *   hidden  = another person's private scenario
 *
 * A tester can create, change and delete only owned scenarios. Everything else
 * in the stored file — other scenarios, their resource entries, every other
 * top-level key — is kept exactly as stored.
 *
 * Scenarios point at entries in five resource lists by numeric id
 * (tripRequirementId → tripRequirements[].id, and so on). The editor allocates
 * those ids as max+1 over what it can SEE, so a tester's new entry can carry an
 * id that a hidden scenario already uses. The merge therefore never lets a
 * tester's entry replace one that another scenario still references: when the
 * tester's version differs, it is copied to a fresh id and the tester's
 * scenario is repointed (copy-on-write). The same rule covers an old datafile
 * where a tester's scenario and a shared one reference the same entry.
 *
 * The run list is personal (maintainer decision, same day): what a tester
 * ticks is stored per user — see utils/runSelections.js — and the file's own
 * scenariosToRun stays the Test Manager's company default.
 *
 * Everything here is pure: plain objects in, plain objects out.
 */

// [list key, the scenario field that references it]
const RESOURCE_LISTS = Object.freeze([
  ['tripRequirements',                'tripRequirementId'],
  ['passengersList',                  'passengersListId'],
  ['purchaserList',                   'purchaserListId'],
  ['requestedFulfillmentOptionsList', 'requestedFulfillmentOptionsListId'],
  ['offerSearchCriteriaList',         'offerSearchCriteriaListId'],
]);
// The only non-merged keys a tester may set, and only while the file has none:
// the two plain strings the editor's first-save skeleton carries.
const FIRST_SAVE_KEYS = Object.freeze(['osdmVersion', 'collection']);

const arr = v => (Array.isArray(v) ? v : []);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const normEmail = e => String(e == null ? '' : e).trim().toLowerCase();

function isOwnedBy(sc, email) {
  const me = normEmail(email);
  return isObj(sc) && !sc.shared && me !== '' && normEmail(sc.created_by) === me;
}

function isVisibleTo(sc, email) {
  if (!isObj(sc)) return false;
  return isOwnedBy(sc, email) || !!sc.shared || normEmail(sc.created_by) === '';
}

/**
 * Stable JSON for "is this the same thing": keys sorted, and keys starting
 * with "__" dropped — GET /datafile annotates scenarios with
 * __featureNotDeclaredWarnings, so a scenario echoed back by the editor carries
 * a key the stored copy may not have.
 */
function canonical(value) {
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const out = {};
    // Code-unit order, deliberately not localeCompare: the result must not
    // depend on the server's locale. Keys are unique, so a tie never occurs.
    for (const k of Object.keys(v).sort((a, b) => (a < b ? -1 : 1))) {
      if (!k.startsWith('__')) out[k] = walk(v[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * "Is this the stored scenario, unchanged?" — tolerant of exactly what the
 * editor adds on its own. scenarios.js backfills two missing fields on load,
 * on every scenario including read-only ones: salesFlowActions (every flag
 * true — migrateLegacySalesFlowActions) and offerSearchCriteria ({} —
 * migrateMissingOfferSearchCriteria). An untouched shared scenario therefore
 * comes back with those keys when its stored copy lacks them. Any other added
 * key, either of those two with a non-default value, or any change to a key the
 * stored copy has, is a real edit.
 */
const EDITOR_BACKFILL = Object.freeze({
  salesFlowActions:    v => isObj(v) && Object.values(v).every(x => x === true),
  offerSearchCriteria: v => isObj(v) && Object.keys(v).length === 0,
});

function sameContent(storedSc, sentSc) {
  if (!isObj(storedSc) || !isObj(sentSc)) return false;
  for (const k of Object.keys(storedSc)) {
    if (!k.startsWith('__') && canonical(storedSc[k]) !== canonical(sentSc[k])) return false;
  }
  for (const k of Object.keys(sentSc)) {
    if (k.startsWith('__') || k in storedSc) continue;
    if (!(k in EDITOR_BACKFILL) || !EDITOR_BACKFILL[k](sentSc[k])) return false;
  }
  return true;
}

/** Every numeric id and every numeric reference, in any of the datafiles given. */
function collectIds(...datafiles) {
  const ids = new Set();
  for (const df of datafiles) {
    if (!isObj(df)) continue;
    for (const [list, ref] of RESOURCE_LISTS) {
      for (const e of arr(df[list])) if (isObj(e) && typeof e.id === 'number') ids.add(e.id);
      for (const s of arr(df.scenarios)) if (isObj(s) && typeof s[ref] === 'number') ids.add(s[ref]);
    }
  }
  return ids;
}

/** A run list with each renamed code swapped in where the editor had put it. */
function withRenames(scenariosToRun, renamed) {
  if (scenariosToRun === 'ALL') return 'ALL';
  const list = typeof scenariosToRun === 'string'
    ? scenariosToRun.split(',').map(s => s.trim()).filter(Boolean)
    : arr(scenariosToRun).slice();
  for (const { from, to } of renamed) {
    const i = list.lastIndexOf(from);            // the editor appends what it adds
    if (i !== -1) list[i] = to;
  }
  return list;
}


function orderedUnique(codes) {
  const seen = new Set();
  return codes.filter(c => typeof c === 'string' && !seen.has(c) && seen.add(c));
}

/** The codes a tester sees, in file order. */
function visibleCodes(datafile, email) {
  return orderedUnique(arr(datafile?.scenarios).filter(s => isVisibleTo(s, email)).map(s => s.code));
}

/**
 * Resolve a scenariosToRun value ("ALL" or an array) against a set of codes the
 * caller may run, keeping order and dropping anything else.
 */
function resolveRunList(scenariosToRun, allowedCodes) {
  const allowed = new Set(allowedCodes);
  if (scenariosToRun === 'ALL') return allowedCodes.slice();
  const list = typeof scenariosToRun === 'string'                  // Bruno also accepts "code1,code2"
    ? scenariosToRun.split(',').map(s => s.trim()).filter(Boolean)
    : arr(scenariosToRun);
  return orderedUnique(list).filter(c => allowed.has(c));
}

/**
 * The tester's view of a datafile: hidden scenarios removed, resource entries
 * that only hidden scenarios reference removed, and scenariosToRun replaced by
 * the tester's personal run list (or, when they have none yet, the company
 * default restricted to what they can see).
 *
 * @param {object} datafile  the stored datafile
 * @param {string} email     the tester's email
 * @param {string[]|null} selection  their stored personal run list, or null
 */
function viewForTester(datafile, email, selection) {
  if (!isObj(datafile)) return datafile;
  const scenarios = arr(datafile.scenarios);
  const visible = scenarios.filter(s => isVisibleTo(s, email));
  const hidden  = scenarios.filter(s => !isVisibleTo(s, email));

  const view = { ...datafile, scenarios: visible };
  for (const [list, ref] of RESOURCE_LISTS) {
    if (!Array.isArray(datafile[list])) continue;
    const usedByVisible = new Set(visible.map(s => s[ref]));
    const usedByHidden  = new Set(hidden.map(s => s[ref]));
    view[list] = datafile[list].filter(e => !(isObj(e) && usedByHidden.has(e.id) && !usedByVisible.has(e.id)));
  }
  const codes = visibleCodes(datafile, email);
  view.scenariosToRun = resolveRunList(selection == null ? datafile.scenariosToRun : selection, codes);
  return view;
}

/**
 * Merge a tester's Save & Apply into the stored datafile.
 *
 * @returns {{
 *   datafile: object,          the file to store
 *   selection: string[],       the tester's personal run list, to store per user
 *   ignoredReadOnly: string[], read-only scenarios they sent changed — kept as stored
 *   renamed: {from:string, to:string}[]  new scenarios of theirs whose code someone
 *                              else's scenario already uses, stored under a free code
 *   forked: {list:string, from:number, to:number}[]  resource entries copied to a fresh id
 * }}
 *
 * The rules below each close a defect an independent review reproduced against
 * the first version (2026-09-11); the letters match
 * tests/unit/datafile-ownership.test.js.
 */
function mergeTesterSave(stored, incoming, email) {
  const base = isObj(stored) ? stored : {};
  const inc  = isObj(incoming) ? incoming : {};
  const storedScenarios = arr(base.scenarios).filter(isObj);
  const sentScenarios = arr(inc.scenarios).filter(isObj);

  const ownedStored = new Map();                 // code -> stored owned scenario
  const othersByCode = new Map();                // code -> [stored non-owned scenarios]
  for (const s of storedScenarios) {
    if (isOwnedBy(s, email)) { if (!ownedStored.has(s.code)) ownedStored.set(s.code, s); }
    else othersByCode.set(s.code, [...(othersByCode.get(s.code) || []), s]);
  }

  // (C) Codes are the only identity a scenario has, and the editor picks them
  // from what the tester can see. A new scenario of theirs whose code someone
  // else's already uses is stored under the next free code — never dropped
  // behind a success message, never refused for a clash they cannot see.
  const takenCodes = new Set([...storedScenarios, ...sentScenarios].map(s => s.code));
  const freeCode = code => {
    let n = 2, candidate;
    do { candidate = `${code}_${n++}`; } while (takenCodes.has(candidate));
    takenCodes.add(candidate);
    return candidate;
  };
  const stamp = (sc, code = sc.code) => ({
    ...sc,
    code,
    shared: false,                               // only a Test Manager shares a scenario
    created_by: ownedStored.has(code) ? ownedStored.get(code).created_by : email,
  });

  const ignoredReadOnly = [];
  const renamed = [];
  const ownIncoming = [];
  for (const sc of sentScenarios) {
    const others = othersByCode.get(sc.code) || [];
    if (others.some(o => sameContent(o, sc))) continue;                   // an unchanged read-only scenario, echoed back
    if (ownedStored.has(sc.code)) { ownIncoming.push(stamp(sc)); continue; }
    if (isOwnedBy(sc, email)) {                                           // a new scenario of theirs
      if (others.length) {
        const to = freeCode(sc.code);
        renamed.push({ from: sc.code, to });
        ownIncoming.push(stamp(sc, to));
      } else {
        ownIncoming.push(stamp(sc));
      }
      continue;
    }
    // Someone else's scenario as the editor last saw it. An edit to one that is
    // still visible is reported. A stale copy of one since deleted or un-shared
    // is simply not kept: never resurrected as theirs, never a clash.
    if (others.some(o => isVisibleTo(o, email))) ignoredReadOnly.push(sc.code);
  }

  // Keep every non-owned scenario where it was; the tester's scenarios fill the
  // slots theirs used to occupy, and any extra ones go at the end.
  const scenarios = [];
  let k = 0;
  for (const s of storedScenarios) {
    if (!isOwnedBy(s, email)) scenarios.push(s);
    else if (k < ownIncoming.length) scenarios.push(ownIncoming[k++]);
  }
  while (k < ownIncoming.length) scenarios.push(ownIncoming[k++]);

  // (A) A tester writes scenarios, the resource lists and their own run list —
  // nothing else. Every other top-level key is company configuration, and
  // systemInfoParameters in particular is turned by Bruno into environment
  // variables for EVERY run (api_base included): a key planted by a tester would
  // send colleagues' runs, bearer token and all, wherever they chose. The only
  // exception is the two plain strings the editor's own first-save skeleton
  // carries, and only while the file has none.
  const datafile = { ...base };
  for (const key of FIRST_SAVE_KEYS) {
    const v = inc[key];
    if (!(key in base) && typeof v === 'string' && v.length <= 64) datafile[key] = v;
  }
  datafile.scenarios = scenarios;

  // (J) Fresh ids are unique among every id and every reference anywhere in the
  // stored file and the request, and always safe integers — max+1 stops
  // counting at 2^53, which let a copy land on another tester's entry.
  const usedIds = collectIds(base, inc);
  let cursor = 1 + Math.max(0, ...[...usedIds].filter(Number.isSafeInteger));
  const allocateId = () => {
    while (!Number.isSafeInteger(cursor) || usedIds.has(cursor)) cursor = Number.isSafeInteger(cursor) ? cursor + 1 : 1;
    usedIds.add(cursor);
    return cursor++;
  };

  const forked = [];
  const visibleOthers = scenarios.filter(s => !isOwnedBy(s, email) && isVisibleTo(s, email));
  const hiddenOthers  = scenarios.filter(s => !isVisibleTo(s, email));
  for (const [list, ref] of RESOURCE_LISTS) {
    const storedList = arr(base[list]).filter(isObj);
    const incomingList = arr(inc[list]).filter(isObj);
    if (!(list in base) && !(list in inc)) continue;

    // Not the tester's to change: entries a non-owned scenario references,
    // stored entries nothing references (company data), and (K) the first
    // purchaser — Bruno reads purchaserList[0] for every scenario, whatever its
    // purchaserListId says, so that entry is everyone's.
    const referencedInStore = new Set(storedScenarios.map(s => s[ref]));
    const protectedIds = new Set([
      ...scenarios.filter(s => !isOwnedBy(s, email)).map(s => s[ref]),
      ...storedList.filter(e => !referencedInStore.has(e.id)).map(e => e.id),
      ...(list === 'purchaserList' && storedList.length ? [storedList[0].id] : []),
    ]);
    // (L) Entries only hidden scenarios use. Linking an own scenario to one would
    // put it in the tester's view, so a new link is cut; a link their stored
    // scenario already had (old aliasing, from when everyone saw everything) stays.
    const visibleUse = new Set(visibleOthers.map(s => s[ref]));
    const hiddenOnly = new Set(hiddenOthers.map(s => s[ref]).filter(id => !visibleUse.has(id)));

    const storedById = new Map(storedList.map(e => [e.id, e]));
    const incomingById = new Map(incomingList.map(e => [e.id, e]));
    const ownNeeded = new Map();                 // id -> the entry to keep for the tester's scenarios
    const forkOf = new Map();                    // protected id -> fresh id, one copy per id
    const forkEntries = [];
    for (const sc of ownIncoming) {
      const id = sc[ref];
      if (id === undefined || id === null) continue;
      const mine = incomingById.get(id);
      if (protectedIds.has(id)) {
        const theirs = storedById.get(id);
        // Fork when the tester's entry differs from the protected one — or when
        // there is no stored entry at all (another scenario's dangling id), which
        // would otherwise drop the tester's entry and break their scenario.
        if (mine && (!theirs || canonical(mine) !== canonical(theirs))) {
          if (!forkOf.has(id)) {
            const fresh = allocateId();
            forkOf.set(id, fresh);
            forkEntries.push({ ...mine, id: fresh });
            forked.push({ list, from: id, to: fresh });
          }
          sc[ref] = forkOf.get(id);
        } else if (hiddenOnly.has(id)) {
          const before = ownedStored.get(sc.code);
          if (!before || before[ref] !== id) sc[ref] = null;
        }
        continue;                                // otherwise it shares the protected entry as is
      }
      if (!ownNeeded.has(id)) {
        const entry = mine || storedById.get(id);
        if (entry) ownNeeded.set(id, entry);
      }
    }

    // Walk the stored list so nothing moves: protected entries as stored, the
    // tester's entries replaced in place, the rest (entries of scenarios they
    // deleted) dropped. New entries and copies go at the end. An unchanged save
    // therefore rewrites nothing.
    const result = [];
    for (const e of storedList) {
      if (protectedIds.has(e.id)) result.push(e);
      else if (ownNeeded.has(e.id)) { result.push(ownNeeded.get(e.id)); ownNeeded.delete(e.id); }
    }
    result.push(...ownNeeded.values(), ...forkEntries);
    datafile[list] = result;
  }

  // The company run list is the Test Manager's: unchanged, apart from codes
  // that no longer exist (the tester deleted or renamed an owned scenario).
  // (H) Bruno's comma-separated form is pruned the same way — kept verbatim, a
  // list naming only deleted codes made Bruno abort every run in the company.
  // On a first save there is none yet, so the request's list becomes the default.
  const allCodes = [...new Set(scenarios.map(s => s.code))];
  const exists = new Set(allCodes);
  if (base.scenariosToRun === 'ALL') datafile.scenariosToRun = 'ALL';
  else if (Array.isArray(base.scenariosToRun)) datafile.scenariosToRun = base.scenariosToRun.filter(c => exists.has(c));
  else if (typeof base.scenariosToRun === 'string') datafile.scenariosToRun = resolveRunList(base.scenariosToRun, allCodes);
  else datafile.scenariosToRun = resolveRunList(withRenames(inc.scenariosToRun, renamed), allCodes);

  const selection = resolveRunList(withRenames(inc.scenariosToRun, renamed), visibleCodes(datafile, email));

  return { datafile, selection, ignoredReadOnly: orderedUnique(ignoredReadOnly), renamed, forked };
}


module.exports = {
  RESOURCE_LISTS,
  isOwnedBy,
  isVisibleTo,
  canonical,
  visibleCodes,
  resolveRunList,
  viewForTester,
  mergeTesterSave,
};
