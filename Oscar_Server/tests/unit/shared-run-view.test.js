// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/** shared-run-view.test.js — #901: what the company a run is shared with sees. */

const { replaceEmails, sharedRunRow } = require('../../src/utils/sharedRunView');

describe('replaceEmails', () => {
  const emails = ['ann@uic.example', 'Bob.Smith@uic.example'];

  test('every one, whatever its case, as often as it comes', () => {
    expect(replaceEmails('by ann@uic.example and ANN@UIC.EXAMPLE, then bob.smith@uic.example.', emails, 'UIC'))
      .toBe('by UIC and UIC, then UIC.');
  });

  test('other text and other e-mails are left as they are', () => {
    expect(replaceEmails('{"email":"paula@example.org"}', emails, 'UIC')).toBe('{"email":"paula@example.org"}');
    expect(replaceEmails('', emails, 'UIC')).toBe('');
    expect(replaceEmails(null, emails, 'UIC')).toBeNull();
    expect(replaceEmails('ann@uic.example', null, 'UIC')).toBe('ann@uic.example');
  });

  test('a name that contains the e-mail does not loop', () => {
    expect(replaceEmails('x ann@uic.example y', ['ann@uic.example'], 'ann@uic.example (UIC)')).toBe('x ann@uic.example (UIC) y');
  });

  test('characters special to a regular expression are plain text', () => {
    expect(replaceEmails('a.b+c@d.example a-b+c@d.example', ['a.b+c@d.example'], 'D')).toBe('D a-b+c@d.example');
  });
});

describe('sharedRunRow', () => {
  const view = { distributor: { id: 'd', name: 'UIC' }, provider: { id: 'p', name: 'CHAPS' } };

  test('the listed fields only, the distributor in place of the person', () => {
    const row = sharedRunRow({ id: 'r', company_id: 'p', status: 'COMPLETED', user_id: 'u', error_message: 'by ann@uic.example',
      deleted_by: 'ann@uic.example', shared_with_certifier_by: 'ann@uic.example', datafile_hash_used: 'h', exit_code: 0 }, view);
    expect(row).toEqual({ id: 'r', company_id: 'p', status: 'COMPLETED', exit_code: 0, submitted_by: 'UIC',
      shared: { distributor: 'UIC', provider: 'CHAPS' } });
  });
});
