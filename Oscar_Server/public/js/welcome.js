/* global oscarReportError */  // nav.js, loaded before it by the page
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of welcome.html, moved out of the page (#1423) so that the
// content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

// ── Auth guard ────────────────────────────────────────────────────────────────
// Auth guard — the source of truth is the httpOnly oscar_session cookie set
// at login / verify-email. JS can't read it (httpOnly), so we use the
// presence of oscar_user in localStorage as the client-side proxy for "I
// have a session". Bearer-header fetches still use oscar_token if present
// (legacy flows), but the cookie auth handles everything else.
const token = localStorage.getItem('oscar_token') || '';
if (!localStorage.getItem('oscar_user')) window.location.href = '/';

const user    = JSON.parse(localStorage.getItem('oscar_user')    || '{}');
const company = JSON.parse(localStorage.getItem('oscar_company') || '{}');
const role    = user.role || 'company_user';

// logout() provided by nav.js

// ── Role meta ─────────────────────────────────────────────────────────────────
const ROLE_CONFIG = {
  administrator: {
    label:   'Administrator',
    cssClass:'administrator',
    icon:    '🛡️',
    desc:    'You have full access to manage users, companies, and monitor server activity. Use the menus above to navigate to the area you need.',
    actions: [
      { href:'/admin.html?tab=users',     label:'Manage Users',     desc:'Add, edit or disable user accounts',      icon:'👥', color:'red'    },
      { href:'/admin.html?tab=companies', label:'Manage Companies', desc:'Configure company profiles and settings',  icon:'🏢', color:'blue'   },
      { href:'/admin.html?tab=reports',   label:'All Reports',      desc:'Browse conformance reports for all tenants',icon:'📋', color:'teal'   },
      { href:'/admin.html?tab=activity',  label:'Server Activity',  desc:'Live run queue and execution logs',         icon:'📡', color:'green'  },
    ],
    cols: 'cols-4',
  },
  certification_user: {
    label:   'Certifier',
    cssClass:'certifier',
    icon:    '🔍',
    desc:    'You have read access to all submitted conformance reports. Review results and use the Compare tool to track conformance progress over time.',
    actions: [
      { href:'/admin.html?tab=reports', label:'All Reports', desc:'Browse all submitted test reports',        icon:'📋', color:'blue'   },
      { href:'/compare.html',           label:'Compare',     desc:'Diff two reports side by side',            icon:'⚖️', color:'purple' },
    ],
    cols: 'cols-2',
  },
  test_manager: {
    label:   'Test Manager',
    cssClass:'test-manager',
    icon:    '⭐',
    desc:    'You manage the shared test framework, resources and scenarios for your company. Run conformance tests and curate the configuration that all testers in your company use.',
    actions: [
      { href:'/scenarios.html', label:'Test Config', desc:'Manage shared framework, resources, scenarios', icon:'🧪', color:'orange' },
      { href:'/run.html',       label:'New Run',     desc:'Execute the full OTST test suite',              icon:'▶️',  color:'green'  },
      { href:'/dashboard.html', label:'Dashboard',   desc:'View your run history and results',             icon:'📊', color:'blue'   },
      { href:'/compare.html',   label:'Compare',     desc:'Diff two reports side by side',                 icon:'⚖️', color:'purple' },
      { href:'/profile.html',   label:'API Config',  desc:'Update your endpoint & credentials',            icon:'⚙️', color:'teal'   },
    ],
    cols: 'cols-5',
  },
  _tester: {
    label:   'Tester',
    cssClass:'tester',
    icon:    '🚀',
    desc:    'Run OSDM conformance tests against your API, review results, and compare reports to track your implementation progress.',
    actions: [
      { href:'/run.html',       label:'New Run',     desc:'Execute the full OTST test suite',       icon:'▶️',  color:'green'  },
      { href:'/dashboard.html', label:'Dashboard',   desc:'View your run history and results',       icon:'📊', color:'blue'   },
      { href:'/compare.html',   label:'Compare',     desc:'Diff two reports side by side',           icon:'⚖️', color:'purple' },
      { href:'/profile.html',   label:'API Config',  desc:'Update your endpoint & credentials',      icon:'⚙️', color:'teal'   },
      { href:'/scenarios.html', label:'Test Config', desc:'Select scenarios and edit parameters',    icon:'🧪', color:'orange' },
    ],
    cols: 'cols-5',
  },
};

function getRoleConfig() {
  return ROLE_CONFIG[role] || ROLE_CONFIG['_tester'];
}

// S11: the one shared escaper (js/esc.js). Was {&,<,>}-only; now also " and '. Declared before the
// welcome banner is drawn, which uses it at once (#1423).
const esc = window.esc;

// ── Render welcome banner ─────────────────────────────────────────────────────
(function renderWelcome() {
  const cfg = getRoleConfig();
  const banner  = document.getElementById('welcome-banner');
  const heading = document.getElementById('welcome-heading');
  const desc    = document.getElementById('welcome-desc');
  const icon    = document.getElementById('welcome-icon');

  banner.classList.add(cfg.cssClass);
  icon.textContent = cfg.icon;

  const displayName = user.email ? user.email.split('@')[0] : 'there';
  const pill = `<span class="role-pill ${cfg.cssClass}">${cfg.label}</span>`;
  heading.innerHTML = `Welcome, ${esc(displayName)}! ${pill}`;
  desc.innerHTML = `You are acting as <strong>${cfg.label}</strong>. ${cfg.desc}`;
})();

// ── Render quick actions ──────────────────────────────────────────────────────
(function renderActions() {
  const cfg  = getRoleConfig();
  const grid = document.getElementById('actions-grid');
  grid.className = 'actions-grid ' + cfg.cols;
  grid.innerHTML = cfg.actions.map(a => `
    <a href="${a.href}" class="action-card ${a.color}">
      <div class="ac-icon">${a.icon}</div>
      <div class="ac-label">${a.label}</div>
      <div class="ac-desc">${a.desc}</div>
    </a>`).join('');
})();

// ── News carousel ─────────────────────────────────────────────────────────────
let newsItems = [];
let newsIndex = 0;


function renderNewsItem(idx) {
  const item = newsItems[idx];
  document.getElementById('news-body').innerHTML = `
    <div class="news-body">
      <div class="news-tag">${esc(item.tag || 'News')}</div>
      <div class="news-title">${esc(item.title)}</div>
      <div class="news-date">${esc(item.date)}</div>
      <div class="news-content">${esc(item.content)}</div>
    </div>`;

  document.getElementById('news-counter').textContent =
    newsItems.length > 1 ? `${idx + 1} / ${newsItems.length}` : '';

  // Update dots
  document.querySelectorAll('.news-dot').forEach((d, i) => {
    d.classList.toggle('active', i === idx);
  });

  // Update buttons
  document.getElementById('btn-prev').disabled = idx === 0;
  document.getElementById('btn-next').disabled = idx === newsItems.length - 1;
}

function moveNews(dir) {
  const next = newsIndex + dir;
  if (next < 0 || next >= newsItems.length) return;
  newsIndex = next;
  renderNewsItem(newsIndex);
}

async function loadNews() {
  try {
    const res = await fetch('/news/index.json');
    if (!res.ok) throw new Error('Failed to load news.');
    newsItems = await res.json();
    if (!Array.isArray(newsItems) || newsItems.length === 0) {
      document.getElementById('news-body').innerHTML =
        '<div class="news-loading">No news available.</div>';
      return;
    }

    // Build dots
    const dotsEl = document.getElementById('news-dots');
    dotsEl.innerHTML = newsItems.map((_, i) =>
      `<button class="news-dot${i === 0 ? ' active' : ''}" title="News ${i+1}"></button>`
    ).join('');
    dotsEl.querySelectorAll('.news-dot').forEach((dot, i) => {
      dot.addEventListener('click', () => goToNews(i));
    });

    document.getElementById('news-nav').style.display =
      newsItems.length > 1 ? 'flex' : 'none';

    newsIndex = 0;
    renderNewsItem(0);
  } catch (err) {
    document.getElementById('news-body').innerHTML =
      `<div class="news-loading">Could not load news: ${esc(err.message)}</div>`;
  }
}

function goToNews(idx) {
  newsIndex = idx;
  renderNewsItem(idx);
}

document.getElementById('btn-prev').addEventListener('click', () => moveNews(-1));
document.getElementById('btn-next').addEventListener('click', () => moveNews(1));

loadNews().catch(oscarReportError);
