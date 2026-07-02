// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mailer.test.js — Unit tests for src/utils/mailer.js
 *
 * Covers:
 *   - isSmtpConfigured() true/false against the real server_config table
 *   - sendVerificationEmail / sendPendingApprovalEmail / sendTestEmail /
 *     sendPasswordResetEmail, each in:
 *       (a) SMTP not configured + NODE_ENV=production      → throws
 *       (b) SMTP not configured + NODE_ENV!=production      → devMode fallback, no network
 *       (c) SMTP configured, sendMail resolves               → sends with correct to/subject/html
 *       (d) SMTP configured, sendMail rejects                → re-throws (all four functions do)
 *   - escHtml's effect (indirectly, via companyName/applicantEmail/requestedBy/to
 *     containing '<', '>', '&')
 *
 * nodemailer is mocked so no real SMTP network calls are made. The
 * server_config table is the REAL one used by the shared test DB (see
 * tests/setup.js) — SMTP_HOST/SMTP_USER/SMTP_PASS rows are inserted/deleted
 * around each test that needs the "configured" branch, mirroring the pattern
 * in tests/integration/admin-routes.test.js (see the SMTP_PASS masking test).
 */

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

jest.mock('nodemailer', () => ({
  createTransport: (...args) => mockCreateTransport(...args),
}));

const { run, get } = require('../../src/db/db');
const { smtpSends } = require('../../src/utils/metrics');
const {
  sendVerificationEmail,
  sendPendingApprovalEmail,
  sendTestEmail,
  sendPasswordResetEmail,
  isSmtpConfigured,
} = require('../../src/utils/mailer');

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

// Snapshot whatever server_config already has for these keys so we can
// restore it exactly — other test files sharing this DB (e.g.
// tests/integration/admin-routes.test.js) may run in the same process and
// read server_config too.
function snapshotSmtpConfig() {
  const snap = {};
  for (const key of SMTP_KEYS) {
    snap[key] = get(`SELECT value FROM server_config WHERE key = ?`, [key]);
  }
  return snap;
}

function restoreSmtpConfig(snap) {
  for (const key of SMTP_KEYS) {
    const prior = snap[key];
    if (prior) {
      run(`UPDATE server_config SET value = ? WHERE key = ?`, [prior.value, key]);
    } else {
      run(`DELETE FROM server_config WHERE key = ?`, [key]);
    }
  }
}

function setSmtpConfigured() {
  const upsert = (key, value) => run(
    `INSERT INTO server_config (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), 'test-setup')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
  upsert('SMTP_HOST', 'smtp.example.com');
  upsert('SMTP_PORT', '587');
  upsert('SMTP_SECURE', 'false');
  upsert('SMTP_USER', 'smtp-user@example.com');
  upsert('SMTP_PASS', 'smtp-secret-pass');
  upsert('SMTP_FROM', 'OSCAR Platform <noreply@oscar.uic.org>');
}

function clearSmtpConfig() {
  run(`DELETE FROM server_config WHERE key IN (${SMTP_KEYS.map(() => '?').join(',')})`, SMTP_KEYS);
}

describe('mailer.js', () => {
  let smtpSnapshot;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    smtpSnapshot = snapshotSmtpConfig();
  });

  afterAll(() => {
    restoreSmtpConfig(smtpSnapshot);
    process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    mockSendMail.mockReset();
    mockCreateTransport.mockClear();
    clearSmtpConfig();
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── isSmtpConfigured() ───────────────────────────────────────────────────

  describe('isSmtpConfigured', () => {
    test('returns false when SMTP_HOST/SMTP_USER/SMTP_PASS are all empty', () => {
      expect(isSmtpConfigured()).toBe(false);
    });

    test('returns false when only some of SMTP_HOST/SMTP_USER/SMTP_PASS are set', () => {
      run(
        `INSERT INTO server_config (key, value) VALUES ('SMTP_HOST', 'smtp.example.com')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      run(
        `INSERT INTO server_config (key, value) VALUES ('SMTP_USER', 'user@example.com')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      // SMTP_PASS intentionally left empty
      expect(isSmtpConfigured()).toBe(false);
    });

    test('returns true when SMTP_HOST, SMTP_USER and SMTP_PASS are all set', () => {
      setSmtpConfigured();
      expect(isSmtpConfigured()).toBe(true);
    });
  });

  // ── sendVerificationEmail ────────────────────────────────────────────────

  describe('sendVerificationEmail', () => {
    const params = {
      to: 'applicant@example.com',
      companyName: 'Acme Rail',
      verificationUrl: 'https://oscar.example.com/verify?token=abc123',
    };

    test('not configured + NODE_ENV=production → throws', async () => {
      process.env.NODE_ENV = 'production';
      await expect(sendVerificationEmail(params)).rejects.toThrow(
        'SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in oscar-server.env'
      );
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('not configured + NODE_ENV!=production → devMode fallback, no network call', async () => {
      process.env.NODE_ENV = 'test';
      const result = await sendVerificationEmail(params);
      expect(result).toEqual({ devMode: true, verificationUrl: params.verificationUrl });
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(mockCreateTransport).not.toHaveBeenCalled();
    });

    test('configured → calls sendMail with correct to/subject/html and resolves', async () => {
      setSmtpConfigured();
      const info = { messageId: '<abc@example.com>', response: '250 OK', accepted: [params.to], rejected: [] };
      mockSendMail.mockResolvedValueOnce(info);

      const incSpy = jest.spyOn(smtpSends, 'inc');
      const result = await sendVerificationEmail(params);

      expect(result).toBe(info);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const call = mockSendMail.mock.calls[0][0];
      expect(call.to).toBe(params.to);
      expect(call.subject).toBe('OSCAR — Confirm your account registration');
      expect(call.from).toBe('OSCAR Platform <noreply@oscar.uic.org>');
      expect(call.html).toContain(params.companyName);
      expect(call.html).toContain(params.verificationUrl);
      expect(call.text).toContain(params.verificationUrl);
      expect(incSpy).toHaveBeenCalledWith({ result: 'success', kind: 'verification' });
      incSpy.mockRestore();
    });

    test('configured + sendMail rejects → re-throws and increments failure metric', async () => {
      setSmtpConfigured();
      const smtpError = new Error('535 Authentication failed');
      smtpError.code = 'EAUTH';
      smtpError.command = 'AUTH PLAIN';
      smtpError.responseCode = 535;
      smtpError.response = '535 5.7.8 Authentication failed';
      mockSendMail.mockRejectedValueOnce(smtpError);

      const incSpy = jest.spyOn(smtpSends, 'inc');
      await expect(sendVerificationEmail(params)).rejects.toBe(smtpError);
      expect(incSpy).toHaveBeenCalledWith({ result: 'failure', kind: 'verification' });
      incSpy.mockRestore();
    });

    test('escapes HTML-significant characters in companyName', async () => {
      setSmtpConfigured();
      mockSendMail.mockResolvedValueOnce({ messageId: 'x', response: 'ok', accepted: [], rejected: [] });
      const dangerousParams = { ...params, companyName: '<b>Acme</b> & Co' };

      await sendVerificationEmail(dangerousParams);

      const call = mockSendMail.mock.calls[0][0];
      expect(call.html).toContain('&lt;b&gt;Acme&lt;/b&gt; &amp; Co');
      expect(call.html).not.toContain('<b>Acme</b> & Co');
    });
  });

  // ── sendPendingApprovalEmail ─────────────────────────────────────────────

  describe('sendPendingApprovalEmail', () => {
    const params = {
      to: ['tm1@example.com', 'tm2@example.com'],
      applicantEmail: 'newuser@example.com',
      companyName: 'Acme Rail',
      reviewUrl: 'https://oscar.example.com/admin/users?highlight=42',
    };

    test('not configured + NODE_ENV=production → throws', async () => {
      process.env.NODE_ENV = 'production';
      await expect(sendPendingApprovalEmail(params)).rejects.toThrow(
        'SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in oscar-server.env'
      );
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('not configured + NODE_ENV!=production → devMode fallback, no network call', async () => {
      process.env.NODE_ENV = 'development';
      const result = await sendPendingApprovalEmail(params);
      expect(result).toEqual({ devMode: true, reviewUrl: params.reviewUrl });
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('configured → calls sendMail with correct to/subject/html and resolves', async () => {
      setSmtpConfigured();
      const info = { messageId: '<def@example.com>', response: '250 OK', accepted: params.to, rejected: [] };
      mockSendMail.mockResolvedValueOnce(info);

      const incSpy = jest.spyOn(smtpSends, 'inc');
      const result = await sendPendingApprovalEmail(params);

      expect(result).toBe(info);
      const call = mockSendMail.mock.calls[0][0];
      expect(call.to).toBe(params.to);
      expect(call.subject).toBe(`OSCAR — New user awaiting approval (${params.companyName})`);
      expect(call.html).toContain(params.applicantEmail);
      expect(call.html).toContain(params.companyName);
      expect(call.html).toContain(params.reviewUrl);
      expect(incSpy).toHaveBeenCalledWith({ result: 'success', kind: 'pending_approval' });
      incSpy.mockRestore();
    });

    test('configured + sendMail rejects → re-throws and increments failure metric', async () => {
      setSmtpConfigured();
      const smtpError = new Error('Connection timed out');
      smtpError.code = 'ETIMEDOUT';
      mockSendMail.mockRejectedValueOnce(smtpError);

      const incSpy = jest.spyOn(smtpSends, 'inc');
      await expect(sendPendingApprovalEmail(params)).rejects.toBe(smtpError);
      expect(incSpy).toHaveBeenCalledWith({ result: 'failure', kind: 'pending_approval' });
      incSpy.mockRestore();
    });

    test('escapes HTML-significant characters in applicantEmail and companyName', async () => {
      setSmtpConfigured();
      mockSendMail.mockResolvedValueOnce({ messageId: 'x', response: 'ok', accepted: [], rejected: [] });
      const dangerousParams = {
        ...params,
        applicantEmail: 'a<script>@example.com',
        companyName: 'R&D <Rail>',
      };

      await sendPendingApprovalEmail(dangerousParams);

      const call = mockSendMail.mock.calls[0][0];
      expect(call.html).toContain('a&lt;script&gt;@example.com');
      expect(call.html).toContain('R&amp;D &lt;Rail&gt;');
      expect(call.html).not.toContain('a<script>@example.com');
    });
  });

  // ── sendTestEmail ────────────────────────────────────────────────────────

  describe('sendTestEmail', () => {
    const params = { to: 'admin@example.com', requestedBy: 'admin@admin-test.com' };

    test('not configured → throws a NOT_CONFIGURED error regardless of NODE_ENV', async () => {
      process.env.NODE_ENV = 'test';
      let caught;
      try {
        await sendTestEmail(params);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe('SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS first.');
      expect(caught.code).toBe('NOT_CONFIGURED');
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('not configured + NODE_ENV=production → still throws the same NOT_CONFIGURED error', async () => {
      process.env.NODE_ENV = 'production';
      let caught;
      try {
        await sendTestEmail(params);
      } catch (e) {
        caught = e;
      }
      expect(caught.code).toBe('NOT_CONFIGURED');
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('configured → calls sendMail with correct to/subject/html and resolves', async () => {
      setSmtpConfigured();
      const info = { messageId: '<ghi@example.com>', response: '250 OK', accepted: [params.to], rejected: [] };
      mockSendMail.mockResolvedValueOnce(info);

      const incSpy = jest.spyOn(smtpSends, 'inc');
      const result = await sendTestEmail(params);

      expect(result).toBe(info);
      const call = mockSendMail.mock.calls[0][0];
      expect(call.to).toBe(params.to);
      expect(call.subject).toBe('OSCAR — SMTP test email');
      expect(call.html).toContain(params.requestedBy);
      expect(call.text).toContain(params.requestedBy);
      expect(incSpy).toHaveBeenCalledWith({ result: 'success', kind: 'test' });
      incSpy.mockRestore();
    });

    test('configured + sendMail rejects → re-throws and increments failure metric', async () => {
      setSmtpConfigured();
      const smtpError = new Error('550 Sender address rejected');
      smtpError.code = 'EENVELOPE';
      smtpError.responseCode = 550;
      mockSendMail.mockRejectedValueOnce(smtpError);

      const incSpy = jest.spyOn(smtpSends, 'inc');
      await expect(sendTestEmail(params)).rejects.toBe(smtpError);
      expect(incSpy).toHaveBeenCalledWith({ result: 'failure', kind: 'test' });
      incSpy.mockRestore();
    });

    test('escapes HTML-significant characters in requestedBy', async () => {
      setSmtpConfigured();
      mockSendMail.mockResolvedValueOnce({ messageId: 'x', response: 'ok', accepted: [], rejected: [] });
      const dangerousParams = { ...params, requestedBy: '<admin> & "friends"' };

      await sendTestEmail(dangerousParams);

      const call = mockSendMail.mock.calls[0][0];
      expect(call.html).toContain('&lt;admin&gt; &amp; "friends"');
      expect(call.html).not.toContain('<admin> & "friends"');
    });

    test('falls back to "unknown admin" in the text body when requestedBy is omitted', async () => {
      setSmtpConfigured();
      mockSendMail.mockResolvedValueOnce({ messageId: 'x', response: 'ok', accepted: [], rejected: [] });

      await sendTestEmail({ to: params.to });

      const call = mockSendMail.mock.calls[0][0];
      expect(call.text).toContain('Requested by: unknown admin');
    });
  });

  // ── sendPasswordResetEmail ───────────────────────────────────────────────

  describe('sendPasswordResetEmail', () => {
    const params = {
      to: 'user@example.com',
      resetUrl: 'https://oscar.example.com/reset-password.html?token=xyz789',
    };

    test('not configured + NODE_ENV=production → throws', async () => {
      process.env.NODE_ENV = 'production';
      await expect(sendPasswordResetEmail(params)).rejects.toThrow(
        'SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in oscar-server.env'
      );
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('not configured + NODE_ENV!=production → devMode fallback, no network call', async () => {
      process.env.NODE_ENV = 'test';
      const result = await sendPasswordResetEmail(params);
      expect(result).toEqual({ devMode: true, resetUrl: params.resetUrl });
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('configured → calls sendMail with correct to/subject/html and resolves', async () => {
      setSmtpConfigured();
      const info = { messageId: '<jkl@example.com>', response: '250 OK', accepted: [params.to], rejected: [] };
      mockSendMail.mockResolvedValueOnce(info);

      const incSpy = jest.spyOn(smtpSends, 'inc');
      const result = await sendPasswordResetEmail(params);

      expect(result).toBe(info);
      const call = mockSendMail.mock.calls[0][0];
      expect(call.to).toBe(params.to);
      expect(call.subject).toBe('OSCAR — Password reset request');
      expect(call.html).toContain(params.resetUrl);
      expect(call.text).toContain(params.resetUrl);
      expect(incSpy).toHaveBeenCalledWith({ result: 'success', kind: 'password_reset' });
      incSpy.mockRestore();
    });

    // NOTE: read src/utils/mailer.js lines 378-390 — the catch block here logs
    // and increments the failure metric, then does `throw sendErr`, exactly
    // like the other three send functions. It does NOT swallow the error.
    test('configured + sendMail rejects → re-throws and increments failure metric', async () => {
      setSmtpConfigured();
      const smtpError = new Error('451 Temporary local problem');
      smtpError.code = 'ECONNRESET';
      smtpError.command = 'DATA';
      smtpError.responseCode = 451;
      smtpError.response = '451 4.3.0 Temporary local problem';
      mockSendMail.mockRejectedValueOnce(smtpError);

      const incSpy = jest.spyOn(smtpSends, 'inc');
      await expect(sendPasswordResetEmail(params)).rejects.toBe(smtpError);
      expect(incSpy).toHaveBeenCalledWith({ result: 'failure', kind: 'password_reset' });
      incSpy.mockRestore();
    });

    test('escapes HTML-significant characters in "to"', async () => {
      setSmtpConfigured();
      mockSendMail.mockResolvedValueOnce({ messageId: 'x', response: 'ok', accepted: [], rejected: [] });
      const dangerousParams = { ...params, to: 'weird+<tag>&name@example.com' };

      await sendPasswordResetEmail(dangerousParams);

      const call = mockSendMail.mock.calls[0][0];
      expect(call.html).toContain('weird+&lt;tag&gt;&amp;name@example.com');
      expect(call.html).not.toContain('weird+<tag>&name@example.com');
    });
  });
});
