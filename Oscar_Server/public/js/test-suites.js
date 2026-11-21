/* global esc, runSelection */  // esc.js, run.html
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * test-suites.js — the Run page's named suites (#1342 PR 4). A Test Manager
 * saves the selection the panel shows as a suite, which the company's test
 * automation then asks by name (POST /v1/api/test-requests { suite }).
 * Suites belong to the company and apply to every provider. Loaded after the
 * Run page's own script: it reads its `runSelection` (the selection as the
 * server took it).
 *
 * suitesHtml(), selectionText() and suiteIdOf() are pure top-level functions, lifted by
 * the page test; the rest is wiring.
 */

const SUITE_FILTER_WORDS = [['categories', 'category'], ['modes', 'distribution'], ['groups', 'capability'], ['forms', 'offer request']];

// A selection in words: each filter that keeps some values, and the last run.
function selectionText(selection) {
  if (!selection) return '';
  const parts = SUITE_FILTER_WORDS
    .filter(([key]) => Array.isArray(selection[key]) && selection[key].length > 0)
    .map(([key, word]) => word + ': ' + selection[key].join(', '));
  if (selection.lastRun && selection.lastRun !== 'all') parts.push('last run: ' + selection.lastRun);
  // #1353: the run list is each provider's own, read at each launch.
  if (selection.base === 'list') parts.unshift('run list of each provider');
  return parts.length ? parts.join(' · ') : 'every scenario';
}

// An id read from an answer, before it goes in a request address: a UUID, else null (S8476).
const SUITE_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function suiteIdOf(value) {
  const text = typeof value === 'string' ? value : '';
  return SUITE_ID.test(text) ? text.toLowerCase() : null;
}

function suitesHtml(suites, canChange) {
  if (!suites.length) return '<div class="muted">No suite yet.</div>';
  return '<table class="suites"><thead><tr><th>Name</th><th>What it runs</th><th></th></tr></thead><tbody>'
    + suites.map(s => '<tr><td><strong>' + esc(s.name) + '</strong></td><td>'
      + (s.selection ? esc(selectionText(s.selection)) : '')
      + (s.selection && s.codes ? ' · ' : '')
      + (s.codes ? esc(s.codes.length + ' scenario(s) named: ' + s.codes.join(', ')) : '')
      + '</td><td>' + (canChange ? '<button type="button" class="btn btn-sm" data-suite-action="delete" data-id="' + esc(s.id) + '">Delete</button>' : '')
      + '</td></tr>').join('')
    + '</tbody></table>';
}

(function () {
  if (typeof document === 'undefined') return;
  const card = document.getElementById('suites-card');
  if (!card) return;
  let me = {};
  try { me = JSON.parse(localStorage.getItem('oscar_user') || '{}'); } catch { me = {}; }
  if (me.role !== 'test_manager' && me.role !== 'company_user') return;
  const canChange = me.role === 'test_manager';
  card.style.display = 'block';
  document.getElementById('suite-save').style.display = canChange ? 'flex' : 'none';

  function say(text, ok) {
    const el = document.getElementById('suite-msg');
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
    el.style.display = 'block';
  }
  async function readError(res, fallback) {
    const d = await res.json().catch(() => ({}));
    return d.detail || d.title || fallback;
  }

  async function load() {
    const res = await fetch('/v1/company/test-suites');
    const list = document.getElementById('suites-list');
    if (!res.ok) { list.textContent = await readError(res, 'The suites could not be loaded.'); return; }
    list.innerHTML = suitesHtml((await res.json()).suites || [], canChange);
  }

  async function save() {
    const name = document.getElementById('suite-name').value.trim();
    if (!name) { say('Give the suite a name: your test automation asks it by that name.', false); return; }
    // runSelection is the Run page's: what the panel shows, as the server took it.
    const selection = typeof runSelection === 'undefined' ? null : runSelection;
    if (!selection) { say('Choose a selection in the panel first.', false); return; }
    const res = await fetch('/v1/company/test-suites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, selection }),
    });
    if (!res.ok) { say(await readError(res, 'The suite was not saved.'), false); return; }
    document.getElementById('suite-name').value = '';
    say('Suite saved. Its filters are applied again on each provider at each launch.', true);
    await load();
  }

  async function remove(value) {
    const id = suiteIdOf(value);
    if (!id) { say('This is not an id OSCAR gave: reload the page.', false); return; }
    if (!confirm('Delete this suite? A test automation asking it by name gets a 404 from now on.')) return;
    const res = await fetch('/v1/company/test-suites/' + id, { method: 'DELETE' });
    if (!res.ok) { say(await readError(res, 'The suite was not deleted.'), false); return; }
    say('Suite deleted.', true);
    await load();
  }

  const report = e => say(e?.message || 'Something went wrong.', false);
  card.addEventListener('click', (e) => {
    const el = e.target.closest('[data-suite-action]');
    if (!el) return;
    if (el.dataset.suiteAction === 'save') save().catch(report);
    else if (el.dataset.suiteAction === 'delete') remove(el.dataset.id).catch(report);
  });
  load().catch(report);
})();
