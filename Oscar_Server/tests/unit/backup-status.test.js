// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * backup-status.test.js — #572: the disaster-recovery status.
 *  - the server's reader keeps only the members it knows, each of its type;
 *  - the host scripts write it (oscar-backup-status.sh, and oscar-backup.sh on
 *    success and on failure, run here with stub sqlite3/gpg/docker), with no
 *    path, file name or secret in it;
 *  - the Admin Dashboard draws it with text only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const BS = require('../../src/utils/backupStatus');

const REPO = path.join(__dirname, '..', '..', '..');
const SCRIPTS = path.join(REPO, 'OSCAR_Deploy', 'scripts');
const STATUS_SH = path.join(SCRIPTS, 'oscar-backup-status.sh');
const BACKUP_SH = path.join(SCRIPTS, 'oscar-backup.sh');
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'date -u -d 2026-01-01 +%s'], { encoding: 'utf8' }).status === 0;
const bashTest = hasBash ? test : test.skip;

const NOW = new Date('2026-10-19T10:00:00Z');
const FULL = {
  format: 1, updated_at: '2026-10-19T02:31:00Z', frequency: 'monthly', next_run: '2026-11-01T02:30:00Z',
  retention_keep: 6, archives_present: 3, last_backup_at: '2026-10-19T02:31:00Z', last_backup_ok: true,
  last_backup_size_bytes: 123456, last_success_at: '2026-10-19T02:31:00Z', last_failure_at: null,
  last_restore_drill_at: '2026-10-01T00:00:00Z',
};

describe('viewOf: the members the page gets', () => {
  test('a full status, no warning', () => {
    const v = BS.viewOf(FULL, NOW);
    expect(v).toEqual({ ...FULL, format: undefined, state: 'reported', warnings: [] });
    expect('format' in v).toBe(false);
  });

  test('unknown members are dropped; wrong types read as null', () => {
    const v = BS.viewOf({ ...FULL, path: '/root/oscar-backups/x.gpg', passphrase: 'p', frequency: 'hourly', retention_keep: -1,
      archives_present: 1.5, last_backup_ok: 'yes', last_backup_at: '2026-10-19 02:31', next_run: 7 }, NOW);
    expect(Object.keys(v).sort()).toEqual([
      'archives_present', 'frequency', 'last_backup_at', 'last_backup_ok', 'last_backup_size_bytes', 'last_failure_at',
      'last_restore_drill_at', 'last_success_at', 'next_run', 'retention_keep', 'state', 'updated_at', 'warnings']);
    expect(v).toMatchObject({ frequency: null, retention_keep: null, archives_present: null, last_backup_ok: null, last_backup_at: null, next_run: null });
    expect(JSON.stringify(v)).not.toMatch(/root|passphrase|gpg/);
  });

  test('warnings: a failed backup, a next run in the past, more archives than kept, no drill', () => {
    const v = BS.viewOf({ ...FULL, last_backup_ok: false, next_run: '2026-10-01T02:30:00Z', archives_present: 7, last_restore_drill_at: null }, NOW);
    expect(v.warnings).toEqual(['last_backup_failed', 'next_run_past', 'more_archives_than_kept', 'no_restore_drill']);
  });

  test('not an object is unreadable', () => {
    for (const raw of [null, [], 'x', 3]) expect(BS.viewOf(raw, NOW)).toEqual({ state: 'unreadable' });
  });
});

describe('readBackupStatus', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-bs-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('no file yet', () => {
    expect(BS.readBackupStatus({ file: path.join(dir, 'backup-status.json'), now: NOW })).toEqual({ state: 'none' });
  });

  test('a file it can read', () => {
    const file = path.join(dir, 'backup-status.json');
    fs.writeFileSync(file, JSON.stringify(FULL));
    expect(BS.readBackupStatus({ file, now: NOW }).state).toBe('reported');
  });

  test('not JSON, too large, or a directory: unreadable', () => {
    const file = path.join(dir, 'backup-status.json');
    fs.writeFileSync(file, '{ not json');
    expect(BS.readBackupStatus({ file, now: NOW })).toEqual({ state: 'unreadable' });
    fs.writeFileSync(file, JSON.stringify({ ...FULL, pad: 'x'.repeat(BS.MAX_BYTES) }));
    expect(BS.readBackupStatus({ file, now: NOW })).toEqual({ state: 'unreadable' });
    expect(BS.readBackupStatus({ file: dir, now: NOW })).toEqual({ state: 'unreadable' });
  });

  test('statusPath: next to the database, or named', () => {
    expect(BS.statusPath({ OSCAR_DB_PATH: '/srv/data/oscar.db' })).toBe(path.join('/srv/data', 'backup-status.json'));
    expect(BS.statusPath({ OSCAR_BACKUP_STATUS_PATH: '/x/s.json', OSCAR_DB_PATH: '/srv/data/oscar.db' })).toBe('/x/s.json');
  });
});

describe('the host scripts write it', () => {
  let root, data, out, timer;
  const env = () => ({ ...process.env, HOME: root, OSCAR_DATA_DIR: data, OSCAR_BACKUP_DIR: out, OSCAR_BACKUP_KEEP: '4', OSCAR_BACKUP_TIMER_FILE: timer });
  const status = (...args) => execFileSync('bash', [STATUS_SH, ...args], { env: env(), encoding: 'utf8' });
  const stored = () => JSON.parse(fs.readFileSync(path.join(data, 'backup-status.json'), 'utf8'));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-bs-host-'));
    data = path.join(root, 'data'); out = path.join(root, 'backups'); timer = path.join(root, 'oscar-backup.timer');
    fs.mkdirSync(data); fs.mkdirSync(out);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  bashTest('backup-ok, then a failure, then a drill: each keeps what the others wrote', () => {
    const archive = path.join(out, 'oscar-backup-20261019-023000.tar.gz.gpg');
    fs.writeFileSync(archive, Buffer.alloc(2048));
    fs.writeFileSync(`${archive}.sha256`, 'x');
    fs.writeFileSync(timer, '[Timer]\nOnCalendar=*-*-01 02:30:00\nPersistent=true\n');

    status('backup-ok', archive);
    let s = stored();
    expect(s).toMatchObject({ format: 1, frequency: 'monthly', retention_keep: 4, archives_present: 1, last_backup_ok: true,
      last_backup_size_bytes: 2048, last_failure_at: null, last_restore_drill_at: null });
    expect(s.last_success_at).toBe(s.last_backup_at);
    const success = s.last_success_at;

    status('backup-failed');
    s = stored();
    expect(s).toMatchObject({ last_backup_ok: false, last_backup_size_bytes: null, last_success_at: success });
    expect(s.last_failure_at).toBe(s.last_backup_at);

    status('drill', '2026-10-02');
    s = stored();
    expect(s).toMatchObject({ last_restore_drill_at: '2026-10-02T00:00:00Z', last_success_at: success, last_backup_ok: false });

    fs.rmSync(timer);
    status('schedule');
    expect(stored()).toMatchObject({ frequency: 'on-demand', next_run: null, last_restore_drill_at: '2026-10-02T00:00:00Z' });

    // Metadata only: no path, file name, host or user anywhere in it.
    const text = fs.readFileSync(path.join(data, 'backup-status.json'), 'utf8');
    for (const word of [root, 'oscar-backup-2026', os.hostname(), '.gpg']) expect(text).not.toContain(word);
    expect(BS.viewOf(JSON.parse(text), NOW).state).toBe('reported');
    expect((fs.statSync(path.join(data, 'backup-status.json')).mode & 0o777).toString(8)).toBe('644');
  });

  bashTest('a bad drill date or command changes nothing', () => {
    expect(spawnSync('bash', [STATUS_SH, 'drill', 'yesterday'], { env: env() }).status).toBe(2);
    expect(spawnSync('bash', [STATUS_SH, 'download'], { env: env() }).status).toBe(2);
    expect(fs.existsSync(path.join(data, 'backup-status.json'))).toBe(false);
  });

  // oscar-backup.sh itself, with stub tools: the status is written when it
  // succeeds and when it fails.
  function stubTools(gpgFails) {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const write = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
    write('sqlite3', 'if [ "$2" != "${2#.backup}" ]; then f="${2#.backup }"; f="${f//\\\'/}"; : > "$f"; else echo 1; fi');
    write('docker', 'exit 1');
    write('gpg', gpgFails ? 'exit 1' : 'out=""; while [ $# -gt 1 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; cp "$1" "$out"');
    write('logger', 'exit 0');
    return bin;
  }
  function runBackup(gpgFails) {
    const bin = stubTools(gpgFails);
    fs.writeFileSync(path.join(data, 'oscar.db'), '');
    fs.writeFileSync(path.join(root, '.env'), 'ENCRYPTION_KEY=secret-key-value\n');
    fs.writeFileSync(path.join(root, 'pass'), 'secret-pass-value\n');
    return spawnSync('bash', [BACKUP_SH], {
      env: { ...env(), PATH: `${bin}:${process.env.PATH}`, OSCAR_ENV_FILE: path.join(root, '.env'), OSCAR_BACKUP_PASSPHRASE_FILE: path.join(root, 'pass') },
      encoding: 'utf8',
    });
  }

  bashTest('oscar-backup.sh records a success', () => {
    const r = runBackup(false);
    expect([r.status, r.stderr]).toEqual([0, '']);
    const s = stored();
    expect(s).toMatchObject({ last_backup_ok: true, archives_present: 1, retention_keep: 4 });
    expect(s.last_backup_size_bytes).toBeGreaterThan(0);
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/secret|ENCRYPTION_KEY|oscar-backup-/);
  });

  bashTest('oscar-backup.sh records a failure and still fails', () => {
    const r = runBackup(true);
    expect(r.status).not.toBe(0);
    expect(stored()).toMatchObject({ last_backup_ok: false, last_success_at: null });
  });
});

describe('the Admin Dashboard panel', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'admin-dashboard.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('#572'));

  test('it writes text only, and offers nothing but reading', () => {
    expect(script).toBeDefined();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(script).not.toMatch(/method\s*:/);
    expect(html).not.toMatch(/data-action="[^"]*backup/);
  });

  function render(status) {
    const made = [];
    const el = (tag) => {
      const e = { tag, className: '', textContent: '', children: [], appendChild(c) { this.children.push(c); return c; }, replaceChildren(...c) { this.children = c; } };
      made.push(e);
      return e;
    };
    const ctx = { document: { createElement: el }, Number, Date, String };
    vm.runInNewContext(script.replace(/\(function \(\) \{[\s\S]*\}\)\(\);\s*$/, ''), ctx);
    const body = el('div');
    ctx.drRender(body, status);
    const texts = [];
    (function walk(n) { if (n.textContent) texts.push(n.textContent); n.children.forEach(walk); })(body);
    return texts;
  }

  test('a status is drawn item by item, with its warnings', () => {
    const texts = render(BS.viewOf({ ...FULL, last_backup_ok: false, last_restore_drill_at: null }, NOW));
    expect(texts).toEqual(expect.arrayContaining(['Last backup', 'Result', 'Failed', 'Size', '120.6 KB', 'Frequency', 'Monthly (the 1st, 02:30)',
      'Retention', 'keeps 6', 'Archives present', '3', 'Last restore drill', '—']));
    expect(texts.some((t) => t.startsWith('The last backup failed'))).toBe(true);
    expect(texts.some((t) => t.startsWith('No restore drill is recorded'))).toBe(true);
  });

  test('no status yet, or one that cannot be read', () => {
    expect(render({ state: 'none' })[0]).toMatch(/^No backup recorded yet/);
    expect(render({ state: 'unreadable' })[0]).toMatch(/cannot be read/);
  });
});
