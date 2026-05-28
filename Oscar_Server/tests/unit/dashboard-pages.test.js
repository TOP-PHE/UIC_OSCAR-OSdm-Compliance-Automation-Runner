/**
 * dashboard-pages.test.js — inline-script integrity smoke test (issue #291).
 *
 * Goal: catch the class of bug that broke release 2026.111 (PR #290 / #287),
 * where a stray `</script>` inside an inline `<script>` block closed the
 * outer script element early and the rest of the JS bled out as visible
 * page text.
 *
 * Approach (no browser, no Playwright): for each `Oscar_Server/public/*.html`,
 * simulate the HTML5 parser's "script-data state" to extract each inline
 * script's content AS THE PARSER WOULD SEE IT, then assert:
 *
 *   (a) Every `<script>` open has a matching close — i.e. the walker pairs
 *       them one-to-one and none is left dangling.
 *   (b) The raw count of `</script>` substrings in the file equals the
 *       number of blocks the walker matched. A stray `</script>` inside an
 *       inline script's content adds an extra raw close that the walker
 *       does NOT pair (because it already terminated the script at the
 *       FIRST `</script>` it saw). This is the exact #287 signature.
 *   (c) For `run-detail.html`, the parser-visible content of the outer
 *       inline block contains a known TAIL MARKER (`poll();`) — the final
 *       statement of the inline script. If a stray `</script>` truncates
 *       the outer block, the tail won't be in the parser-visible content
 *       and this assertion fires with a clear message.
 *
 * Why not Playwright: a true headless-browser test would also work, but it
 * would mean adding `@playwright/test` + its browser binaries to the dev
 * dependency tree (and re-resolving `package-lock.json`). The detection
 * here is deterministic, runs in milliseconds, has zero new dependencies,
 * and catches the precise regression class. A real-browser test can be
 * added later as a separate scope if richer "did the script actually
 * execute end-to-end in a real DOM" coverage is wanted.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

function listHtml(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.html')) out.push(p);
    }
  }
  return out;
}

/**
 * State-machine walker that mirrors the HTML5 parser's behaviour for
 * `<script>` blocks. Returns `{ openIdx, contentStart, contentEnd,
 * content, attrs, isExternal, closed }` per matched block.
 */
function inlineScriptBlocks(html) {
  const blocks = [];
  const openRe = /<script\b([^>]*)>/gi;
  let position = 0;
  while (position < html.length) {
    openRe.lastIndex = position;
    const openMatch = openRe.exec(html);
    if (!openMatch) break;
    const attrs = openMatch[1] || '';
    const isExternal = /\bsrc\s*=/i.test(attrs);
    const contentStart = openMatch.index + openMatch[0].length;
    const closeRe = /<\/script[\s/>]/gi;
    closeRe.lastIndex = contentStart;
    const closeMatch = closeRe.exec(html);
    if (!closeMatch) {
      blocks.push({
        openIdx: openMatch.index,
        contentStart,
        contentEnd: html.length,
        content: html.slice(contentStart),
        attrs,
        isExternal,
        closed: false,
      });
      break;
    }
    const contentEnd = closeMatch.index;
    const closeTagEnd = html.indexOf('>', contentEnd);
    blocks.push({
      openIdx: openMatch.index,
      contentStart,
      contentEnd,
      content: html.slice(contentStart, contentEnd),
      attrs,
      isExternal,
      closed: true,
    });
    position = (closeTagEnd === -1 ? html.length : closeTagEnd + 1);
  }
  return blocks;
}

const HTML_FILES = listHtml(PUBLIC_DIR);

describe('dashboard pages — inline <script> integrity (#291)', () => {
  test('Oscar_Server/public/ contains at least one HTML page', () => {
    expect(HTML_FILES.length).toBeGreaterThan(0);
  });

  for (const full of HTML_FILES) {
    const rel = path.relative(PUBLIC_DIR, full);

    describe(`page: ${rel}`, () => {
      const html = fs.readFileSync(full, 'utf8');
      const blocks = inlineScriptBlocks(html);

      test('every <script> element is properly closed', () => {
        const unclosed = blocks.filter(b => !b.closed);
        expect(unclosed.map(b => `<script@offset=${b.openIdx}>`)).toEqual([]);
      });

      test('raw </script> count matches the number of paired blocks (no strays inside inline scripts)', () => {
        const rawCloses = (html.match(/<\/script\s*>/gi) || []).length;
        const matched = blocks.length;
        // If rawCloses > matched, there's at least one literal `</script>`
        // inside an inline block's content — the #287 regression signature.
        expect({ rawCloses, matched }).toEqual({ rawCloses: matched, matched });
      });
    });
  }

  test('run-detail.html outer inline script reaches its tail marker (regression guard for #287)', () => {
    const f = HTML_FILES.find(p => p.toLowerCase().endsWith('run-detail.html'));
    expect(f).toBeDefined();
    const html = fs.readFileSync(f, 'utf8');
    const inlineOnly = inlineScriptBlocks(html).filter(b => !b.isExternal);
    expect(inlineOnly.length).toBeGreaterThan(0);
    // The outer inline block is the longest one by parser-visible content.
    const outer = inlineOnly.reduce((a, b) => (b.content.length > a.content.length ? b : a));
    // Tail of the inline script: `poll();` is the final statement that kicks
    // off the run-status polling loop. If a stray `</script>` truncates the
    // outer script (as in #287), this tail is NOT in the parser-visible
    // content.
    expect(outer.content).toContain('poll();');
    // Belt-and-braces: also assert one of the deeply-defined functions is
    // in scope, proving the entire script body was parsed as a single
    // element.
    expect(outer.content).toContain('function mountJsonTree');
  });
});
