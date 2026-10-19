// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * shared-banner.test.js — #807: every page draws the same banner from one
 * script (public/js/banner.js) and styles it from one stylesheet
 * (public/css/oscar-banner.css). No page carries its own copy of either.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const BANNER_JS = read('js/banner.js');

// The selectors oscar-banner.css holds: no page and no other stylesheet may
// state them again.
const SHARED_SELECTORS = [...read('css/oscar-banner.css').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
  .map((m) => m[1].replace(/\s+/g, ' ').trim());

function rulesOf(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{[^{}]*\}/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
}

// A small DOM, enough for banner.js.
function fakeDocument() {
  function el(tag) {
    return {
      tagName: tag.toUpperCase(), className: '', attrs: {}, children: [],
      classList: { contains(c) { return this.owner.className.split(' ').includes(c); } },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; },
    };
  }
  const make = (tag) => { const e = el(tag); e.classList.owner = e; return e; };
  const header = make('header');
  header.className = 'uic-banner';
  const script = make('script');
  script.parentElement = header;
  header.children.push(script);
  return { document: { createElement: make, currentScript: script }, header, script };
}

describe('#807 one banner for every page', () => {
  test('there are pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(18);
    expect(SHARED_SELECTORS).toContain('.uic-banner');
  });

  test.each(pages)('%s: the header loads banner.js first and holds no logo of its own', (page) => {
    const html = read(page);
    const header = html.match(/<header class="uic-banner">([\s\S]*?)<\/header>/);
    expect(header).not.toBeNull();
    expect(header[1].trim().startsWith('<script src="/js/banner.js"></script>')).toBe(true);
    expect(html.match(/<header\b/g)).toHaveLength(1);
    expect(html).not.toContain('uic-logo.png');
    expect(html).not.toContain('osdm-logo.png');
    expect(html).not.toContain('uic-banner-top');
  });

  test.each(pages)('%s: oscar-banner.css is its first stylesheet, and no inline rule repeats it', (page) => {
    const html = read(page);
    const head = html.slice(0, html.indexOf('</head>'));
    const first = head.match(/<link rel="stylesheet" href="\/css\/[^"]+">|<style[^>]*>/);
    expect(first[0]).toBe('<link rel="stylesheet" href="/css/oscar-banner.css">');
    const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    expect(rulesOf(inline).filter((s) => SHARED_SELECTORS.includes(s))).toEqual([]);
  });

  test('the other stylesheets do not repeat the banner rules', () => {
    for (const css of fs.readdirSync(path.join(PUBLIC, 'css')).filter((f) => f.endsWith('.css') && f !== 'oscar-banner.css')) {
      expect([css, rulesOf(read(`css/${css}`)).filter((s) => SHARED_SELECTORS.includes(s))]).toEqual([css, []]);
    }
  });

  test('banner.js draws the two logos in front of itself, and only inside the banner', () => {
    const { document, header, script } = fakeDocument();
    vm.runInNewContext(BANNER_JS, { window: { document } });
    expect(header.children).toHaveLength(2);
    expect(header.children[1]).toBe(script);
    const top = header.children[0];
    expect(top.className).toBe('uic-banner-top');
    expect(top.children.map((side) => side.className)).toEqual(['uic-banner-left', 'uic-banner-right']);
    const links = top.children.map((side) => side.children[0]);
    expect(links.map((a) => a.attrs)).toEqual([
      { href: 'https://uic.org', 'aria-label': 'UIC website' },
      { href: 'https://osdm.io', 'aria-label': 'OSDM website' },
    ]);
    expect(links.map((a) => [a.children[0].attrs, a.children[0].className])).toEqual([
      [{ src: '/uic-logo.png', alt: 'UIC' }, 'uic-banner-logo'],
      [{ src: '/osdm-logo.png', alt: 'OSDM' }, 'osdm-banner-logo'],
    ]);

    const elsewhere = fakeDocument();
    elsewhere.header.className = 'card';
    vm.runInNewContext(BANNER_JS, { window: { document: elsewhere.document } });
    expect(elsewhere.header.children).toEqual([elsewhere.script]);
  });

  test('banner.js writes no markup from text', () => {
    expect(BANNER_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
