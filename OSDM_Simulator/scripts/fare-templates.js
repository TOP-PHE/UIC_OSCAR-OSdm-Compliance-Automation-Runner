// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * fare-templates.js — writes `fares/templates.json` from DB's OSDM offline
 * fare delivery 2024.02 (#1047):
 *
 *   node scripts/fare-templates.js < "<folder>/1080_2024.02.gtm.json"
 *
 * The delivery is read from standard input, as a stream (1.3 GB), and the
 * output always goes to the same file: nothing from the command line becomes
 * a path. The regions read and the rules are in `fare-templates-lib.js`. The
 * run stops, writing nothing, when the templates would name a place, a
 * company or a card of the delivery.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DeliveryScanner } = require('./gtm-reader-lib');
const { REGIONS, createCollector, templatesOf, templatesText, leaksIn } = require('./fare-templates-lib');

const OUTPUT = path.join(__dirname, '..', 'fares', 'templates.json');

/**
 * Reads a delivery from `input` (a readable stream) and writes the templates
 * of `regions` to `output`. Resolves with what was written.
 */
function run(input, output, regions = REGIONS) {
  return new Promise((resolve, reject) => {
    const collector = createCollector(regions.flatMap((r) => r.numbers));
    const scanner = new DeliveryScanner(collector);
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      try { scanner.write(chunk); } catch (e) { input.destroy(e); }
    });
    input.on('error', reject);
    input.on('end', () => {
      try {
        const { templates, corrections } = templatesOf(collector.kept, regions);
        const leaks = leaksIn(templates, collector.kept);
        if (leaks.length > 0) throw new Error(`the templates would name places, companies or cards of the delivery: ${leaks.join(', ')}`);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, templatesText(templates));
        resolve({ templates: templates.templates.length, fares: templates.templates.reduce((n, t) => n + t.fares.length, 0), corrections });
      } catch (e) {
        reject(e);
      }
    });
  });
}

if (require.main === module) {
  run(process.stdin, OUTPUT).then(
    (done) => process.stdout.write(`${done.templates} templates, ${done.fares} fares, ${done.corrections.length} fares given back to their passenger.\n`),
    (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; },
  );
}

module.exports = { run, OUTPUT };
