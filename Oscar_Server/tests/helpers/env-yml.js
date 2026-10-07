// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A strict reader for the Bruno environment file worker/runner.js writes for a
 * run. It accepts four line shapes and nothing else, so a line that is not one
 * of them (a broken quote, a comment, a value running over two lines, a raw
 * character) makes it throw instead of being read as something.
 *
 * It does NOT by itself prove that a value stayed a value: text pasted into
 * the file that happens to form a well-shaped extra variable is read as an
 * extra variable. That is what the callers check: they compare the list of
 * variable names with the one they expect, and valueIn() throws when a name
 * appears twice.
 *
 *   name: "<scalar>"
 *   variables:
 *     - name: <identifier>
 *       value: "<scalar>"
 *
 * A scalar is what the runner promises: printable ASCII between the quotes,
 * with `"` and `\` escaped and everything else written as \b \f \n \r \t or
 * \uXXXX. That is a JSON string, so JSON.parse reads it back.
 */

// The scalar is spelled out in both patterns: one quote, then any number of
// plain characters or escapes, then one quote. The three alternatives cannot
// match the same text, so there is one way to read any line.
const NAME_LINE = /^name: ("(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\bfnrt]|\\u[0-9a-f]{4})*")$/;
const VAR_NAME_LINE = /^ {2}- name: ([A-Za-z_][A-Za-z0-9_-]*)$/;
const VAR_VALUE_LINE = /^ {4}value: ("(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\bfnrt]|\\u[0-9a-f]{4})*")$/;

function readEnvYml(yml) {
  if (!yml.endsWith('\n')) throw new Error('env yml: no final line break');
  const lines = yml.slice(0, -1).split('\n');
  const head = NAME_LINE.exec(lines[0]);
  if (!head) throw new Error(`env yml: line 1 is not a quoted name: ${JSON.stringify(lines[0])}`);
  if (lines[1] !== 'variables:') throw new Error(`env yml: line 2 is not "variables:": ${JSON.stringify(lines[1])}`);
  const rest = lines.slice(2);
  if (rest.length % 2 !== 0) throw new Error('env yml: a variable has a name without a value, or a value without a name');
  const variables = [];
  for (let i = 0; i < rest.length; i += 2) {
    const n = VAR_NAME_LINE.exec(rest[i]);
    const v = VAR_VALUE_LINE.exec(rest[i + 1]);
    if (!n) throw new Error(`env yml: line ${i + 3} is not a variable name: ${JSON.stringify(rest[i])}`);
    if (!v) throw new Error(`env yml: line ${i + 4} is not a quoted value: ${JSON.stringify(rest[i + 1])}`);
    variables.push({ name: n[1], value: JSON.parse(v[1]) });
  }
  return { name: JSON.parse(head[1]), variables };
}

// The value of one variable; throws if the name appears more than once.
function valueIn(env, name) {
  const found = env.variables.filter(v => v.name === name);
  if (found.length > 1) throw new Error(`env yml: ${name} appears ${found.length} times`);
  return found.length === 1 ? found[0].value : undefined;
}

module.exports = { readEnvYml, valueIn };
