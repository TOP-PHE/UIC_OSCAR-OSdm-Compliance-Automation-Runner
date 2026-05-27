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

module.exports = { handleAccessTokenResponse };

// Expose to global for the eval/require loader flows (matches the other modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
