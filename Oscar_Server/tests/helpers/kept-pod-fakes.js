// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * What a kept run pod's tests need (#1318): a collection as the image holds
 * it, and a Bruno that does what each run's plan says.
 *
 * A run's plan is plans/<first 8 characters of its id>.json: { code, sleepMs,
 * tmp, orphanFile, holdOutputMs } (exit code, a wait before it, a folder to
 * leave a file in, a process left behind that writes that file 0.8 s later,
 * a process left behind that holds the output open that long). Bruno
 * writes what it was started with to plans/<id8>.env.json, its results, a
 * report, a file in its home folder, and one line on stdout and one on stderr.
 */

const fs = require('node:fs');
const path = require('node:path');

function makeKeptPodFakes(root) {
  const collectionDir = path.join(root, 'collection');
  const plansDir = path.join(root, 'plans');
  fs.mkdirSync(path.join(collectionDir, '02-Common Requests'), { recursive: true });
  fs.mkdirSync(path.join(collectionDir, 'library-bruno'), { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(collectionDir, '02-Common Requests', '01. POST Get Offer.yml'), 'request: offer\n');
  fs.writeFileSync(path.join(collectionDir, 'opencollection.yml'), 'name: OSCAR\n');
  fs.writeFileSync(path.join(collectionDir, 'library-bruno', 'mergeReport.js'), `
const fs = require('fs');
fs.writeFileSync('Validation_Reports/20261118_' + process.argv[2] + '_Report.html', '<html>merged</html>');
process.stdout.write('merge output\\n');
`);
  const fakeBru = path.join(root, 'fake-bru.js');
  fs.writeFileSync(fakeBru, `
const fs = require('fs');
const path = require('path');
const [plansDir, ...args] = process.argv.slice(2);
const json = args[args.indexOf('--reporter-json') + 1];
const id = path.basename(json).slice('.bru_results_'.length, '.bru_results_'.length + 8);
const plan = JSON.parse(fs.readFileSync(path.join(plansDir, id + '.json'), 'utf8'));
fs.writeFileSync(path.join(plansDir, id + '.env.json'), JSON.stringify({ env: process.env, cwd: process.cwd(), args }));
fs.writeFileSync(json, JSON.stringify({ results: [] }));
fs.writeFileSync('Validation_Reports/20261118_x_' + id + '_Report.html', '<html>' + id + '</html>');
fs.writeFileSync(path.join(process.env.HOME, 'home-of-' + id), 'x');
if (plan.tmp) fs.writeFileSync(path.join(plan.tmp, 'left-by-' + id), 'x');
// A process left behind: one that writes a file later, its output elsewhere;
// one that holds the output open.
if (plan.orphanFile) {
  const code = 'setTimeout(() => require("fs").writeFileSync(' + JSON.stringify(plan.orphanFile) + ', "x"), 800)';
  require('child_process').spawn(process.execPath, ['-e', code], { stdio: 'ignore' }).unref();
}
if (plan.holdOutputMs) {
  require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + plan.holdOutputMs + ')'], { stdio: 'inherit' }).unref();
}
process.stdout.write('bru output ' + id + '\\n');
process.stderr.write('bru error ' + id + '\\n');
if (plan.sleepMs) setTimeout(() => { process.exitCode = plan.code; }, plan.sleepMs);
else process.exitCode = plan.code;
`);
  const id8 = (runId) => runId.slice(0, 8);
  return {
    collectionDir,
    plansDir,
    bru: [process.execPath, fakeBru, plansDir],
    plan: (runId, plan) => fs.writeFileSync(path.join(plansDir, `${id8(runId)}.json`), JSON.stringify({ code: 0, ...plan })),
    started: (runId) => {
      const file = path.join(plansDir, `${id8(runId)}.env.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
  };
}

module.exports = { makeKeptPodFakes };
