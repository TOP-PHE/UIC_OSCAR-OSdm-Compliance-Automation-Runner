// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Read a fetch answer's body as text, up to `max` bytes. A longer answer is
 * not read further: the reader is cancelled and an error with code
 * ANSWER_TOO_LARGE is thrown. Used where OSCAR reads a provider's answer
 * (token endpoint, OSDM API), whose size OSCAR does not choose.
 */
function tooLarge(max) {
  const err = new Error(`The answer is larger than ${Math.round(max / 1024)} KB; OSCAR does not read it.`);
  err.code = 'ANSWER_TOO_LARGE';
  return err;
}

async function readBody(res, max) {
  // No stream (an empty answer, or an answer object without one): its text,
  // held to the same size.
  if (!res.body) {
    const text = typeof res.text === 'function' ? String(await res.text()) : '';
    if (Buffer.byteLength(text) > max) throw tooLarge(max);
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge(max);
    }
    chunks.push(Buffer.from(value));
  }
}

module.exports = { readBody };
