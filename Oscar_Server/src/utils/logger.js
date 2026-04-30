'use strict';

/**
 * logger.js — Structured logging via pino
 *
 * Replaces ad-hoc console.log calls with a single configured logger.
 * - In production (NODE_ENV=production): JSON output for log aggregation tools
 * - In development: pretty-printed colored output for human reading
 *
 * Log level priority (first non-empty wins):
 *   1. server_config table (LOG_LEVEL row) — editable at runtime via admin UI
 *   2. LOG_LEVEL env var
 *   3. 'info' in production, 'debug' in development
 *
 * Usage:
 *   const logger = require('./utils/logger');
 *   logger.info({ runId, companyId }, 'Run started');
 *   logger.warn('Slow query', { sql, durationMs });
 *   logger.error({ err }, 'Failed to send email');
 *
 * Use child loggers for module-specific context:
 *   const log = logger.child({ module: 'runner' });
 *   log.info('Bruno spawned');
 *
 * Runtime level change (called by admin config endpoint):
 *   logger.setLevel('debug');
 */

const pino = require('pino');
const { getConfig } = require('../db/db');

const isProduction = process.env.NODE_ENV === 'production';

// Read initial level from DB → env var → default
const initialLevel = getConfig('LOG_LEVEL', isProduction ? 'info' : 'debug');

const logger = pino({
  level: initialLevel,
  // Pretty print in dev, JSON in production (for log aggregation tools)
  transport: isProduction ? undefined : {
    target: 'pino-pretty',
    options: {
      colorize:    true,
      translateTime: 'SYS:HH:MM:ss',
      ignore:      'pid,hostname'
    }
  },
  // Redact sensitive fields if they ever appear in log objects
  redact: {
    paths: [
      'password', 'token', 'access_token', 'client_secret',
      'ENCRYPTION_KEY', 'JWT_SECRET', 'PLATFORM_BOOTSTRAP_TOKEN',
      'req.headers.authorization', 'req.headers.cookie',
      '*.password', '*.token', '*.access_token', '*.client_secret'
    ],
    censor: '[REDACTED]'
  }
});

/**
 * Change the log level at runtime. Called by PATCH /v1/admin/config.
 * Affects this logger and ALL child loggers (they share the same level).
 * Valid values: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
 */
logger.setLevel = function setLevel(level) {
  const valid = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
  if (!valid.includes(level)) {
    logger.warn({ requestedLevel: level, valid }, 'Invalid log level requested — ignored');
    return false;
  }
  logger.level = level;
  logger.info({ level }, 'Log level changed at runtime');
  return true;
};

module.exports = logger;
