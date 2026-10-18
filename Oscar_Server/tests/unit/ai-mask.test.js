// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #827 PR C: a request or response body as the AI analysis may send it
 * (utils/aiMask.js): test data kept, personal and connection data masked.
 */

const M = require('../../src/utils/aiMask');

const body = (v) => M.maskBody(JSON.stringify(v));

describe('#827 masking', () => {
  test('a passenger\'s and a purchaser\'s personal data are masked wherever they are, test data kept', () => {
    const out = body({
      passengers: [{ id: 'P1', type: 'ADULT', age: 30, detail: { firstName: 'Jane', last_name: 'Doe', Gender: 'FEMALE', preferredLanguage: 'fr',
        contact: { email: 'jane@example.com', phoneNumber: '+33 6' } }, dateOfBirth: '1990-01-01', reductionCards: [{ code: 'BC50' }] }],
      purchaser: { detail: { firstName: 'John', address: { street: 'x' } }, companyName: 'ACME' },
      offers: [{ offerId: 'O1', price: { amount: 1200, currency: 'EUR' }, products: [{ code: 'P', summary: 'Flexi' }] }],
    });
    expect(out.passengers[0]).toEqual({ id: 'P1', type: 'ADULT', age: 30, detail: { firstName: '<masked>', last_name: '<masked>', Gender: '<masked>',
      preferredLanguage: 'fr', contact: '<masked>' }, dateOfBirth: '<masked>', reductionCards: '<masked>' });
    expect(out.purchaser).toEqual({ detail: { firstName: '<masked>', address: '<masked>' }, companyName: '<masked>' });
    expect(out.offers[0]).toEqual({ offerId: 'O1', price: { amount: 1200, currency: 'EUR' }, products: [{ code: 'P', summary: 'Flexi' }] });
    for (const secret of ['Jane', 'Doe', 'jane@', 'John', 'ACME', 'BC50', '1990']) expect(JSON.stringify(out)).not.toContain(secret);
  });

  test('connection data never appears: tokens, client ids and secrets, the requestor, addresses of the web', () => {
    const out = body({ access_token: 'abc', client_id: 'c', clientSecret: 's', requestor: 'R', password: 'p', _links: [{ href: 'https://provider.example/b/1' }], note: 'http://x' });
    expect(out).toEqual({ access_token: '<masked>', client_id: '<masked>', clientSecret: '<masked>', requestor: '<masked>', password: '<masked>',
      _links: [{ href: '<url>' }], note: '<url>' });
  });

  test('a Problem keeps its code, not its title or detail; another object\'s title is test data', () => {
    const out = body({ problems: [{ code: 'MISSING_INFORMATION', title: 'Purchaser Jane Doe is missing', detail: 'jane@x', pointers: ['/purchaser'] }],
      product: { title: 'Flexi ticket' } });
    expect(out).toEqual({ problems: [{ code: 'MISSING_INFORMATION', title: '<masked>', detail: '<masked>', pointers: ['/purchaser'] }], product: { title: 'Flexi ticket' } });
  });

  test('long text, long lists and deep values are cut; a null stays null', () => {
    const out = body({ content: 'A'.repeat(5000), items: [1, 2, 3, 4, 5, 6], firstName: null, deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 1 } } } } } } } } } } } });
    expect(out.content).toBe('<5000 characters>');
    expect(out.items).toEqual([1, 2, 3, '<3 more>']);
    expect(out.firstName).toBeNull();
    expect(JSON.stringify(out.deep)).toContain('<…>');
  });

  test('no body, a body that is not JSON, a body too large', () => {
    expect(M.maskBody(null)).toBeNull();
    expect(M.maskBody('')).toBeNull();
    expect(M.maskBody('<html>Request Rejected</html>')).toBe('<not JSON, 29 characters>');
    const big = body({ a: Array.from({ length: 3 }, () => ({ b: Array.from({ length: 3 }, () => ({ c: 'x'.repeat(290), d: 'y'.repeat(290), e: 'z'.repeat(290) })) })) });
    expect(big.cut).toBe(true);
    expect(big.start.length).toBe(M.MAX_SAMPLE_CHARS);
  });
});
