// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mailer.js — Email sending utility for OSCAR
 *
 * Requires env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 * Optional:          SMTP_SECURE (default false — uses STARTTLS on port 587)
 *
 * If SMTP is not configured and NODE_ENV !== 'production', the verification
 * URL is printed to the console instead (useful for local development).
 */

const nodemailer = require('nodemailer');
const { getConfig } = require('../db/db');
const log = require('./logger').child({ module: 'mailer' });

function isSmtpConfigured() {
  return !!(getConfig('SMTP_HOST', '') && getConfig('SMTP_USER', '') && getConfig('SMTP_PASS', ''));
}

function createTransport() {
  return nodemailer.createTransport({
    host:   getConfig('SMTP_HOST', ''),
    port:   parseInt(getConfig('SMTP_PORT', '587'), 10),
    secure: getConfig('SMTP_SECURE', 'false') === 'true',
    auth: {
      user: getConfig('SMTP_USER', ''),
      pass: getConfig('SMTP_PASS', '')
    }
  });
}

async function sendVerificationEmail({ to, companyName, verificationUrl }) {
  if (!isSmtpConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in oscar-server.env');
    }
    // Development fallback — print link to console
    log.warn({ verificationUrl }, 'DEV MODE — SMTP not configured. Verification link returned to caller.');
    return { devMode: true, verificationUrl };
  }

  const from = getConfig('SMTP_FROM', 'OSCAR Platform <noreply@oscar.uic.org>');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f5f7f9;margin:0;padding:30px 16px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden">
    <div style="background:#0090D4;padding:24px 32px;display:flex;align-items:center;gap:12px">
      <span style="color:#fff;font-size:22px;font-weight:900;letter-spacing:1px">OSCAR</span>
      <span style="color:#b3e0f7;font-size:13px">OSDM Conformance Automation Runner</span>
    </div>
    <div style="padding:32px">
      <h2 style="color:#37474f;font-size:20px;margin:0 0 12px">Confirm your registration</h2>
      <p style="color:#546e7a;font-size:14px;line-height:1.6;margin:0 0 8px">
        You requested a Tester account for <strong>${escHtml(companyName)}</strong>.
      </p>
      <p style="color:#546e7a;font-size:14px;line-height:1.6;margin:0 0 28px">
        Click the button below to confirm your email address and set your password.
        This link expires in <strong>24 hours</strong>.
      </p>
      <a href="${verificationUrl}"
         style="display:inline-block;background:#0090D4;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:700">
        Confirm &amp; Set Password
      </a>
      <p style="color:#90a4ae;font-size:12px;margin:28px 0 0;line-height:1.5">
        If you did not request this account, ignore this email — no account will be created.<br>
        If the button does not work, copy this link into your browser:<br>
        <a href="${verificationUrl}" style="color:#0090D4;word-break:break-all">${verificationUrl}</a>
      </p>
    </div>
    <div style="background:#f5f7f9;padding:16px 32px;text-align:center;border-top:1px solid #eceff1">
      <p style="color:#b0bec5;font-size:11px;margin:0">&copy; UIC — International union of railways. 2026. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;

  const text = `OSCAR — Confirm your registration\n\nYou requested a Tester account for ${companyName}.\n\nConfirm your email and set your password by visiting:\n${verificationUrl}\n\nThis link expires in 24 hours.\n\nIf you did not request this account, ignore this email.`;

  const transporter = createTransport();

  log.info({
    to, from, companyName,
    smtpHost: getConfig('SMTP_HOST', ''),
    smtpPort: getConfig('SMTP_PORT', '587'),
    smtpSecure: getConfig('SMTP_SECURE', 'false'),
    smtpUser: getConfig('SMTP_USER', ''),
  }, 'Email send attempt');

  try {
    const info = await transporter.sendMail({ from, to, subject: 'OSCAR — Confirm your account registration', text, html });
    log.info({
      messageId: info.messageId,
      response:  info.response,
      accepted:  info.accepted,
      rejected:  info.rejected,
    }, 'Email sent successfully');
    return info;
  } catch (sendErr) {
    log.error({
      err:           sendErr.message,
      code:          sendErr.code,
      command:       sendErr.command,
      responseCode:  sendErr.responseCode,
      response:      sendErr.response,
    }, 'Email send FAILED');
    throw sendErr;
  }
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Diagnostic — sends a small fixed-content email using the current SMTP
 * config. Used by the admin "Test Email" button to validate end-to-end
 * delivery without going through the registration flow.
 *
 * Returns the nodemailer info object on success, OR throws the underlying
 * error so the caller can surface the precise SMTP rejection (auth failure,
 * unverified sender, port closed, etc.) to the admin.
 */
async function sendTestEmail({ to, requestedBy }) {
  if (!isSmtpConfigured()) {
    const err = new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS first.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const from = getConfig('SMTP_FROM', 'OSCAR Platform <noreply@oscar.uic.org>');
  const sentAt = new Date().toISOString();

  const text =
`OSCAR — SMTP test email

This is a test email sent from the OSCAR admin panel to verify the
current SMTP configuration is working end-to-end.

Requested by: ${requestedBy || 'unknown admin'}
Sent at:      ${sentAt}
SMTP host:    ${getConfig('SMTP_HOST', '')}
SMTP port:    ${getConfig('SMTP_PORT', '587')}
SMTP user:    ${getConfig('SMTP_USER', '')}
From address: ${from}

If you received this, your SMTP relay is reachable, authenticated, and
your sender domain is accepted by the relay. Registration emails will
also work.

You can safely delete this message.

— OSCAR
`;

  const html = `
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f5f7f9;margin:0;padding:30px 16px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden">
    <div style="background:#0090D4;padding:24px 32px">
      <span style="color:#fff;font-size:22px;font-weight:900;letter-spacing:1px">OSCAR</span>
      <span style="color:#b3e0f7;font-size:13px;margin-left:10px">SMTP test email</span>
    </div>
    <div style="padding:32px">
      <h2 style="color:#37474f;font-size:18px;margin:0 0 14px">✅ SMTP delivery confirmed</h2>
      <p style="color:#546e7a;font-size:14px;line-height:1.55;margin:0 0 14px">
        This is a test email sent from the OSCAR admin panel to verify
        the current SMTP configuration is working end-to-end.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#37474f">
        <tr><td style="padding:6px 8px;color:#90a4ae;width:140px">Requested by</td><td style="padding:6px 8px"><code>${escHtml(requestedBy)}</code></td></tr>
        <tr><td style="padding:6px 8px;color:#90a4ae">Sent at</td><td style="padding:6px 8px"><code>${escHtml(sentAt)}</code></td></tr>
        <tr><td style="padding:6px 8px;color:#90a4ae">SMTP host</td><td style="padding:6px 8px"><code>${escHtml(getConfig('SMTP_HOST', ''))}</code></td></tr>
        <tr><td style="padding:6px 8px;color:#90a4ae">SMTP port</td><td style="padding:6px 8px"><code>${escHtml(getConfig('SMTP_PORT', '587'))}</code></td></tr>
        <tr><td style="padding:6px 8px;color:#90a4ae">SMTP user</td><td style="padding:6px 8px"><code>${escHtml(getConfig('SMTP_USER', ''))}</code></td></tr>
        <tr><td style="padding:6px 8px;color:#90a4ae">From</td><td style="padding:6px 8px"><code>${escHtml(from)}</code></td></tr>
      </table>
      <p style="color:#90a4ae;font-size:12px;margin:24px 0 0">
        If you received this, registration emails will also work. You can safely delete this message.
      </p>
    </div>
  </div>
</body></html>`;

  const transporter = createTransport();

  log.info({
    to, from, requestedBy,
    smtpHost: getConfig('SMTP_HOST', ''),
    smtpPort: getConfig('SMTP_PORT', '587'),
    smtpSecure: getConfig('SMTP_SECURE', 'false'),
    smtpUser: getConfig('SMTP_USER', ''),
  }, 'SMTP test email send attempt');

  const info = await transporter.sendMail({
    from, to,
    subject: 'OSCAR — SMTP test email',
    text, html
  });

  log.info({
    messageId: info.messageId,
    response:  info.response,
    accepted:  info.accepted,
    rejected:  info.rejected,
  }, 'SMTP test email sent successfully');

  return info;
}

/**
 * Self-service password reset (issue #15). User clicks "Forgot password?"
 * on the login page, submits their email, server generates a token and
 * calls this function to send the reset link. resetUrl includes the token
 * as ?token=... — clicked from the email it lands on /reset-password.html
 * which validates and presents the new-password form.
 */
async function sendPasswordResetEmail({ to, resetUrl }) {
  if (!isSmtpConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in oscar-server.env');
    }
    log.warn({ resetUrl }, 'DEV MODE — SMTP not configured. Password-reset link returned to caller.');
    return { devMode: true, resetUrl };
  }

  const from = getConfig('SMTP_FROM', 'OSCAR Platform <noreply@oscar.uic.org>');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f5f7f9;margin:0;padding:30px 16px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden">
    <div style="background:#0090D4;padding:24px 32px;display:flex;align-items:center;gap:12px">
      <span style="color:#fff;font-size:22px;font-weight:900;letter-spacing:1px">OSCAR</span>
      <span style="color:#b3e0f7;font-size:13px">Password reset request</span>
    </div>
    <div style="padding:32px">
      <h2 style="color:#37474f;font-size:20px;margin:0 0 12px">Reset your password</h2>
      <p style="color:#546e7a;font-size:14px;line-height:1.6;margin:0 0 8px">
        We received a request to reset the password for the account at
        <strong>${escHtml(to)}</strong>.
      </p>
      <p style="color:#546e7a;font-size:14px;line-height:1.6;margin:0 0 28px">
        Click the button below to set a new password.
        This link expires in <strong>24 hours</strong> and can be used only once.
      </p>
      <a href="${resetUrl}"
         style="display:inline-block;background:#0090D4;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:700">
        Set a new password
      </a>
      <p style="color:#90a4ae;font-size:12px;margin:28px 0 0;line-height:1.5">
        If you did not request this reset, ignore this email — your password is unchanged.<br>
        If the button does not work, copy this link into your browser:<br>
        <a href="${resetUrl}" style="color:#0090D4;word-break:break-all">${resetUrl}</a>
      </p>
    </div>
    <div style="background:#f5f7f9;padding:16px 32px;text-align:center;border-top:1px solid #eceff1">
      <p style="color:#b0bec5;font-size:11px;margin:0">&copy; UIC — International union of railways. 2026. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;

  const text = `OSCAR — Password reset request

We received a request to reset the password for the account at ${to}.

Set a new password by visiting:
${resetUrl}

This link expires in 24 hours and can be used only once.

If you did not request this reset, ignore this email — your password is unchanged.`;

  const transporter = createTransport();

  log.info({
    to, from,
    smtpHost: getConfig('SMTP_HOST', ''),
    smtpPort: getConfig('SMTP_PORT', '587'),
    smtpUser: getConfig('SMTP_USER', ''),
  }, 'Password-reset email send attempt');

  try {
    const info = await transporter.sendMail({ from, to, subject: 'OSCAR — Password reset request', text, html });
    log.info({ messageId: info.messageId, response: info.response, accepted: info.accepted, rejected: info.rejected }, 'Password-reset email sent');
    return info;
  } catch (sendErr) {
    log.error({
      err: sendErr.message, code: sendErr.code, command: sendErr.command,
      responseCode: sendErr.responseCode, response: sendErr.response,
    }, 'Password-reset email send FAILED');
    throw sendErr;
  }
}

module.exports = { sendVerificationEmail, sendTestEmail, sendPasswordResetEmail, isSmtpConfigured };
