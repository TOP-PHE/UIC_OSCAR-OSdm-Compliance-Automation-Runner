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

    var token = localStorage.getItem('oscar_token');
    // Basic JWT format validation (three Base64url segments)
    if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      localStorage.clear(); window.location.href = '/'; return;
    }

    var user, company;
    try {
      user    = JSON.parse(localStorage.getItem('oscar_user')    || '{}');
      company = JSON.parse(localStorage.getItem('oscar_company') || '{}');
    } catch (_e) {
      localStorage.clear(); window.location.href = '/'; return;
    }
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
})(window);
