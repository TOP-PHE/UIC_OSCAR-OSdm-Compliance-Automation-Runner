#!/usr/bin/env node
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * oscar-test — ask OSCAR for conformance tests as a Company API account
 * (OSCAR #1342), wait for the verdict, report it, write JUnit XML.
 *
 * Node 22 or later, no dependency. `node oscar-test.js --help` for the options.
 */

const fs = require('node:fs');
const { argsOf, USAGE } = require('./src/args');
const { clientFor, privateKeyOf, originOf, OscarError } = require('./src/oscar');
const { runTool, textOf, EXIT } = require('./src/run');

async function main() {
  const settings = argsOf(process.argv.slice(2), process.env);
  if (settings.error) {
    process.stderr.write(`${settings.error}\n`);
    return EXIT.error;
  }
  if (settings.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const pem = settings.keyText ? settings.keyText.replaceAll(String.raw`\n`, '\n') : fs.readFileSync(settings.key, 'utf8');
    const client = clientFor({
      origin: originOf(settings.oscar),
      clientId: settings.clientId.trim(),
      privateKey: privateKeyOf(pem),
      // Reading only needs runs:read; launching needs runs:write too.
      scope: settings.whoami || settings.suites || settings.status ? 'runs:read' : 'runs:read runs:write',
    });
    const { code } = await runTool(settings, client, {
      out: line => process.stdout.write(`${line}\n`),
      readFile: file => textOf(fs.readFileSync(file)),
      writeFile: (file, text) => fs.writeFileSync(file, text),
    });
    return code;
  } catch (e) {
    if (e instanceof OscarError || e?.code === 'ENOENT') {
      const text = e.code === 'ENOENT' ? 'File not found: ' + e.path : e.message;
      process.stderr.write(text + '\n');
      return EXIT.error;
    }
    throw e;
  }
}

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`Unexpected error: ${e?.message || e}\n`);
  process.exitCode = EXIT.error;
});
