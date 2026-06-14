// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

/**
 * nav.js — OSCAR shared navigation renderer
 *
 * Call renderOscarNav('oscar-nav', activePage) from each page.
 *
 * Menu per role:
 *   administrator      : Manage Users | Manage Companies | All Reports | Server Activity | Report Builder
 *   certification_user : All Reports | Report Builder | Compare
 *   test_manager        : Dashboard | New Run | Report Builder | Compare | API Config | Scenarios
 *   tester (all others): Dashboard | New Run | Report Builder | Compare | API Config
 *
 * Nav bar right side (all roles): Company: XYZ | email [Badge] | Sign Out
 */
(function (global) {
  'use strict';

  // ── Universal auth-injecting fetch wrapper ──────────────────────────────────
  // Every page that loads nav.js automatically gets a fetch() that:
  //   - includes credentials so the oscar_session httpOnly cookie travels
  //   - injects Authorization: Bearer <token> from localStorage as a fallback
  //     for dev/HTTP environments where the Secure cookie attribute is blocked
  // This way scattered fetch(url, {}) calls in scenarios.js, dashboard.html,
  // etc. don't need to know about auth — they just work.
  if (!global.__oscarFetchPatched) {
    var _origFetch = global.fetch.bind(global);
    global.fetch = function(input, init) {
      init = init || {};
      // Don't override credentials if the caller already set one (e.g. CORS)
      if (init.credentials == null) init.credentials = 'same-origin';
      // Inject Authorization header unless the caller already provided one
      var bearer = null;
      try { bearer = localStorage.getItem('oscar_token'); } catch (_e) {}
      if (bearer) {
        var hdrs = new Headers(init.headers || {});
        if (!hdrs.has('Authorization')) hdrs.set('Authorization', 'Bearer ' + bearer);
        init.headers = hdrs;
      }
      return _origFetch(input, init).then(function(res) {
        // ── Session-expiry handler (v1.9.0) ────────────────────────────────
        // 401 from any authenticated API call means the cookie expired or the
        // bearer token was rejected — clear stale localStorage, drop a friendly
        // banner, and bounce to login. Avoids the "dead UI" state where users
        // see the page render but every button silently fails.
        // Skipped for explicit auth endpoints so we don't loop on the login form.
        try {
          var url = (typeof input === 'string') ? input : (input && input.url) || '';
          var isAuthEndpoint = /\/v1\/auth\/(login|register|password-reset|verify)/.test(url);
          if (res.status === 401 && !isAuthEndpoint && localStorage.getItem('oscar_user')) {
            localStorage.removeItem('oscar_user');
            localStorage.removeItem('oscar_token');
            localStorage.removeItem('oscar_company');
            // One-shot toast via sessionStorage; index.html reads & clears it.
            sessionStorage.setItem('oscar_login_message', 'Your session has expired. Please sign in again.');
            global.location.href = '/';
          }
        } catch (_e) { /* never let the interceptor break the original response */ }
        return res;
      });
    };
    global.__oscarFetchPatched = true;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Badge helper ──────────────────────────────────────────────────────────────
  var ROLE_META = {
    administrator:      { label: 'Admin',     color: '#c62828', bg: '#ffebee' },
    certification_user: { label: 'Certifier', color: '#1565c0', bg: '#e3f2fd' },
    test_manager:       { label: 'Test Mgr',  color: '#6a1b9a', bg: '#f3e5f5' },
    _tester:            { label: 'Tester',    color: '#2e7d32', bg: '#e8f5e9' },
  };

  function roleMeta(role) {
    return ROLE_META[role] || ROLE_META['_tester'];
  }

  function inlineBadge(meta) {
    return '<span style="display:inline-block;padding:1px 8px;border-radius:9px;'
      + 'font-size:10px;font-weight:700;background:' + meta.bg + ';color:' + meta.color + ';'
      + 'margin-left:5px;vertical-align:middle;border:1px solid ' + meta.color + '33">'
      + esc(meta.label) + '</span>';
  }

  // ── Version badge (release / server / collection) ─────────────────────────────
  // Reads /health, caches the result in localStorage for 5 minutes so we don't
  // hammer the server on every page navigation. Color-codes the chip based on
  // compatibility_status:
  //   tested                → green
  //   untested_combination  → amber
  //   matrix_missing        → red
  //   anything else / fetch failed → gray
  var VERSION_CACHE_KEY = 'oscar_version_info';
  var VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
  var COMPAT_COLORS = {
    tested:                { bg: '#e8f5e9', fg: '#2e7d32', dot: '#4caf50' },
    untested_combination:  { bg: '#fff8e1', fg: '#a85b00', dot: '#ffb300' },
    matrix_missing:        { bg: '#ffebee', fg: '#c62828', dot: '#e53935' },
    unknown:               { bg: '#eceff1', fg: '#546e7a', dot: '#90a4ae' },
  };
  var COMPAT_LABELS = {
    tested:               'Tested combination',
    untested_combination: 'Untested combination — server / collection versions are not in compatibility.json',
    matrix_missing:       'compatibility.json not found on server',
    unknown:              'Version info unavailable',
  };

  function loadCachedVersion() {
    try {
      var raw = localStorage.getItem(VERSION_CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (Date.now() - (parsed._fetchedAt || 0) > VERSION_CACHE_TTL_MS) return null;
      return parsed;
    } catch (_e) { return null; }
  }

  function fetchVersionInfo() {
    return fetch('/health')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var info = {
          server_version:       data.server_version       || data.version || 'unknown',
          collection_version:   data.collection_version   || 'unknown',
          release_label:        data.release_label        || null,
          compatibility_status: data.compatibility_status || 'unknown',
          _fetchedAt: Date.now(),
        };
        try { localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify(info)); } catch (_e) {}
        return info;
      })
      .catch(function () {
        return { server_version: 'unknown', collection_version: 'unknown',
                 release_label: null, compatibility_status: 'unknown' };
      });
  }

  function renderVersionBadge(info) {
    if (!info) return '';
    var status = info.compatibility_status in COMPAT_COLORS ? info.compatibility_status : 'unknown';
    var c = COMPAT_COLORS[status];
    var releasePart = info.release_label
      ? '<strong>' + esc(info.release_label) + '</strong> · '
      : '';
    var tooltip = COMPAT_LABELS[status]
      + '\nServer: ' + (info.server_version || 'unknown')
      + '\nCollection: ' + (info.collection_version || 'unknown')
      + (info.release_label ? '\nRelease: ' + info.release_label : '');
    return '<span class="oscar-version-badge" title="' + esc(tooltip) + '" '
      + 'style="display:inline-flex;align-items:center;gap:6px;padding:2px 9px;'
      + 'margin-left:8px;border-radius:10px;font-size:10px;font-weight:600;'
      + 'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;'
      + 'background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.fg + '33;">'
      + '<span style="width:6px;height:6px;border-radius:50%;background:' + c.dot + '"></span>'
      + releasePart
      + esc(info.server_version) + ' / ' + esc(info.collection_version)
      + '</span>';
  }

  // After the nav DOM is in place, hydrate the badge — first synchronously from
  // cache (so the badge appears instantly on hot navigation), then refresh from
  // /health in the background to pick up server-side version changes.
  function hydrateVersionBadge() {
    var slot = document.getElementById('oscar-version-slot');
    if (!slot) return;
    var cached = loadCachedVersion();
    if (cached) slot.innerHTML = renderVersionBadge(cached);
    fetchVersionInfo().then(function (info) {
      slot.innerHTML = renderVersionBadge(info);
    });
  }

  // ── Main render function ──────────────────────────────────────────────────────
  function renderOscarNav(containerId, activePage) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var user, company;
    try {
      user    = JSON.parse(localStorage.getItem('oscar_user')    || '{}');
      company = JSON.parse(localStorage.getItem('oscar_company') || '{}');
    } catch (_e) {
      localStorage.clear(); window.location.href = '/'; return;
    }
    // If user info is missing, session is not established — redirect to login.
    if (!user || !user.email) { localStorage.clear(); window.location.href = '/'; return; }
    var role    = user.role || '';

    var isAdmin  = role === 'administrator';
    var isCertif = role === 'certification_user';
    var meta     = roleMeta(role);

    // ── Menu definitions per role ─────────────────────────────────────────────
    var items;

    var homeItem = { href: '/welcome.html', label: 'Home', page: 'welcome' };

    if (isAdmin) {
      items = [
        homeItem,
        { href: '/admin.html?tab=users',     label: 'Manage Users',     page: 'admin-users'     },
        { href: '/admin.html?tab=companies', label: 'Manage Companies', page: 'admin-companies' },
        { href: '/admin.html?tab=reports',   label: 'All Reports',      page: 'admin-reports'   },
        { href: '/admin.html?tab=activity',  label: 'Server Activity',  page: 'admin-activity'  },
        { href: '/admin.html?tab=config',    label: 'Server Config',    page: 'admin-config'    },
        { href: '/admin-dashboard.html',     label: 'Admin Dashboard',  page: 'admin-dashboard' },
        { href: '/report-builder.html',      label: 'Report Builder',   page: 'report-builder'  },
      ];
    } else if (isCertif) {
      items = [
        homeItem,
        { href: '/admin.html?tab=reports', label: 'All Reports',     page: 'admin-reports'  },
        { href: '/report-builder.html',    label: 'Report Builder',  page: 'report-builder' },
        { href: '/compare.html',           label: 'Compare',         page: 'compare'        },
      ];
    } else {
      // company_user (tester) and test_manager share the same core menu.
      // test_manager additionally gets a "Manage Users" entry that points
      // at admin.html?tab=users — the page detects the role and uses the
      // /v1/company/users endpoint family scoped to their own company.
      items = [
        homeItem,
        { href: '/dashboard.html',      label: 'Dashboard',      page: 'dashboard'      },
        { href: '/run.html',            label: 'New Run',        page: 'run'            },
        { href: '/report-builder.html', label: 'Report Builder', page: 'report-builder' },
        { href: '/compare.html',        label: 'Compare',        page: 'compare'        },
        { href: '/profile.html',        label: 'API Config',     page: 'profile'        },
        { href: '/scenarios.html',      label: 'Test Config',    page: 'scenarios'      },
        { href: '/findings.html',       label: 'Test Findings',  page: 'findings'       },
      ];
      if (role === 'test_manager') {
        items.push({ href: '/admin.html?tab=users', label: 'Manage Users', page: 'admin-users' });
      }
    }

    // ── Build nav bar HTML ────────────────────────────────────────────────────
    var sep = '<span class="uic-nav-sep">|</span>';

    var linkParts = items.map(function (item) {
      var isActive = item.page === activePage;
      return '<a href="' + item.href + '"' + (isActive ? ' class="active"' : '') + '>'
           + esc(item.label) + '</a>';
    });

    var companyLabel =
      '<span style="font-size:10px;font-weight:700;color:#b0bec5;text-transform:uppercase;letter-spacing:.4px">Company</span>'
      + '&nbsp;<strong style="color:#37474f;font-size:12px">' + esc(company.name || 'N/A') + '</strong>';

    // Local timezone reference chip — every page renders timestamps in the
    // viewer's local time (parseServerTs + toLocaleString), so show the zone once
    // here as the reference for all time columns.
    var tzRef = (typeof global.localTzRef === 'function') ? global.localTzRef() : '';
    var tzChip = tzRef
      ? '<span class="nav-user" title="All times on OSCAR pages are shown in this local timezone" style="font-size:11px;color:#78909c">🕒 ' + esc(tzRef) + '</span>' + sep
      : '';

    container.innerHTML =
      '<a href="/welcome.html" class="brand">'
        + '<img src="/oscar-icon.svg" alt="OSCAR"> OSCAR'
      + '</a>'
      // Empty slot — populated asynchronously by hydrateVersionBadge() below.
      // Rendered between brand and the menu items so it stays visible across
      // every page without affecting the menu layout when missing.
      + '<span id="oscar-version-slot"></span>'
      + sep
      + linkParts.join(sep)
      + '<span class="spacer"></span>'
      + tzChip
      + '<span class="nav-user">' + companyLabel + '</span>'
      + sep
      + '<span class="nav-user">' + esc(user.email || '') + inlineBadge(meta) + '</span>'
      + sep
      + '<a href="#" id="nav-signout">Sign Out</a>';
    setTimeout(function() {
      var signout = document.getElementById('nav-signout');
      if (signout) signout.addEventListener('click', function(e) { e.preventDefault(); logout(); });
      hydrateVersionBadge();
    }, 0);
  }

  global.renderOscarNav = renderOscarNav;

  // ── Server-timestamp parser (v1.11.7) ────────────────────────────────────────
  // SQLite's `datetime('now')` returns UTC timestamps WITHOUT a TZ marker
  // (e.g. "2026-05-16 08:44:24"). The OSCAR server passes these through to
  // the browser unchanged. `new Date("2026-05-16 08:44:24")` in JavaScript
  // then interprets the string as LOCAL time (not UTC), which causes the
  // dashboard to display the UTC value as if it were local — i.e. a 10:44
  // Paris event shows as "08:44" because the browser thinks 08:44 is local.
  //
  // This helper detects the missing TZ marker and normalises to ISO with 'Z'
  // so the browser correctly converts UTC → viewer's local timezone. Storage
  // stays UTC (correct); display localises to whoever is viewing the page.
  //
  // Use everywhere a server-side timestamp is rendered:
  //   parseServerTs(run.queued_at).toLocaleString()
  //
  // Already-marked ISO strings (ending in Z or with ±HH:MM offset) pass
  // through unchanged.
  global.parseServerTs = function parseServerTs(s) {
    if (s instanceof Date) return s;
    if (typeof s !== 'string' || !s) return new Date(s);
    if (/Z$/.test(s) || /[+-]\d\d:?\d\d$/.test(s)) return new Date(s);
    return new Date(s.replace(' ', 'T') + 'Z');
  };

  // ── Local timezone reference (v1.11.56) ───────────────────────────────────────
  // All timestamps are stored UTC and rendered with parseServerTs(...).
  // toLocaleString() (i.e. the viewer's local zone) — but that prints no zone, so
  // it's unclear *which* local time. This returns a human label for the viewer's
  // zone, e.g. "Europe/Paris (UTC+02:00)" (auto-reflects DST), shown once in the
  // nav bar so every page's time columns have an explicit reference.
  global.localTzRef = function localTzRef() {
    var zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_e) {}
    var off = -new Date().getTimezoneOffset();   // minutes east of UTC
    var sign = off >= 0 ? '+' : '-';
    var abs = Math.abs(off);
    var hh = String(Math.floor(abs / 60));
    var mm = String(abs % 60);
    if (hh.length < 2) hh = '0' + hh;
    if (mm.length < 2) mm = '0' + mm;
    var utc = 'UTC' + sign + hh + ':' + mm;
    return zone ? (zone + ' (' + utc + ')') : utc;
  };

  // ── Global logout helper ─────────────────────────────────────────────────────
  // Revokes the session token on the server (clears httpOnly cookie), then clears
  // client-side session storage and redirects to the login page.
  global.logout = function logout() {
    fetch('/v1/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(function () { /* ignore network errors — session data is cleared regardless */ })
      .finally(function () {
        localStorage.removeItem('oscar_user');
        localStorage.removeItem('oscar_company');
        localStorage.removeItem('oscar_token'); // remove legacy key if still present
        localStorage.removeItem('oscar_version_info'); // refresh on next login
        window.location.href = '/';
      });
  };
})(window);

// ── #363: in-page toasts ──────────────────────────────────────────────────────
// Native alert() renders in the browser chrome at the very top of the window
// and testers miss it. oscarToast() renders INSIDE the OSCAR UI — top-centre,
// just under the nav — auto-dismisses (errors stay longer) and can be closed.
// oscarToastAfterNav() hands the message over a page navigation via
// sessionStorage (submit → redirect flows); nav.js shows it on the next page.
function oscarToast(message, kind) {
  try {
    kind = kind || 'info';
    let host = document.getElementById('oscar-toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'oscar-toasts';
      // #366: upper third of the viewport, overlapping the page content —
      // tester feedback: under-the-nav toasts were still missed.
      host.style.cssText = 'position:fixed;top:28vh;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none;max-width:90vw';
      document.body.appendChild(host);
    }
    const colors = { info: '#0090D4', success: '#2e7d32', error: '#c62828', warning: '#ef6c00' };
    const icons  = { info: 'ℹ️', success: '✅', error: '⛔', warning: '⚠️' };
    const t = document.createElement('div');
    t.style.cssText = 'pointer-events:auto;min-width:340px;max-width:640px;background:#fff;border-left:5px solid ' + (colors[kind] || colors.info) +
      ';box-shadow:0 8px 32px rgba(0,0,0,.38);border-radius:8px;padding:14px 18px;font:14.5px/1.5 system-ui,sans-serif;color:#263238;display:flex;gap:12px;align-items:flex-start;white-space:pre-wrap';
    if (t.animate) t.animate(
      [{ opacity: 0, transform: 'translateY(-14px) scale(.96)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
      { duration: 180, easing: 'ease-out' });
    const ic = document.createElement('span');
    ic.textContent = icons[kind] || icons.info;
    const span = document.createElement('span');
    span.textContent = String(message);
    span.style.cssText = 'flex:1;word-break:break-word';
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Dismiss';
    x.style.cssText = 'background:none;border:none;cursor:pointer;color:#90a4ae;font-size:13px;line-height:1;padding:0';
    x.onclick = function () { t.remove(); };
    t.appendChild(ic); t.appendChild(span); t.appendChild(x);
    host.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'error' || kind === 'warning' ? 12000 : 7000);
  } catch (_e) {
    try { alert(message); } catch (_a) { /* headless context */ }
  }
}
function oscarToastAfterNav(message, kind) {
  try { sessionStorage.setItem('oscar_toast_pending', JSON.stringify({ m: String(message), k: kind || 'info' })); }
  catch (_e) { oscarToast(message, kind); }
}
(function () {
  function showPending() {
    try {
      const raw = sessionStorage.getItem('oscar_toast_pending');
      if (!raw) return;
      sessionStorage.removeItem('oscar_toast_pending');
      const p = JSON.parse(raw);
      oscarToast(p.m, p.k);
    } catch (_e) { /* no pending toast */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showPending);
  else showPending();
})();
