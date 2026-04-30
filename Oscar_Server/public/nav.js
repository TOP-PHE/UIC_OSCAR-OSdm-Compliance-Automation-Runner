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
      return _origFetch(input, init);
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
      items = [
        homeItem,
        { href: '/dashboard.html',      label: 'Dashboard',      page: 'dashboard'      },
        { href: '/run.html',            label: 'New Run',        page: 'run'            },
        { href: '/report-builder.html', label: 'Report Builder', page: 'report-builder' },
        { href: '/compare.html',        label: 'Compare',        page: 'compare'        },
        { href: '/profile.html',        label: 'API Config',     page: 'profile'        },
        { href: '/scenarios.html',      label: 'Test Config',    page: 'scenarios'      },
      ];
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

    container.innerHTML =
      '<a href="/welcome.html" class="brand">'
        + '<img src="/oscar-icon.svg" alt="OSCAR"> OSCAR'
      + '</a>'
      + sep
      + linkParts.join(sep)
      + '<span class="spacer"></span>'
      + '<span class="nav-user">' + companyLabel + '</span>'
      + sep
      + '<span class="nav-user">' + esc(user.email || '') + inlineBadge(meta) + '</span>'
      + sep
      + '<a href="#" id="nav-signout">Sign Out</a>';
    setTimeout(function() {
      var signout = document.getElementById('nav-signout');
      if (signout) signout.addEventListener('click', function(e) { e.preventDefault(); logout(); });
    }, 0);
  }

  global.renderOscarNav = renderOscarNav;

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
        window.location.href = '/';
      });
  };
})(window);
