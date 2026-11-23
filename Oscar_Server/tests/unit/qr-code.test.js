// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * qr-code.test.js — the QR code encoder (#1414), utils/qrCode.js.
 *
 * Three kinds of proof: the standard's own tables (capacities, alignment
 * positions, format and version information, a worked Reed–Solomon example);
 * every code made is read back here, by a reader written apart from the
 * encoder; and every version and mask is compared, module by module, with
 * another encoder's output (tests/helpers/qr-reference.json, made by
 * scripts/qr-reference.py with segno).
 */

const crypto = require('node:crypto');
const Q = require('../../src/utils/qrCode');
const reference = require('../helpers/qr-reference.json');

const { formatBits, versionBits, rsDivisor, rsRemainder, functionMap } = Q._internal;

// The same characters scripts/qr-reference.py makes for a case.
function caseText(length, seed) {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCodePoint(33 + ((i * 7 + Math.floor(i / 5) + seed * 13) % 94));
  return text;
}
const textOf = c => (c.text ?? caseText(c.length, c.seed));

// ISO/IEC 18004 table 7: bytes a level M symbol holds in byte mode.
const BYTE_CAPACITY_M = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
  711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331,
];

// Annex E: centres of the alignment patterns.
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

// Annex C: the format information of level M, mask 0 to 7, most significant bit first.
const FORMAT_M = [
  '101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000',
];

// Annex D: the version information of versions 7 to 40.
const VERSION_INFO = [
  0x07C94, 0x085BC, 0x09A99, 0x0A4D3, 0x0BBF6, 0x0C762, 0x0D847, 0x0E60D, 0x0F928, 0x10B78, 0x1145D,
  0x12A17, 0x13532, 0x149A6, 0x15683, 0x168C9, 0x177EC, 0x18EC4, 0x191E1, 0x1AFAB, 0x1B08E, 0x1CC1A,
  0x1D33F, 0x1ED75, 0x1F250, 0x209D5, 0x216F0, 0x228BA, 0x2379F, 0x24B0B, 0x2542E, 0x26A64, 0x27541, 0x28C69,
];

// Remainder bits after the last codeword (section 7.6).
const REMAINDER_BITS = v => {
  if (v === 1) return 0;
  if (v <= 6) return 7;
  if (v <= 13) return 0;
  if (v <= 20) return 3;
  if (v <= 27) return 4;
  if (v <= 34) return 3;
  return 0;
};

/** Modules that carry codewords, counted from the patterns (Project Nayuki's formula). */
function rawDataModules(v) {
  let result = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const count = Math.floor(v / 7) + 2;
    result -= (25 * count - 10) * count - 55;
    if (v >= 7) result -= 36;
  }
  return result;
}

const bitsText = (value, length) => value.toString(2).padStart(length, '0');

// ── A reader, written apart from the encoder ────────────────────────────────

function readFormat(modules, size) {
  let first = 0;
  let second = 0;
  const firstAt = i => {
    if (i <= 5) return [8, i];
    if (i === 6) return [8, 7];
    if (i === 7) return [8, 8];
    if (i === 8) return [7, 8];
    return [14 - i, 8];
  };
  const secondAt = i => (i < 8 ? [size - 1 - i, 8] : [8, size - 15 + i]);
  for (let i = 0; i < 15; i++) {
    const [x1, y1] = firstAt(i);
    const [x2, y2] = secondAt(i);
    if (modules[y1][x1]) first |= 1 << i;
    if (modules[y2][x2]) second |= 1 << i;
  }
  return { first, second };
}

function readVersion(modules, size) {
  let below = 0;
  let right = 0;
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    if (modules[b][a]) below |= 1 << i;
    if (modules[a][b]) right |= 1 << i;
  }
  return { below, right };
}

// Two-module columns from the right; column 6 is the timing pattern, so the
// pairs left of it are 5–4, 3–2, 1–0. The direction turns at each pair.
function zigzagBits(modules, size, isFunction, flip) {
  const pairs = [];
  let column = size - 1;
  while (column >= 1) {
    if (column === 6) column = 5;
    pairs.push(column);
    column -= 2;
  }
  const bits = [];
  pairs.forEach((right, index) => {
    const upward = index % 2 === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (!isFunction[y][x]) bits.push(modules[y][x] !== flip(x, y));
      }
    }
  });
  return bits;
}

function readBack(qr) {
  const { size, modules } = qr;
  const version = (size - 17) / 4;
  const format = readFormat(modules, size);
  expect(format.second).toBe(format.first);
  const mask = FORMAT_M.findIndex(f => Number.parseInt(f, 2) === format.first);
  expect(mask).toBeGreaterThanOrEqual(0);
  expect(modules[size - 8][8]).toBe(true);   // the dark module
  if (version >= 7) {
    const info = readVersion(modules, size);
    expect([info.below, info.right]).toEqual([VERSION_INFO[version - 7], VERSION_INFO[version - 7]]);
  }
  const bits = zigzagBits(modules, size, functionMap(version), Q.MASKS[mask]);
  const [ecc, blocks1, data1, blocks2, data2] = Q.LEVEL_M_BLOCKS[version];
  const total = blocks1 * data1 + blocks2 * data2 + (blocks1 + blocks2) * ecc;
  expect(bits.length - total * 8).toBe(REMAINDER_BITS(version));
  expect(bits.slice(total * 8).every(b => b === false)).toBe(true);

  const codewords = [];
  for (let i = 0; i < total; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((byte, b) => (byte << 1) | Number(b), 0));
  const blocks = Array.from({ length: blocks1 + blocks2 }, (_, i) => ({ size: i < blocks1 ? data1 : data2, data: [], ecc: [] }));
  let next = 0;
  for (let i = 0; i < Math.max(data1, data2); i++) for (const block of blocks) if (i < block.size) block.data.push(codewords[next++]);
  for (let i = 0; i < ecc; i++) for (const block of blocks) block.ecc.push(codewords[next++]);
  for (const block of blocks) expect(rsRemainder(block.data, rsDivisor(ecc))).toEqual(block.ecc);

  const data = blocks.flatMap(b => b.data);
  const stream = data.flatMap(byte => bitsText(byte, 8).split('').map(Number));
  const take = n => Number.parseInt(stream.splice(0, n).join(''), 2);
  expect(take(4)).toBe(0b0100);   // byte mode
  const length = take(version <= 9 ? 8 : 16);
  const bytes = Array.from({ length }, () => take(8));
  return { version, mask, text: Buffer.from(bytes).toString('utf8') };
}

// ── The standard's tables ────────────────────────────────────────────────────

describe("the encoder's tables against the standard", () => {
  test('every version: the blocks fill exactly the data modules, group 2 holds one codeword more', () => {
    for (let v = 1; v <= Q.MAX_VERSION; v++) {
      const [ecc, blocks1, data1, blocks2, data2] = Q.LEVEL_M_BLOCKS[v];
      expect(blocks1 * (data1 + ecc) + blocks2 * (data2 + ecc)).toBe(Math.floor(rawDataModules(v) / 8));
      if (blocks2 > 0) expect(data2).toBe(data1 + 1);
    }
  });

  test('the byte capacity of every version is table 7 of the standard', () => {
    const capacity = v => Math.floor((8 * Q.dataCodewordCount(v) - 4 - (v <= 9 ? 8 : 16)) / 8);
    expect(Array.from({ length: 40 }, (_, i) => capacity(i + 1))).toEqual(BYTE_CAPACITY_M);
  });

  test('a text takes the smallest version that holds it', () => {
    BYTE_CAPACITY_M.forEach((bytes, i) => {
      expect(Q.versionFor(bytes)).toBe(i + 1);
      expect(Q.versionFor(bytes + 1)).toBe(i === 39 ? null : i + 2);
    });
  });

  test('the alignment patterns are where annex E puts them', () => {
    expect(Array.from({ length: 40 }, (_, i) => Q.alignmentPositions(i + 1))).toEqual(ALIGNMENT);
  });

  test('the format information is annex C, the version information annex D', () => {
    expect(FORMAT_M.map((_, mask) => bitsText(formatBits(mask), 15))).toEqual(FORMAT_M);
    expect(Array.from({ length: 34 }, (_, i) => versionBits(i + 7))).toEqual(VERSION_INFO);
  });

  test("Reed–Solomon gives the error correction of the standard's worked example (1-M)", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
});

// ── Codes read back ──────────────────────────────────────────────────────────

describe('a code reads back as its text', () => {
  test.each(reference.cases.map(c => [textOf(c).length, c]))('%i characters', (_, c) => {
    const text = textOf(c);
    const qr = Q.encode(text);
    expect(readBack(qr)).toEqual({ version: qr.version, mask: qr.mask, text });
  });

  test('with every mask', () => {
    const text = reference.cases.find(c => c.text?.startsWith('otpauth')).text;
    for (let mask = 0; mask < 8; mask++) expect(readBack(Q.encode(text, { mask })).text).toBe(text);
  });

  test('a text too long for version 40 has no code', () => {
    expect(Q.encode('x'.repeat(2332))).toBeNull();
    expect(Q.qrDataUrl('x'.repeat(2332))).toBeNull();
  });
});

// ── Against another encoder ──────────────────────────────────────────────────

const matrixHash = modules => crypto.createHash('sha256')
  .update(modules.map(row => row.map(m => (m ? '1' : '0')).join('')).join('\n'))
  .digest('hex').slice(0, 16);

describe('module by module, the same code as segno', () => {
  test('the reference was made', () => {
    expect(reference.generator).toMatch(/^segno \d/);
    expect(reference.cases.every(c => c.masks?.length === 8)).toBe(true);
  });

  test.each(reference.cases.map(c => [textOf(c).length, c]))('%i characters, every mask', (_, c) => {
    const text = textOf(c);
    for (let mask = 0; mask < 8; mask++) {
      const qr = Q.encode(text, { mask });
      expect(qr.version).toBe(c.version);
      expect(matrixHash(qr.modules)).toBe(c.masks[mask]);
    }
  });

  // The mask the penalty rules choose is not compared: encoders read rule N3
  // (the 1:1:3:1:1 finder-like pattern) differently, segno chose another
  // mask for 37 of these 83 texts, and every mask gives a valid code (all
  // eight are compared above and read back below).
});

// ── The picture ──────────────────────────────────────────────────────────────

describe('the SVG', () => {
  test('has a light border of four modules and draws only the code', () => {
    const qr = Q.encode('otpauth://totp/OSCAR:a%40b.example?secret=JBSWY3DPEHPK3PXP');
    const svg = Q.toSvg(qr, 4);
    const dimension = qr.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${dimension} ${dimension}"`);
    expect(svg).toContain(`width="${dimension * 4}"`);
    expect(svg).not.toContain('otpauth');
    const darkInSvg = [...svg.matchAll(/h(\d+)v1/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(darkInSvg).toBe(qr.modules.flat().filter(Boolean).length);
    expect(svg).toContain('d="M4 4h7v1h-7z');   // the top row of the top-left finder
  });

  test('as a data: URL holds base64 of the SVG, nothing of the text', () => {
    const url = Q.qrDataUrl('secret-text-123');
    expect(url).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
    const svg = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).not.toContain('secret-text-123');
  });
});
