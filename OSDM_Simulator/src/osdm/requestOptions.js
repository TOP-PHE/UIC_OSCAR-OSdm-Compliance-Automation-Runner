'use strict';

/**
 * requestOptions.js — what the provider does with optional members of the
 * offer request (#227), for trips from one stop place (`requestOptions.from`
 * in the profile).
 *
 * OSCAR's offer request options scenario sends each optional member alone and
 * classifies the answer; each behaviour here gives one of its classes:
 *   ignore-silent   the member is dropped, nothing said (offers do not keep to it)
 *   ignore-said     the member is dropped, a PARAMETER_NOT_SUPPORTED warning names it
 *   not-implemented 501
 *   error           500
 *   no-offer-said   no offer, a warning says why
 *   no-offer-silent no offer, nothing said
 *   refuse-unknown  400 for a code not in `promotionCodes` (the promotion codes)
 * A member the profile does not name is answered as anywhere else.
 */

const { HttpError } = require('../http');

// Where a member lives in the request: "passenger.<m>" on each passenger,
// "offerSearchCriteria.<m>" / "tripSearchCriteria.<m>" in those objects, else
// at the root.
function presentIn(body, member) {
  const [head, tail] = member.split('.');
  if (!tail) return body?.[head] !== undefined;
  if (head === 'passenger') return (body?.anonymousPassengerSpecifications || []).some((p) => p && p[tail] !== undefined);
  return body?.[head] && typeof body[head] === 'object' && body[head][tail] !== undefined;
}

function without(body, member) {
  const copy = JSON.parse(JSON.stringify(body));
  const [head, tail] = member.split('.');
  if (!tail) {
    delete copy[head];
  } else if (head === 'passenger') {
    for (const p of copy.anonymousPassengerSpecifications || []) {
      if (p) delete p[tail];
    }
  } else if (copy[head] && typeof copy[head] === 'object') {
    delete copy[head][tail];
  }
  return copy;
}

const pointerOf = (member) => {
  const [head, tail] = member.split('.');
  if (!tail) return `/${head}`;
  return head === 'passenger' ? `/anonymousPassengerSpecifications/0/${tail}` : `/${head}/${tail}`;
};

const ignoredProblem = (member) => ({
  code: 'PARAMETER_NOT_SUPPORTED',
  title: `Parameter '${member}' was ignored.`,
  detail: `This provider does not support '${member}'; the offers are given without it.`,
  pointers: [{ requestPointer: pointerOf(member) }],
});

/**
 * The request as the provider reads it, and what it adds to the answer:
 * { body, problems, noOffer }. Throws an HttpError for the behaviours that
 * refuse the request.
 */
function applyRequestOptions(body, trips, provider) {
  const options = provider.requestOptions;
  if (!options || !trips.some((t) => t.origin?.stopPlaceRef === options.from)) return { body, problems: [], noOffer: false };
  let read = body;
  const problems = [];
  let noOffer = false;
  for (const [member, behaviour] of Object.entries(options.members)) {
    if (!presentIn(body, member)) continue;
    if (behaviour === 'not-implemented') throw new HttpError(501, 'NOT_IMPLEMENTED', 'Not implemented', `This provider does not implement '${member}' in an offer request.`);
    if (behaviour === 'error') throw new HttpError(500, 'INTERNAL_ERROR', 'Internal error', 'The offer request could not be handled.');
    if (behaviour === 'refuse-unknown') {
      const unknown = (body.promotionCodes || []).map((c) => c?.code).find((c) => !options.promotionCodes.includes(c));
      if (unknown !== undefined) throw new HttpError(400, 'PROMOTION_CODE_UNKNOWN', 'Promotion code unknown', `The promotion code "${unknown}" is not known.`);
      continue;
    }
    if (behaviour === 'ignore-silent' || behaviour === 'ignore-said') read = without(read, member);
    if (behaviour === 'ignore-said') problems.push(ignoredProblem(member));
    if (behaviour === 'no-offer-said') {
      noOffer = true;
      problems.push({ code: 'NO_OFFER_FOUND', title: 'No offer found', detail: `No offer is sold for the '${member}' asked; asked without it, offers are available.` });
    }
    if (behaviour === 'no-offer-silent') noOffer = true;
  }
  return { body: read, problems, noOffer };
}

module.exports = { applyRequestOptions };
