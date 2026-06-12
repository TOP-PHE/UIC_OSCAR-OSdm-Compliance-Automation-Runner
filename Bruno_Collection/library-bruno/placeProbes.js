/**
 * placeProbes.js — Non-Happy-Flow PLACE-SELECTION probe sweep (#378).
 *
 * One scenario, one sweep (the #258 purchaser-sweep design, endorsed for place
 * selection): the enabled probes run INSIDE `02. POST Create Booking`. Each
 * probe pass corrupts exactly ONE aspect of the otherwise-clean booking
 * request, fires it, grades the provider's reaction, then loops the step
 * (02 → 02). After the last probe the step re-runs CLEAN and the normal flow
 * continues. A rejected probe consumes nothing on the provider side — only
 * the final clean pass creates the run's booking.
 *
 * Probes (env `placeSelectionProbes`, an ordered JSON array of keys):
 *   omitPlaceSelections      — send NO placeSelections although the offer's
 *                              reservation demands a compartment choice.
 *                              Rejection expected; acceptance WITH a
 *                              placeAllocation is OSDM-tolerated
 *                              auto-allocation (placeSelections is optional
 *                              in BookingRequest) → WARNING; acceptance with
 *                              NO allocation FAILS (ambiguous booking —
 *                              nobody knows which compartment was sold).
 *   unknownAccommodationType — ask for accommodationType 'HAMMOCK', a value
 *                              unknown to the AccommodationType code list
 *                              (x-extensible-enum). A 400 + RFC-9457 Problem
 *                              is the recommended answer; acceptance is a
 *                              WARNING (tolerant reader, provider-fair); a
 *                              5xx FAILS (crash on an unknown enum value).
 *   wrongReservationId       — reference a reservationId that exists in NO
 *                              reservation offer part of the selected offer.
 *                              Acceptance FAILS (referential integrity).
 *
 * Grading of rejections rides on validateProblemResponse (RFC-9457 shape:
 * 4xx not 5xx, Problem body, field identification) with the '🧪 Place probe'
 * prefix; every probe additionally registers ONE outcome assertion so the
 * report shows a row per probe (these are probe RESULTS, not guards — R8
 * does not apply to them; auth failures are the exception: our problem, not
 * a provider verdict, so they log a WARNING and register nothing).
 *
 * A wrongly-ACCEPTED probe created a real booking: the sweep stops (remaining
 * probes are skipped — they would create more bookings) and 02's
 * after-response falls through so the run continues with that booking.
 *
 * Auto-skips (one WARNING, no assertions): scenario sends no placeSelections
 * to corrupt; two-step return bookings (#178 — the multi-offer branching owns
 * the step); expiredOfferTest armed (the expired-flow wait owns the step).
 */
const { validationLogger } = require('./displays.js');
const { bruTest: test } = require('./testCapture.js');

const FAKE_RESERVATION_ID = 'OSCAR-PROBE-NO-SUCH-RESERVATION';

const PLACE_PROBE_DEFS = [
  {
    key: 'omitPlaceSelections',
    label: 'omit-placeSelections',
    banner: 'OMIT placeSelections entirely — the booking does not state which compartment/place is wanted',
  },
  {
    key: 'unknownAccommodationType',
    label: 'unknown-accommodation-type',
    banner: "request accommodationType 'HAMMOCK' — a value unknown to the OSDM AccommodationType code list (x-extensible-enum)",
  },
  {
    key: 'wrongReservationId',
    label: 'wrong-reservation-id',
    banner: "reference reservationId '" + FAKE_RESERVATION_ID + "' — no such reservation offer part exists in the selected offer",
  },
];

// The probes the scenario enabled, in canonical order (parser emits the keys
// already ordered, but filtering against DEFS keeps unknown keys out).
function activePlaceProbes() {
  let keys = [];
  try { keys = JSON.parse(bru.getEnvVar('placeSelectionProbes') || '[]'); } catch (_e) { keys = []; }
  if (!Array.isArray(keys)) keys = [];
  return PLACE_PROBE_DEFS.filter((d) => keys.includes(d.key));
}

/**
 * The probe the CURRENT booking-step pass must execute, or null when the
 * builder must produce a CLEAN request (sweep off / finished / step owned by
 * another flow). Shape: { def, index, total }.
 */
function placeProbeCurrent() {
  const probes = activePlaceProbes();
  if (probes.length === 0) return null;

  // Flows that own the booking step — probes stand down (warn once).
  const owned =
    // #385: a SKIPPED expired-offer timer (__expiredOfferArmed === 'false',
    // decided before the body is built) frees this step for the probes.
    (String(bru.getEnvVar('expiredOfferTest')) === 'true' && bru.getEnvVar('__expiredOfferArmed') !== 'false'
      && 'the Expired-offer timer waits past the offer deadline and grades the rejection itself')
    || ((bru.getEnvVar('inboundOfferId') && bru.getEnvVar('outboundOfferId')) && 'two-step return bookings re-run the step for the outbound/inbound legs');
  if (owned) {
    if (bru.getEnvVar('__placeProbeSkipWarned') !== 'true') {
      bru.setEnvVar('__placeProbeSkipWarned', 'true');
      validationLogger(`[WARNING] 🧪 Place-selection probes SKIPPED for this scenario — ${owned}. Run the probes on a plain one-way reservation scenario.`);
    }
    return null;
  }

  let idx = parseInt(bru.getEnvVar('__placeProbeIndex') || '0', 10);
  if (isNaN(idx) || idx < 0) idx = 0;
  if (idx >= probes.length) return null; // sweep complete → clean pass
  return { def: probes[idx], index: idx, total: probes.length };
}

/**
 * Corrupt the CLEAN booking-request body for the current probe pass (called
 * by buildBookingRequest just before the body is serialised). Returns true
 * when a corruption was applied; false when the sweep cannot run (no
 * placeSelections to corrupt → the sweep ends and the clean body goes out
 * unchanged, i.e. this very request becomes the real booking).
 */
function applyPlaceProbeCorruption(body) {
  const cur = placeProbeCurrent();
  if (!cur) return false;

  const offerEntry = (body && Array.isArray(body.offers)) ? body.offers[0] : null;
  const selections = (offerEntry && Array.isArray(offerEntry.placeSelections)) ? offerEntry.placeSelections : [];
  if (!offerEntry || selections.length === 0) {
    validationLogger('[WARNING] 🧪 Place-selection probes SKIPPED — the clean booking request carries no placeSelections to corrupt. '
      + 'Enable a place-selection flow on the scenario (e.g. an Accommodation type on an IRT/NJ trip) to make these probes meaningful.');
    bru.setEnvVar('__placeProbeIndex', String(cur.total)); // end the sweep
    return false;
  }

  validationLogger(`[WARNING] 🧪 Place-selection probe ${cur.index + 1}/${cur.total} [${cur.def.label}]: `
    + `${cur.def.banner} — expecting the provider to reject this booking.`);

  if (cur.def.key === 'omitPlaceSelections') {
    delete offerEntry.placeSelections;
  } else if (cur.def.key === 'unknownAccommodationType') {
    selections[0].accommodations = [{ accommodationType: 'HAMMOCK' }];
  } else if (cur.def.key === 'wrongReservationId') {
    selections[0].reservationId = FAKE_RESERVATION_ID;
  }

  bru.setEnvVar('placeProbeTarget', JSON.stringify({
    key: cur.def.key, label: cur.def.label, index: cur.index, total: cur.total,
  }));
  return true;
}

/**
 * Grade the response of a probe pass (called first thing by 02's
 * after-response). Returns:
 *   'off'                — not a probe pass; process the response normally.
 *   'next-probe'         — graded; loop 02 → 02 for the next probe.
 *   'clean-pass'         — last probe graded; loop 02 → 02 for the CLEAN booking.
 *   'accepted-continue'  — the corrupted request was ACCEPTED: a real booking
 *                          exists. The sweep stopped; fall through and process
 *                          this response as the run's booking.
 */
function gradePlaceProbeResponse(res) {
  let target = null;
  try { target = JSON.parse(bru.getEnvVar('placeProbeTarget') || 'null'); } catch (_e) { target = null; }
  if (!target || !target.key) return 'off';
  bru.setEnvVar('placeProbeTarget', ''); // consume — one grade per probe request

  const status = res.getStatus();
  let body = null;
  try { body = res.getBody(); } catch (_e) { body = null; }

  const probeName = `🧪 Place probe ${target.index + 1}/${target.total} [${target.label}]`;

  const advance = () => {
    const next = target.index + 1;
    bru.setEnvVar('__placeProbeIndex', String(next));
    if (next < target.total) return 'next-probe';
    validationLogger(`[INFO] 🧪 Place-selection probe sweep complete (${target.total} probe(s)) — re-running the booking step CLEAN.`);
    return 'clean-pass';
  };

  // Auth failures are OUR setup's problem, not a provider verdict — grading
  // them as probe results would mislabel the vendor. Warn, register nothing.
  if (status === 401 || status === 403) {
    validationLogger(`[WARNING] ${probeName}: got HTTP ${status} — an AUTH failure, not a place-selection rejection. `
      + 'Probe NOT graded; check the token/requestor setup.');
    return advance();
  }

  if (status >= 400) {
    // Rejected, as hoped. Outcome row + RFC-9457 shape grading (4xx not 5xx,
    // Problem body, field identification) via the shared grader.
    const rejected4xx = status < 500;
    test(`${probeName}: provider REJECTED the corrupted booking (HTTP ${status})`, () => {
      if (!rejected4xx) {
        throw new Error(`Rejected with a SERVER error (${status}) — a malformed/incoherent booking request must be answered with a 4xx Problem, not a crash.`);
      }
    });
    const { validateProblemResponse } = require('./requestedInformation.js');
    validateProblemResponse({
      status: status,
      body: body,
      targets: [], // hard grading: rejection required → 4xx + Problem body asserted
      label: target.label,
      prefix: '🧪 Place probe',
      assert: (name, ok, msg) => { test(name, () => { if (!ok) throw new Error(msg); }); },
      log: (lvl, msg) => validationLogger(`[${lvl}] ${msg}`),
    });
    if (rejected4xx) validationLogger(`[INFO] ${probeName} PASSED — provider rejected with HTTP ${status}.`);
    return advance();
  }

  // 2xx — the corrupted request was ACCEPTED: a real booking now exists.
  // Grade per probe, stop the sweep (more probes would create more bookings),
  // and let 02 process this response as the run's booking.
  bru.setEnvVar('__placeProbeIndex', String(target.total));
  const booking = (body && typeof body === 'object') ? body.booking : null;
  const bookingId = (booking && booking.id) ? booking.id : null;
  const allocations = [];
  ((booking && booking.bookedOffers) || []).forEach((bo) => {
    ((bo && bo.reservations) || []).forEach((rsv) => {
      if (rsv && rsv.placeAllocation) allocations.push(rsv.placeAllocation);
    });
  });

  if (target.key === 'omitPlaceSelections') {
    if (allocations.length > 0) {
      const a = allocations[0];
      test(`${probeName}: ACCEPTED with auto-allocation — provider chose ${a.accommodationType || '?'}/${a.accommodationSubType || '?'} itself (placeSelections is optional in BookingRequest, so this is OSDM-tolerated)`, () => {});
      validationLogger(`[WARNING] ${probeName}: the provider accepted the booking WITHOUT placeSelections and auto-allocated `
        + `${a.accommodationType || '?'}/${a.accommodationSubType || '?'} — spec-valid, but the customer never stated the compartment. Vendor-capability note.`);
    } else {
      test(`${probeName}: a reservation booking with NO compartment stated and NO allocation made must not be accepted`, () => {
        throw new Error(`HTTP ${status} accepted the booking${bookingId ? ` (${bookingId})` : ''} without placeSelections AND the booked reservation `
          + 'carries no placeAllocation — the booking is ambiguous: nobody knows which compartment/place was sold.');
      });
    }
  } else if (target.key === 'unknownAccommodationType') {
    const echoed = allocations.some((a) => String(a.accommodationType || '').toUpperCase() === 'HAMMOCK');
    if (echoed) {
      test(`${probeName}: the unknown accommodationType 'HAMMOCK' must not come back allocated`, () => {
        throw new Error(`HTTP ${status} accepted AND the booked reservation claims placeAllocation.accommodationType='HAMMOCK' — `
          + 'the provider echoes a value that exists in no code list.');
      });
    } else {
      const got = allocations[0]
        ? `${allocations[0].accommodationType || '?'}/${allocations[0].accommodationSubType || '?'}`
        : 'nothing it reports';
      test(`${probeName}: ACCEPTED — provider ignored the unknown 'HAMMOCK' and allocated ${got} (tolerant reader; rejecting with a 400 Problem is the recommended practice)`, () => {});
      validationLogger(`[WARNING] ${probeName}: the provider ACCEPTED a placeSelection asking for accommodationType 'HAMMOCK' `
        + '(unknown to the AccommodationType x-extensible-enum) instead of rejecting it. '
        + (allocations[0] ? `It allocated ${got} instead. ` : 'No placeAllocation is echoed, so what was sold is unclear. ')
        + 'A 400 RFC-9457 Problem is the recommended answer for a requested value the system does not know.');
    }
  } else if (target.key === 'wrongReservationId') {
    test(`${probeName}: a placeSelection whose reservationId exists in no offer part must be rejected`, () => {
      throw new Error(`HTTP ${status} accepted the booking${bookingId ? ` (${bookingId})` : ''} although placeSelections[0].reservationId='${FAKE_RESERVATION_ID}' `
        + 'matches NO reservation offer part of the selected offer — referential-integrity violation.');
    });
  }

  validationLogger(`[WARNING] 🧪 Place-selection probe sweep STOPPED at probe ${target.index + 1}/${target.total} — the corrupted request was `
    + `accepted and created a real booking${bookingId ? ` (${bookingId})` : ''}. Remaining probes are skipped; the run continues with this booking.`);
  return 'accepted-continue';
}

module.exports = {
  PLACE_PROBE_DEFS,
  FAKE_RESERVATION_ID,
  activePlaceProbes,
  placeProbeCurrent,
  applyPlaceProbeCorruption,
  gradePlaceProbeResponse,
};

// Expose to global for convenience in eval/require loader flows (matches the
// other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
