// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * qrCode.js — a QR code encoder, pure, no dependency (#1414).
 *
 * It draws the otpauth:// address an authenticator app reads when a person
 * turns on the second factor of their account. ISO/IEC 18004: byte mode
 * (UTF-8), error correction level M (15 %), versions 1 to 40, the mask of
 * lowest penalty. The layout follows Project Nayuki's reference encoder
 * (MIT), whose steps are the standard's; the tests compare every version
 * and every mask, module by module, with another encoder (segno).
 *
 * Coordinates are (x, y) = (column, row); a module is true when dark.
 */

// Level M, per version 1–40: [error correction codewords per block,
// blocks of group 1, data codewords of each, blocks of group 2, data
// codewords of each]. ISO/IEC 18004, table 9.
const LEVEL_M_BLOCKS = Object.freeze([
  null,
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42], [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
  [26, 17, 42, 0, 0], [28, 17, 46, 0, 0], [28, 4, 47, 14, 48], [28, 6, 45, 14, 46],
  [28, 8, 47, 13, 48], [28, 19, 46, 4, 47], [28, 22, 45, 3, 46], [28, 3, 45, 23, 46],
  [28, 21, 45, 7, 46], [28, 19, 47, 10, 48], [28, 2, 46, 29, 47], [28, 10, 46, 23, 47],
  [28, 14, 46, 21, 47], [28, 14, 46, 23, 47], [28, 12, 47, 26, 48], [28, 6, 47, 34, 48],
  [28, 29, 46, 14, 47], [28, 13, 46, 32, 47], [28, 40, 47, 7, 48], [28, 18, 47, 31, 48],
].map(row => (row ? Object.freeze(row) : row)));

const MAX_VERSION = 40;
const LEVEL_M_FORMAT = 0b00;        // the two level bits of the format information
const QUIET_ZONE = 4;               // modules of light border the standard asks for
const PENALTY = Object.freeze({ N1: 3, N2: 3, N3: 40, N4: 10 });

// The eight masks: true where a data module is flipped.
const MASKS = Object.freeze([
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]);

const bitOf = (value, i) => ((value >>> i) & 1) !== 0;

// ── The data ─────────────────────────────────────────────────────────────────

function dataCodewordCount(version) {
  const [, blocks1, data1, blocks2, data2] = LEVEL_M_BLOCKS[version];
  return blocks1 * data1 + blocks2 * data2;
}

/** Bits of the character count in byte mode. */
function countBits(version) {
  return version <= 9 ? 8 : 16;
}

/** The smallest version holding `length` bytes at level M, or null. */
function versionFor(length) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (4 + countBits(version) + 8 * length <= 8 * dataCodewordCount(version)) return version;
  }
  return null;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** Mode, count, bytes, terminator and padding, as data codewords. */
function dataCodewords(bytes, version) {
  const capacity = dataCodewordCount(version) * 8;
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, countBits(version));
  for (const byte of bytes) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  let pad = 0xec;   // the pad codewords alternate 0xEC and 0x11
  while (bits.length < capacity) {
    appendBits(bits, pad, 8);
    pad ^= 0xec ^ 0x11;
  }
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return codewords;
}

// ── Reed–Solomon over GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1 ────────

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

/** The data split in blocks, each block's error correction added, interleaved. */
function interleaved(data, version) {
  const [ecc, blocks1, data1, blocks2, data2] = LEVEL_M_BLOCKS[version];
  const divisor = rsDivisor(ecc);
  const blocks = [];
  let start = 0;
  for (let i = 0; i < blocks1 + blocks2; i++) {
    const part = data.slice(start, start + (i < blocks1 ? data1 : data2));
    start += part.length;
    blocks.push({ part, ecc: rsRemainder(part, divisor) });
  }
  const out = [];
  for (let i = 0; i < Math.max(data1, data2); i++) {
    for (const block of blocks) if (i < block.part.length) out.push(block.part[i]);
  }
  for (let i = 0; i < ecc; i++) for (const block of blocks) out.push(block.ecc[i]);
  return out;
}

// ── The matrix ───────────────────────────────────────────────────────────────

function newMatrix(size) {
  const grid = () => Array.from({ length: size }, () => new Array(size).fill(false));
  return { size, modules: grid(), isFunction: grid() };
}

function setFunction(m, x, y, dark) {
  m.modules[y][x] = dark;
  m.isFunction[y][x] = true;
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < m.size && y >= 0 && y < m.size) setFunction(m, x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) setFunction(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

/** Centres of the alignment patterns along one side. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  // From the last one (size - 7) inwards, each `step` before the previous.
  for (let i = 0; i < count - 1; i++) result.splice(1, 0, size - 7 - i * step);
  return result;
}

function formatBits(mask) {
  const data = (LEVEL_M_FORMAT << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormatBits(m, mask) {
  const bits = formatBits(mask);
  const last = m.size - 1;
  for (let i = 0; i <= 5; i++) setFunction(m, 8, i, bitOf(bits, i));
  setFunction(m, 8, 7, bitOf(bits, 6));
  setFunction(m, 8, 8, bitOf(bits, 7));
  setFunction(m, 7, 8, bitOf(bits, 8));
  for (let i = 9; i < 15; i++) setFunction(m, 14 - i, 8, bitOf(bits, i));
  for (let i = 0; i < 8; i++) setFunction(m, last - i, 8, bitOf(bits, i));
  for (let i = 8; i < 15; i++) setFunction(m, 8, m.size - 15 + i, bitOf(bits, i));
  setFunction(m, 8, m.size - 8, true);   // the dark module
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawVersion(m, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(m, a, b, bitOf(bits, i));
    setFunction(m, b, a, bitOf(bits, i));
  }
}

function drawFunctionPatterns(m, version) {
  for (let i = 0; i < m.size; i++) {
    setFunction(m, 6, i, i % 2 === 0);
    setFunction(m, i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, m.size - 4, 3);
  drawFinder(m, 3, m.size - 4);
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((x, i) => positions.forEach((y, j) => {
    const nearFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
    if (!nearFinder) drawAlignment(m, x, y);
  }));
  drawFormatBits(m, 0);   // reserves the area; drawn again once the mask is chosen
  drawVersion(m, version);
}

/** The right column of each two-module column, right to left, skipping the timing column 6. */
function columnPairs(size) {
  const rights = [];
  for (let right = size - 1; right >= 1; right -= 2) rights.push(right <= 6 ? right - 1 : right);
  return rights;
}

/** Places the codewords in the zigzag of two-module columns. */
function drawCodewords(m, codewords) {
  let i = 0;
  for (const right of columnPairs(m.size)) {
    const upward = ((right + 1) & 2) === 0;
    for (let vertical = 0; vertical < m.size; vertical++) {
      const y = upward ? m.size - 1 - vertical : vertical;
      for (const x of [right, right - 1]) {
        if (!m.isFunction[y][x] && i < codewords.length * 8) {
          m.modules[y][x] = bitOf(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function applyMask(m, mask) {
  const flip = MASKS[mask];
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[y][x] && flip(x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

// ── The penalty of a mask (the standard's four rules) ─────────────────────

function addRun(length, history, size) {
  history.pop();
  history.unshift(history[0] === 0 ? length + size : length);   // light border before the first run
}

// A dark-light-dark-dark-dark-light-dark run of 1:1:3:1:1 with 4 light on one side.
function finderLikeCount(history) {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
    + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

/** Rules 1 and 3 over one row or column. */
function linePenalty(line, size) {
  let result = 0;
  let runColor = false;
  let run = 0;
  const history = [0, 0, 0, 0, 0, 0, 0];
  for (const color of line) {
    if (color === runColor) {
      run++;
      if (run === 5) result += PENALTY.N1;
      else if (run > 5) result++;
    } else {
      addRun(run, history, size);
      if (!runColor) result += finderLikeCount(history) * PENALTY.N3;
      runColor = color;
      run = 1;
    }
  }
  if (runColor) {
    addRun(run, history, size);
    run = 0;
  }
  addRun(run + size, history, size);   // light border after the last run
  return result + finderLikeCount(history) * PENALTY.N3;
}

function blockPenalty(m) {
  let result = 0;
  for (let y = 0; y < m.size - 1; y++) {
    for (let x = 0; x < m.size - 1; x++) {
      const color = m.modules[y][x];
      if (color === m.modules[y][x + 1] && color === m.modules[y + 1][x] && color === m.modules[y + 1][x + 1]) {
        result += PENALTY.N2;
      }
    }
  }
  return result;
}

function balancePenalty(m) {
  const total = m.size * m.size;
  const dark = m.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return k * PENALTY.N4;
}

function penaltyOf(m) {
  let result = blockPenalty(m) + balancePenalty(m);
  for (let i = 0; i < m.size; i++) {
    result += linePenalty(m.modules[i], m.size);
    result += linePenalty(m.modules.map(row => row[i]), m.size);
  }
  return result;
}

function bestMask(m) {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < MASKS.length; mask++) {
    applyMask(m, mask);
    drawFormatBits(m, mask);
    const score = penaltyOf(m);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(m, mask);   // a mask is its own inverse
  }
  return best;
}

// ── The encoder ──────────────────────────────────────────────────────────────

/**
 * The QR code of a text: { version, mask, size, modules } (modules[y][x],
 * true = dark), or null when the text is too long for version 40. `mask`
 * forces one of the eight masks (tests); by default the lowest penalty wins.
 */
function encode(text, options = {}) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = versionFor(bytes.length);
  if (!version) return null;
  const m = newMatrix(version * 4 + 17);
  drawFunctionPatterns(m, version);
  drawCodewords(m, interleaved(dataCodewords(bytes, version), version));
  const mask = Number.isInteger(options.mask) && options.mask >= 0 && options.mask < 8 ? options.mask : bestMask(m);
  applyMask(m, mask);
  drawFormatBits(m, mask);
  return { version, mask, size: m.size, modules: m.modules };
}

/** An SVG of the code with its light border, one path per row of dark runs. */
function toSvg(qr, scale = 5) {
  const dimension = qr.size + QUIET_ZONE * 2;
  const runs = [];
  qr.modules.forEach((row, y) => {
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) { x++; continue; }
      const start = x;
      while (x < qr.size && row[x]) x++;
      runs.push(`M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`);
    }
  });
  const pixels = dimension * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" `
    + `viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">`
    + `<rect width="${dimension}" height="${dimension}" fill="#fff"/>`
    + `<path fill="#000" d="${runs.join('')}"/></svg>`;
}

/**
 * The QR code of a text as a data: URL an <img> shows, or null when the text
 * is too long. The SVG holds only the drawing, never the text.
 */
function qrDataUrl(text, scale = 5) {
  const qr = encode(text);
  if (!qr) return null;
  return `data:image/svg+xml;base64,${Buffer.from(toSvg(qr, scale), 'utf8').toString('base64')}`;
}

/** Which modules of a version are function patterns (tests read a code back with it). */
function functionMap(version) {
  const m = newMatrix(version * 4 + 17);
  drawFunctionPatterns(m, version);
  return m.isFunction;
}

module.exports = {
  encode, toSvg, qrDataUrl, versionFor, dataCodewordCount, alignmentPositions,
  LEVEL_M_BLOCKS, MAX_VERSION, QUIET_ZONE, MASKS,
  // For the tests: the standard's computations, checked against its tables.
  _internal: { formatBits, versionBits, rsDivisor, rsRemainder, functionMap },
};
