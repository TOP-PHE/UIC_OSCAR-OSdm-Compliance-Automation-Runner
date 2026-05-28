#!/usr/bin/env node
/**
 * lint-inline-scripts.js (issue #292)
 *
 * Static check for `Oscar_Server/public/*.html`: fail the build if any HTML
 * file contains a literal `</script>` substring inside an inline
 * `<script>...</script>` block.
 *
 * Why this rule exists
 * --------------------
 * HTML5 parsers terminate a `<script>` element at the first `</script>`
 * substring they see, regardless of JS string / comment / template-literal
 * context. To emit the characters `</script>` from inside an inline script
 * you must write `<\/script>` in the source — the JS engine collapses `\/`
 * to `/` so the resulting HTML is correct, but the HTML parser scanning the
 * source sees `<\/` (not `</`) and keeps the outer script open.
 *
 * This was the root cause of the broken run-detail page in release 2026.111
 * (PR #290 / issue #287): a single literal `</script>` inside a template
 * literal in `renderMessage()` closed the outer inline script early and the
 * rest of the JS source bled into the DOM as visible text.
 *
 * Detection algorithm
 * -------------------
 * 1. Walk the file with the HTML5 "script-data state" rules to extract every
 *    inline `<script>...</script>` block exactly as the browser's parser
 *    would: an open is `<script\b[^>]*>`, the close is the next
 *    `</script` followed by whitespace / `/` / `>` (per spec).
 * 2. Count the number of `</script\s*>` substrings in the raw file. In a
 *    healthy file this equals the number of blocks the walker matched —
 *    every `</script>` in the source IS a real close tag.
 * 3. If `raw_closes > matched_closes`, the file contains extra `</script>`
 *    substrings that the parser would treat as closes — i.e. a stray
 *    `</script>` inside an inline block, the exact #287 signature.
 *
 * The output names the first stray's file + line so the author can fix it.
 *
 * Wired into the `lint` npm script so it runs as part of CI's
 * Lint/audit/test job — no new dependencies, no extra workflow.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

function walkHtml(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtml(p));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) out.push(p);
  }
  return out;
}

function lineOfIndex(text, idx) {
  let line = 1;
  const end = Math.min(idx, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * State-machine walker that mirrors the HTML5 parser's behaviour for
 * `<script>` blocks. Returns an array of `{ openIdx, closeIdx, closeTagEnd }`
 * entries, one per matched block.
 */
function findScriptBlocks(html) {
  const blocks = [];
  const openRe = /<script\b[^>]*>/gi;
  let position = 0;
  while (position < html.length) {
    openRe.lastIndex = position;
    const openMatch = openRe.exec(html);
    if (!openMatch) break;
    const openIdx = openMatch.index;
    const contentStart = openIdx + openMatch[0].length;
    // Per HTML5 script-data state: close on `</script` followed by ` \t\n\r/>`.
    const closeRe = /<\/script[\s/>]/gi;
    closeRe.lastIndex = contentStart;
    const closeMatch = closeRe.exec(html);
    if (!closeMatch) {
      blocks.push({ openIdx, closeIdx: -1, closeTagEnd: html.length, closed: false });
      break;
    }
    const closeIdx = closeMatch.index;
    // The close tag ends at the next `>` (it could be `</script ...>`).
    const closeTagEnd = html.indexOf('>', closeIdx);
    blocks.push({
      openIdx,
      closeIdx,
      closeTagEnd: closeTagEnd === -1 ? html.length : closeTagEnd + 1,
      closed: true,
    });
    position = (closeTagEnd === -1 ? html.length : closeTagEnd + 1);
  }
  return blocks;
}

const errors = [];
const files = walkHtml(PUBLIC_DIR);

for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const blocks = findScriptBlocks(html);
  const rel = path.relative(PUBLIC_DIR, f);

  // (a) Every open must be closed — unclosed = malformed (also a regression).
  const unclosed = blocks.find(b => !b.closed);
  if (unclosed) {
    errors.push({
      file: rel,
      line: lineOfIndex(html, unclosed.openIdx),
      msg: `inline <script> at this position is never closed — missing </script>.`,
    });
    continue;
  }

  // (b) Stray-close detection: raw `</script>` substrings in the file should
  // equal the number of blocks the walker actually matched. Extra `</script>`
  // substrings live inside an inline script's content — the #287 signature.
  const rawCloses = (html.match(/<\/script\s*>/gi) || []).length;
  if (rawCloses > blocks.length) {
    // Find the first stray: scan the file linearly with the walker's
    // matched-close indices in mind; the first `</script>` whose index is
    // NOT one of the matched close indices is the offender.
    const matchedCloseIdx = new Set(blocks.map(b => b.closeIdx));
    const closeIter = html.matchAll(/<\/script\s*>/gi);
    let firstStrayIdx = -1;
    for (const m of closeIter) {
      if (!matchedCloseIdx.has(m.index)) { firstStrayIdx = m.index; break; }
    }
    if (firstStrayIdx >= 0) {
      errors.push({
        file: rel,
        line: lineOfIndex(html, firstStrayIdx),
        msg:
          `literal "</script>" found inside an inline <script> block — ` +
          `the HTML parser will terminate the outer <script> here, closing ` +
          `it early. Escape as "<\\/script>" (JS reads "\\/" as "/", so the ` +
          `emitted HTML is correct).`,
      });
    } else {
      errors.push({
        file: rel,
        line: 1,
        msg:
          `extra "</script>" substring(s) outside any matched <script> block ` +
          `(raw closes ${rawCloses} vs walker matched ${blocks.length}).`,
      });
    }
  }
}

if (errors.length > 0) {
  console.error('inline-script lint FAILED:');
  for (const e of errors) console.error(`  ${e.file}:${e.line} — ${e.msg}`);
  console.error('See PR #290 / issues #287, #292 for the regression class.');
  process.exit(1);
}

const n = files.length;
console.log(`inline-script lint OK (scanned ${n} HTML file${n === 1 ? '' : 's'} under Oscar_Server/public/).`);
