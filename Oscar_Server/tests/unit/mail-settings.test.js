// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mail-settings.test.js — the mail server's settings are the server's
 * environment's (#1363).
 *
 *   - utils/mailSettings.js, pure: which settings, which source, the start line;
 *   - db.js getConfig(): the environment's values are the ones read once the
 *     environment names a mail server, the stored ones until then;
 *   - a first start: a mail server named by the environment is not copied
 *     into the database, its password least of all;
 *   - the mailer and the Alertmanager file read through getConfig();
 *   - who writes server_config in src/, so that a new writer is looked at.
 *
 * The route's side (nothing written from Server Config, a save answering what
 * a read gives) is in tests/integration/admin-routes.test.js.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const M = require('../../src/utils/mailSettings');

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

// The test's own view of the environment's mail settings, put back after each test.
let envBefore;
beforeEach(() => {
  envBefore = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    if (envBefore[key] === undefined) delete process.env[key];
    else process.env[key] = envBefore[key];
  }
});

describe('utils/mailSettings.js', () => {
  test('the mail settings are the six SMTP_* keys, and no other key', () => {
    expect([...M.MAIL_KEYS].sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) expect(M.isMailKey(key)).toBe(true);
    for (const key of ['ALERT_RECIPIENTS', 'LOG_LEVEL', 'JWT_SECRET', 'smtp_host', '', undefined, null, 'constructor', '__proto__']) {
      expect(M.isMailKey(key)).toBe(false);
    }
  });

  test('the environment names a mail server when SMTP_HOST holds text', () => {
    expect(M.fromEnvironment({ SMTP_HOST: 'smtp.example.org' })).toBe(true);
    expect(M.fromEnvironment({ SMTP_HOST: '  smtp.example.org  ' })).toBe(true);
    for (const env of [{}, { SMTP_HOST: '' }, { SMTP_HOST: '   ' }, { SMTP_HOST: undefined }, { SMTP_USER: 'u', SMTP_PASS: 'p' }]) {
      expect(M.fromEnvironment(env)).toBe(false);
    }
  });

  test('a value of the environment is its trimmed text, or null; never another key', () => {
    const env = { SMTP_HOST: ' smtp.example.org ', SMTP_PORT: '465', SMTP_USER: '', ENCRYPTION_KEY: 'not-for-here' };
    expect(M.environmentValue('SMTP_HOST', env)).toBe('smtp.example.org');
    expect(M.environmentValue('SMTP_PORT', env)).toBe('465');
    expect(M.environmentValue('SMTP_USER', env)).toBeNull();
    expect(M.environmentValue('SMTP_PASS', env)).toBeNull();
    expect(M.environmentValue('ENCRYPTION_KEY', env)).toBeNull();
  });

  test('the source: the environment first, else what is stored, else none', () => {
    expect(M.sourceOf('smtp.stored.example', { SMTP_HOST: 'smtp.env.example' })).toBe('environment');
    expect(M.sourceOf('', { SMTP_HOST: 'smtp.env.example' })).toBe('environment');
    expect(M.sourceOf('smtp.stored.example', {})).toBe('stored');
    for (const stored of ['', '   ', undefined, null]) expect(M.sourceOf(stored, {})).toBe('none');
  });

  test('the start line warns for settings still read from the database', () => {
    expect(M.startLine('environment').level).toBe('info');
    expect(M.startLine('none').level).toBe('info');
    const stored = M.startLine('stored');
    expect(stored.level).toBe('warn');
    expect(stored.text).toMatch(/server's environment/);
    for (const source of ['environment', 'stored', 'none']) expect(M.startLine(source).text).toMatch(/^Mail settings: /);
  });

  // An .env may still hold the mail server of the first installation, changed
  // since from the page: at the upgrade that old one becomes the one read.
  describe('saved settings the environment replaces with another value', () => {
    const SAVED = { SMTP_HOST: 'smtp.new.example', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'login', SMTP_PASS: 'new-key', SMTP_FROM: 'OSCAR Platform <noreply@oscar.uic.org>' };

    test('none when the environment names no mail server, or says the same', () => {
      expect(M.replacedByEnvironment(SAVED, {})).toEqual([]);
      expect(M.replacedByEnvironment(SAVED, { ...SAVED })).toEqual([]);
      // What the environment leaves out is its default: the same as a saved default.
      expect(M.replacedByEnvironment(SAVED, { SMTP_HOST: 'smtp.new.example', SMTP_USER: 'login', SMTP_PASS: 'new-key' })).toEqual([]);
      expect(M.replacedByEnvironment({}, { SMTP_HOST: 'smtp.env.example' })).toEqual([]);
      expect(M.replacedByEnvironment(undefined, { SMTP_HOST: 'smtp.env.example' })).toEqual([]);
    });

    test('the names of those that differ, in the settings\' order, never a value', () => {
      const env = { SMTP_HOST: 'smtp.old.example', SMTP_PORT: '465', SMTP_USER: 'login', SMTP_PASS: 'old-key' };
      const replaced = M.replacedByEnvironment(SAVED, env);
      expect(replaced).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_PASS']);
      const line = M.startLine('environment', replaced);
      expect(line.level).toBe('warn');
      expect(line.text).toContain('SMTP_HOST, SMTP_PORT, SMTP_PASS');
      for (const value of ['smtp.old.example', 'smtp.new.example', 'old-key', 'new-key']) expect(line.text).not.toContain(value);
    });

    test('a saved value the environment leaves out is replaced by nothing, and said', () => {
      expect(M.replacedByEnvironment({ SMTP_HOST: 'h', SMTP_USER: 'login' }, { SMTP_HOST: 'h' })).toEqual(['SMTP_USER']);
    });
  });
});

describe('getConfig() reads a mail setting where the mail server is named', () => {
  const { getConfig, run, get } = require('../../src/db/db');
  const store = (key, value) => run(`INSERT INTO server_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  const STORED = { SMTP_HOST: 'smtp.stored.example', SMTP_PORT: '2525', SMTP_SECURE: 'true', SMTP_USER: 'stored-login', SMTP_PASS: 'stored-password', SMTP_FROM: 'Stored <s@stored.example>' };

  let before;
  beforeEach(() => {
    before = Object.fromEntries(KEYS.map(key => [key, get('SELECT value FROM server_config WHERE key = ?', [key])?.value]));
    for (const [key, value] of Object.entries(STORED)) store(key, value);
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (before[key] === undefined) run('DELETE FROM server_config WHERE key = ?', [key]);
      else store(key, before[key]);
    }
  });

  test('no mail server in the environment: the stored values, as before', () => {
    for (const key of KEYS) expect(getConfig(key, 'fallback')).toBe(STORED[key]);
  });

  test('a mail server in the environment: every mail setting is the environment\'s', () => {
    Object.assign(process.env, { SMTP_HOST: 'smtp.env.example', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'env-login', SMTP_PASS: 'env-password', SMTP_FROM: 'Env <e@env.example>' });
    expect(KEYS.map(key => getConfig(key, 'fallback'))).toEqual(['smtp.env.example', '465', 'true', 'env-login', 'env-password', 'Env <e@env.example>']);
  });

  test('what the environment leaves out is the default, never the stored value', () => {
    process.env.SMTP_HOST = 'smtp.env.example';
    expect(getConfig('SMTP_PORT', '587')).toBe('587');
    expect(getConfig('SMTP_SECURE', 'false')).toBe('false');
    expect(getConfig('SMTP_USER', '')).toBe('');
    expect(getConfig('SMTP_PASS', '')).toBe('');
    expect(getConfig('SMTP_FROM', 'OSCAR Platform <noreply@oscar.uic.org>')).toBe('OSCAR Platform <noreply@oscar.uic.org>');
  });

  test('the environment is read at each call: no restart of the tests\' server between', () => {
    expect(getConfig('SMTP_HOST', '')).toBe('smtp.stored.example');
    process.env.SMTP_HOST = 'smtp.env.example';
    expect(getConfig('SMTP_HOST', '')).toBe('smtp.env.example');
    delete process.env.SMTP_HOST;
    expect(getConfig('SMTP_HOST', '')).toBe('smtp.stored.example');
  });

  test('other settings are read as before: the stored value wins over the environment', () => {
    const prior = get("SELECT value FROM server_config WHERE key = 'ALERT_RECIPIENTS'")?.value;
    const envPrior = process.env.ALERT_RECIPIENTS;
    store('ALERT_RECIPIENTS', 'stored@example.org');
    process.env.ALERT_RECIPIENTS = 'env@example.org';
    process.env.SMTP_HOST = 'smtp.env.example';
    try {
      expect(getConfig('ALERT_RECIPIENTS', '')).toBe('stored@example.org');
    } finally {
      if (envPrior === undefined) delete process.env.ALERT_RECIPIENTS; else process.env.ALERT_RECIPIENTS = envPrior;
      if (prior === undefined) run("DELETE FROM server_config WHERE key = 'ALERT_RECIPIENTS'"); else store('ALERT_RECIPIENTS', prior);
    }
  });

  test('the mailer and the Alertmanager file follow', () => {
    const { isSmtpConfigured } = require('../../src/utils/mailer');
    const { renderConfig } = require('../../src/utils/alertmanagerConfig');
    const priorRecipients = get("SELECT value FROM server_config WHERE key = 'ALERT_RECIPIENTS'")?.value;
    store('ALERT_RECIPIENTS', 'admin@example.org');
    Object.assign(process.env, { SMTP_HOST: 'smtp.env.example', SMTP_USER: 'env-login', SMTP_PASS: 'env-password', SMTP_FROM: 'Env <e@env.example>' });
    try {
      expect(isSmtpConfigured()).toBe(true);
      const yaml = renderConfig();
      expect(yaml).toContain('smtp.env.example');
      expect(yaml).toContain('env-login');
      expect(yaml).not.toContain('smtp.stored.example');
      expect(yaml).not.toContain('stored-password');
      // The environment names a server and gives no login: not configured,
      // whatever login is still stored.
      delete process.env.SMTP_USER;
      expect(isSmtpConfigured()).toBe(false);
    } finally {
      if (priorRecipients === undefined) run("DELETE FROM server_config WHERE key = 'ALERT_RECIPIENTS'"); else store('ALERT_RECIPIENTS', priorRecipients);
    }
  });
});

describe('a first start', () => {
  // db.js opens its database from OSCAR_DB_PATH when it is required and seeds
  // server_config; each case boots it against a database of its own.
  let dir;
  let dbPathBefore;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-mail-settings-'));
    dbPathBefore = process.env.OSCAR_DB_PATH;
  });
  afterAll(() => {
    if (dbPathBefore === undefined) delete process.env.OSCAR_DB_PATH; else process.env.OSCAR_DB_PATH = dbPathBefore;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Boots db.js on a new database, closes it, and answers its server_config.
  function seededBy(name) {
    const file = path.join(dir, `${name}.db`);
    jest.isolateModules(() => {
      process.env.OSCAR_DB_PATH = file;
      require('../../src/db/db').db.close();
    });
    process.env.OSCAR_DB_PATH = dbPathBefore;
    const d = new DatabaseSync(file);
    try {
      return Object.fromEntries(d.prepare('SELECT key, value FROM server_config').all().map(r => [r.key, r.value]));
    } finally {
      d.close();
    }
  }

  test('a mail server named by the environment is not copied into the database', () => {
    Object.assign(process.env, { SMTP_HOST: 'smtp.env.example', SMTP_USER: 'env-login', SMTP_PASS: 'env-password-never-stored', SMTP_FROM: 'Env <e@env.example>' });
    const config = seededBy('environment');
    for (const key of KEYS) expect(config).not.toHaveProperty(key);
    expect(JSON.stringify(config)).not.toContain('env-password-never-stored');
    // The other settings are seeded as before.
    expect(config).toHaveProperty('MAX_CONCURRENT_RUNS');
    expect(config).toHaveProperty('ALERT_REPEAT_CRITICAL', '1h');
  });

  test('with no mail server in the environment, the rows are seeded as before', () => {
    const config = seededBy('none');
    expect(KEYS.map(key => config[key])).toEqual(['', '587', 'false', '', '', 'OSCAR Platform <noreply@oscar.uic.org>']);
  });
});

describe('who writes server_config', () => {
  // A mail setting must never be written from a request. Today three files
  // write the table: admin.js (the Server Config save, which refuses the mail
  // settings, and the session secret), db.js (the first start's seed) and
  // server.js (the session secret), besides the simulator's own keys. A new
  // writer fails here, to be read before it is added to the list.
  const SRC = path.join(__dirname, '..', '..', 'src');
  const WRITES = /(INSERT(\s+OR\s+[A-Z]+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+server_config/;

  function filesUnder(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) return filesUnder(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  test('only the known files do', () => {
    const writers = filesUnder(SRC)
      .filter(file => WRITES.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();
    expect(writers).toEqual(['api/routes/admin.js', 'db/db.js', 'server.js', 'services/simulatorAdmin.js']);
  });

  test('the Server Config save looks at the mail settings before anything is stored or removed', () => {
    const source = fs.readFileSync(path.join(SRC, 'api', 'routes', 'admin.js'), 'utf8');
    const handler = source.slice(source.indexOf("router.patch('/config'"));
    const guard = handler.indexOf('mailSettings.isMailKey(key)');
    expect(guard).toBeGreaterThan(-1);
    for (const later of ['checkedSetting(', 'backToDefault(key)', 'storeSetting(']) {
      expect(handler.indexOf(later)).toBeGreaterThan(guard);
    }
  });
});
