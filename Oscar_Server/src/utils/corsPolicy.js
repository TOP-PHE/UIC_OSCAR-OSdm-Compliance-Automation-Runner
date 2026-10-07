// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * corsPolicy.js — the CORS options for the app (tracker S7-cors, v1.11.212).
 *
 * When ALLOWED_ORIGINS was unset the app used `origin: true` with
 * `credentials: true`: the Access-Control-Allow-Origin header was reflected back
 * to ANY site, with credentials permitted. That lets any web page a signed-in
 * user visits make credentialed cross-origin calls to the API.
 *
 * OSCAR is served same-origin — nginx fronts the SPA and the API on one host
 * (see OSCAR_Deploy/nginx/oscar.conf.example) — so when no allowlist is
 * configured the safe default is to permit no cross-origin at all. Same-origin
 * requests carry no Origin the browser enforces, so the app keeps working; the
 * reflect-anything-with-credentials primitive is gone. To allow a cross-origin
 * UI host, set ALLOWED_ORIGINS; only those origins are then allowed, with
 * credentials.
 */

function corsOptions(allowedOrigins) {
  const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  if (list.length === 0) {
    // Fail closed: no cross-origin. Same-origin (and non-browser, no-Origin)
    // requests are unaffected; a cross-origin request gets no ACAO header.
    return { origin: false, credentials: false };
  }
  return {
    // A request with no Origin (same-origin, curl, server-to-server) is allowed;
    // a cross-origin one only when its origin is on the list.
    origin: (origin, cb) => (!origin || list.includes(origin)) ? cb(null, true) : cb(new Error('CORS blocked')),
    credentials: true,
  };
}

module.exports = { corsOptions };
