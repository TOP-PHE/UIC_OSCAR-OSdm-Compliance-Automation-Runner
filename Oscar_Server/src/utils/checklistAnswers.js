// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checklistAnswers.js — the answers of a filled set-up checklist (#795), read
 * back from its Word file for the AI analysis (#827). Pure.
 *
 * Every answer of the checklist is a Word content control whose tag is the
 * answer's name: a checkbox tagged `<name>=<code>` (ticked = true), or a text
 * field tagged `<name>`. Word keeps the tags when a provider fills the file
 * in, whatever else it rewrites, so the tags are all this reads.
 *
 * Kept: what a provider says about its system (`fw.*`, `data.*`, `info.*`,
 * the service sheets `svc*.*` and journeys `jrn.*`). Never kept: the API
 * Config answers (`api.*`: endpoint, token address, authentication) and the
 * contact details (`meta.*`).
 */

const { readZipEntry, ZipError } = require('./zip');

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_ANSWERS = 3000;
const MAX_VALUE = 2000;
const MAX_TAG = 200;
// About 5,000 tokens: the provider's context must not crowd out the results.
const MAX_CONTEXT_CHARS = 20000;
const NEVER_KEPT = ['api.', 'meta.'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text) {
  return String(text).replaceAll(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e];
    const code = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
  });
}

// The text of a control's content: its runs, a break as a new line.
function textOf(content) {
  let text = '';
  for (const m of content.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(br|cr)\b[^>]*\/>|<w:tab\b[^>]*\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) text += unescapeXml(m[1]);
    else if (m[2]) text += '\n';
    else if (m[0].startsWith('<w:tab')) text += '\t';
    else text += '\n';
  }
  return text.trim();
}

// Each content control as { props, content }: the text of its properties and
// of its content. Found by one pass over the start and end tags, so a control
// inside another is read on its own.
function controlsOf(xml) {
  const controls = [];
  const open = [];
  for (const m of xml.matchAll(/<w:sdt[\s>]|<\/w:sdt>/g)) {
    if (m[0] !== '</w:sdt>') { open.push(m.index); continue; }
    const start = open.pop();
    if (start === undefined) continue;
    const block = xml.slice(start, m.index);
    const propsEnd = block.indexOf('</w:sdtPr>');
    const contentStart = block.indexOf('<w:sdtContent');
    if (propsEnd < 0) continue;
    controls.push({ props: block.slice(0, propsEnd), content: contentStart >= 0 ? block.slice(contentStart) : '' });
  }
  return controls;
}

function attribute(props, element) {
  const at = props.indexOf(`<${element} `);
  if (at < 0) return null;
  const end = props.indexOf('>', at);
  const m = /\bw(?:14)?:val="([^"]*)"/.exec(props.slice(at, end));
  return m ? unescapeXml(m[1]) : null;
}

/**
 * The answers of a checklist's word/document.xml: { tag: true | "text" }.
 * A box not ticked and a field not filled in are left out.
 */
function answersOfXml(xml) {
  const answers = {};
  let count = 0;
  for (const { props, content } of controlsOf(String(xml))) {
    const tag = attribute(props, 'w:tag');
    if (!tag || tag.length > MAX_TAG || Object.hasOwn(answers, tag)) continue;
    if (props.includes('<w14:checkbox')) {
      const checked = attribute(props, 'w14:checked');
      if (checked === '1' || checked === 'true') answers[tag] = true;
    } else if (!props.includes('<w:showingPlcHdr')) {
      const text = textOf(content);
      if (text) answers[tag] = text.slice(0, MAX_VALUE);
    }
    if (Object.hasOwn(answers, tag) && ++count >= MAX_ANSWERS) break;
  }
  return answers;
}

/** The answers of a checklist's .docx bytes, or { refusal } with a sentence. */
function answersOfDocx(buffer) {
  let xml;
  try {
    xml = readZipEntry(buffer, 'word/document.xml', { maxBytes: MAX_DOCUMENT_BYTES });
  } catch (err) {
    if (err instanceof ZipError) return { refusal: `This is not a Word file OSCAR can read (${err.message}).` };
    throw err;
  }
  if (!xml) return { refusal: 'This is not a Word file: it has no word/document.xml.' };
  const answers = keptAnswers(answersOfXml(xml.toString('utf8')));
  if (Object.keys(answers).length === 0) {
    return { refusal: 'No answer found: this file is not an OSCAR set-up checklist (v2), or nothing is filled in.' };
  }
  return { answers };
}

/** The answers OSCAR keeps: never the API Config or contact answers. */
function keptAnswers(answers) {
  return Object.fromEntries(Object.entries(answers || {}).filter(([tag]) => !NEVER_KEPT.some((p) => tag.startsWith(p))));
}

// What the provider says of its system first, then the test data it named:
// when the context is cut, the service sheets go first.
const RANK = ['info.', 'data.', 'fw.', 'jrn.'];
const rank = (name) => {
  const at = RANK.findIndex((p) => name.startsWith(p));
  return at < 0 ? RANK.length : at;
};

// "fw.salesFlows=SALE" → ["fw.salesFlows", "SALE"]; a text answer has no code.
function splitTag(tag) {
  const eq = tag.indexOf('=');
  return eq > 0 ? [tag.slice(0, eq), tag.slice(eq + 1)] : [tag, null];
}

// The answers told, by name: ticked codes as one list, text cut to 600.
function toldByName(answers) {
  const byName = new Map();
  for (const [tag, value] of Object.entries(keptAnswers(answers))) {
    const [name, code] = splitTag(tag);
    const told = !name.startsWith('fw.') || name.endsWith('.comment');
    if (told && code !== null && value === true) {
      byName.set(name, [...(byName.get(name) || []), code]);
    } else if (told && code === null && typeof value === 'string') {
      byName.set(name, value.length > 600 ? value.slice(0, 600) + '…' : value);
    }
  }
  return byName;
}

/**
 * What the AI analysis is told of the provider: each answer by its name, the
 * ticked codes of a question as one list. The Test Framework is sent apart,
 * so of the `fw.*` answers only the comments are. Capped at MAX_CONTEXT_CHARS;
 * `cut` says how many answers were left out.
 */
function contextOf(answers) {
  const byName = toldByName(answers);
  const out = {};
  let chars = 2;
  let cut = 0;
  const names = [...byName.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const name of names) {
    const size = JSON.stringify(name).length + JSON.stringify(byName.get(name)).length + 2;
    if (chars + size > MAX_CONTEXT_CHARS) { cut++; continue; }
    out[name] = byName.get(name);
    chars += size;
  }
  return { answers: out, cut };
}

module.exports = { answersOfXml, answersOfDocx, keptAnswers, contextOf, MAX_CONTEXT_CHARS, MAX_ANSWERS };
