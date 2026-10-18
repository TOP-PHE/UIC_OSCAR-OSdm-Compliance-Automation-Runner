// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * zip.js — a minimal, dependency-free ZIP writer (STORE mode, no compression).
 *
 * In keeping with this codebase's hand-rolled-over-dependency convention
 * (cf. utils/at-rest.js for the AES envelope, the cookie parser in auth.js),
 * we don't pull in `archiver` just to bundle a handful of text artifacts —
 * HTML reports + JSON results for one run-batch. STORE mode keeps the format
 * trivially valid: each entry is its bytes verbatim, preceded by a local
 * header, followed by a central directory and an end-of-central-directory
 * record. No ZIP64 (sizes are well under 4 GB), no streaming (a batch's
 * artifacts comfortably fit in memory).
 *
 *   buildZip([{ name, data }, ...]) -> Buffer   (a complete .zip)
 *
 * `name` is the in-archive path (forward slashes), `data` a Buffer or string.
 */

const zlib = require('node:zlib');

// ── CRC-32 (IEEE 802.3), self-contained so we don't depend on a particular
// Node build exposing zlib.crc32. Table computed once, lazily. ───────────────
let _crcTable = null;
function _crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

const SIG_LOCAL   = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END     = 0x06054b50;
const DOS_TIME = 0;        // 00:00:00 — fixed, avoids timezone ambiguity
const DOS_DATE = 0x0021;   // 1980-01-01 (the DOS epoch); day/month must be >= 1

function buildZip(entries) {
  if (!Array.isArray(entries)) throw new TypeError('buildZip expects an array of {name, data}');
  const parts = [];     // local headers + data, in order
  const central = [];   // central-directory records
  let offset = 0;       // running offset of the next local header

  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const data    = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const crc     = _crc32(data);
    const size    = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6);        // general-purpose flags: bit 11 = UTF-8 names
    local.writeUInt16LE(0, 8);             // compression method: 0 = store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);         // compressed size (== size in store mode)
    local.writeUInt32LE(size, 22);         // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra-field length
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);           // flags (UTF-8)
    cd.writeUInt16LE(0, 10);               // method: store
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra-field length
    cd.writeUInt16LE(0, 32);               // file-comment length
    cd.writeUInt16LE(0, 34);               // disk number start
    cd.writeUInt16LE(0, 36);               // internal attributes
    cd.writeUInt32LE(0, 38);               // external attributes
    cd.writeUInt32LE(offset, 42);          // relative offset of local header
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf  = Buffer.concat(central);
  const centralSize = centralBuf.length;
  const centralOff  = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);                 // this disk number
  end.writeUInt16LE(0, 6);                 // disk with central dir start
  end.writeUInt16LE(entries.length, 8);    // central-dir records on this disk
  end.writeUInt16LE(entries.length, 10);   // total central-dir records
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOff, 16);
  end.writeUInt16LE(0, 20);                // .zip comment length

  return Buffer.concat([...parts, centralBuf, end]);
}

// ── Reading one entry (#827) ──────────────────────────────────────────────────
// Enough to read word/document.xml out of a .docx: stored or deflated
// entries, found through the central directory. No ZIP64, no encryption.
// `maxBytes` bounds what one entry may inflate to, so a small file that
// inflates to gigabytes is refused, not read.

class ZipError extends Error {}

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const END_MIN = 22;
const COMMENT_MAX = 0xFFFF;

function findEnd(buf) {
  const stop = Math.max(0, buf.length - END_MIN - COMMENT_MAX);
  for (let at = buf.length - END_MIN; at >= stop; at--) {
    if (buf.readUInt32LE(at) === SIG_END) return at;
  }
  throw new ZipError('not a ZIP file');
}

function centralEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < END_MIN) throw new ZipError('not a ZIP file');
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== SIG_CENTRAL) throw new ZipError('damaged central directory');
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    entries.push({
      name: buf.toString('utf8', at + 46, at + 46 + nameLength),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      localOffset: buf.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of the entry `name`, or null when the archive has none. */
function readZipEntry(buf, name, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const entry = centralEntries(buf).find((e) => e.name === name);
  if (!entry) return null;
  if (entry.flags & 1) throw new ZipError('encrypted entry');
  if (entry.size > maxBytes) throw new ZipError('entry too large');
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== SIG_LOCAL) throw new ZipError('damaged entry');
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ZipError('damaged entry');
  if (entry.method === METHOD_STORE) return Buffer.from(data);
  if (entry.method !== METHOD_DEFLATE) throw new ZipError('unsupported compression');
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch {
    throw new ZipError('entry too large or damaged');
  }
}

module.exports = { buildZip, readZipEntry, ZipError };
