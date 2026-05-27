'use strict';

/**
 * auth.js — access-token acquisition handling (#208)
 *
 * Shared by every vendor "Access Token" request (00-Access Token/*). Previously
 * each request only did `console.error("No access_token found")` on failure —
 * no assertion, no clear message, no stop — so an invalid OAuth credential let
 * the run continue and cascade into misleading 4xx errors on every downstream
 * request (the tester could not tell the real cause was a bad token).
 *
 * handleAccessTokenResponse():
 *   - on success: stores access_token and records a passing assertion
 *     (NEVER logs the token value — security);
 *   - on failure (non-2xx or no token): emits a clear, actionable diagnostic
 *     naming the likely cause (OAuth credentials), records a FAILING assertion,
 *     clears any stale token, and STOPS the run so the cascade never happens.
 */

const { validationLogger } = require('./displays.js');
const { bruTest } = require('./testCapture.js');

/**
 * @param {object} res   the Bruno response object (res.getStatus(), res.getBody())
 * @param {object} [opts] { vendor: string }
 * @returns {boolean} true when a token was acquired
 */
function handleAccessTokenResponse(res, opts) {
  opts = opts || {};
  const vendor = opts.vendor || 'provider';

  let status = -1;
  try { status = res.getStatus(); } catch (_e) { /* ignore */ }
  let body = null;
  try { body = res.getBody(); } catch (_e) { /* non-JSON / empty */ }

  // The OAuth token field varies by vendor (access_token / accessToken).
  let token = null;
  if (body && typeof body === 'object') {
    const fields = ['access_token', 'accessToken', 'token'];
    for (let i = 0; i < fields.length; i++) {
      const v = body[fields[i]];
      if (typeof v === 'string' && v.length > 0) { token = v; break; }
    }
  }

  const ok = status >= 200 && status < 300 && !!token;

  if (ok) {
    bru.setEnvVar('access_token', token);
    // SECURITY: never log the token value.
    validationLogger(`[INFO] ✅ Access token acquired for ${vendor} (HTTP ${status}).`);
    bruTest(`Authentication: access token acquired for ${vendor}`, function () {
      expect(token, 'access token should be a non-empty string').to.be.a('string').and.not.be.empty;
    });
    return true;
  }

  // ── Failure: clear, actionable, fail-fast ──────────────────────────────────
  let providerMsg = '';
  if (body && typeof body === 'object') {
    const e = body.error_description || body.error || body.message || body.title;
    if (e) providerMsg = ' Provider response: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '.';
  } else if (typeof body === 'string' && body.trim() !== '') {
    providerMsg = ' Provider response: ' + body.slice(0, 200) + '.';
  }

  const msg = `AUTHENTICATION FAILED for ${vendor}: could not obtain an access token (HTTP ${status}).`
    + providerMsg
    + ` Check the OAuth credentials (client_id / client_secret / scope / token URL) configured for ${vendor} in the environment`
    + ` — invalid credentials are the usual cause. The run is stopped here so the missing token does not cascade into misleading 4xx errors on every following request.`;

  validationLogger(`[ERROR] ❌ ${msg}`);
  bru.setEnvVar('access_token', ''); // clear any stale token

  bruTest(`Authentication: access token acquired for ${vendor}`, function () {
    expect(ok, msg).to.be.true;
  });

  try { bru.runner.stopExecution(); } catch (_e) { /* not in a runner context */ }
  return false;
}

/**
 * Stop the run fast on an authentication rejection (#208). Called from the
 * collection-level after-response for every request. Covers the case the
 * token-step handler can't: a bearer/static token that is present but
 * EXPIRED/REVOKED (the server can't know without calling the provider, so it
 * injects the dead token and every request 401/403s). On the first such
 * rejection we surface a clear message, fail an assertion, and stop the run so
 * the dead token doesn't cascade into failures on every following request.
 *
 * Keyed strictly on 401/403 (a *rejected* credential). A 404/400 means a wrong
 * endpoint / bad request, not an auth problem, and is left alone — as is the
 * token-acquisition request itself (handled by handleAccessTokenResponse).
 *
 * @param {object} res      Bruno response
 * @param {string} reqName  the current request's name
 * @returns {boolean} true when an auth rejection was detected (run stopped)
 */
function checkAuthRejection(res, reqName) {
  const name = String(reqName || '').toLowerCase();
  if (name.includes('token') || name.includes('access')) return false; // token step handles itself

  let status = -1;
  try { status = res.getStatus(); } catch (_e) { return false; }
  if (status !== 401 && status !== 403) return false;

  const msg = `AUTHENTICATION REJECTED (HTTP ${status}) on "${reqName || 'request'}". `
    + `Your access / bearer token is most likely invalid or expired. `
    + `Update the token (or OAuth credentials) in Profile → API Configuration and re-run. `
    + `The run is stopped here so the rejected token does not cascade into failures on every following request.`;

  validationLogger(`[ERROR] ❌ ${msg}`);
  bruTest(`Authentication accepted on "${reqName || 'request'}"`, function () {
    expect(status, msg).to.not.be.oneOf([401, 403]);
  });
  try { bru.runner.stopExecution(); } catch (_e) { /* not in a runner context */ }
  return true;
}

module.exports = { handleAccessTokenResponse, checkAuthRejection };

// Expose to global for the eval/require loader flows (matches the other modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
