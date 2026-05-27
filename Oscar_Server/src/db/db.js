// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * db.js — SQLite database connection and helpers
 * Uses Node.js built-in node:sqlite (available from Node 22.5+).
 * No native compilation required — works on any platform with Node 22+.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ── Paths ─────────────────────────────────────────────────────────────────────
// OSCAR_DB_PATH env var overrides the default DB location — used by test
// suites to run against a temp/in-memory DB without polluting dev data.
const DATA_DIR   = path.resolve(__dirname, '../../data');
const DB_PATH    = process.env.OSCAR_DB_PATH || path.join(DATA_DIR, 'oscar.db');
const SCHEMA_SQL = path.resolve(__dirname, 'schema.sql');

// Ensure parent directory exists for whichever DB path we're using
const DB_PARENT = path.dirname(DB_PATH);
if (!fs.existsSync(DB_PARENT)) fs.mkdirSync(DB_PARENT, { recursive: true });

// ── Open database ─────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);

// Apply schema (idempotent — all statements use IF NOT EXISTS)
const schema = fs.readFileSync(SCHEMA_SQL, 'utf8');
db.exec(schema);

// ── Versioned migrations ──────────────────────────────────────────────────────
// Each migration declares its version + a short name + an `up` function. The
// schema_version table tracks the highest version applied so the runner skips
// migrations already in place — gives a clear deployment log and removes the
// "run-everything-every-boot" noise of the previous loop.
//
// ALTER TABLE failures (typically "duplicate column" when a column from an
// older loose-migration era is already present) are caught inside each `up`
// so we still mark the version as applied — the desired schema state is
// reached either way. Real errors are re-thrown so they surface at boot.
const MIGRATIONS = [
  { version: 2, name: 'runs-deletion-tracking', up: () => {
      _safeAlter('ALTER TABLE runs ADD COLUMN deleted_by TEXT');
      _safeAlter('ALTER TABLE runs ADD COLUMN previous_status TEXT');
  }},
  { version: 3, name: 'companies-subscription-key', up: () => {
      _safeAlter('ALTER TABLE companies ADD COLUMN subscription_key_enc TEXT');
  }},
  { version: 4, name: 'runs-concurrent-sessions', up: () => {
      _safeAlter('ALTER TABLE runs ADD COLUMN batch_id TEXT');
      _safeAlter('ALTER TABLE runs ADD COLUMN scenario_code TEXT');
  }},
  { version: 5, name: 'run-events-structured-metadata', up: () => {
      _safeAlter('ALTER TABLE run_events ADD COLUMN category TEXT');      // system, bruno, http, assertion, auth
      _safeAlter('ALTER TABLE run_events ADD COLUMN phase TEXT');         // setup, execution, reporting, teardown
      _safeAlter('ALTER TABLE run_events ADD COLUMN suite_name TEXT');
      _safeAlter('ALTER TABLE run_events ADD COLUMN request_name TEXT');
      _safeAlter('ALTER TABLE run_events ADD COLUMN http_status INTEGER');
  }},
  { version: 6, name: 'run-suites-scenario-name', up: () => {
      _safeAlter('ALTER TABLE run_suites ADD COLUMN scenario_name TEXT');
      // Backfill: copy runs.scenario_code onto suites that pre-date the column.
      // Idempotent — WHERE skips already-populated rows.
      try {
        db.exec(`
          UPDATE run_suites
             SET scenario_name = (SELECT scenario_code FROM runs WHERE runs.id = run_suites.run_id)
           WHERE scenario_name IS NULL
             AND (SELECT scenario_code FROM runs WHERE runs.id = run_suites.run_id) IS NOT NULL
        `);
      } catch (_) { /* best-effort backfill */ }
  }},
  { version: 7, name: 'run-events-scenario-milestones', up: () => {
      _safeAlter('ALTER TABLE run_events ADD COLUMN event_kind TEXT');     // 'log' | 'scenario_start' | 'scenario_retry' | 'scenario_skipped' | 'scenario_end'
      _safeAlter('ALTER TABLE run_events ADD COLUMN attempt_index INTEGER');
      _safeAlter('ALTER TABLE run_events ADD COLUMN attempt_total INTEGER');
      _safeAlter('ALTER TABLE run_events ADD COLUMN scenario_name TEXT');
      _safeAlter('ALTER TABLE run_requests ADD COLUMN vendor_capability TEXT');
  }},
  { version: 8, name: 'run-requests-context-json', up: () => {
      _safeAlter('ALTER TABLE run_requests ADD COLUMN context TEXT');
  }},
  { version: 9, name: 'backfill-event-suite-and-request', up: () => {
      // Re-parse each pre-v5 run's stdout into the new suite_name /
      // request_name columns, mirroring the LogParser state machine.
      // Scoped to runs that have no tagged events at all so we never
      // re-process a run we already backfilled.
      try {
        const runsToBackfill = db.prepare(`
          SELECT DISTINCT run_id FROM run_events
           WHERE run_id NOT IN (
             SELECT DISTINCT run_id FROM run_events
              WHERE suite_name IS NOT NULL OR request_name IS NOT NULL
           )
        `).all();
        const updateStmt = db.prepare(
          'UPDATE run_events SET suite_name = ?, request_name = ? WHERE id = ?'
        );
        const folderReqRe = /^([^()\\\/]+)[\\/]([^()]+?)\s+\(([^)]+)\)/;
        runsToBackfill.forEach(({ run_id }) => {
          const events = db.prepare(
            'SELECT id, message FROM run_events WHERE run_id = ? ORDER BY id ASC'
          ).all(run_id);
          let curSuite = null, curRequest = null;
          db.exec('BEGIN');
          try {
            events.forEach(e => {
              const trimmed = (e.message || '').trim();
              const m = trimmed.match(folderReqRe);
              if (m) { curSuite = m[1].trim(); curRequest = m[2].trim(); }
              if (curSuite || curRequest) updateStmt.run(curSuite, curRequest, e.id);
            });
            db.exec('COMMIT');
          } catch (_e) {
            db.exec('ROLLBACK');
          }
        });
      } catch (_) { /* best-effort backfill */ }
  }},
  { version: 10, name: 'companies-oauth-profile-adapters', up: () => {
      // Pluggable token-fetch profiles — see src/worker/auth-profiles.js for
      // the per-profile request shapes. Default 'oauth2_basic' preserves the
      // historical RFC 6749 client_secret_basic behaviour for every existing
      // company; switching to another profile is opt-in via the Profile UI.
      _safeAlter("ALTER TABLE companies ADD COLUMN oauth_profile TEXT NOT NULL DEFAULT 'oauth2_basic'");
      _safeAlter('ALTER TABLE companies ADD COLUMN oauth_scope TEXT');
      _safeAlter('ALTER TABLE companies ADD COLUMN oauth_extra_enc TEXT');
      _safeAlter('ALTER TABLE companies ADD COLUMN oauth_custom_template TEXT');
  }},
  { version: 11, name: 'companies-token-cache', up: () => {
      // Token cache — reuse a still-valid token across runs instead of
      // re-fetching on every scenario. Cleared on auth-config change.
      _safeAlter('ALTER TABLE companies ADD COLUMN cached_token_enc TEXT');
      _safeAlter('ALTER TABLE companies ADD COLUMN cached_token_expires_at TEXT');
  }},
  { version: 12, name: 'users-per-tester-credentials', up: () => {
      // Move OSDM credentials from companies (org-level) → users (per-tester).
      // After this migration:
      //   - companies keeps api_base, datafile_*, name/slug
      //   - users gains all auth/credential columns
      // The old companies columns are NOT dropped (SQLite makes that painful)
      // but nothing reads them anymore — a future cleanup migration could
      // NULL them out once we're confident in the new shape.
      _safeAlter("ALTER TABLE users ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'bearer'");
      _safeAlter('ALTER TABLE users ADD COLUMN access_token_enc TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN client_id_enc TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN client_secret_enc TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN token_url TEXT');
      _safeAlter("ALTER TABLE users ADD COLUMN oauth_profile TEXT NOT NULL DEFAULT 'oauth2_basic'");
      _safeAlter('ALTER TABLE users ADD COLUMN oauth_scope TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN oauth_extra_enc TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN oauth_custom_template TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN cached_token_enc TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN cached_token_expires_at TEXT');
      // #208: fingerprint of the credentials the cached token was issued for, so
      // the cache is invalidated when the tester changes any credential.
      _safeAlter('ALTER TABLE users ADD COLUMN cached_token_cred_fp TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN requestor_enc TEXT');
      _safeAlter('ALTER TABLE users ADD COLUMN subscription_key_enc TEXT');

      // Backfill: copy each company's credentials onto every user belonging
      // to that company. Existing testers keep working post-deploy without
      // having to re-enter credentials. The cached token is intentionally
      // NOT copied — let it refresh on first run under the new model so we
      // don't carry an old company-scoped cache into the user-scoped world.
      // COALESCE protects the NOT NULL columns when a company row was NULL.
      try {
        db.exec(`
          UPDATE users SET
            auth_mode             = COALESCE((SELECT auth_mode FROM companies c WHERE c.id = users.company_id), 'bearer'),
            access_token_enc      = (SELECT access_token_enc      FROM companies c WHERE c.id = users.company_id),
            client_id_enc         = (SELECT client_id_enc         FROM companies c WHERE c.id = users.company_id),
            client_secret_enc     = (SELECT client_secret_enc     FROM companies c WHERE c.id = users.company_id),
            token_url             = (SELECT token_url             FROM companies c WHERE c.id = users.company_id),
            oauth_profile         = COALESCE((SELECT oauth_profile FROM companies c WHERE c.id = users.company_id), 'oauth2_basic'),
            oauth_scope           = (SELECT oauth_scope           FROM companies c WHERE c.id = users.company_id),
            oauth_extra_enc       = (SELECT oauth_extra_enc       FROM companies c WHERE c.id = users.company_id),
            oauth_custom_template = (SELECT oauth_custom_template FROM companies c WHERE c.id = users.company_id),
            requestor_enc         = (SELECT requestor_enc         FROM companies c WHERE c.id = users.company_id),
            subscription_key_enc  = (SELECT subscription_key_enc  FROM companies c WHERE c.id = users.company_id);
        `);
      } catch (e) {
        // Logged + rethrown so boot halts loudly rather than leaving users
        // half-credentialed. The migration row won't be marked applied, so a
        // second boot retries idempotently (ALTERs are no-ops via _safeAlter).
        console.error('[db] v12 backfill failed:', e.message);
        throw e;
      }
  }},
  { version: 13, name: 'run-requests-http-traffic', up: () => {
      // Persist full request/response payloads + headers per HTTP call so
      // Report Builder can show them and let the user navigate the message
      // chain (e.g. booking → originating offer). Bodies are TEXT (JSON or
      // raw) — truncated upstream in structureResults.js to keep DB size
      // bounded (default 100 KB per body).
      _safeAlter('ALTER TABLE run_requests ADD COLUMN request_body TEXT');
      _safeAlter('ALTER TABLE run_requests ADD COLUMN request_headers TEXT');     // JSON
      _safeAlter('ALTER TABLE run_requests ADD COLUMN response_body TEXT');
      _safeAlter('ALTER TABLE run_requests ADD COLUMN response_headers TEXT');    // JSON
      // Chain navigation: a /bookings call references its originating /offers
      // result, etc. parent_request_id points to the run_requests.id of the
      // earlier call in the chain (NULL for chain roots and unlinked calls).
      _safeAlter('ALTER TABLE run_requests ADD COLUMN parent_request_id INTEGER');
      // Index for fast "show me children of this offer" lookups
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_run_requests_parent ON run_requests(parent_request_id)'); }
      catch (_e) { /* benign */ }
  }},
  { version: 14, name: 'token-revocation-blacklist', up: () => {
      // Per-session token revocation (P3-11). Stores revoked JWT IDs (jti)
      // so individual sessions can be invalidated without rotating the global
      // secret. The jti claim is added to all new tokens at signing time.
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS token_blacklist (
          jti        TEXT PRIMARY KEY,
          user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          revoked_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires ON token_blacklist(expires_at)');
      } catch (_e) { /* benign if already exists */ }
  }},

  { version: 15, name: 'companies-share-reports-with-certifier', up: () => {
      // Per-company privacy toggle. When 0, certification_user role cannot
      // see this company's runs / reports — only the company's own
      // test_manager(s) and the platform administrator do. Default 1
      // preserves the historical "everyone with the role can see" behaviour
      // for existing companies; new companies default to 1 too — opt-in to
      // privacy, not opt-out, since most users will expect today's behaviour.
      _safeAlter('ALTER TABLE companies ADD COLUMN share_reports_with_certifier INTEGER NOT NULL DEFAULT 1');
  }},

  { version: 16, name: 'password-reset-tokens', up: () => {
      // Self-service password reset (issue #15). User submits email →
      // server generates a single-use UUID token, stores it here with a
      // 24h expiry, and emails the recipient a /reset-password.html?token=...
      // link. On confirm we update users.password_hash and DELETE the
      // token row (single-use). Cascading FK ensures stale tokens are
      // cleaned up if a user is deleted.
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token        TEXT NOT NULL UNIQUE,
          expires_at   TEXT NOT NULL,
          requested_ip TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user  ON password_reset_tokens(user_id)');
      } catch (_e) { /* benign if already exists */ }
  }},

  { version: 17, name: 'scrub-historical-credentials-from-run-requests', up: () => {
      // Issue #17 retroactive scrub. PR #29 stops NEW runs from storing
      // credentials in run_requests, but rows that pre-date that fix still
      // hold plaintext Authorization / Ocp-Apim-Subscription-Key / etc. in
      // request_headers + response_headers, AND client_secret / access_token
      // bodies on /token POSTs. Walk every row and re-redact in place.
      //
      // Self-contained — does NOT import from src/reports/* on purpose:
      // migrations should keep working even if the importable code drifts.
      // Helpers here are an exact copy of the runtime redaction in
      // structureResults.js as of PR #29.
      const SENSITIVE = new Set([
        'authorization', 'proxy-authorization',
        'x-subscription-key', 'ocp-apim-subscription-key',
        'apikey', 'api-key', 'x-api-key',
        'x-auth-token', 'x-access-token',
        'x-requestor', 'cookie', 'set-cookie'
      ]);
      const REDACTED = '[REDACTED — credential]';
      function redactObj(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const out = Array.isArray(obj) ? [] : {};
        for (const [k, v] of Object.entries(obj)) {
          out[k] = SENSITIVE.has(String(k).toLowerCase()) ? REDACTED : v;
        }
        return out;
      }
      function redactHeadersJsonString(s) {
        if (s === null || s === undefined || s === '') return s;
        try {
          const parsed = JSON.parse(s);
          return JSON.stringify(redactObj(parsed));
        } catch (_e) {
          // Not JSON — assume already a marker / stringified value, leave it.
          return s;
        }
      }
      function isAuthUrl(u) { return /\/(token|login|auth|logon|oauth)/i.test(String(u || '')); }

      let rows;
      try {
        rows = db.prepare(`
          SELECT id, http_url, request_headers, response_headers,
                 request_body, response_body
            FROM run_requests
           WHERE request_headers  IS NOT NULL
              OR response_headers IS NOT NULL
              OR request_body     IS NOT NULL
              OR response_body    IS NOT NULL
        `).all();
      } catch (_e) {
        // Table doesn't exist (fresh install before run_requests migration ran)
        // or columns absent — nothing to scrub.
        return;
      }

      if (rows.length === 0) {
        console.log('[db] migration v17 — no run_requests rows to scrub');
        return;
      }

      const upd = db.prepare(`
        UPDATE run_requests
           SET request_headers = ?, response_headers = ?,
               request_body    = ?, response_body    = ?
         WHERE id = ?
      `);

      let scrubbed = 0;
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          const auth = isAuthUrl(r.http_url);
          const newReqHdr = redactHeadersJsonString(r.request_headers);
          const newResHdr = redactHeadersJsonString(r.response_headers);
          const newReqBody = auth
            ? `${REDACTED} (auth-endpoint request body — typically client_id / client_secret / grant_type)`
            : r.request_body;
          const newResBody = auth
            ? `${REDACTED} (auth-endpoint response body — typically access_token / refresh_token)`
            : r.response_body;

          if (newReqHdr   !== r.request_headers
           || newResHdr   !== r.response_headers
           || newReqBody  !== r.request_body
           || newResBody  !== r.response_body) {
            upd.run(newReqHdr, newResHdr, newReqBody, newResBody, r.id);
            scrubbed++;
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      console.log(`[db] migration v17 — scrubbed credentials from ${scrubbed} of ${rows.length} run_requests rows`);
  }},

  { version: 18, name: 'runs-per-run-share-with-certifier', up: () => {
      // Per-run share-with-certifier toggle (issue #60, v1.10.0).
      //
      // Replaces the all-or-nothing companies.share_reports_with_certifier
      // toggle as the gating mechanism for certifier visibility. The company-
      // wide toggle becomes a master kill switch: when set to 0 it overrides
      // every per-run share, allowing a vendor to revoke ALL certifier access
      // in one click. When set to 1 (default), per-run sharing decides.
      //
      // shared_with_certifier_at: ISO 8601 UTC timestamp of when the test
      //   manager opted to share. NULL = not shared (the safe default).
      // shared_with_certifier_by: email of the test manager who shared (for
      //   audit). NULL when not shared.
      _safeAlter('ALTER TABLE runs ADD COLUMN shared_with_certifier_at TEXT');
      _safeAlter('ALTER TABLE runs ADD COLUMN shared_with_certifier_by TEXT');

      // Backfill: any company that today has share_reports_with_certifier=1
      // (the legacy v15 toggle) gets ALL its terminal runs marked shared, so
      // existing certifier workflows don't suddenly go dark on rollover.
      // After v1.10.0 ships, test managers explicitly pick which NEW runs to
      // share — the bulk-share is purely a backward-compat preservation.
      try {
        db.exec(`
          UPDATE runs
             SET shared_with_certifier_at = COALESCE(completed_at, queued_at),
                 shared_with_certifier_by = 'system_migration_v18'
           WHERE shared_with_certifier_at IS NULL
             AND status IN ('COMPLETED', 'FAILED', 'CANCELLED')
             AND company_id IN (
               SELECT id FROM companies WHERE share_reports_with_certifier = 1
             )
        `);
        const cnt = db.prepare(
          "SELECT COUNT(*) AS n FROM runs WHERE shared_with_certifier_by = 'system_migration_v18'"
        ).get();
        console.log(`[db] migration v18 — backfilled ${cnt.n} terminal runs as 'shared with certifier' (legacy company-wide toggle preserved)`);
      } catch (e) {
        console.error('[db] v18 backfill failed:', e.message);
        throw e;
      }

      // Partial index for the certifier list-query: "all runs visible to me"
      // → WHERE shared_with_certifier_at IS NOT NULL ORDER BY shared_at DESC
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_runs_shared_with_certifier ON runs(shared_with_certifier_at) WHERE shared_with_certifier_at IS NOT NULL');
      } catch (_e) { /* benign if already exists */ }
  }},

  { version: 19, name: 'at-rest-encrypt-sensitive-columns', up: () => {
      // Phase 2 of issue #60 (v1.11.0). Encrypts content of every existing
      // plaintext row in the sensitive columns by prepending the 'enc:v1:'
      // marker and AES-256-GCM ciphertext (same envelope as colEncrypt()).
      //
      // Idempotent — rows already carrying the prefix are skipped. Rows
      // with NULL stay NULL. Migration is wrapped in transactions per
      // table so a crash mid-migration leaves a half-encrypted state
      // that the helper handles transparently (colDecrypt's prefix check).
      //
      // Artifact + datafile files on disk are NOT touched by this DB
      // migration — they're encrypted-on-next-write by the runner /
      // company-routes. A separate operator script (in OSCAR_Deploy/scripts/)
      // can backfill those if desired, but it's not required: the read
      // helpers handle plaintext files transparently.
      const COL_PREFIX = 'enc:v1:';
      const tables = [
        { name: 'run_events',     col: 'message' },
        { name: 'run_requests',   col: 'request_body'    },
        { name: 'run_requests',   col: 'request_headers' },
        { name: 'run_requests',   col: 'response_body'   },
        { name: 'run_requests',   col: 'response_headers'},
        { name: 'run_requests',   col: 'context'         },
        { name: 'test_frameworks', col: 'config'          },
        { name: 'test_resources',  col: 'data'            },
      ];

      for (const { name, col } of tables) {
        let rows;
        // v1.11.1 fix: use explicit `id` primary key instead of `rowid`.
        // Node 22's built-in node:sqlite (DatabaseSync) does NOT expose
        // `rowid` as a row property when SELECTed without alias — `r.rowid`
        // comes back undefined and binding it fails with
        // "Provided value cannot be bound to SQLite parameter 2".
        // All four tables (run_events, run_requests, test_frameworks,
        // test_resources) have an `id` PK column, so this is uniform.
        try {
          rows = db.prepare(
            `SELECT id, "${col}" AS v FROM "${name}" WHERE "${col}" IS NOT NULL AND "${col}" != ''`
          ).all();
        } catch (_e) {
          // Table or column doesn't exist on this DB (typically a fresh
          // install where some rows haven't been created yet). Skip.
          continue;
        }
        if (rows.length === 0) {
          console.log(`[db] migration v19 — ${name}.${col}: no rows to encrypt`);
          continue;
        }

        const upd = db.prepare(`UPDATE "${name}" SET "${col}" = ? WHERE id = ?`);
        let encrypted = 0;
        let skipped = 0;
        let perRowErrors = 0;
        db.exec('BEGIN');
        try {
          for (const r of rows) {
            const v = r.v;
            if (typeof v !== 'string' || v.startsWith(COL_PREFIX)) {
              skipped++;
              continue;
            }
            try {
              // Inline AES-256-GCM encrypt + prefix (mirrors colEncrypt)
              const iv = crypto.randomBytes(12);
              const cipher = crypto.createCipheriv('aes-256-gcm', _key(), iv);
              const enc = Buffer.concat([cipher.update(v, 'utf8'), cipher.final()]);
              const tag = cipher.getAuthTag();
              const stored = COL_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
              upd.run(stored, r.id);
              encrypted++;
            } catch (rowErr) {
              // Per-row isolation: a single bad row (NULL id, oversized value,
              // unbindable type) should not abort the whole table's migration.
              // Logged and counted; the row stays plaintext and will be
              // encrypted on its next natural write via colEncrypt.
              perRowErrors++;
              if (perRowErrors <= 5) {
                console.error(`[db] v19 row encrypt failed (${name}.${col} id=${r.id}): ${rowErr.message}`);
              }
            }
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          console.error(`[db] migration v19 ${name}.${col} FAILED:`, e.message);
          throw e;
        }
        if (perRowErrors > 0) {
          console.warn(`[db] migration v19 ${name}.${col} — ${perRowErrors} rows could not be encrypted (left as plaintext, will encrypt on next write)`);
        }
        console.log(`[db] migration v19 — ${name}.${col}: encrypted ${encrypted} rows (skipped ${skipped} already-encrypted)`);
      }
  }},
  { version: 20, name: 'users-cached-token-cred-fp', up: () => {
      // #208 REGRESSION FIX. The cached_token_cred_fp ALTER was mistakenly added
      // inside the already-applied v12 migration, so the version-gated runner
      // (`if (m.version <= current) continue`) SKIPPED it on every existing DB —
      // the column was never created. resolveAccessToken() then tried to persist
      // the cache with `UPDATE users SET ... cached_token_cred_fp = ? ...`, which
      // threw "no such column: cached_token_cred_fp" and FAILED EVERY oauth2 run
      // (valid credentials included). Re-add it here as a NEW migration so
      // deployed DBs actually get the column. Idempotent: fresh DBs that already
      // ran the v12 ALTER simply no-op via _safeAlter. companies gets it too so
      // the migrated schema matches schema.sql (column is currently unused there
      // — resolveAccessToken caches against users — but kept consistent).
      _safeAlter('ALTER TABLE users ADD COLUMN cached_token_cred_fp TEXT');
      _safeAlter('ALTER TABLE companies ADD COLUMN cached_token_cred_fp TEXT');
  }},
];

// Tolerant ALTER wrapper: SQLite throws on a duplicate column, which is
// expected when a column from an earlier loose-migration era is already
// present. Anything else surfaces.
function _safeAlter(sql) {
  try { db.exec(sql); }
  catch (e) {
    const msg = String(e && e.message || '');
    const benign = /duplicate column name|already exists/i.test(msg);
    if (!benign) throw e;
  }
}

(function applyMigrations() {
  // Read the highest version already applied. The bare schema.sql seeds
  // version=1 (base tables present), so a brand-new DB starts there.
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const current = (row && row.v) || 0;
  const insertVersion = db.prepare(
    "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
  );
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    try {
      m.up();
      insertVersion.run(m.version);
      console.log(`[db] migration v${m.version} "${m.name}" applied`);
      applied++;
    } catch (e) {
      console.error(`[db] migration v${m.version} "${m.name}" FAILED:`, e.message);
      throw e; // halt the boot — leaving a half-migrated DB silent is worse
    }
  }
  if (applied === 0) {
    const top = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : current;
    console.log(`[db] schema up to date (version ${Math.max(current, top)})`);
  }
})();

// ── Seed server_config from env vars (only inserts if key doesn't exist) ─────
(function seedServerConfig() {
  const defaults = {
    MAX_CONCURRENT_RUNS: process.env.MAX_CONCURRENT_RUNS || '10',
    PARALLEL_STAGGER_MS: process.env.PARALLEL_STAGGER_MS || '2000',
    RUN_TIMEOUT_MS:      process.env.RUN_TIMEOUT_MS      || '600000',
    // SMTP settings — seed from env vars so they're editable via admin UI
    SMTP_HOST:   process.env.SMTP_HOST   || '',
    SMTP_PORT:   process.env.SMTP_PORT   || '587',
    SMTP_SECURE: process.env.SMTP_SECURE || 'false',
    SMTP_USER:   process.env.SMTP_USER   || '',
    SMTP_PASS:   process.env.SMTP_PASS   || '',
    SMTP_FROM:   process.env.SMTP_FROM   || 'OSCAR Platform <noreply@oscar.uic.org>',
    // Logging level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
    LOG_LEVEL:   process.env.LOG_LEVEL   || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    // Alerting (v1.9.0) — used by src/utils/alertmanagerConfig.js to regenerate
    // alertmanager.yml from a single source of truth (this DB). Empty by
    // default so the alerting card on the Server Config tab prompts the
    // operator to fill it in before clicking "Apply alerting config".
    ALERT_RECIPIENTS:      process.env.ALERT_RECIPIENTS      || '',
    ALERT_REPEAT_CRITICAL: process.env.ALERT_REPEAT_CRITICAL || '1h',
    ALERT_REPEAT_WARNING:  process.env.ALERT_REPEAT_WARNING  || '4h',
  };
  for (const [key, val] of Object.entries(defaults)) {
    const exists = db.prepare('SELECT key FROM server_config WHERE key = ?').get(key);
    if (!exists) {
      db.prepare('INSERT INTO server_config (key, value) VALUES (?, ?)').run(key, val);
    }
  }
})();

console.log(`[db] SQLite ready → ${DB_PATH}`);

// ── Encryption helpers ────────────────────────────────────────────────────────
const ALGO = 'aes-256-gcm';

function _key() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = _key();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc  = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(encoded) {
  if (encoded == null || encoded === '') return null;
  const key = _key();
  const buf  = Buffer.from(encoded, 'base64');
  const iv   = buf.subarray(0, 12);
  const tag  = buf.subarray(12, 28);
  const enc  = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ── Generic query helpers ─────────────────────────────────────────────────────
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

// ── At-rest column encryption (Phase 2 of issue #60, v1.11.0) ───────────────
// Wraps the existing encrypt()/decrypt() with a versioned prefix marker so
// reads can transparently distinguish "encrypted v1" rows from legacy
// plaintext rows. The forward-compat read path (colDecrypt) is what makes
// migration v19 optional — even before backfill, mixed plaintext/encrypted
// rows render correctly.
//
// Used for sensitive content columns where SSH-level read access would
// otherwise reveal vendor data:
//   - run_events.message              (log stream content)
//   - run_requests.request_body       (HTTP traffic in)
//   - run_requests.request_headers    (sensitive headers)
//   - run_requests.response_body      (HTTP traffic out)
//   - run_requests.response_headers
//   - test_frameworks.config          (vendor capability declaration)
//   - test_resources.data             (test trains / trips definitions)
//
// NOT applied to columns we still need to query/sort/filter on (status,
// timestamps, company_id, http_status, suite_name, etc.). Those remain
// plaintext — but they're metadata, not vendor data.

const COL_PREFIX = 'enc:v1:';

function colEncrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  return COL_PREFIX + encrypt(String(plaintext));
}

function colDecrypt(stored) {
  if (stored == null || stored === '') return stored;
  if (typeof stored !== 'string') return stored;
  if (!stored.startsWith(COL_PREFIX)) return stored;   // legacy plaintext
  try {
    return decrypt(stored.slice(COL_PREFIX.length));
  } catch (err) {
    // AES-GCM auth-tag failure on a value with our prefix is a real
    // security alert — either the row was tampered with, or the
    // ENCRYPTION_KEY rotated without re-encryption. Surface but never
    // crash the request — return null so the caller keeps working with
    // missing data instead of a 500.
    console.error('[db.colDecrypt] decryption failed for prefixed value:', err.message);
    return null;
  }
}

// ── Server config helper ─────────────────────────────────────────────────────
// Reads from server_config table first, falls back to env var, then default.
// This allows runtime changes via the admin UI without server restart.
function getConfig(key, defaultValue) {
  const row = db.prepare('SELECT value FROM server_config WHERE key = ?').get(key);
  return row ? row.value : (process.env[key] || defaultValue);
}

// ── Transaction helper ────────────────────────────────────────────────────────
function transaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, all, get, run, transaction, encrypt, decrypt, colEncrypt, colDecrypt, getConfig };
