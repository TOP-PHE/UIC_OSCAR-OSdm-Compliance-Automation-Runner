// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The files of a run's working folder, as the server reads and writes them.
 *
 * The folder belongs to the run: Bruno and the collection write in it, and
 * with RUN_ISOLATION=isolated it sits on a volume the runner container
 * writes too. So the server never follows a link there:
 *  - a file is opened without following a link (O_NOFOLLOW where the system
 *    has it, else a link check on the open file) and without waiting on a
 *    pipe (O_NONBLOCK), and must be a plain file under the size limit;
 *  - the folder holding it must resolve to where it should be (no folder of
 *    its path is a link), checked before opening and, where the system can
 *    say (/proc/self/fd), on the open file itself;
 *  - a write creates a new file (O_EXCL), after removing whatever had its
 *    name: removing a link never touches what it names.
 * A refusal is an error with code ERUNFILE. No dependency on the database.
 */

const fs = require('node:fs');
const path = require('node:path');

const C = fs.constants;
// Windows has neither flag. There the open file is compared with what lstat
// finds under its name; no isolated run is made on Windows.
const NOFOLLOW = C.O_NOFOLLOW || 0;
const NONBLOCK = C.O_NONBLOCK || 0;
// About ten times the largest report seen from a real provider (9 MB).
const MAX_RUN_FILE_BYTES = 100 * 1024 * 1024;
const READ_CHUNK = 1024 * 1024;

class RunFileRefusal extends Error {
  constructor(message) {
    super(message);
    this.code = 'ERUNFILE';
  }
}

/** `name` when it is one file name (no folder, no `..`), else a refusal. */
function plainName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..'
      || name.length > 255 || /[/\\]/.test(name) || name.includes('\0')) {
    throw new RunFileRefusal(`"${String(name).slice(0, 80)}" is not a file name`);
  }
  return name;
}

/** The real path of `dir`, which must be `expected` when one is given. */
async function realFolder(dir, expected) {
  const real = await fs.promises.realpath(dir);
  if (expected && real !== expected) {
    throw new RunFileRefusal(`${path.basename(dir)} is not the run's own folder: a folder of its path is a link`);
  }
  return real;
}

/** Where an open file is (Linux), or null when the system cannot say. */
async function openedPath(handle) {
  try {
    return await fs.promises.readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    return null;
  }
}

/** Refuses an open file that is not `file` itself. */
async function checkOpened(handle, file) {
  const where = await openedPath(handle);
  if (where !== null && where !== file) {
    throw new RunFileRefusal(`${path.basename(file)} was opened outside the run's folder`);
  }
  return where;
}

// The open file's details, refused unless it is a plain file named `file`.
async function plainFileStat(handle, file) {
  const st = await handle.stat();
  if (!st.isFile()) throw new RunFileRefusal(`${path.basename(file)} is not a plain file`);
  await checkOpened(handle, file);
  if (!NOFOLLOW) {
    const named = await fs.promises.lstat(file);
    if (named.isSymbolicLink() || named.ino !== st.ino || named.dev !== st.dev) {
      throw new RunFileRefusal(`${path.basename(file)} is a link`);
    }
  }
  return st;
}

// Reads to the end, refusing more than maxBytes (the file may grow after stat).
async function readAtMost(handle, maxBytes, name) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new RunFileRefusal(`${name} is larger than ${maxBytes} bytes`);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

// A link met by O_NOFOLLOW is ELOOP (Linux, macOS) or EMLINK (BSD).
function asRefusal(err, name) {
  if (err?.code === 'ELOOP' || err?.code === 'EMLINK') return new RunFileRefusal(`${name} is a link`);
  return err;
}

/**
 * The content of the plain file `name` of the folder `dir`.
 * @param {{ expectedDir?: string|null, maxBytes?: number }} [options]
 *   expectedDir: the real path `dir` must have (null: not checked).
 */
async function readRunFile(dir, name, { expectedDir = null, maxBytes = MAX_RUN_FILE_BYTES } = {}) {
  const file = path.join(await realFolder(dir, expectedDir), plainName(name));
  let handle;
  try {
    handle = await fs.promises.open(file, C.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (err) {
    throw asRefusal(err, name);
  }
  try {
    const st = await plainFileStat(handle, file);
    if (st.size > maxBytes) throw new RunFileRefusal(`${name} is larger than ${maxBytes} bytes`);
    return await readAtMost(handle, maxBytes, name);
  } finally {
    await handle.close();
  }
}

/**
 * Writes `data` as a new file `name` of the folder `dir`, replacing whatever
 * had that name (a link is removed, never followed).
 * @param {{ expectedDir?: string|null, mode?: number }} [options]
 */
async function writeRunFile(dir, name, data, { expectedDir = null, mode = 0o600 } = {}) {
  const file = path.join(await realFolder(dir, expectedDir), plainName(name));
  try {
    await fs.promises.unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let handle;
  try {
    handle = await fs.promises.open(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, mode);
  } catch (err) {
    throw asRefusal(err, name);
  }
  let where = null;
  try {
    where = await openedPath(handle);
    if (where !== null && where !== file) {
      throw new RunFileRefusal(`${name} was created outside the run's folder`);
    }
    await handle.writeFile(data);
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    // The file this call created goes, wherever it was created.
    await fs.promises.unlink(where ?? file).catch(() => {});
    throw err;
  }
}

/** Removes the file `name` of `dir` (a link is removed, never followed). */
async function removeRunFile(dir, name, { expectedDir = null } = {}) {
  const file = path.join(await realFolder(dir, expectedDir), plainName(name));
  try {
    await fs.promises.unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * The entries of `dir`, each { name, plain, mtimeMs }: `plain` is true for a
 * plain file only (a link is described as itself, never followed).
 */
async function listRunFolder(dir, { expectedDir = null } = {}) {
  const real = await realFolder(dir, expectedDir);
  const names = await fs.promises.readdir(real);
  return Promise.all(names.map(async (name) => {
    const st = await fs.promises.lstat(path.join(real, name));
    return { name, plain: st.isFile(), mtimeMs: st.mtimeMs };
  }));
}

/**
 * Makes the new folder `name` in `dir` (never one that is there already) and
 * returns its real path.
 */
async function makeRunFolder(dir, name, { expectedDir = null } = {}) {
  const folder = path.join(await realFolder(dir, expectedDir), plainName(name));
  await fs.promises.mkdir(folder);
  return folder;
}

/**
 * Copies the file `source` (the server's own) as the new file `name` of
 * `dir`, with its mode. Returns false when `source` is not there.
 */
async function copyFileIntoRunFolder(source, dir, name, { expectedDir = null } = {}) {
  let handle;
  try {
    handle = await fs.promises.open(source, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  let content;
  let mode;
  try {
    // Mode and content of the one file opened, never looked up twice by name.
    ({ mode } = await handle.stat());
    content = await handle.readFile();
  } finally {
    await handle.close();
  }
  await writeRunFile(dir, name, content, { expectedDir, mode: mode & 0o777 });
  return true;
}

/**
 * Copies the folder `source` (the server's own, read as it is) into a new
 * folder `name` of `dir`, writing each file as a new one.
 */
async function copyIntoRunFolder(source, dir, name, { expectedDir = null } = {}) {
  const folder = await makeRunFolder(dir, name, { expectedDir });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const from = path.join(source, entry.name);
    if (entry.isDirectory()) {
      await copyIntoRunFolder(from, folder, entry.name, { expectedDir: folder });
    } else if (entry.isFile()) {
      await copyFileIntoRunFolder(from, folder, entry.name, { expectedDir: folder });
    }
  }));
  return folder;
}

module.exports = {
  readRunFile,
  writeRunFile,
  removeRunFile,
  listRunFolder,
  makeRunFolder,
  copyFileIntoRunFolder,
  copyIntoRunFolder,
  RunFileRefusal,
  MAX_RUN_FILE_BYTES,
};
