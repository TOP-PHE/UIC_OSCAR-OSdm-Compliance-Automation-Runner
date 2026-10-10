// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * http.js — the few HTTP helpers the simulator needs.
 *
 * Every answer is JSON. Nothing here ever writes HTML, and text received from
 * a client only goes back out through JSON.stringify.
 */

// A failure a route wants turned into an HTTP answer. Anything else that is
// thrown is a bug and becomes a 500 with no detail.
class HttpError extends Error {
  constructor(status, code, title, detail, headers) {
    super(title);
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.headers = headers || {};
  }
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

// An OSDM Problem (RFC 9457 shape, as the OSDM specification uses it).
function sendProblem(res, status, code, title, detail, headers) {
  const body = { code, title, status };
  if (detail) body.detail = detail;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/problem+json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

// Read the request body, refusing anything over `limit` bytes. The size is
// checked while reading: once over the limit nothing more is kept.
//
// A body that is over the limit is still read to its end, without being kept,
// so that the caller receives the 413 instead of a broken connection. That
// patience has its own limit: past `drainLimit` the refusal is sent at once
// and the connection is closed.
function readBody(req, limit) {
  const drainLimit = Math.max(limit * 4, 1024 * 1024);
  const tooLarge = () => new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large', `The limit is ${limit} bytes.`);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        if (size > drainLimit) reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

// The body as a JSON object. An empty body is an empty object: several OSDM
// requests carry none.
function parseJsonObject(buffer) {
  if (buffer.length === 0) return {};
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'The request body is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'The request body must be a JSON object');
  }
  return value;
}

module.exports = { HttpError, BASE_HEADERS, sendJson, sendProblem, readBody, parseJsonObject };
