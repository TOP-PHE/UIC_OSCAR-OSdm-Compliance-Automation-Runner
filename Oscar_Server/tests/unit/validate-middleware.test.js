// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * validate-middleware.test.js — Unit tests for the validate() middleware
 *
 * Covers:
 *   - Valid input passes to next()
 *   - Invalid input short-circuits with 400
 *   - Error shape includes field, location, message
 *   - Accepts a single chain (not array) as input
 *   - Multiple chain errors all reported
 */

const express = require('express');
const request = require('supertest');
const { validate, v } = require('../../src/api/middleware/validate');

// ── Build a minimal test app ──────────────────────────────────────────────────

function buildApp(validationChains) {
  const app = express();
  app.use(express.json());
  app.post('/test',
    validate(validationChains),
    (req, res) => res.status(200).json({ ok: true })
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

// ── Pass-through ──────────────────────────────────────────────────────────────

describe('validate — valid input', () => {
  test('200 when all chains pass', async () => {
    const app = buildApp([
      v.body('email').isEmail(),
      v.body('name').isString().isLength({ min: 1 }),
    ]);
    const res = await request(app)
      .post('/test')
      .send({ email: 'user@example.com', name: 'Alice' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('200 when optional field is absent', async () => {
    const app = buildApp([
      v.body('email').isEmail(),
      v.body('nickname').optional().isString(),
    ]);
    const res = await request(app)
      .post('/test')
      .send({ email: 'user@example.com' });
    expect(res.status).toBe(200);
  });
});

// ── 400 on validation failure ─────────────────────────────────────────────────

describe('validate — invalid input', () => {
  test('400 when required field is missing', async () => {
    const app = buildApp([v.body('email').isEmail()]);
    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
  });

  test('400 response has structured error shape', async () => {
    const app = buildApp([v.body('email').isEmail().withMessage('must be a valid email')]);
    const res = await request(app).post('/test').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe(400);
    expect(res.body.title).toBe('Validation failed');
    expect(res.body.detail).toBeTruthy();
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    const err = res.body.errors[0];
    expect(err).toHaveProperty('field');
    expect(err).toHaveProperty('location');
    expect(err).toHaveProperty('message');
    expect(err.message).toBe('must be a valid email');
  });

  test('error.field matches the failing body field name', async () => {
    const app = buildApp([v.body('username').isLength({ min: 3 }).withMessage('too short')]);
    const res = await request(app).post('/test').send({ username: 'ab' });
    expect(res.status).toBe(400);
    const err = res.body.errors[0];
    expect(err.field).toBe('username');
  });

  test('multiple invalid fields all appear in errors array', async () => {
    const app = buildApp([
      v.body('email').isEmail().withMessage('bad email'),
      v.body('age').isInt({ min: 0 }).withMessage('bad age'),
    ]);
    const res = await request(app).post('/test').send({ email: 'x', age: -1 });
    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Single chain (not array) ──────────────────────────────────────────────────

describe('validate — single chain input', () => {
  test('accepts a single chain (non-array) without wrapping manually', async () => {
    const app = buildApp(v.body('name').isString().notEmpty());
    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
  });

  test('single chain passes when valid', async () => {
    const app = buildApp(v.body('name').isString().notEmpty());
    const res = await request(app).post('/test').send({ name: 'Alice' });
    expect(res.status).toBe(200);
  });
});

// ── Query / param validators ──────────────────────────────────────────────────

describe('validate — v builders', () => {
  test('v.query validates query string params', async () => {
    const app = express();
    app.get('/test',
      validate([v.query('limit').isInt({ min: 1 }).withMessage('limit must be a positive integer')]),
      (req, res) => res.status(200).json({ ok: true })
    );
    const badRes = await request(app).get('/test?limit=0');
    expect(badRes.status).toBe(400);
    const goodRes = await request(app).get('/test?limit=10');
    expect(goodRes.status).toBe(200);
  });

  test('v.param validates URL path params', async () => {
    const app = express();
    app.get('/test/:id',
      validate([v.param('id').matches(/^[0-9a-fA-F-]{36}$/).withMessage('id must be a UUID')]),
      (req, res) => res.status(200).json({ ok: true })
    );
    const bad = await request(app).get('/test/not-a-uuid');
    expect(bad.status).toBe(400);
    const good = await request(app).get('/test/123e4567-e89b-12d3-a456-426614174000');
    expect(good.status).toBe(200);
  });
});
