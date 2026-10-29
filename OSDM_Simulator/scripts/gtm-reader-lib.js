// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * gtm-reader-lib.js — reads an OSDM offline fare delivery as a stream (#1047).
 *
 * A delivery is one JSON object, `{ fareDelivery: { delivery, fareStructure:
 * { <list>: [ … ] } } }`, and a real one is too large to parse at once (DB's
 * 2024 delivery is 1.3 GB, more than a JavaScript string holds). The scanner
 * is fed the text in pieces of any size and hands back, one at a time, the
 * text of each element of the `fareStructure` lists, and the `delivery`
 * object. It never parses them: the caller decides what to keep.
 *
 * It follows strings (with their escapes) and nesting only, so it trusts the
 * text to be JSON: what is not is left to the caller's JSON.parse.
 */

class DeliveryScanner {
  /**
   * @param {object} handlers
   * @param {(list: string, text: string) => void} handlers.onElement
   * @param {(text: string) => void} [handlers.onDelivery]
   */
  constructor({ onElement, onDelivery = () => {} }) {
    this.onElement = onElement;
    this.onDelivery = onDelivery;
    this.stack = [];
    this.inString = false;
    this.escape = false;
    this.key = '';
    this.lastKey = null;
    this.expectingKey = false;
    this.capture = null;
  }

  // The list a new object at this depth belongs to, when it is an element of
  // a fareStructure list.
  listHere() {
    const s = this.stack;
    if (s.length !== 4) return null;
    if (s[1].key !== 'fareDelivery' || s[2].key !== 'fareStructure' || s[3].type !== '[') return null;
    return s[3].key;
  }

  // Is a new object here the delivery's own header?
  deliveryHere() {
    const s = this.stack;
    return s.length === 2 && s[1].key === 'fareDelivery' && this.lastKey === 'delivery';
  }

  openObject(chunk, i) {
    const list = this.listHere();
    if (list) this.capture = { kind: 'element', list, parts: [], from: i };
    else if (this.deliveryHere()) this.capture = { kind: 'delivery', parts: [], from: i };
    this.stack.push({ type: '{', key: this.lastKey });
    this.expectingKey = true;
    this.lastKey = null;
  }

  close(chunk, i) {
    const closed = this.stack.pop();
    const c = this.capture;
    if (!c || closed.type !== '{') return;
    const depth = c.kind === 'element' ? 4 : 2;
    if (this.stack.length !== depth) return;
    c.parts.push(chunk.slice(c.from, i + 1));
    this.capture = null;
    const text = c.parts.join('');
    if (c.kind === 'element') this.onElement(c.list, text);
    else this.onDelivery(text);
  }

  // One character outside a string.
  structural(ch, chunk, i) {
    if (ch === '"') {
      this.inString = true;
      this.key = '';
    } else if (ch === '{') {
      this.openObject(chunk, i);
    } else if (ch === '[') {
      this.stack.push({ type: '[', key: this.lastKey });
      this.expectingKey = false;
      this.lastKey = null;
    } else if (ch === '}' || ch === ']') {
      this.close(chunk, i);
    } else if (ch === ':') {
      this.expectingKey = false;
    } else if (ch === ',') {
      const top = this.stack.at(-1);
      this.expectingKey = top !== undefined && top.type === '{';
    }
  }

  // One character inside a string. Keys are short; a long value is not kept.
  inside(ch) {
    if (this.escape) {
      this.escape = false;
    } else if (ch === '\\') {
      this.escape = true;
    } else if (ch === '"') {
      this.inString = false;
      if (this.expectingKey) this.lastKey = this.key;
    } else if (this.expectingKey && this.key.length < 200) {
      this.key += ch;
    }
  }

  /** Feeds the next piece of the text. */
  write(chunk) {
    if (this.capture) this.capture.from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (this.inString) this.inside(ch);
      else this.structural(ch, chunk, i);
    }
    if (this.capture) this.capture.parts.push(chunk.slice(this.capture.from));
  }
}

module.exports = { DeliveryScanner };
