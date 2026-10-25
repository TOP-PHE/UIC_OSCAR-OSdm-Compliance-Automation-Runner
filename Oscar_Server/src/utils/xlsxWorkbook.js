// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * xlsxWorkbook.js — a minimal .xlsx writer (#956, part 3). Pure, no
 * dependency: the Office Open XML parts written by hand and stored by
 * `zip.js`'s `buildZip()`.
 *
 *   workbook([{ name, columns: [{ title, width }], rows: [[cell, …]] }]) -> Buffer
 *
 * A cell is text, a number, or null. Text is written as an inline string, so
 * Excel never reads it as a formula (a cell starting with "=" stays text).
 * Each sheet has its header row in bold, frozen, with an autofilter.
 */

const { buildZip } = require('./zip');

const MAX_ROWS = 100000;
const MAX_TEXT = 32767; // Excel's limit for one cell

// XML 1.0 allows tab, line feed, carriage return and from U+0020 on, without
// lone surrogates; anything else is dropped.
function xmlText(value) {
  let out = '';
  const text = String(value);
  for (let i = 0; i < text.length && out.length < MAX_TEXT; i += 1) {
    const c = text.codePointAt(i);
    if (c > 0xFFFF) { out += String.fromCodePoint(c); i += 1; continue; }
    const ok = c === 0x9 || c === 0xA || c === 0xD || (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD);
    if (!ok) continue;
    if (c === 0x26) out += '&amp;';
    else if (c === 0x3C) out += '&lt;';
    else if (c === 0x3E) out += '&gt;';
    else if (c === 0x22) out += '&quot;';
    else out += text[i];
  }
  return out;
}

/** A column's letters: 0 -> A, 25 -> Z, 26 -> AA. */
function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCodePoint(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// A sheet name Excel takes: 31 characters, none of : \ / ? * [ ].
function sheetName(name, used) {
  const base = String(name || 'Sheet').replaceAll(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${base.slice(0, 28)} ${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function cellXml(value, ref, style) {
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (value === null || value === undefined || value === '') return '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function sheetXml(sheet) {
  const columns = sheet.columns || [];
  const rows = (sheet.rows || []).slice(0, MAX_ROWS);
  const last = columnName(Math.max(columns.length, 1) - 1);
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(c.width) || 14}" customWidth="1"/>`).join('');
  const header = `<row r="1">${columns.map((c, i) => cellXml(c.title, `${columnName(i)}1`, 1)).join('')}</row>`;
  const body = rows.map((row, r) => `<row r="${r + 2}">${row.map((v, i) => cellXml(v, `${columnName(i)}${r + 2}`, 2)).join('')}</row>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + (cols ? `<cols>${cols}</cols>` : '')
    + `<sheetData>${header}${body}</sheetData>`
    + `<autoFilter ref="A1:${last}${rows.length + 1}"/>`
    + '</worksheet>';
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFECEFF1"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** The .xlsx file of the sheets, as a Buffer. */
function workbook(sheets) {
  const used = new Set();
  const list = (Array.isArray(sheets) ? sheets : []).map((s) => ({ ...s, name: sheetName(s.name, used) }));
  if (list.length === 0) list.push({ name: 'Sheet', columns: [], rows: [] });
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const book = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}"><sheets>`
    + list.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets>'
    + `<definedNames>${list.map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlText(s.name).replaceAll("'", "''")}'!$A$1:$${columnName(Math.max((s.columns || []).length, 1) - 1)}$${Math.min((s.rows || []).length, MAX_ROWS) + 1}</definedName>`).join('')}</definedNames>`
    + '</workbook>';
  const bookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${list.length + 1}" Type="${ns}/styles" Target="styles.xml"/></Relationships>`;
  return buildZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: book },
    { name: 'xl/_rels/workbook.xml.rels', data: bookRels },
    { name: 'xl/styles.xml', data: STYLES },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}

module.exports = { workbook, xmlText, columnName, sheetName, MAX_ROWS };
