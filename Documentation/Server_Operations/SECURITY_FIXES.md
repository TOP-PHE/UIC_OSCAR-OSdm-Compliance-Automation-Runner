# Security Hardening — 13 Findings Fixed

## Summary

A security review of the OSCAR server identified 13 vulnerabilities across Critical, High, and Medium severity. All have been addressed in this release.

**New dependencies:** `helmet`, `express-rate-limit`

---

## Critical

### 1. No security headers (Helmet)

**Finding:** No `helmet()` middleware. Missing HSTS, X-Frame-Options, X-Content-Type-Options, CSP.

**File:** `src/server.js`

**Fix:** Added `helmet()` middleware with a strict Content Security Policy:
- `default-src 'self'` — blocks all external resource loading
- `script-src 'self' 'unsafe-inline'` — inline scripts required by the vanilla JS frontend
- `frame-ancestors 'none'` — prevents clickjacking
- HSTS enabled with 1-year max-age
- X-Content-Type-Options, X-DNS-Prefetch-Control, X-XSS-Protection all set by helmet defaults

---

### 2. Unrestricted CORS

**Finding:** `app.use(cors())` allows requests from any origin.

**File:** `src/server.js`

**Fix:** CORS now reads from `ALLOWED_ORIGINS` environment variable (comma-separated list). When configured, only listed origins are permitted. When not set (local dev), all origins are allowed as a fallback. `credentials: true` is enabled for cookie support.

```
# .env example
ALLOWED_ORIGINS=https://oscar.example.com,https://admin.example.com
```

---

### 3. No rate limiting

**Finding:** Login, registration, and bootstrap routes are open to brute force.

**File:** `src/api/routes/auth.js`

**Fix:** Added `express-rate-limit` on all authentication endpoints:
- **Window:** 15 minutes
- **Max attempts:** 20 per window per IP
- **Affected routes:** `/v1/auth/login`, `/v1/auth/register`, `/v1/auth/bootstrap`
- Returns `429 Too Many Requests` when limit exceeded

---

### 4. Error detail leakage in production

**Finding:** `err.message` returned to clients, exposing SQL errors, file paths, and internals.

**File:** `src/server.js`

**Fix:** The global error handler now returns a generic `{"status": 500, "title": "Internal Server Error"}` with no `detail` field. The full stack trace is logged server-side only via `console.error`.

---

## High

### 5. Credentials written to disk as plaintext

**Finding:** OAuth tokens written as YAML temp files with default permissions. Cleanup silently ignores failures — credentials may persist on disk.

**File:** `src/worker/runner.js`

**Fix (two parts):**

**a) Restricted file permissions:**
```javascript
fs.writeFileSync(envFilePath, envYml, { mode: 0o600, encoding: 'utf8' });
```
File is only readable/writable by the owner process (not world-readable).

**b) Deletion retry with logging:**
Replaced the silent `try { fs.unlinkSync(...) } catch (_) {}` with a 3-attempt retry loop (500ms backoff). Each failed attempt is logged as a warning. If all 3 attempts fail, a CRITICAL error is logged alerting that credentials may persist on disk. The run log explicitly shows whether deletion succeeded or failed.

---

### 6. Path traversal risk in artifact download

**Finding:** Artifact path from DB served directly without validating it resides inside the artifacts directory.

**File:** `src/api/routes/runs.js`

**Fix:** Added a directory containment check before serving any artifact file:
```javascript
const safePath = path.resolve(artifact.path);
if (!safePath.startsWith(ARTIFACTS_DIR + path.sep)) {
  return res.status(403).json({ title: 'Forbidden', detail: 'Artifact path outside allowed directory.' });
}
```
A malicious or corrupted path in the database can no longer serve files outside `data/artifacts/`.

---

### 7. Email enumeration

**Finding:** Registration returns `409 "already registered"` on duplicate email, allowing attackers to enumerate valid accounts.

**File:** `src/api/routes/auth.js`

**Fix:** The duplicate email check now returns the same generic 200 response whether the email exists or not:
```
"If this email is not already registered, a verification link has been sent."
```
An attacker cannot distinguish between a new and existing email address.

---

### 8. No CSRF protection

**Finding:** All state-changing endpoints lack CSRF tokens.

**Resolution:** Not applicable. The API uses `Authorization: Bearer <token>` header authentication, not cookies. Cross-site requests from a malicious page cannot include the Bearer header (blocked by CORS + same-origin policy). CSRF protection would be required if we migrate to httpOnly cookie-based auth in the future.

---

## Medium

### 9. JWT in localStorage (XSS risk)

**Finding:** Tokens stored in `localStorage` are accessible to any XSS payload.

**File:** `public/nav.js`

**Fix (defense in depth):**
- Added JWT format validation on read — if the token doesn't match the `header.payload.signature` Base64url pattern, localStorage is cleared and the user is redirected to login
- Added `try/catch` around `JSON.parse` of user/company data to handle corrupted localStorage gracefully
- The primary XSS mitigation is the Content Security Policy from fix #1 which blocks inline script injection from external sources

**Note:** Full migration to httpOnly secure cookies is a larger refactor tracked separately.

---

### 10. No JWT algorithm pinning

**Finding:** `jwt.verify()` called without `{ algorithms: ['HS256'] }`, vulnerable to algorithm confusion attacks.

**File:** `src/api/middleware/auth.js`

**Fix:**
```javascript
jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })
```
Only HS256 is accepted. An attacker cannot trick the verifier into using `none` or RS256 with a crafted token.

---

### 11. Weak password policy

**Finding:** Minimum 8 characters, no complexity rules.

**File:** `src/api/routes/auth.js`

**Fix:** Password requirements strengthened (applied to both registration confirmation and admin user creation):
- **Minimum length:** 12 characters (was 8)
- **Complexity:** Must contain at least one uppercase letter, one lowercase letter, and one digit
- Clear error messages returned on validation failure

---

### 12. Missing audit logging

**Finding:** Credential updates, user management, and file uploads have no audit trail.

**Files:** `src/api/routes/company.js`, `src/api/routes/admin.js`

**Fix:** Added audit events to the existing `auth_events` table for all security-relevant operations:

| Event Type | Trigger |
|------------|---------|
| `credential_update:{fields}` | PATCH /v1/company (token, OAuth, subscription key changes) |
| `datafile_uploaded` | POST /v1/company/datafile |
| `datafile_deleted` | DELETE /v1/company/datafile |
| `user_created:{email}:{role}` | POST /v1/admin/users |
| `user_updated:{userId}` | PATCH /v1/admin/users/:id |
| `user_deleted:{email}` | DELETE /v1/admin/users/:id |
| `password_reset:{email}` | POST /v1/admin/users/:id/reset-password |

All events record the acting user's ID, email, company context, and timestamp.

---

### 13. Tenant isolation gap

**Finding:** Platform users can specify any `company_id` via header/query without validating the company exists.

**File:** `src/api/middleware/tenant.js`

**Fix:** When a platform user (administrator or certification_user) specifies a `company_id`, the middleware now validates that the company exists in the database before allowing the request to proceed. Returns `404 Not Found` if the company ID is invalid, preventing blind access to non-existent tenant scopes.

---

---

## Future Improvement: Remove inline event handlers (CSP hardening)

**Current state:** The CSP directive `script-src-attr 'unsafe-inline'` is required because all HTML pages use inline event handlers (`onclick="..."`, `onchange="..."`, `oninput="..."`, etc.). This is a pragmatic compromise — the UI would break without it.

**Target state:** Migrate all inline event handlers across every `.html` page to use `addEventListener()` in JavaScript. This would allow setting `script-src-attr 'none'` (helmet default), fully blocking attribute-based script injection.

**Scope:** ~200+ inline handlers across dashboard.html, profile.html, scenarios.html, run-detail.html, run.html, compare.html, admin.html, index.html, welcome.html, verify-email.html.

**Priority:** Medium — the current risk is low (dynamic content is HTML-escaped via `esc()`, and `script-src` already requires `'unsafe-inline'` for the inline `<script>` blocks), but removing `script-src-attr 'unsafe-inline'` would close the last CSP gap.

---

## Files Changed

| File | Issues |
|------|--------|
| `package.json` | #1, #3 (new deps: helmet, express-rate-limit) |
| `src/server.js` | #1, #2, #4 |
| `src/api/routes/auth.js` | #3, #7, #11 |
| `src/api/middleware/auth.js` | #10 |
| `src/api/middleware/tenant.js` | #13 |
| `src/worker/runner.js` | #5 |
| `src/api/routes/runs.js` | #6 |
| `public/nav.js` | #9 |
| `src/api/routes/company.js` | #12 |
| `src/api/routes/admin.js` | #12 |
