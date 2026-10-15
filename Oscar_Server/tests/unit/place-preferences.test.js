'use strict';

/**
 * #766 PR 2 — seat preferences: asked in the booking among those the offer
 * lists, narrowed by GET /availabilities/preferences in the PREFERENCES flow,
 * and looked for in the places booked. Warnings, never a failure, except a
 * preferences request that answers an error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { placeSelectionFlowOf } = require('../../src/utils/frameworkGating');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');
const ps = require(path.join(LIB, 'placeSelection.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const part = (over = {}) => ({ id: 'R1', passengerRefs: ['P1', 'P2'], ...over });
const groups = (...g) => [{ preferenceGroups: g.map(([preferenceGroup, preferences]) => ({ preferenceGroup, preferences })) }];

describe('#766 PR 2 — the scenario', () => {
  test('preferences are a list or text, upper case, each once', () => {
    expect(ps.preferencesOfScenario({ placePreferences: ['window', 'WINDOW', ' power ', '', 3] })).toEqual(['WINDOW', 'POWER']);
    expect(ps.preferencesOfScenario({ placePreferences: 'window, power;TABLE  aisle' })).toEqual(['WINDOW', 'POWER', 'TABLE', 'AISLE']);
    expect(ps.preferencesOfScenario({})).toEqual([]);
    expect(ps.preferencesOfScenario(null)).toEqual([]);
  });

  test('preferences make the flow automatic, on both sides; a flow named wins', () => {
    for (const [sc, flow] of [
      [{ placePreferences: ['WINDOW'] }, 'AUTOMATIC_PLACE_SELECTION'],
      [{ placePreferences: 'WINDOW' }, 'AUTOMATIC_PLACE_SELECTION'],
      [{ placePreferences: [] }, null],
      [{ placePreferences: ' , ' }, null],
      [{ placePreferences: ['WINDOW'], placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_PREFERENCES' }, 'AUTOMATIC_PLACE_SELECTION_PREFERENCES'],
    ]) {
      expect(ps.flowOfScenario(sc)).toBe(flow);
      expect(placeSelectionFlowOf(sc)).toBe(flow);
    }
  });
});

describe('#766 PR 2 — what the offer lists', () => {
  test('availablePlacePreferences is a list in OSDM 3.8; a single object is read too', () => {
    const offer = { reservationOfferParts: [part({ availablePlacePreferences: groups(['POSITION', ['WINDOW', 'AISLE']], ['ZONE', ['TABLE']]) })] };
    expect(ps.preferencesOffered(offer)).toEqual({ POSITION: ['WINDOW', 'AISLE'], ZONE: ['TABLE'] });
    const single = { reservationOfferParts: [part({ availablePlacePreferences: groups(['POSITION', ['WINDOW']])[0] })] };
    expect(ps.preferencesOffered(single)).toEqual({ POSITION: ['WINDOW'] });
  });

  test('a part offers the codes of its groups and of its available places', () => {
    expect(ps.propertiesOfPart(part({
      availablePlacePreferences: groups(['POSITION', ['window']]),
      availablePlaces: [{ accommodationType: 'SEAT', placeProperties: ['POWER', 'WINDOW'] }, {}],
    }))).toEqual(['WINDOW', 'POWER']);
    expect(ps.propertiesOfPart(null)).toEqual([]);
  });

  test('those offered are sent; one not offered is a warning; an offer listing none sends all', () => {
    const offer = { reservationOfferParts: [part({ availablePlacePreferences: groups(['POSITION', ['WINDOW', 'AISLE']]) })] };
    const chosen = ps.choosePreferences(offer, ['window', 'UPPER_DECK']);
    expect(chosen.send).toEqual(['WINDOW']);
    expect(chosen.notOffered).toEqual(['UPPER_DECK']);
    expect(chosen.lines.map((l) => l.level)).toEqual(['INFO', 'WARNING']);
    expect(chosen.lines[1].text).toBe('Seat preference UPPER_DECK: the offer does not list it (it lists WINDOW, AISLE); it is not asked, and the customer cannot have it.');
    const silent = ps.choosePreferences({ reservationOfferParts: [part()] }, ['WINDOW']);
    expect([silent.send, silent.lines.map((l) => l.level)]).toEqual([['WINDOW'], ['INFO']]);
    const none = ps.choosePreferences({ reservationOfferParts: [] }, ['WINDOW']);
    expect([none.send, none.lines.map((l) => l.level)]).toEqual([[], ['WARNING']]);
    expect(ps.choosePreferences(offer, [])).toEqual({ send: [], notOffered: [], lines: [] });
  });
});

describe('#766 PR 2 — the booking request', () => {
  const offer = { reservationOfferParts: [part({ availablePlaces: [{ accommodationType: 'COUCHETTE', accommodationSubType: 'C4' }, { accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT' }] }), part({ id: 'R2', passengerRefs: [] })] };
  const sel = (reservationId, extra = {}) => ({ reservationId, tripLegCoverage: { tripId: 'T', legId: 'L' }, ...extra });

  test('a selection without accommodations gets one for its part\'s passengers, typed from its seat places', () => {
    expect(ps.withPreferences([sel('R1')], offer, ['WINDOW'], ['P1', 'P2'])).toEqual([sel('R1', {
      accommodations: [{ passengerRefs: ['P1', 'P2'], accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', placeProperties: ['WINDOW'] }],
    })]);
  });

  test('a part naming no passenger takes the booking\'s; references unknown to the booking keep the part\'s', () => {
    expect(ps.withPreferences([sel('R2')], offer, ['WINDOW'], ['P9'])[0].accommodations[0].passengerRefs).toEqual(['P9']);
    expect(ps.withPreferences([sel('R1')], offer, ['WINDOW'], ['X'])[0].accommodations[0].passengerRefs).toEqual(['P1', 'P2']);
    expect(ps.withPreferences([sel('R2')], offer, ['WINDOW'], [])).toEqual([sel('R2')]);
  });

  test('accommodations already there get the preferences added; other selections are left alone', () => {
    const couchette = sel('R1', { accommodations: [{ passengerRefs: ['P1'], accommodationType: 'COUCHETTE', accommodationSubType: 'ANY_SEAT', placeProperties: ['MEN'] }] });
    expect(ps.withPreferences([couchette, sel('ZZ')], offer, ['LOWER'], [])).toEqual([
      sel('R1', { accommodations: [{ passengerRefs: ['P1'], accommodationType: 'COUCHETTE', accommodationSubType: 'ANY_SEAT', placeProperties: ['MEN', 'LOWER'] }] }),
      sel('ZZ'),
    ]);
    const asIs = [sel('R1')];
    expect(ps.withPreferences(asIs, offer, [], ['P1'])).toBe(asIs);
  });

  test('no seat place in the part: SEAT / ANY_SEAT', () => {
    const plain = { reservationOfferParts: [part()] };
    expect(ps.withPreferences([sel('R1')], plain, ['WINDOW'], ['P1'])[0].accommodations[0]).toEqual(
      { passengerRefs: ['P1'], accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', placeProperties: ['WINDOW'] });
  });
});

describe('#766 PR 2 — GET /availabilities/preferences', () => {
  test('the query names the offer and the reservation, encoded', () => {
    expect(ps.preferencesQuery('O 1', 'R&2')).toBe('/availabilities/preferences?contextId=O%201&contextType=OFFER&resourceId=R%262&resourceType=RESERVATION');
  });

  test('a preference it no longer gives is a warning and is dropped', () => {
    const body = { availablePlaces: [{ accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', placeProperties: ['window', 'POWER'], tripLegCoverage: { tripId: 'T', legId: 'L' } }] };
    const out = ps.checkPreferenceAvailability(200, body, 'R1', ['WINDOW', 'TABLE']);
    expect(out.available).toEqual(['WINDOW']);
    expect(out.checks.every((c) => c.ok)).toBe(true);
    expect(out.checks.map((c) => c.name)).toEqual([
      'GET /availabilities/preferences (reservation R1) is answered with 2xx',
      'GET /availabilities/preferences (reservation R1): availablePlaces is a list',
      'GET /availabilities/preferences (reservation R1): each available place names its accommodation type, sub-type and leg',
    ]);
    expect(out.lines).toEqual([{ level: 'WARNING', text: 'Seat preference TABLE: listed by the offer, but no longer available (GET /availabilities/preferences (reservation R1) gives WINDOW, POWER); it is not asked.' }]);
  });

  test('a place without its required members fails; an answer with no property leaves the choice', () => {
    const out = ps.checkPreferenceAvailability(200, { availablePlaces: [{ accommodationType: 'SEAT' }] }, 'R1', ['WINDOW']);
    expect(out.checks.find((c) => !c.ok).message).toBe('incomplete: availablePlaces[0]');
    expect(out.available).toEqual(['WINDOW']);
    expect(out.lines[0].level).toBe('INFO');
    expect(ps.checkPreferenceAvailability(200, {}, 'R1', ['WINDOW']).checks[1]).toMatchObject({ ok: false, message: 'availablePlaces is absent' });
  });

  test('501, 404, 405: not provided, a warning; another error fails; both keep the choice', () => {
    for (const status of [404, 405, 501]) {
      const out = ps.checkPreferenceAvailability(status, null, 'R1', ['WINDOW']);
      expect([out.checks, out.available, out.lines[0].level]).toEqual([[], ['WINDOW'], 'WARNING']);
    }
    const failed = ps.checkPreferenceAvailability(500, null, 'R1', ['WINDOW']);
    expect(failed.checks).toEqual([{ name: 'GET /availabilities/preferences (reservation R1) is answered with 2xx', ok: false, message: 'HTTP 500' }]);
    expect(failed.available).toEqual(['WINDOW']);
  });
});

describe('#766 PR 2 — the places booked', () => {
  const booking = (places) => ({ bookedOffers: [{ reservations: [{ id: 'B1', placeAllocation: { reservedPlaces: places } }] }] });

  test('given: passes; missing or unnamed: a warning naming what was given', () => {
    expect(ps.checkPreferencesGiven(booking([{ placeProperties: ['window'] }]), ['B1'], ['WINDOW'])).toEqual([
      { name: 'Booking: reservation B1 gives the seat preferences asked (WINDOW)', ok: true, level: 'warn', message: 'not given: ; its places name WINDOW' },
    ]);
    const [missing] = ps.checkPreferencesGiven(booking([{ placeProperties: ['AISLE'] }]), ['B1'], ['WINDOW', 'POWER']);
    expect([missing.ok, missing.message]).toEqual([false, 'not given: WINDOW, POWER; its places name AISLE']);
    expect(ps.checkPreferencesGiven(booking([{}]), ['B1'], ['WINDOW'])[0].message).toBe('not given: WINDOW; its places name no property');
  });

  test('a booking that renamed the reservation: every reservation is looked at; nothing asked, nothing checked', () => {
    expect(ps.checkPreferencesGiven(booking([{ placeProperties: ['WINDOW'] }]), ['R1'], ['WINDOW'])[0].ok).toBe(true);
    expect(ps.checkPreferencesGiven(booking([]), ['B1'], [])).toEqual([]);
  });
});

describe('#766 PR 2 — with the simulator\'s answers', () => {
  const SIM = path.join(ROOT, 'OSDM_Simulator');
  const { loadProviders } = require(path.join(SIM, 'src', 'config'));
  const { buildOfferCollection } = require(path.join(SIM, 'src', 'osdm', 'offers'));
  const { createBooking } = require(path.join(SIM, 'src', 'osdm', 'bookings'));
  const { preferenceAvailability } = require(path.join(SIM, 'src', 'osdm', 'reservations'));
  const gamma = loadProviders(path.join(SIM, 'providers')).get('gamma');
  const leg = {
    timedLeg: {
      start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000092' }, serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+02:00' } },
      end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T10:00:00+02:00' } },
      service: { vehicleNumbers: ['511'], productCategory: { name: 'SC', shortName: 'SC' } },
    },
  };

  test('offered, narrowed, sent and given end to end', () => {
    const { response, remembered } = buildOfferCollection({
      anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }],
      tripSpecifications: [{ legs: [leg] }],
    }, gamma, Date.parse('2026-10-11T08:00:00Z'));
    const offer = response.offers[0];
    const found = remembered.find((e) => e.offer.offerId === offer.offerId);
    const chosen = ps.choosePreferences(offer, ['WINDOW', 'TABLE', 'UPPER_DECK']);
    expect([chosen.send, chosen.notOffered]).toEqual([['WINDOW', 'TABLE'], ['UPPER_DECK']]);
    const resId = offer.reservationOfferParts[0].id;
    const answer = preferenceAvailability(new URLSearchParams(ps.preferencesQuery(offer.offerId, resId).split('?')[1]), found, gamma);
    const narrowed = ps.checkPreferenceAvailability(200, answer, resId, chosen.send);
    expect(narrowed.checks.every((c) => c.ok)).toBe(true);
    expect(narrowed.available).toEqual(['WINDOW']);
    const trip = response.trips[0];
    const selections = ps.withPreferences([{ reservationId: resId, tripLegCoverage: { tripId: trip.id, legId: trip.legs[0].id } }], offer, narrowed.available, ['P1']);
    const booking = createBooking({
      offers: [{ offerId: offer.offerId, passengerRefs: ['P1'], placeSelections: selections }],
      passengerSpecifications: [{ externalRef: 'P1', type: 'PERSON', detail: { firstName: 'A', lastName: 'B' } }],
    }, () => found, gamma, Date.parse('2026-10-11T08:00:00Z'));
    expect(ps.checkPreferencesGiven(booking, [resId], narrowed.available).map((c) => c.ok)).toEqual([true]);
  });
});

describe('#766 PR 2 — the collection wiring', () => {
  test('parser: the preferences, PLACE_SELECTION by default, the new variables in both reset lists', () => {
    const parser = read('Bruno_Collection', 'library-bruno', 'scenarioParser.js');
    expect(parser).toContain('bru.setEnvVar("placePreferences", JSON.stringify(_placePreferences));');
    expect(parser).toContain('|| (_placePreferences.length > 0 ? "PLACE_SELECTION" : null));');
    const vars = '"placeSelectionFlow", "placePreferences", "__placePreferencesSent", "__placePreferencesFor", "__placePreferencesAskedFor", "__placePreferencesOutcome", "reservationBookingForm"';
    for (const text of [parser, read('Bruno_Collection', 'opencollection.yml')]) expect(text).toContain(vars);
  });

  test('02 asks the availability before building the booking and records it after; 07 looks at the places', () => {
    const step02 = read('Bruno_Collection', '02-Common Requests', '02. POST Create Booking.yml');
    expect(step02.indexOf('offers.js").askPlacePreferences();')).toBeGreaterThan(-1);
    expect(step02.indexOf('offers.js").askPlacePreferences();')).toBeLessThan(step02.indexOf('        buildBookingRequest();'));
    expect(step02).toContain('offers.js").recordPlacePreferenceChecks();');
    expect(read('Bruno_Collection', '02-Common Requests', '07. GET Booking after Fulfillments.yml')).toContain('placeSelection.js").checkPreferencesGiven(');
    expect(read('Bruno_Collection', 'library-bruno', 'requestsBuilder.js')).toContain('const placeSelections = withSeatPreferences([...seatMapSelections,');
  });

  function withBru(env, run, sendRequest) {
    const logs = [];
    global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; }, sendRequest };
    global.validationLogger = (l) => logs.push(l);
    global.test = (name, fn) => { try { fn(); logs.push(`PASS ${name}`); } catch (e) { logs.push(`FAIL ${name}: ${e.message}`); } };
    let result;
    jest.isolateModules(() => {
      jest.doMock(path.join(LIB, 'displays.js'), () => ({ validationLogger: (l) => logs.push(l), logStepStart: () => {} }));
      result = run(require(path.join(LIB, 'offers.js')));
    });
    return { logs, result };
  }
  afterEach(() => { delete global.bru; delete global.test; delete global.validationLogger; });

  test('the offer step keeps the preferences the offer lists and warns of the others', () => {
    const env = {
      placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION',
      placePreferences: '["WINDOW","UPPER_DECK"]',
      offer: JSON.stringify({ reservationOfferParts: [part({ supportedPlaceSelectionFlows: ['AUTOMATIC_PLACE_SELECTION'], availablePlacePreferences: groups(['POSITION', ['WINDOW']]) })] }),
    };
    const { logs } = withBru(env, (offers) => offers.checkOfferPlaceSelection());
    expect(env.__placePreferencesSent).toBe('["WINDOW"]');
    expect(logs.filter((l) => l.startsWith('[WARNING]'))).toEqual(['[WARNING] Seat preference UPPER_DECK: the offer does not list it (it lists WINDOW); it is not asked, and the customer cannot have it.']);
    const cleared = { offer: env.offer, __placePreferencesSent: '["X"]' };
    withBru(cleared, (offers) => offers.checkOfferPlaceSelection());
    expect(cleared.__placePreferencesSent).toBe('[]');
  });

  test('the PREFERENCES flow asks once per offer, narrows, and 02 records the checks once', async () => {
    const env = {
      placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_PREFERENCES',
      __placePreferencesSent: '["WINDOW","TABLE"]',
      offerId: 'O1',
      api_base: 'https://p.example/osdm',
      access_token: 'tok',
      reservationPlaceSelections: '[{"reservationId":"R1"}]',
    };
    const urls = [];
    const send = (req, cb) => {
      urls.push([req.method, req.url, req.headers.Authorization, 'Requestor' in req.headers]);
      cb(null, { status: 200, data: JSON.stringify({ availablePlaces: [{ accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', placeProperties: ['WINDOW'], tripLegCoverage: { tripId: 'T', legId: 'L' } }] }) });
    };
    let logs = [];
    let ask;
    ({ logs, result: ask } = withBru(env, (offers) => offers.askPlacePreferences(), send));
    await ask;
    expect(urls).toEqual([['GET', 'https://p.example/osdm/availabilities/preferences?contextId=O1&contextType=OFFER&resourceId=R1&resourceType=RESERVATION', 'Bearer tok', false]]);
    expect(env.__placePreferencesSent).toBe('["WINDOW"]');
    expect(logs.some((l) => l.startsWith('[WARNING] Seat preference TABLE: listed by the offer, but no longer available'))).toBe(true);
    ({ result: ask } = withBru(env, (offers) => offers.askPlacePreferences(), send));
    await ask;
    expect(urls).toHaveLength(1);
    const recorded = withBru(env, (offers) => offers.recordPlacePreferenceChecks()).logs.filter((l) => !l.startsWith('[DEBUG]'));
    expect(recorded).toHaveLength(3);
    expect(recorded.every((l) => l.startsWith('PASS '))).toBe(true);
    expect(withBru(env, (offers) => offers.recordPlacePreferenceChecks()).logs).toEqual([]);
  });

  test('another flow, nothing to send, or no reservation placed: nothing is asked', async () => {
    const calls = [];
    const send = () => calls.push(1);
    for (const env of [
      { placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION', __placePreferencesSent: '["WINDOW"]', offerId: 'O1' },
      { placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_PREFERENCES', __placePreferencesSent: '[]', offerId: 'O1' },
      { placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_PREFERENCES', __placePreferencesSent: '["WINDOW"]', offerId: 'O1' },
    ]) {
      await withBru(env, (offers) => offers.askPlacePreferences(), send).result;
    }
    expect(calls).toEqual([]);
  });
});
