// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #827 PR A: a filled set-up checklist read back from its Word file
 * (utils/checklistAnswers.js) and the ZIP reader under it (utils/zip.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const CL = require('../../src/utils/checklistAnswers');
const { buildZip, readZipEntry, ZipError } = require('../../src/utils/zip');

const CHECKLISTS = path.join(__dirname, '..', '..', '..', 'Documentation', 'Server_Operations', 'Simulator checklists');
const alpha = () => fs.readFileSync(path.join(CHECKLISTS, 'OSCAR_Test_Config_Checklist_Simulator_alpha.docx'));

// A one-entry ZIP whose entry is deflated (buildZip only stores).
function deflatedZip(name, data) {
  const packed = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBuf.length, 12); end.writeUInt32LE(30 + nameBuf.length + packed.length, 16);
  return { zip: Buffer.concat([local, nameBuf, packed, central, nameBuf, end]), central };
}

const checkbox = (tag, on) => `<w:sdt><w:sdtPr><w:tag w:val="${tag}"/><w14:checkbox><w14:checked w14:val="${on ? 1 : 0}"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>x</w:t></w:r></w:sdtContent></w:sdt>`;
const field = (tag, runs, placeholder) => `<w:sdt><w:sdtPr><w:alias w:val="a"/><w:tag w:val="${tag}"/>${placeholder ? '<w:showingPlcHdr/>' : ''}<w:text/></w:sdtPr><w:sdtContent>${runs}</w:sdtContent></w:sdt>`;

describe('#827 reading a ZIP entry', () => {
  test('a stored and a deflated entry come back as they were; a missing one is null', () => {
    const stored = buildZip([{ name: 'a.txt', data: 'stored' }, { name: 'word/document.xml', data: '<x/>' }]);
    expect(readZipEntry(stored, 'word/document.xml').toString()).toBe('<x/>');
    expect(readZipEntry(stored, 'nope')).toBeNull();
    const { zip } = deflatedZip('word/document.xml', Buffer.from('<w:document>ö</w:document>'));
    expect(readZipEntry(zip, 'word/document.xml').toString()).toBe('<w:document>ö</w:document>');
  });

  test('not a ZIP, an entry inflating past the limit, an encrypted or damaged entry are refused', () => {
    expect(() => readZipEntry(Buffer.from('hello'), 'x')).toThrow(ZipError);
    expect(() => readZipEntry(Buffer.alloc(100), 'x')).toThrow('not a ZIP file');
    const big = deflatedZip('word/document.xml', Buffer.alloc(2 * 1024 * 1024));
    expect(() => readZipEntry(big.zip, 'word/document.xml', { maxBytes: 1024 * 1024 })).toThrow('entry too large');
    // A central directory that understates the size: the inflation itself stops at the limit.
    const lying = deflatedZip('word/document.xml', Buffer.alloc(2 * 1024 * 1024));
    lying.zip.writeUInt32LE(10, lying.zip.length - 22 - 46 - 'word/document.xml'.length + 24);
    expect(() => readZipEntry(lying.zip, 'word/document.xml', { maxBytes: 1024 * 1024 })).toThrow('entry too large or damaged');
    const enc = buildZip([{ name: 'x', data: 'y' }]);
    enc.writeUInt16LE(1, enc.length - 22 - 46 - 1 + 8);
    expect(() => readZipEntry(enc, 'x')).toThrow('encrypted entry');
  });
});

describe('#827 reading the answers', () => {
  test('ticked boxes are true, unticked ones and placeholders are left out, text keeps its lines', () => {
    const xml = `<w:document><w:body>${checkbox('fw.salesFlows=SALE', true)}${checkbox('fw.salesFlows=REFUND_FULL', false)}`
      + field('info.limits', '<w:r><w:t xml:space="preserve">a &amp; b</w:t><w:br/><w:t>line &#233;2</w:t></w:r>')
      + field('info.empty', '<w:r><w:t>Click to answer</w:t></w:r>', true)
      + `${checkbox('fw.x=TRUE', true).replace('w14:val="1"', 'w14:val="true"')}</w:body></w:document>`;
    expect(CL.answersOfXml(xml)).toEqual({ 'fw.salesFlows=SALE': true, 'info.limits': 'a & b\nline é2', 'fw.x=TRUE': true });
  });

  test('the first control of a tag wins; a control inside another is read on its own', () => {
    const inner = field('info.inner', '<w:r><w:t>in</w:t></w:r>');
    const xml = field('info.a', '<w:r><w:t>one</w:t></w:r>') + field('info.a', '<w:r><w:t>two</w:t></w:r>')
      + `<w:sdt><w:sdtPr><w:tag w:val="info.outer"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;
    expect(CL.answersOfXml(xml)).toEqual({ 'info.a': 'one', 'info.inner': 'in', 'info.outer': 'in' });
  });

  test('the simulator\'s alpha checklist reads back every answer it was filled with', () => {
    const xml = readZipEntry(alpha(), 'word/document.xml').toString('utf8');
    const all = CL.answersOfXml(xml);
    expect(Object.keys(all)).toHaveLength(276);
    expect(all['fw.osdmVersion=3.6']).toBe(true);
    expect(all['api.baseUrl']).toBe('https://<simulator-host>/alpha');
    const { answers } = CL.answersOfDocx(alpha());
    expect(Object.keys(answers)).toHaveLength(264);
    expect(Object.keys(answers).some((k) => k.startsWith('api.') || k.startsWith('meta.'))).toBe(false);
  });

  test('a file that is not a filled checklist is refused with a sentence', () => {
    expect(CL.answersOfDocx(Buffer.from('not a zip')).refusal).toContain('not a Word file OSCAR can read');
    expect(CL.answersOfDocx(buildZip([{ name: 'a.txt', data: 'x' }])).refusal).toContain('no word/document.xml');
    expect(CL.answersOfDocx(buildZip([{ name: 'word/document.xml', data: '<w:document/>' }])).refusal).toContain('No answer found');
    const onlyApi = buildZip([{ name: 'word/document.xml', data: field('api.baseUrl', '<w:r><w:t>https://x</w:t></w:r>') }]);
    expect(CL.answersOfDocx(onlyApi).refusal).toContain('No answer found');
  });
});

describe('#827 what the model is told', () => {
  test('ticked codes become one list, fw values are left out but not their comments, api and meta never appear', () => {
    const ctx = CL.contextOf({ 'fw.salesFlows=SALE': true, 'fw.salesFlows.comment': 'No exchange.', 'info.pastDeparture=SOLD': true,
      'info.pastDeparture=REFUSED': false, 'data.bookingOps=IDEMPOTENCY_KEY': true, 'data.bookingOps=DELETE_PREBOOKED': true,
      'api.tokenUrl': 'https://x', 'meta.contact': 'Jane', 'svc1.remarks': 'x'.repeat(700) });
    expect(ctx.cut).toBe(0);
    expect(ctx.answers).toEqual({ 'info.pastDeparture': ['SOLD'], 'data.bookingOps': ['IDEMPOTENCY_KEY', 'DELETE_PREBOOKED'],
      'fw.salesFlows.comment': 'No exchange.', 'svc1.remarks': 'x'.repeat(600) + '…' });
    expect(Object.keys(ctx.answers)).toEqual(['info.pastDeparture', 'data.bookingOps', 'fw.salesFlows.comment', 'svc1.remarks']);
  });

  test('over the size, the service sheets go first and what is left out is counted', () => {
    const many = {};
    for (let i = 0; i < 60; i++) { many[`svc${i}.remarks`] = 'r'.repeat(500); many[`info.q${i}`] = 'i'.repeat(300); }
    const ctx = CL.contextOf(many);
    expect(JSON.stringify(ctx.answers).length).toBeLessThanOrEqual(CL.MAX_CONTEXT_CHARS);
    expect(Object.keys(ctx.answers).filter((k) => k.startsWith('info.'))).toHaveLength(60);
    expect(ctx.cut).toBeGreaterThan(0);
  });
});
