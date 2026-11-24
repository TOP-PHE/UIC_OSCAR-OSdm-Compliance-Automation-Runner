// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * secret-files.test.js — a secret may come from a file (#1430): NAME_FILE is
 * read into NAME at the start, never both; the server reads the files before
 * anything uses a secret; the runner agent and the dispatcher refuse to start
 * when they see a server secret's file; the Compose override and .gitignore
 * keep the files out of git.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { loadSecretFiles, SECRET_NAMES, MAX_BYTES } = require('../../src/utils/secretFiles');

const REPO = path.resolve(__dirname, '../../..');
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8').replaceAll('\r\n', '\n');

/** A file system of one directory, `files` name → { text, mode }. */
function fakeFs(files) {
  const entry = (file) => {
    const f = files[file];
    if (!f) { const err = new Error('no such file'); err.code = 'ENOENT'; throw err; }
    return f;
  };
  return {
    statSync: (file) => {
      const f = entry(file);
      return { isFile: () => f.dir !== true, size: Buffer.byteLength(f.text || ''), mode: f.mode ?? 0o100400 };
    },
    readFileSync: (file) => entry(file).text,
    platform: 'linux',
  };
}

describe('loadSecretFiles', () => {
  test('NAME_FILE is read into NAME, without the line end an editor adds', () => {
    const env = { ENCRYPTION_KEY_FILE: '/run/secrets/encryption_key', SMTP_PASS_FILE: '/run/secrets/smtp_pass' };
    const read = loadSecretFiles(env, fakeFs({
      '/run/secrets/encryption_key': { text: `${'a'.repeat(64)}\n` },
      '/run/secrets/smtp_pass': { text: 'p@ss word \r\n' },
    }));
    expect(read).toEqual(['ENCRYPTION_KEY', 'SMTP_PASS']);
    expect(env.ENCRYPTION_KEY).toBe('a'.repeat(64));
    expect(env.SMTP_PASS).toBe('p@ss word ');   // only the line end goes
  });

  test('nothing to read: nothing changes', () => {
    const env = { ENCRYPTION_KEY: 'k', SMTP_PASS_FILE: '' };
    expect(loadSecretFiles(env, fakeFs({}))).toEqual([]);
    expect(env).toEqual({ ENCRYPTION_KEY: 'k', SMTP_PASS_FILE: '' });
  });

  test('NAME and NAME_FILE both set: refused', () => {
    const env = { ENCRYPTION_KEY: 'k', ENCRYPTION_KEY_FILE: '/run/secrets/encryption_key' };
    expect(() => loadSecretFiles(env, fakeFs({ '/run/secrets/encryption_key': { text: 'x' } })))
      .toThrow('ENCRYPTION_KEY and ENCRYPTION_KEY_FILE are both set: keep one of them.');
  });

  test('an empty NAME line beside NAME_FILE is not "both"', () => {
    const env = { ENCRYPTION_KEY: '', ENCRYPTION_KEY_FILE: '/k' };
    loadSecretFiles(env, fakeFs({ '/k': { text: 'value' } }));
    expect(env.ENCRYPTION_KEY).toBe('value');
  });

  test.each([
    ['missing', {}, 'cannot be read: ENOENT.'],
    ['a directory', { '/k': { dir: true, text: '' } }, 'cannot be read: not a file.'],
    ['too long', { '/k': { text: 'x'.repeat(MAX_BYTES + 1) } }, `cannot be read: longer than ${MAX_BYTES} bytes.`],
    ['empty', { '/k': { text: '\n' } }, 'is empty.'],
  ])('a file %s stops the start, naming it', (_what, files, words) => {
    expect(() => loadSecretFiles({ METRICS_TOKEN_FILE: '/k' }, fakeFs(files))).toThrow(`METRICS_TOKEN_FILE (/k) ${words}`);
  });

  test('a file others can read is reported, and still read', () => {
    const warnings = [];
    const env = { SMTP_PASS_FILE: '/k' };
    loadSecretFiles(env, { ...fakeFs({ '/k': { text: 'v', mode: 0o100644 } }), warn: m => warnings.push(m) });
    expect(env.SMTP_PASS).toBe('v');
    expect(warnings).toEqual(['SMTP_PASS_FILE (/k) can be read by others than its owner (mode 644): chmod 400 it.']);
    loadSecretFiles({ SMTP_PASS_FILE: '/k' }, { ...fakeFs({ '/k': { text: 'v', mode: 0o100400 } }), warn: m => warnings.push(m) });
    expect(warnings).toHaveLength(1);
  });

  test('only the names asked for, and only the known secrets by default', () => {
    expect(SECRET_NAMES).toEqual(['ENCRYPTION_KEY', 'SMTP_PASS', 'PLATFORM_BOOTSTRAP_TOKEN', 'METRICS_TOKEN', 'RUN_AGENT_TOKEN']);
    const env = { ENCRYPTION_KEY_FILE: '/k', RUN_AGENT_TOKEN_FILE: '/t', OTHER_FILE: '/o' };
    const files = fakeFs({ '/k': { text: 'k' }, '/t': { text: 't' }, '/o': { text: 'o' } });
    expect(loadSecretFiles(env, { ...files, names: ['RUN_AGENT_TOKEN'] })).toEqual(['RUN_AGENT_TOKEN']);
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    delete env.RUN_AGENT_TOKEN_FILE;   // read above: the second call would see both
    loadSecretFiles(env, files);
    expect(env.OTHER).toBeUndefined();
  });

  test('a real file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-secret-'));
    try {
      const file = path.join(dir, 'encryption_key');
      fs.writeFileSync(file, 'real-value\n', { mode: 0o400 });
      const env = { ENCRYPTION_KEY_FILE: file };
      expect(loadSecretFiles(env, { warn: () => {} })).toEqual(['ENCRYPTION_KEY']);
      expect(env.ENCRYPTION_KEY).toBe('real-value');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('where the files are read', () => {
  test('the server reads them right after .env, before the required variables are checked', () => {
    const server = read('Oscar_Server/src/server.js');
    const load = server.indexOf("require('./utils/secretFiles').loadSecretFiles()");
    expect(load).toBeGreaterThan(server.indexOf('dotenv.config({ path: ENV_PRIMARY })'));
    expect(load).toBeLessThan(server.indexOf('const REQUIRED_ENV = ['));
    expect(load).toBeLessThan(server.indexOf("require('./db/db')") === -1 ? Infinity : server.indexOf("require('./db/db')"));
  });

  test.each(['Oscar_Server/src/runner-agent/agent.js', 'Oscar_Server/src/run-dispatcher/dispatcher.js'])(
    '%s reads its RUN_AGENT_TOKEN_FILE before its start checks', (file) => {
      const src = read(file);
      const load = src.indexOf("loadSecretFiles(process.env, { names: ['RUN_AGENT_TOKEN'] })");
      expect(load).toBeGreaterThan(src.indexOf('if (require.main === module) {'));
      expect(load).toBeLessThan(src.indexOf('startupProblem(', load));
    });

  test('the runner agent refuses to start when it sees a server secret, or its file', () => {
    const { startupProblem, SERVER_SECRETS } = require('../../src/runner-agent/agent');
    for (const name of ['ENCRYPTION_KEY', 'SMTP_PASS', 'METRICS_TOKEN', 'PLATFORM_BOOTSTRAP_TOKEN']) {
      expect(SERVER_SECRETS).toEqual(expect.arrayContaining([name, `${name}_FILE`]));
    }
    expect(SERVER_SECRETS).not.toContain('RUN_AGENT_TOKEN_FILE');
    const ok = { RUN_AGENT_TOKEN: 'x'.repeat(64), RUN_WORKSPACES_DIR: '/w' };
    expect(startupProblem(ok, () => false)).toBeNull();
    expect(startupProblem({ ...ok, ENCRYPTION_KEY_FILE: '/run/secrets/encryption_key' }, () => false))
      .toMatch(/can see the server's ENCRYPTION_KEY_FILE/);
  });

  test('a run\'s child processes never get a secret\'s file', () => {
    const { childBaseEnv } = require('../../src/worker/childEnv');
    const saved = { ...process.env };
    try {
      for (const name of SECRET_NAMES) process.env[`${name}_FILE`] = `/run/secrets/${name.toLowerCase()}`;
      const child = childBaseEnv();
      for (const name of SECRET_NAMES) expect(child).not.toHaveProperty(`${name}_FILE`);
    } finally {
      for (const name of SECRET_NAMES) delete process.env[`${name}_FILE`];
      Object.assign(process.env, saved);
    }
  });
});

describe('the Compose override and git', () => {
  const override = yaml.load(read('OSCAR_Deploy/docker-compose.secrets.yml'));

  test('each NAME_FILE names a secret of the file, mounted from OSCAR_Deploy/secrets/', () => {
    const service = override.services.oscar;
    for (const [variable, target] of Object.entries(service.environment)) {
      expect(variable).toMatch(/^[A-Z_]+_FILE$/);
      expect(SECRET_NAMES).toContain(variable.replace(/_FILE$/, ''));
      const secret = target.replace('/run/secrets/', '');
      expect(service.secrets).toContain(secret);
      expect(override.secrets[secret].file).toBe(`./secrets/${secret}`);
    }
  });

  test('the secrets folder is never committed', () => {
    expect(read('.gitignore').split('\n')).toContain('OSCAR_Deploy/secrets/');
  });

  test('restore puts secrets/ back for the container\'s user alone', () => {
    const restore = read('OSCAR_Deploy/scripts/oscar-restore.sh');
    expect(restore).toContain('cp -a "$STAGE/secrets" "$COMPOSE_DIR/secrets"');
    expect(restore).toContain('chmod 700 "$COMPOSE_DIR/secrets" && chmod 400 "$COMPOSE_DIR/secrets/"*');
    expect(restore).toContain('chown -R 1000:1000 "$COMPOSE_DIR/secrets"');
  });
});
