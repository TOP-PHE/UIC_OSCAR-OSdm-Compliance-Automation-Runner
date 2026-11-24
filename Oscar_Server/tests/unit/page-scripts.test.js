// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * page-scripts.test.js — the pages carry no script of their own (#1423): each
 * page's code is a file under public/js/, and its menu entry is a data-page
 * attribute that nav.js reads, so that the content security policy can
 * refuse inline scripts.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const PAGES = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html')).sort();
const read = rel => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
// An end tag may carry attributes or white space ("</script foo>"): the
// parser closes the script there all the same.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;

describe('every page', () => {
  test.each(PAGES)('%s holds no inline script and no inline event handler', (page) => {
    const html = read(page);
    const inline = [...html.matchAll(SCRIPT_RE)].filter(m => !/\bsrc\s*=/.test(m[1]));
    expect(inline.map(m => m[0].slice(0, 80))).toEqual([]);
    expect(html.match(/<[^>]+\son[a-z]+\s*=/gi) || []).toEqual([]);
    expect(html).not.toMatch(/(href|src|action)\s*=\s*["']\s*javascript:/i);
  });

  test.each(PAGES)('%s loads only scripts that exist, from OSCAR itself', (page) => {
    const sources = [...read(page).matchAll(SCRIPT_RE)].map(m => (m[1].match(/\bsrc="([^"]+)"/) || [])[1]).filter(Boolean);
    for (const src of sources) {
      expect(src).toMatch(/^\/[a-z0-9/._-]+\.js$/);
      expect(fs.existsSync(path.join(PUBLIC_DIR, src))).toBe(true);
    }
  });

  test.each(PAGES.filter(p => read(p).includes('<script src="/nav.js"></script>')))(
    '%s names its menu entry on the menu element, before nav.js', (page) => {
      const html = read(page);
      const host = html.match(/<div class="uic-banner-nav" id="oscar-nav" data-page="([a-z-]+)"( data-page-tab="[a-z]+")?><\/div>/);
      expect(host).not.toBeNull();
      expect(html.indexOf(host[0])).toBeLessThan(html.indexOf('<script src="/nav.js"></script>'));
    });
});

describe("nav.js draws the page's own entry", () => {
  const nav = read('nav.js');
  const start = nav.indexOf("// ── The page's own menu entry (#1423)");
  const code = nav.slice(start);

  function drawn(host, search = '') {
    const calls = [];
    const window = { renderOscarNav: (id, page) => calls.push([id, page]) };
    vm.runInNewContext(code, {
      window, URLSearchParams, location: { search },
      document: { getElementById: id => (id === 'oscar-nav' ? host : null) },
    });
    return calls;
  }

  test('it is the last part of nav.js, where the pages called renderOscarNav() after it', () => {
    expect(start).toBeGreaterThan(nav.indexOf('global.renderOscarNav = renderOscarNav;'));
    expect(start).toBeGreaterThan(nav.indexOf('global.logout = function logout()'));
  });

  test('the entry data-page names', () => {
    expect(drawn({ dataset: { page: 'dashboard' } })).toEqual([['oscar-nav', 'dashboard']]);
  });

  test("the administration page's entry is its tab, users when the address names none", () => {
    const host = { dataset: { page: 'admin-', pageTab: 'users' } };
    expect(drawn(host)).toEqual([['oscar-nav', 'admin-users']]);
    expect(drawn(host, '?tab=companies')).toEqual([['oscar-nav', 'admin-companies']]);
  });

  test('nothing without a menu element or a data-page', () => {
    expect(drawn(null)).toEqual([]);
    expect(drawn({ dataset: {} })).toEqual([]);
  });
});
