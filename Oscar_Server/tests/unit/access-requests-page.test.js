// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Manage Users shows the administrator a request whose e-mail is not
 * confirmed yet, greyed, with when its link runs out, and offers only Refuse.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE = fs.readFileSync(path.join(__dirname, '../../public/admin.html'), 'utf8');

function loadFunction(name, context) {
  const lines = PAGE.split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.codePointAt(0)};`);
const parseServerTs = s => new Date(/Z$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
const context = { esc, parseServerTs, fmtDate: s => `date(${s})`, Date, Number };
const unconfirmedHtml = loadFunction('unconfirmedHtml', context);

test('a request not confirmed yet says so, with when its link runs out', () => {
  const later = new Date(Date.now() + 3600e3).toISOString();
  expect(unconfirmedHtml(later)).toContain('E-mail not confirmed yet');
  expect(unconfirmedHtml(later)).toContain(`link valid until date(${later})`);
  expect(unconfirmedHtml('2020-01-01 00:00:00')).toContain('link expired');
});

test('only Refuse is offered for it, and only to the administrator', () => {
  const actions = loadFunction('accessActionsHtml', { ...context, isTestMgr: false, companies: [{ id: 'c1', name: 'Acme' }] });
  const unconfirmed = actions({ id: 'r1', email: 'a@x.test', state: 'unverified' });
  expect(unconfirmed).toContain('data-access-action="refuse"');
  expect(unconfirmed).not.toContain('data-access-action="assign"');
  expect(actions({ id: 'r2', email: 'b@x.test', state: 'verified' })).toContain('data-access-action="assign"');
});

test('the company column of an unconfirmed request names no company', () => {
  const column = loadFunction('accessCompanyHtml', { ...context, isTestMgr: false, unconfirmedHtml });
  expect(column({ state: 'unverified', link_expires_at: '2020-01-01 00:00:00' })).toContain('E-mail not confirmed yet');
  expect(column({ state: 'verified' })).toContain('To place');
});
