'use strict';

/**
 * The two limits a new function is held to, in the server, the pages'
 * scripts and the Bruno collection's library.
 *
 * - complexity: 15 paths through a function at most ("modified": a switch
 *   counts once, whatever its cases).
 * - max-lines-per-function: 100 lines of code at most, blank lines and
 *   comments not counted.
 *
 * The code had 189 functions over the first and 45 over the second when the
 * limits were set (November 2026). Those are recorded, file by file, in
 * eslint-suppressions.json (the server and the pages) and
 * eslint-library-suppressions.json (the library): ESLint's own baseline. A
 * file may hold as many functions over a limit as its record says, and no
 * more: a new one fails `npm run lint`. One brought under the limit fails it
 * too, until `npm run lint:baseline` lowers the record: the numbers only go
 * down.
 *
 * To let a function over a limit in on purpose, the record is raised by hand
 * in the JSON file, and lint-config.test.js holds the totals: the choice shows
 * twice in the diff.
 *
 * SonarCloud measures another thing (cognitive complexity, S3776) and reports
 * after the push; this stops the function before it is committed.
 */
module.exports = {
  complexity: ['error', { max: 15, variant: 'modified' }],
  'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
};
