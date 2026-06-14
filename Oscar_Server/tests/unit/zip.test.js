// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * zip.test.js — unit tests for the hand-rolled store-mode ZIP writer (#405).
 * Validates the archive structure (signatures, central directory, EOCD) and
 * the CRC-32 (cross-checked against zlib.crc32 where available).
 */

const { buildZip } = require('../../src/utils/zip');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

describe('buildZip (store-mode ZIP writer)', () => {
  test('produces a structurally valid archive with correct signatures and counts', () => {
    const entries = [
      { name: 'a.json', data: '{"x":1}' },
      { name: 'sub/b.html', data: '<html>ö✓</html>' },   // UTF-8 name-safe + UTF-8 data
      { name: 'c.txt', data: Buffer.from('line1\nline2') },
    ];
    const zip = buildZip(entries);
    expect(Buffer.isBuffer(zip)).toBe(true);

    // First bytes are a local file header.
    expect(zip.readUInt32LE(0)).toBe(SIG_LOCAL);

    // End-of-central-directory lives in the final 22 bytes (no zip comment).
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(SIG_END);
    expect(zip.readUInt16LE(eocd + 8)).toBe(3);    // entries on this disk
    expect(zip.readUInt16LE(eocd + 10)).toBe(3);   // total entries

    // Central directory: offset + size must end exactly at the EOCD, and begin
    // with the central-directory signature.
    const cdSize = zip.readUInt32LE(eocd + 12);
    const cdOff = zip.readUInt32LE(eocd + 16);
    expect(cdOff + cdSize).toBe(eocd);
    expect(zip.readUInt32LE(cdOff)).toBe(SIG_CENTRAL);

    // Names + payloads appear verbatim (store mode = no compression).
    expect(zip.includes(Buffer.from('a.json'))).toBe(true);
    expect(zip.includes(Buffer.from('sub/b.html'))).toBe(true);
    expect(zip.includes(Buffer.from('{"x":1}'))).toBe(true);
    expect(zip.includes(Buffer.from('<html>ö✓</html>'))).toBe(true);
  });

  test('CRC-32 in the first local header matches zlib (when available)', () => {
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const zip = buildZip([{ name: 'f.txt', data }]);
    const crcInHeader = zip.readUInt32LE(14) >>> 0;   // local header CRC-32 field
    const zlib = require('zlib');
    if (typeof zlib.crc32 === 'function') {
      expect(crcInHeader).toBe(zlib.crc32(data) >>> 0);
    } else {
      expect(crcInHeader).not.toBe(0);   // at least a non-trivial CRC was written
    }
  });

  test('an empty entry list yields just the EOCD record', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(SIG_END);
    expect(zip.readUInt16LE(10)).toBe(0);
  });
});
