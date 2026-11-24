// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * page-source.js — a page as the browser runs it (#1423). The pages' scripts
 * live in public/js/<page>.js, loaded by a `<script src>` where the inline
 * block stood, so that the content security policy can refuse inline scripts.
 * The tests that lift a page's functions out of its text read the page
 * through `pageSource()`: each `<script src="/js/<page>.js">` of the page's
 * own file comes back as an inline block, at the same place. Called like
 * `fs.readFileSync(file, 'utf8')`; any other file is read as it is.
 */

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const MOVED = 'moved out of the page (#1423)';

function pageSource(file) {
  const full = path.resolve(file);
  const text = fs.readFileSync(full, 'utf8');
  if (!full.endsWith('.html') || path.dirname(full) !== PUBLIC_DIR) return text;
  const page = path.basename(full, '.html');
  const tag = `<script src="/js/${page}.js"></script>`;
  const own = path.join(PUBLIC_DIR, 'js', `${page}.js`);
  if (!text.includes(tag)) return text;
  const code = fs.readFileSync(own, 'utf8');
  // Only a script that was the page's own inline code: account.js and the
  // like were files of their own before.
  if (!code.includes(MOVED)) return text;
  return text.replace(tag, () => `<script>\n${code}</script>`);
}

module.exports = { pageSource, PUBLIC_DIR };
