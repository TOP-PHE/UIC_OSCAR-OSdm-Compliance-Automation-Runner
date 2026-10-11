// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * app.js — the request handler: who is calling, for which provider, and which
 * answer they get.
 *
 * The provider is the first path segment (`/<provider>/offers`). The token
 * endpoint is `/<provider>/oauth/token`; everything else under a provider
 * needs a token that was issued for that provider. A token of provider A used
 * on provider B is refused, which is what makes a mix-up between providers in
 * the caller visible.
 *
 * The simulator never makes an outbound request.
 */

const crypto = require('node:crypto');
const { HttpError, BASE_HEADERS, sendJson, sendProblem, readBody, parseJsonObject } = require('./http');
const { clientMatches } = require('./config');
const { buildOfferCollection, productsOf } = require('./osdm/offers');
const { createBooking, confirmBooking, releaseIfExpired, addOfferParts, findPassenger, patchPassenger, setPurchaser, exchangedBookedOffer } = require('./osdm/bookings');
const { createRefundOffers, findRefundOffer, confirmRefundOffer, deleteRefundOffer } = require('./osdm/refunds');
const { reductionCardCollection } = require('./osdm/reductionCards');
const { buildTripCollection } = require('./osdm/trips');
const { fulfillmentWithDocuments, showRefundReceipt } = require('./osdm/documents');
const exchanges = require('./osdm/exchanges');
const persons = require('./osdm/persons');
const { version: VERSION } = require('../package.json');

// OSDM resources this simulator knows of and does not provide. They answer
// 501, the HTTP status for functionality a server does not support (RFC 9110
// section 15.6.2). Any other unknown path is a 404.
const NOT_PROVIDED = new Set([
  'availabilities', 'bookings-search', 'coach-deck-layouts', 'coach-layouts', 'complaints', 'fulfillments',
  'offer-overview-route', 'offer-overview-trip', 'passenger-categories', 'places', 'product-tags', 'products',
  'products-search', 'promotion-codes', 'reduction-cards', 'travel-accounts', 'trips', 'trips-collection',
  'trips-collections', 'zones',
]);
const BOOKING_PARTS_NOT_PROVIDED = new Set([
  'cancel-fulfillments-offers', 'cleanup', 'documents', 'exchange-offers', 'exchange-operations',
  'fulfillment-check', 'history', 'on-hold-offer', 'reimbursements', 'release-offers', 'split',
]);

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Not found');
// What a route returns for a 204: the answer has no body.
const NO_CONTENT = Symbol('no content');
const notProvided = () => new HttpError(501, 'NOT_IMPLEMENTED', 'Not implemented', 'This simulator does not provide this OSDM resource.');
const methodNotAllowed = (allowed) => new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', undefined, { Allow: allowed.join(', ') });

// A fixed window per caller address. It protects the process, not the
// credentials: those are long random secrets.
function createRateLimiter({ perMinute, now }) {
  const MAX_TRACKED = 20000;
  let windowStart = now();
  let counts = new Map();
  return function allow(address) {
    if (now() - windowStart >= 60000) {
      windowStart = now();
      counts = new Map();
    }
    // More distinct callers than can be tracked: refuse the new ones until the
    // window turns, instead of letting the table grow.
    if (!counts.has(address) && counts.size >= MAX_TRACKED) return false;
    const n = (counts.get(address) || 0) + 1;
    counts.set(address, n);
    return n <= perMinute;
  };
}

// Refuse a method the route does not have, naming the ones it has.
function requireMethod(req, ...allowed) {
  if (!allowed.includes(req.method)) throw methodNotAllowed(allowed);
}

// An error answer of the token endpoint (RFC 6749 section 5.2).
// GET /products, GET /products/{id} (#598)
function productRoute(req, provider, productId) {
  requireMethod(req, 'GET');
  const products = productsOf(provider);
  if (productId === undefined) return { products };
  const product = products.find((p) => p.id === productId);
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  return { product };
}

function oauthError(res, status, error, description, headers) {
  sendJson(res, status, { error, error_description: description }, { Pragma: 'no-cache', ...headers });
}

// The client id and secret of an "Authorization: Basic ..." header, or null.
function basicCredentials(header) {
  const match = /^basic +([a-z0-9+/=]+)$/i.exec(header || '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : { id: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

// The token of an "Authorization: Bearer ..." header, or '' when there is none.
function bearerToken(header) {
  const match = /^bearer +(\S+)$/i.exec(header || '');
  return match ? match[1] : '';
}

function createApp({ providers, clients, tokens, store, limits, trustProxy = false, now = Date.now, log = () => {} }) {
  const allow = createRateLimiter({ perMinute: limits.requestsPerMinute, now });

  function callerAddress(req) {
    if (trustProxy) {
      // The reverse proxy appends the address it saw; the last one is its own word.
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  // ── token endpoint (RFC 6749, client credentials) ─────────────────────────
  async function tokenEndpoint(req, res, provider, seen) {
    requireMethod(req, 'POST');
    const raw = await readBody(req, limits.bodyBytes);
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const params = type === 'application/json'
      ? parseJsonObject(raw)
      : Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    const basic = basicCredentials(req.headers.authorization);
    const id = basic ? basic.id : params.client_id;
    const secret = basic ? basic.secret : params.client_secret;
    if (!clientMatches(clients, provider.key, id, secret)) {
      oauthError(res, 401, 'invalid_client', 'Client authentication failed.',
        basic ? { 'WWW-Authenticate': 'Basic realm="osdm-simulator"' } : {});
      return 401;
    }
    seen.client = id;
    if (params.grant_type !== 'client_credentials') {
      oauthError(res, 400, 'unsupported_grant_type', 'Only client_credentials is supported.');
      return 400;
    }
    sendJson(res, 200, {
      access_token: tokens.issue(provider.key, id, provider.tokenLifetimeSeconds),
      token_type: 'Bearer',
      expires_in: provider.tokenLifetimeSeconds,
    }, { Pragma: 'no-cache' });
    return 200;
  }

  // ── OSDM routes ───────────────────────────────────────────────────────────
  function authenticate(req, provider) {
    // Checked whatever the header holds: what is not a token of ours is null.
    const claims = tokens.verify(bearerToken(req.headers.authorization));
    const known = claims?.provider === provider.key && clients.get(provider.key)?.has(claims.clientId);
    if (!known) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required',
        'A valid access token issued for this provider is required.', { 'WWW-Authenticate': 'Bearer' });
    }
    return claims.clientId;
  }

  const bodyOf = async (req) => parseJsonObject(await readBody(req, limits.bodyBytes));

  function bookingOf(scope, bookingId) {
    const booking = store.get('booking', scope, bookingId);
    // Unknown, expired, or another client's: the same answer for all three.
    if (!booking) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    return booking;
  }

  // #604: a request carrying an Idempotency-Key gets, the second time, the
  // answer it got the first time, on a provider that keeps them. The same key
  // with another body (or for another request) is refused.
  async function idempotent(req, provider, scope, what, answer) {
    const raw = await readBody(req, limits.bodyBytes);
    const key = req.headers['idempotency-key'];
    if (!provider.idempotency || key === undefined) return answer(parseJsonObject(raw));
    if (typeof key !== 'string' || key.length === 0 || key.length > 100) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'The request is not valid', 'The Idempotency-Key header is not valid.');
    }
    const fingerprint = crypto.createHash('sha256').update(what).update('\n').update(raw).digest('hex');
    const kept = store.get('idempotency', scope, key);
    if (kept) {
      if (kept.fingerprint !== fingerprint) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused', 'This Idempotency-Key was used for another request.');
      }
      return structuredClone(kept.answer);
    }
    const result = answer(parseJsonObject(raw));
    // The answer as it was: the booking changes afterwards.
    store.put('idempotency', scope, key, { fingerprint, answer: structuredClone(result) });
    return result;
  }

  // POST /bookings
  async function newBooking(req, provider, scope) {
    requireMethod(req, 'POST');
    return idempotent(req, provider, scope, 'POST /bookings', (body) => {
      const booking = createBooking(body, (offerId) => store.get('offer', scope, offerId), provider, now());
      store.put('booking', scope, booking.id, booking);
      return { booking };
    });
  }

  // POST /bookings/{id}/fulfillments; the documents with them (#603).
  async function fulfillments(req, provider, scope, bookingId) {
    requireMethod(req, 'POST');
    return idempotent(req, provider, scope, `POST /bookings/${bookingId}/fulfillments`, () => {
      const booking = bookingOf(scope, bookingId);
      // #611: with an exchange pre-booked, this confirms the exchange.
      const pending = exchanges.pendingExchange(booking);
      if (pending) return { fulfillments: exchanges.confirmExchange(booking, pending, provider, now(), (entry) => exchangedBookedOffer(booking, entry, now())) };
      const issued = confirmBooking(booking, provider, now());
      for (const fulfillment of issued) store.put('fulfillment', scope, fulfillment.id, booking.id);
      return booking.fulfillmentDocuments ? { fulfillments: issued, fulfillmentDocuments: booking.fulfillmentDocuments } : { fulfillments: issued };
    });
  }

  // GET /fulfillments/{id} (#603): one fulfilment of this client's bookings.
  function fulfillmentRoute(req, scope, fulfillmentId) {
    requireMethod(req, 'GET');
    const bookingId = store.get('fulfillment', scope, fulfillmentId);
    const booking = bookingId && store.get('booking', scope, bookingId);
    const fulfillment = booking?.fulfillments.find((f) => f.id === fulfillmentId);
    if (!fulfillment) throw new HttpError(404, 'FULFILLMENT_NOT_FOUND', 'Fulfillment not found');
    return fulfillmentWithDocuments(booking, fulfillment);
  }

  // GET, PATCH /bookings/{id}/passengers/{id}
  async function passenger(req, provider, scope, bookingId, passengerId) {
    requireMethod(req, 'GET', 'PATCH');
    const booking = bookingOf(scope, bookingId);
    if (req.method === 'GET') return { passenger: findPassenger(booking, passengerId) };
    const body = await bodyOf(req);
    // #611: the values checked, and the demanded fields on the result, before anything changes.
    persons.checkPassengerPatch(body, provider);
    persons.checkDemanded(booking, patchPassenger(structuredClone(booking), passengerId, body));
    const patched = patchPassenger(booking, passengerId, body);
    persons.showRequestedInformation(booking);
    return { passenger: patched };
  }

  // GET, PATCH, POST /bookings/{id}/purchaser
  async function purchaser(req, provider, scope, bookingId) {
    requireMethod(req, 'GET', 'PATCH', 'POST');
    const booking = bookingOf(scope, bookingId);
    if (req.method === 'GET') {
      if (!booking.purchaser) throw new HttpError(404, 'PURCHASER_NOT_FOUND', 'Purchaser not found', 'This booking has no purchaser yet.');
      return { purchaser: booking.purchaser };
    }
    const body = await bodyOf(req);
    persons.checkPurchaser(body, provider);
    return { purchaser: setPurchaser(booking, body) };
  }

  // POST, GET /bookings/{id}/refund-offers; GET, PATCH, DELETE .../{refundOfferId}
  async function refundOffers(req, provider, scope, bookingId, refundOfferId) {
    const booking = bookingOf(scope, bookingId);
    if (refundOfferId === undefined) {
      requireMethod(req, 'POST', 'GET');
      if (req.method === 'GET') return { refundOffers: booking.refundOffers || [] };
      return { refundOffers: createRefundOffers(booking, await bodyOf(req), provider, now()) };
    }
    requireMethod(req, 'GET', 'PATCH', 'DELETE');
    if (req.method === 'GET') return { refundOffer: findRefundOffer(booking, refundOfferId) };
    if (req.method === 'PATCH') return { refundOffer: confirmRefundOffer(booking, refundOfferId, await bodyOf(req), provider, now()) };
    deleteRefundOffer(booking, refundOfferId);
    return NO_CONTENT;
  }

  // #611: POST .../exchange-offers; POST .../exchange-operations; GET, DELETE
  // .../exchange-operations/{id}, on a provider that exchanges.
  async function exchangeRoute(req, provider, scope, bookingId, part, operationId) {
    const booking = bookingOf(scope, bookingId);
    if (part === 'exchange-offers') {
      if (operationId !== undefined) throw notFound();
      requireMethod(req, 'POST');
      const known = { trip: (id) => store.get('trip', scope, id) };
      return { exchangeOffers: exchanges.createExchangeOffers(booking, await bodyOf(req), provider, now(), known) };
    }
    if (operationId === undefined) {
      requireMethod(req, 'POST');
      return { exchangeOperation: exchanges.createExchangeOperation(booking, await bodyOf(req), provider, now()) };
    }
    requireMethod(req, 'GET', 'DELETE');
    if (req.method === 'GET') return { exchangeOperation: exchanges.findExchangeOperation(booking, operationId) };
    exchanges.deleteExchangeOperation(booking, operationId);
    return NO_CONTENT;
  }

  // POST /bookings/{id}/booked-offers/{bookedOfferId}/offer-parts (#601); the
  // other booked-offer resources are not provided.
  async function bookedOfferRoute(req, scope, bookingId, bookedOfferId, more) {
    if (bookedOfferId === undefined || more.length !== 1 || more[0] !== 'offer-parts') throw notProvided();
    requireMethod(req, 'POST');
    const booking = bookingOf(scope, bookingId);
    return addOfferParts(booking, bookedOfferId, await bodyOf(req), (offerId) => store.get('offer', scope, offerId));
  }

  async function bookingRoute(req, provider, scope, rest) {
    const [bookingId, part, partId, ...more] = rest;
    if (bookingId === undefined) return newBooking(req, provider, scope);
    if (part === undefined) {
      requireMethod(req, 'GET');
      const booking = bookingOf(scope, bookingId);
      releaseIfExpired(booking, now());
      persons.showRequestedInformation(booking);
      showRefundReceipt(booking, provider, now());
      return { booking };
    }
    if (provider.exchange && (part === 'exchange-offers' || part === 'exchange-operations') && more.length === 0) {
      return exchangeRoute(req, provider, scope, bookingId, part, partId);
    }
    if (BOOKING_PARTS_NOT_PROVIDED.has(part)) throw notProvided();
    if (part === 'booked-offers') return bookedOfferRoute(req, scope, bookingId, partId, more);
    if (more.length > 0) throw notFound();
    if (part === 'fulfillments' && partId === undefined) return fulfillments(req, provider, scope, bookingId);
    if (part === 'passengers' && partId !== undefined) return passenger(req, provider, scope, bookingId, partId);
    if (part === 'purchaser' && partId === undefined) return purchaser(req, provider, scope, bookingId);
    if (part === 'refund-offers') return refundOffers(req, provider, scope, bookingId, partId);
    throw notFound();
  }

  // POST /offers
  async function offerRoute(req, provider, scope) {
    requireMethod(req, 'POST');
    const known = {
      offer: (id) => store.get('offer', scope, id),
      trip: (id) => store.get('trip', scope, id),
    };
    const { response, remembered, trips } = buildOfferCollection(await bodyOf(req), provider, now(), known);
    for (const entry of remembered) store.put('offer', scope, entry.offer.offerId, entry);
    for (const trip of trips) store.put('trip', scope, trip.id, trip);
    return response;
  }

  // POST /trips-collection (#602): its trips are remembered, so that offers
  // can be asked for them by id.
  async function tripCollectionRoute(req, provider, scope) {
    requireMethod(req, 'POST');
    const { response, trips } = buildTripCollection(await bodyOf(req), provider);
    for (const trip of trips) store.put('trip', scope, trip.id, trip);
    return response;
  }

  async function osdmRoute(req, provider, clientId, segments) {
    const scope = `${provider.key}\n${clientId}`;
    const [resource, ...rest] = segments;
    if (resource === 'versions' && rest.length === 0) {
      requireMethod(req, 'GET');
      return [{ version: provider.osdmVersion }];
    }
    // #598: a provider with named products lists them; the others answer 501.
    if (resource === 'products' && rest.length <= 1 && provider.products) return productRoute(req, provider, rest[0]);
    // #597: a provider with reduction cards lists them; the others answer 501.
    if (resource === 'reduction-cards' && rest.length === 0 && provider.reductionCards) {
      requireMethod(req, 'GET');
      return reductionCardCollection(provider);
    }
    if (resource === 'offers' && rest.length === 0) return offerRoute(req, provider, scope);
    // #602: a provider with a trip search answers it; the others answer 501.
    if (resource === 'trips-collection' && rest.length === 0 && provider.tripsCollection) return tripCollectionRoute(req, provider, scope);
    if (resource === 'bookings') return bookingRoute(req, provider, scope, rest);
    // #603: a provider that issues documents answers GET /fulfillments/{id}.
    if (resource === 'fulfillments' && rest.length === 1 && provider.documents) return fulfillmentRoute(req, scope, rest[0]);
    if (NOT_PROVIDED.has(resource)) throw notProvided();
    throw notFound();
  }

  // ── entry point ───────────────────────────────────────────────────────────
  // `seen` collects, for the log line, the provider and the client as soon as
  // each is known, so that a refused request is attributed too.
  async function dispatch(req, res, seen) {
    let pathname;
    let segments;
    try {
      pathname = new URL(req.url, 'https://simulator.invalid').pathname;
      if (pathname.length > 512) throw new Error('too long');
      segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'BAD_REQUEST', 'The request path is not valid');
    }
    if (segments.length === 1 && segments[0] === 'healthz') {
      requireMethod(req, 'GET');
      // #617: the version, so that an installed simulator can be told apart.
      sendJson(res, 200, { status: 'ok', version: VERSION });
      return 200;
    }
    if (!allow(callerAddress(req))) {
      throw new HttpError(429, 'TOO_MANY_REQUESTS', 'Too many requests', undefined, { 'Retry-After': '60' });
    }
    const provider = providers.get(segments[0]);
    if (!provider) throw notFound();
    seen.provider = provider.key;
    if (segments.length === 3 && segments[1] === 'oauth' && segments[2] === 'token') {
      return tokenEndpoint(req, res, provider, seen);
    }
    seen.client = authenticate(req, provider);
    const answer = await osdmRoute(req, provider, seen.client, segments.slice(1));
    if (answer === NO_CONTENT) {
      res.writeHead(204, BASE_HEADERS);
      res.end();
      return 204;
    }
    sendJson(res, 200, answer);
    return 200;
  }

  return async function handle(req, res) {
    const started = now();
    const seen = {};
    let status;
    let failure;
    try {
      status = await dispatch(req, res, seen);
    } catch (error) {
      const headers = { ...(error instanceof HttpError ? error.headers : {}) };
      // A request refused before its body was read must not be followed by
      // another on the same connection: the rest of that body is still coming.
      if (!req.complete) headers.Connection = 'close';
      if (res.headersSent) {
        res.destroy();
      } else if (error instanceof HttpError) {
        sendProblem(res, error.status, error.code, error.title, error.detail, headers, error.extra);
      } else {
        sendProblem(res, 500, 'INTERNAL_ERROR', 'Internal error', undefined, headers);
      }
      status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) failure = error;
    }
    // The path without its query string; never a header, never a body.
    log({
      method: req.method,
      path: String(req.url || '').split('?')[0].slice(0, 200),
      status,
      ms: now() - started,
      provider: seen.provider,
      client: seen.client,
      error: failure,
    });
  };
}

module.exports = { createApp, createRateLimiter };
