// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The run pod's entrypoint (src/run-pod, run isolation option 4, #1130), with
 * a stand-in Bruno and mergeReport.js (Node scripts) and a local server that
 * takes the result files, as the server's internal port does.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes } = require('node:crypto');
const { runPod, runInputs, RUN_CREDENTIALS, BASE_ENV } = require('../../src/run-pod/runPod');
const L = require('../../src/run-pod/runLayout');
const { RUN_ENV_KEYS } = require('../../src/worker/childEnv');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-pod-')));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

// The collection in the image: a request folder, the library with a
// mergeReport.js that records how it was started and writes its report.
const collectionDir = path.join(root, 'collection');
fs.mkdirSync(path.join(collectionDir, '02-Common Requests'), { recursive: true });
fs.mkdirSync(path.join(collectionDir, 'library-bruno'), { recursive: true });
fs.writeFileSync(path.join(collectionDir, '02-Common Requests', '01. POST Get Offer.yml'), 'request: offer\n');
fs.writeFileSync(path.join(collectionDir, 'opencollection.yml'), 'name: OSCAR\n');
fs.writeFileSync(path.join(collectionDir, 'library-bruno', 'mergeReport.js'), `
const fs = require('fs');
fs.writeFileSync('merge-call.json', JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
fs.writeFileSync('Validation_Reports/20261107_' + process.argv[2] + '_Report.html', '<html>merged</html>');
`);

// Bruno: its first arguments are the exit code to end with and a file to link
// to ('-' for none); it records how it
// was started, writes its results, a scenario report and a file that is no result.
const fakeBru = path.join(root, 'fake-bru.js');
fs.writeFileSync(fakeBru, `
const fs = require('fs');
const [code, linkTarget, ...args] = process.argv.slice(2);
fs.writeFileSync('bru-call.json', JSON.stringify({ args, env: process.env }));
const json = args[args.indexOf('--reporter-json') + 1];
fs.writeFileSync(json, JSON.stringify({ results: [] }));
fs.writeFileSync('Validation_Reports/20261107_x_SIM_SALE_Report.html', '<html>scenario</html>');
fs.writeFileSync('Validation_Reports/notes.txt', 'not a result');
if (linkTarget !== '-') fs.symlinkSync(linkTarget, 'Validation_Reports/linked_Report.html', 'file');
console.log('bru output');
process.exit(Number(code));
`);

// The server's internal port, as far as results go.
let server;
let received = [];
let answer = 201;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, secret: req.headers['x-oscar-run-secret'], body: Buffer.concat(chunks).toString() });
      res.statusCode = answer;
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { received = []; answer = 201; });

const YML = 'name: OTST_acme_1a2b3c4d_Env\nvariables:\n  - name: api_base\n    value: "https://p.example/osdm"\n';
function podEnv(over = {}) {
  return {
    PATH: process.env.PATH,
    HOME: root,
    SystemRoot: process.env.SystemRoot,                      // Windows needs it to start node; not passed on
    OSCAR_RUN_ID: randomUUID(),
    OSCAR_ENV_NAME: 'OTST_acme_1a2b3c4d_Env',
    OSCAR_RUN_ENV_YML: Buffer.from(YML).toString('base64'),
    OSCAR_RESULTS_URL: `http://127.0.0.1:${server.address().port}/`,
    OSCAR_RUN_SECRET: randomBytes(32).toString('hex'),
    OSCAR_ACCESS_TOKEN: 'provider-token',
    ENCRYPTION_KEY: 'the-server-key',                         // never reaches a child of the pod
    ...over,
  };
}
let n = 0;
async function run(env, { exitCode = 0, linkTarget = '-' } = {}) {
  n += 1;
  const workDir = path.join(root, `work-${n}`);
  const lines = [];
  const code = await runPod({
    env, collectionDir, workDir, bru: [process.execPath, fakeBru, String(exitCode), linkTarget],
    stdio: 'ignore', log: (l) => lines.push(l),
  });
  const read = (f) => (fs.existsSync(path.join(workDir, f)) ? JSON.parse(fs.readFileSync(path.join(workDir, f), 'utf8')) : null);
  return { code, workDir, lines, bru: read('bru-call.json'), merge: read('merge-call.json') };
}

describe('a run in its pod', () => {
  test('the work folder holds the collection and the environment file', async () => {
    const env = podEnv();
    const { workDir } = await run(env);
    expect(fs.readFileSync(path.join(workDir, '02-Common Requests', '01. POST Get Offer.yml'), 'utf8')).toBe('request: offer\n');
    expect(fs.readFileSync(path.join(workDir, 'opencollection.yml'), 'utf8')).toBe('name: OSCAR\n');
    expect(fs.readFileSync(path.join(workDir, 'environments', 'OTST_acme_1a2b3c4d_Env.yml'), 'utf8')).toBe(YML);
  });

  test('Bruno is started as the server starts it, with the run\'s credentials and nothing of the server', async () => {
    const env = podEnv();
    const { bru } = await run(env);
    expect(bru.args).toEqual(L.bruRunArgs('OTST_acme_1a2b3c4d_Env', env.OSCAR_RUN_ID));
    const allowed = new Set([...BASE_ENV, ...RUN_CREDENTIALS]);
    // On Windows, Node adds the variables a process cannot start without (libuv); the pod runs Linux.
    const windowsAdds = /^(SystemRoot|SystemDrive|windir|TEMP|TMP|HOMEDRIVE|HOMEPATH|USERDOMAIN|USERNAME|USERPROFILE|LOGONSERVER|PATHEXT|ComSpec)$/i;
    const added = (k) => process.platform === 'win32' && windowsAdds.test(k);
    expect(Object.keys(bru.env).filter((k) => !allowed.has(k) && !added(k))).toEqual([]);
    expect(bru.env.OSCAR_ACCESS_TOKEN).toBe('provider-token');
    expect(bru.env.OSCAR_RUN_SECRET).toBe(env.OSCAR_RUN_SECRET);
    expect(bru.env).not.toHaveProperty('ENCRYPTION_KEY');
  });

  test('mergeReport.js gets the environment name and none of the run\'s credentials', async () => {
    const { merge } = await run(podEnv());
    expect(merge.argv).toEqual(['OTST_acme_1a2b3c4d_Env']);
    for (const name of RUN_CREDENTIALS) expect(merge.env).not.toHaveProperty(name);
    expect(merge.env).not.toHaveProperty('ENCRYPTION_KEY');
  });

  test('the result files are sent with the run\'s secret, and only they', async () => {
    const env = podEnv();
    const { code, lines } = await run(env);
    expect(code).toBe(0);
    const runId = env.OSCAR_RUN_ID;
    expect(received.map((r) => r.url)).toEqual([
      `/v1/runs/${runId}/results/${encodeURIComponent(L.bruResultsName(runId))}`,
      `/v1/runs/${runId}/results/20261107_OTST_acme_1a2b3c4d_Env_Report.html`,
      `/v1/runs/${runId}/results/20261107_x_SIM_SALE_Report.html`,
    ]);
    expect(received.every((r) => r.method === 'PUT' && r.secret === env.OSCAR_RUN_SECRET)).toBe(true);
    expect(received[2].body).toBe('<html>scenario</html>');
    expect(lines).toContain('[run-pod] bru ended with 0; 3 result file(s) sent');
  });

  test('Bruno\'s exit code is the pod\'s, and the results are sent all the same', async () => {
    const { code } = await run(podEnv(), { exitCode: 3 });
    expect(code).toBe(3);
    expect(received).toHaveLength(3);
  });

  test('a result the server refuses is logged; the pod still ends with Bruno\'s code', async () => {
    answer = 403;
    const { code, lines } = await run(podEnv());
    expect(code).toBe(0);
    expect(lines.filter((l) => l.includes('not sent: HTTP 403'))).toHaveLength(3);
  });

  test('a link left in the results folder is not sent', async () => {
    const target = path.join(root, 'outside.html');
    fs.writeFileSync(target, 'outside');
    let linked = true;
    try { fs.symlinkSync(target, path.join(root, 'probe-link'), 'file'); } catch { linked = false; }
    if (!linked) return;                                        // Windows without Developer Mode; CI runs it
    const { lines } = await run(podEnv(), { linkTarget: target });
    expect(received.map((r) => r.url).some((u) => u.includes('linked_Report'))).toBe(false);
    expect(lines).toContain('[run-pod] linked_Report.html not sent: not a plain file');
  });

  test('Bruno that cannot start ends the pod with 127', async () => {
    n += 1;
    const code = await runPod({ env: podEnv(), collectionDir, workDir: path.join(root, `work-${n}`), bru: [path.join(root, 'no-such-bru')], stdio: 'ignore', log: () => {} });
    expect(code).toBe(127);
  });
});

describe('inputs', () => {
  test.each([
    ['OSCAR_RUN_ID', 'not-a-run'],
    ['OSCAR_ENV_NAME', '../etc/passwd'],
    ['OSCAR_RUN_ENV_YML', ''],
    ['OSCAR_RESULTS_URL', 'file:///etc/passwd'],
    ['OSCAR_RESULTS_URL', 'http://user:pw@oscar:3003'],
    ['OSCAR_RUN_SECRET', 'short'],
  ])('%s = %p: nothing is started', async (name, value) => {
    const { code, bru, lines } = await run(podEnv({ [name]: value }));
    expect(code).toBe(2);
    expect(bru).toBeNull();
    expect(received).toEqual([]);
    expect(lines[0]).toMatch(/^\[run-pod\] Not started: /);
  });

  test('the address is kept without trailing slashes', () => {
    expect(runInputs(podEnv({ OSCAR_RESULTS_URL: 'http://oscar-internal:3003///' })).resultsBase).toBe('http://oscar-internal:3003');
  });
});

describe('the run image holds nothing of the server', () => {
  test('Bruno\'s credentials are the server\'s list', () => {
    expect([...RUN_CREDENTIALS].sort()).toEqual([...RUN_ENV_KEYS].sort());
  });

  test('the run-pod folder requires Node\'s own modules and its own files only', () => {
    const dir = path.resolve(__dirname, '../../src/run-pod');
    for (const file of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const [, mod] of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        expect([file, mod.startsWith('node:') || /^\.\/[A-Za-z]+$/.test(mod)]).toEqual([file, true]);
      }
    }
  });
});
