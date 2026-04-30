'use strict';

/**
 * tests/setup.js — Loaded before every test file (jest setupFiles)
 *
 * Sets the env vars required for the app modules to load:
 * - ENCRYPTION_KEY: fixed test value (64 hex chars = 32 bytes)
 * - COLLECTION_PATH / BRU_CMD: dummy values (tests don't actually run Bruno)
 * - OSCAR_DB_PATH: per-test-process unique temp file so suites run in parallel
 * - NODE_ENV: 'test' (silences pino-pretty banner, sets info-level logs)
 *
 * Each test file gets a FRESH database. To reset between tests within one
 * file, use the helpers in tests/helpers/db.js.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

process.env.NODE_ENV       = 'test';
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.COLLECTION_PATH = path.join(os.tmpdir(), 'oscar-test-collection');
process.env.BRU_CMD         = 'bru-test-stub';
process.env.LOG_LEVEL       = 'silent';   // keep test output clean

// Unique DB per test process (jest runs files in parallel by default)
const tmpDb = path.join(os.tmpdir(), `oscar-test-${process.pid}-${Date.now()}.db`);
process.env.OSCAR_DB_PATH = tmpDb;

// Ensure dummy collection dir exists so module load doesn't fail
if (!fs.existsSync(process.env.COLLECTION_PATH)) {
  fs.mkdirSync(process.env.COLLECTION_PATH, { recursive: true });
}

// Cleanup: remove the test DB after the process exits
process.on('exit', () => {
  try { fs.unlinkSync(tmpDb); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(tmpDb + '-journal'); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(tmpDb + '-shm'); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(tmpDb + '-wal'); } catch (_) { /* ignore */ }
});
