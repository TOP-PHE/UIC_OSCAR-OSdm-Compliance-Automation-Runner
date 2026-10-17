// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * page-images.test.js — #805: the banner's UIC and OSDM logos were loaded
 * from uic.org, and broke on every page when uic.org stopped serving them.
 * Every image a page shows comes from OSCAR itself, and the content security
 * policy allows no other.
 */

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));

describe('#805 images are served by OSCAR', () => {
  test('no page loads an image from another site', () => {
    const remote = [];
    for (const page of pages) {
      const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
      for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
        if (/^(https?:)?\/\//i.test(m[1])) remote.push(`${page}: ${m[1]}`);
      }
    }
    expect(remote).toEqual([]);
  });

  test('the banner logos are files of OSCAR, and every banner uses them', () => {
    for (const file of ['uic-logo.png', 'osdm-logo.png']) {
      expect(fs.statSync(path.join(PUBLIC, file)).size).toBeGreaterThan(0);
    }
    const banners = pages.filter((p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8').includes('uic-banner-logo"'));
    expect(banners.length).toBeGreaterThan(10);
    for (const page of banners) {
      const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
      expect(html).toContain('src="/uic-logo.png"');
      expect(html).toContain('src="/osdm-logo.png"');
    }
  });

  test('the content security policy allows images from OSCAR only', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
    expect(server).toContain(`imgSrc:        ["'self'", 'data:'],`);
  });
});
