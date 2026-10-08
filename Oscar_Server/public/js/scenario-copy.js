/* global esc, oscarSelectedProvider, oscarToastAfterNav, dirty */  // defined in esc.js, nav.js and scenarios.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// ── Copy scenarios from another company or provider (#540) ────────────────────
// Test Config's "Copy scenarios from…" panel. Shown when the user may work on
// more than one company (their own and at least one provider). The server does
// the copy (POST /v1/company/scenario-copy): this panel picks the source, the
// scenarios, and a train or journey of this company's Test Data for each trip
// entry they use (asked once per trip, not per scenario).
//
// The copy writes the stored data file. Unsaved edits in the page would then
// be saved over it, so the panel refuses while there are any, and reloads the
// page after a copy.
(function () {
  'use strict';

  const panelId = 'scenario-copy-panel';
  const NOTE_STYLE = 'padding:8px 12px;border-radius:6px;font-size:13px;margin:8px 0;';
  const OK_COLORS = 'background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;';
  const ERR_COLORS = 'background:#ffebee;color:#c62828;border:1px solid #ef9a9a;';
  let preview = null;      // the last preview answer
  let sourceId = null;

  const hasUnsavedEdits = () => typeof dirty !== 'undefined' && dirty;   // scenarios.js
  const stnShort = urn => String(urn || '').split(':').pop() || '?';
  const trainValue = (id, index) => ['train', id, index].join('::');
  const warningLine = w => `<br><span style="color:#e65100;font-size:12px">⚠ ${esc(w)}</span>`;

  function showMsg(text, kind) {
    const el = document.getElementById('sc-copy-msg');
    if (!el) return;
    el.textContent = text;
    el.style.cssText = NOTE_STYLE + (kind === 'ok' ? OK_COLORS : ERR_COLORS) + (text ? '' : 'display:none');
  }

  async function readError(res, fallback) {
    const d = await res.json().catch(() => ({}));
    return d.detail || d.title || fallback;
  }

  // The companies this user may copy from: their own and its providers they may
  // use, minus the one this tab works on.
  async function sources() {
    const res = await fetch('/v1/company/providers', {});
    if (!res.ok) return [];
    const providers = (await res.json()).providers || [];
    if (!providers.length) return [];
    let own = {};
    try { own = JSON.parse(localStorage.getItem('oscar_company') || '{}') || {}; } catch { own = {}; }
    const current = (typeof oscarSelectedProvider === 'function' && oscarSelectedProvider()) || null;
    const currentId = current ? current.id : own.id;
    return [{ id: own.id, name: own.name || 'My company' }, ...providers.map(p => ({ id: p.id, name: p.name }))]
      .filter(c => c.id && c.id !== currentId);
  }

  function trainOptions(testData) {
    const opts = [];
    for (const t of testData.trains) {
      t.services.forEach(s => {
        const when = [s.departureTime, s.arrivalTime].filter(Boolean).map(x => String(x).slice(0, 5)).join('→');
        opts.push({ value: trainValue(t.id, s.index),
          text: `🚆 ${t.label} · ${stnShort(t.origin)}→${stnShort(t.destination)}${s.vehicleNumber ? ' · ' + s.vehicleNumber : ''}${when ? ' · ' + when : ''}` });
      });
      if (!t.services.length) opts.push({ value: trainValue(t.id, 0), text: `🚆 ${t.label}` });
    }
    return opts;
  }

  function journeyOptions(testData) {
    return testData.journeys.map(j => ({ value: 'journey::' + j.id, text: `🧭 ${j.label} · ${j.legs} leg${j.legs === 1 ? '' : 's'}` }));
  }

  function selectedCodes() {
    return Array.from(document.querySelectorAll('#sc-copy-scenarios input[type=checkbox]:checked')).map(b => b.value);
  }

  function renderTrips() {
    const el = document.getElementById('sc-copy-trips');
    const codes = new Set(selectedCodes());
    const trips = preview.trips.filter(t => t.usedBy.some(c => codes.has(c)));
    if (!trips.length) { el.innerHTML = ''; return; }
    const trains = trainOptions(preview.testData);
    const journeys = journeyOptions(preview.testData);
    el.innerHTML = '<div style="font-weight:700;margin:14px 0 6px">For each trip, the train or journey of this company\'s Test Data to use</div>'
      + trips.map(t => {
        const opts = (t.needsJourney ? journeys : trains.concat(journeys))
          .map(o => `<option value="${esc(o.value)}">${esc(o.text)}</option>`).join('');
        const label = `${stnShort(t.origin)} → ${stnShort(t.destination)}${t.vehicleNumber ? ' · ' + t.vehicleNumber : ''}${t.legs > 1 ? ' · ' + t.legs + ' legs' : ''}`;
        return `<div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">
          <div style="flex:1;font-size:12px"><strong>${esc(label)}</strong><br><span style="color:#90a4ae">used by ${esc(t.usedBy.join(', '))}</span></div>
          <select data-trip="${esc(t.id)}" style="flex:1.4"><option value="">— choose —</option>${opts}</select></div>`;
      }).join('')
      + (trips.some(t => t.needsJourney) && !journeys.length
        ? `<div style="${NOTE_STYLE}${ERR_COLORS}">A trip with several legs needs a journey, and this company's Test Data has none.</div>` : '');
  }

  function renderPreview() {
    const list = document.getElementById('sc-copy-scenarios');
    if (!preview.scenarios.length) {
      list.innerHTML = '<div style="color:#90a4ae">This source has no scenario you can copy.</div>';
      document.getElementById('sc-copy-trips').innerHTML = '';
      return;
    }
    list.innerHTML = preview.scenarios.map(s => `<label style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;font-size:13px;cursor:pointer">
        <input type="checkbox" value="${esc(s.code)}" data-copy-action="toggle-code" style="width:auto;margin-top:3px">
        <span><strong>${esc(s.code)}</strong> <span style="color:#90a4ae">${esc(s.scenarioType)}${s.scenarioAction ? ' · ' + esc(s.scenarioAction) : ''}</span>
        ${s.warnings.map(warningLine).join('')}</span></label>`).join('');
    renderTrips();
  }

  async function loadPreview() {
    sourceId = document.getElementById('sc-copy-source').value;
    preview = null;
    document.getElementById('sc-copy-scenarios').innerHTML = '';
    document.getElementById('sc-copy-trips').innerHTML = '';
    showMsg('');
    if (!sourceId) return;
    const res = await fetch('/v1/company/scenario-copy/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_id: sourceId }),
    });
    if (!res.ok) { showMsg(await readError(res, 'Could not read the source.'), 'error'); return; }
    preview = await res.json();
    renderPreview();
  }

  async function copy() {
    if (!preview) return;
    if (hasUnsavedEdits()) { showMsg('Save or discard your changes in this page first: the copy writes the stored file.', 'error'); return; }
    const codes = selectedCodes();
    if (!codes.length) { showMsg('Tick at least one scenario.', 'error'); return; }
    const tripMap = {};
    for (const sel of document.querySelectorAll('#sc-copy-trips select[data-trip]')) {
      const [type, id, svc] = String(sel.value).split('::');
      if (!type) { showMsg('Choose a train or journey for every trip.', 'error'); return; }
      tripMap[sel.dataset.trip] = type === 'journey' ? { type, journey_id: id } : { type, train_id: id, service_index: Number(svc) || 0 };
    }
    const btn = document.getElementById('sc-copy-go');
    btn.disabled = true;
    const res = await fetch('/v1/company/scenario-copy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_id: sourceId, codes, trip_map: tripMap }),
    });
    btn.disabled = false;
    if (!res.ok) { showMsg(await readError(res, 'The copy failed.'), 'error'); return; }
    const done = (await res.json()).copied || [];
    const renamed = done.filter(c => c.from !== c.to).map(c => `${c.from} → ${c.to}`);
    oscarToastAfterNav(`${done.length} scenario${done.length === 1 ? '' : 's'} copied from ${preview.source.name}.`
      + (renamed.length ? ` Renamed: ${renamed.join(', ')}.` : ''), 'success');
    location.reload();
  }

  async function openPanel() {
    if (document.getElementById(panelId)) { document.getElementById(panelId).remove(); return; }
    const choices = await sources();
    const panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'card';
    panel.innerHTML = `<div class="card-head"><div class="card-head-title">📋 Copy scenarios from another company or provider</div>
        <button class="btn btn-secondary btn-sm" data-copy-action="close">✕</button></div>
      <div class="card-body">
        <div style="font-size:12px;color:#78909c;margin-bottom:10px">Copies become your scenarios here, adapted to this company's Test Data and Test Framework.
          The endpoint, credentials, known deviations and findings are never copied.</div>
        <div id="sc-copy-msg" style="display:none"></div>
        <label for="sc-copy-source" style="font-weight:700;font-size:12px">Copy from</label>
        <select id="sc-copy-source" data-copy-action="source" style="margin:4px 0 12px">
          <option value="">— choose —</option>${choices.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
        <div id="sc-copy-scenarios"></div>
        <div id="sc-copy-trips"></div>
        <div style="margin-top:14px"><button class="btn btn-primary" id="sc-copy-go" data-copy-action="copy">📋 Copy</button></div>
      </div>`;
    const anchor = document.getElementById('msg');
    anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  }

  const reportError = e => showMsg(e?.message || 'Something went wrong.', 'error');

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-copy-action]');
    if (!el) return;
    if (el.dataset.copyAction === 'open') openPanel().catch(reportError);
    else if (el.dataset.copyAction === 'close') document.getElementById(panelId)?.remove();
    else if (el.dataset.copyAction === 'copy') copy().catch(reportError);
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-copy-action]');
    if (!el) return;
    if (el.dataset.copyAction === 'source') loadPreview().catch(reportError);
    else if (el.dataset.copyAction === 'toggle-code' && preview) renderTrips();
  });

  // The button, only when there is somewhere to copy from.
  sources().then(list => {
    if (!list.length) return;
    const bar = document.getElementById('header-actions');
    if (!bar) return;
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.dataset.copyAction = 'open';
    btn.textContent = '📋 Copy scenarios from…';
    bar.insertBefore(btn, bar.firstChild);
  }).catch(() => { /* no button: nothing to copy from */ });
}());
