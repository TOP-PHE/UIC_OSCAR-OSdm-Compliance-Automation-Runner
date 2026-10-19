// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

/**
 * banner.js — the logos at the top of every page (#807).
 *
 * A page writes `<header class="uic-banner">` with this script as its first
 * child; the script puts the logos in front of itself, so they come before the
 * menu bar nav.js draws below them. Static content, built element by element:
 * nothing here comes from a value.
 */
(function (global) {
  'use strict';

  var LOGOS = [
    { side: 'uic-banner-left', href: 'https://uic.org', label: 'UIC website', src: '/uic-logo.png', alt: 'UIC', cls: 'uic-banner-logo' },
    { side: 'uic-banner-right', href: 'https://osdm.io', label: 'OSDM website', src: '/osdm-logo.png', alt: 'OSDM', cls: 'osdm-banner-logo' },
  ];

  function bannerTop(doc) {
    var top = doc.createElement('div');
    top.className = 'uic-banner-top';
    LOGOS.forEach(function (logo) {
      var side = doc.createElement('div');
      side.className = logo.side;
      var link = doc.createElement('a');
      link.setAttribute('href', logo.href);
      link.setAttribute('aria-label', logo.label);
      var img = doc.createElement('img');
      img.setAttribute('src', logo.src);
      img.setAttribute('alt', logo.alt);
      img.className = logo.cls;
      link.appendChild(img);
      side.appendChild(link);
      top.appendChild(side);
    });
    return top;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { LOGOS: LOGOS, bannerTop: bannerTop };

  var doc = global.document;
  var script = doc && doc.currentScript;
  var header = script && script.parentElement;
  if (header && header.classList.contains('uic-banner')) header.insertBefore(bannerTop(doc), script);
})(typeof window === 'undefined' ? globalThis : window);
