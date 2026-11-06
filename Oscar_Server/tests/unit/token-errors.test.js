// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/** A token failure as a run shows it: no saved secret, no quoted answer. */

const { encrypt } = require('../../src/db/db');
const { tokenErrorText } = require('../../src/utils/tokenErrors');

test('the saved secrets are masked and a quoted answer is cut', () => {
  const row = { client_id_enc: encrypt('my-client-id'), client_secret_enc: encrypt('s3cr3t-value') };
  const err = new Error('HTTP 401: client my-client-id with s3cr3t-value refused. Body: {"access_token":"abc"}');
  const text = tokenErrorText(err, row);
  expect(text).not.toMatch(/my-client-id|s3cr3t-value|access_token|Body/);
  expect(text).toMatch(/HTTP 401: client \*\*\* with \*\*\* refused\./);
});

test('a row without credentials still gives the message', () => {
  expect(tokenErrorText(new Error('timed out'), null)).toBe('timed out');
});
