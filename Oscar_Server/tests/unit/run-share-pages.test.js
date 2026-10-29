'use strict';

// #901 PR 2: the page helpers that share runs with the company operating a
// provider, and show the runs shared with one's own company. No DOM harness
// exists for public/: the top-level functions are lifted out by text and run
// in a bare vm context, as ui-scripts.test.js does.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');

function loadFunction(rel, name, context = {}) {
  const lines = read(rel).split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start === -1) throw new Error(`${rel}: no top-level "function ${name}(" at column 0`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

// The pages' own encoder (public/js/esc.js), loaded the way the pages load it.
const escContext = {};
vm.runInNewContext(read('js/esc.js'), escContext);
const esc = escContext.esc || escContext.escHtml;

const EVIL = 'Op <b>&"\'';
const TM = { id: 'u1', role: 'test_manager' };

describe('dashboard: share with the operating company', () => {
  const ctx = (user, operatorOf) => ({ user, operatorOf, esc });

  test('a finished run of a provider whose link is accepted offers the share, name escaped', () => {
    const f = loadFunction('dashboard.html', 'operatorShareFor', ctx(TM, { p1: EVIL }));
    const html = f({ id: 'r1', company_id: 'p1', status: 'COMPLETED' });
    expect(html).toContain('data-action="share-operator"');
    expect(html).toContain('data-run-id="r1"');
    expect(html).not.toContain('<b>');
    expect(html).toContain(esc(EVIL));
  });

  test('a shared run shows the badge and the undo', () => {
    const f = loadFunction('dashboard.html', 'operatorShareFor', ctx(TM, { p1: 'ČD' }));
    const html = f({ id: 'r1', company_id: 'p1', status: 'FAILED', shared_with_operator_at: '2026-10-20 10:00:00' });
    expect(html).toContain('✓ Shared with ČD');
    expect(html).toContain('data-action="unshare-operator"');
  });

  test('nothing without an accepted link, for a running run, or for a tester', () => {
    expect(loadFunction('dashboard.html', 'operatorShareFor', ctx(TM, {}))({ id: 'r', company_id: 'p1', status: 'COMPLETED' })).toBe('');
    expect(loadFunction('dashboard.html', 'operatorShareFor', ctx(TM, { p1: 'X' }))({ id: 'r', company_id: 'p1', status: 'RUNNING' })).toBe('');
    expect(loadFunction('dashboard.html', 'operatorShareFor', ctx({ role: 'company_user' }, { p1: 'X' }))({ id: 'r', company_id: 'p1', status: 'COMPLETED' })).toBe('');
  });

  test('a batch offers the share until every run of it is shared', () => {
    const f = loadFunction('dashboard.html', 'batchOperatorAction', ctx(TM, { p1: 'ČD' }));
    expect(f([{ company_id: 'p1', shared_with_operator_at: 'x' }, { company_id: 'p1' }], 'b1')).toContain('data-action="share-batch-operator"');
    expect(f([{ company_id: 'p1', shared_with_operator_at: 'x' }], 'b1')).toContain('data-action="unshare-batch-operator"');
    expect(loadFunction('dashboard.html', 'batchOperatorAction', ctx(TM, {}))([{ company_id: 'p1' }], 'b1')).toBe('');
  });

  test('every share action ends in "-operator", which the click handler reads', () => {
    const src = read('dashboard.html');
    expect(src).toContain('[data-action$="-operator"]');
    for (const a of ['share-operator', 'unshare-operator', 'share-batch-operator', 'unshare-batch-operator']) expect(src).toContain(a);
  });
});

describe('dashboard: runs shared with this company', () => {
  test('a row names the distributor and the provider, escaped', () => {
    const f = loadFunction('dashboard.html', 'sharedRunRowHtml', {
      esc, fmtDate: () => 'd', duration: () => '1s',
    });
    const html = f({ id: 'r1', status: 'COMPLETED', scenario_code: '<i>X</i>', shared: { distributor: EVIL, provider: 'CHAPS' } });
    expect(html).not.toContain('<i>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('provider CHAPS');
  });

  test('the list and the links are read for the own company, never the selected provider', () => {
    expect(read('dashboard.html')).toMatch(/\/v1\/company\/shared-runs[^\n]*'X-Provider-Id': ''/);
    expect(read('providers.html')).toMatch(/\/v1\/company\/run-share-links'[^\n]*'X-Provider-Id': ''/);
    expect(read('providers.html')).toMatch(/run-share-links\/' \+ encodeURIComponent\(providerId\)[^\n]*'X-Provider-Id': ''/);
  });
});

describe('run detail: a shared run is read only', () => {
  test('the note is text, never markup', () => {
    const note = { style: {}, textContent: '' };
    const f = loadFunction('run-detail.html', 'showSharedNote', { document: { getElementById: () => note } });
    f({ shared: { distributor: EVIL, provider: 'CHAPS' } });
    expect(note.textContent).toContain(EVIL);
    expect(note.style.display).toBe('block');
    f({});
    expect(note.style.display).toBe('none');
  });

  test('the certifier share is not offered on a shared run', () => {
    expect(read('run-detail.html')).toContain("if (user.role === 'test_manager' && !run.shared) {");
  });
});

describe('providers page', () => {
  test('the operator label escapes the name and says where the link stands', () => {
    const f = loadFunction('providers.html', 'operatorLabel', { esc });
    expect(f(null)).toContain('—');
    const html = f({ company_name: EVIL, status: 'waiting' });
    expect(html).not.toContain('<b>');
    expect(html).toContain('waiting for their acceptance');
  });

  test('a link row offers what its status allows', () => {
    const f = loadFunction('providers.html', 'linkRow', { esc });
    const waiting = f({ provider_id: 'p1', distributor_name: EVIL, provider_name: 'CHAPS', status: 'waiting' });
    expect(waiting).toContain('data-action="link-accept"');
    expect(waiting).toContain('data-action="link-refuse"');
    expect(waiting).not.toContain('<b>');
    const accepted = f({ provider_id: 'p1', distributor_name: 'UIC', provider_name: 'CHAPS', status: 'accepted' });
    expect(accepted).not.toContain('link-accept');
    expect(accepted).toContain('>Stop<');
    expect(f({ provider_id: 'p1', distributor_name: 'UIC', provider_name: 'CHAPS', status: 'refused' })).not.toContain('link-refuse');
  });
});

describe('dashboard: a whole batch shared with certifiers (#1041)', () => {
  const f = (user) => loadFunction('dashboard.html', 'batchCertifierAction', { user, esc });
  const done = (extra = {}) => ({ status: 'COMPLETED', ...extra });

  test('offered while a finished run of the batch is not shared; undone once all are', () => {
    expect(f(TM)([done({ shared_with_certifier_at: 'x' }), done()], 'b1')).toContain('data-action="share-batch-certifier"');
    expect(f(TM)([done({ shared_with_certifier_at: 'x' }), { status: 'RUNNING' }], 'b1')).toContain('data-action="unshare-batch-certifier"');
    expect(f(TM)([done({ shared_with_certifier_at: 'x' }), { status: 'RUNNING' }], 'b1')).toContain('✓ Shared with certifiers');
  });

  test('nothing for a batch with no finished run, nor for anyone but a Test Manager', () => {
    expect(f(TM)([{ status: 'QUEUED' }, { status: 'RUNNING' }], 'b1')).toBe('');
    expect(f({ role: 'company_user' })([done()], 'b1')).toBe('');
    expect(f({ role: 'certification_user' })([done()], 'b1')).toBe('');
  });

  test('the batch id is escaped', () => {
    const html = f(TM)([done()], 'b"><img src=x>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;');
  });

  test('the click handler reads the actions, asks first, and calls the batch route', () => {
    const src = read('dashboard.html');
    expect(src).toContain('[data-action$="-batch-certifier"]');
    expect(src).toContain('/v1/runs/batch/${encodeURIComponent(certEl.dataset.batchId)}/share`');
    expect(src).toMatch(/if \(confirm\(batchCertifierQuestion\(share\)\)\)/);
    // The certifier handler comes before the batch row's toggle, which would swallow the click.
    expect(src.indexOf('-batch-certifier"]')).toBeLessThan(src.indexOf('[data-action="toggle-batch"]\')'));
    const q = loadFunction('dashboard.html', 'batchCertifierQuestion');
    expect(q(true)).toContain('every finished run');
    expect(q(false)).toContain('Stop sharing');
  });
});
