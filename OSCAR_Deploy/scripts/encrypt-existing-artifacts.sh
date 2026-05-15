#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
# Licensed under the Apache License, Version 2.0
#
# encrypt-existing-artifacts.sh — optional one-time backfill for v1.11.0.
#
# Phase 2 of issue #60 encrypts every NEW artifact and datafile written
# after the upgrade. Files written BEFORE v1.11.0 stay plaintext on disk;
# OSCAR reads them transparently (the OSCAR1-magic-header check returns
# them as-is). This script re-writes those legacy files in place so they
# become encrypted too.
#
# It is OPTIONAL. The system is fully secure for new data without it.
# Run it if you want every byte on disk to be ciphertext.
#
# Usage (from inside the OSCAR container):
#   docker exec -it oscar /opt/OSCAR/OSCAR_Deploy/scripts/encrypt-existing-artifacts.sh
#
# Or from the host:
#   docker exec -it oscar node /app/OSCAR_Deploy/scripts/encrypt-existing-artifacts.sh
#
# Idempotent: files already encrypted (OSCAR1 magic) are skipped.

set -euo pipefail

DATA_DIR="${OSCAR_DATA_DIR:-/app/data}"
ARTIFACTS="$DATA_DIR/artifacts"
DATAFILES="$DATA_DIR/datafiles"

if [[ ! -d "$ARTIFACTS" && ! -d "$DATAFILES" ]]; then
  echo "Nothing to do — neither $ARTIFACTS nor $DATAFILES exists."
  exit 0
fi

# Use Node directly so we share the exact same encryption envelope OSCAR
# uses at runtime. This avoids any "two implementations drift" risk.
exec node -e "
const fs = require('fs');
const path = require('path');
const at = require('/app/src/utils/at-rest');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const targets = [...walk('$ARTIFACTS'), ...walk('$DATAFILES')];
let encrypted = 0, skipped = 0, errors = 0;

for (const f of targets) {
  try {
    const content = fs.readFileSync(f);
    if (at.isEncryptedBuffer(content)) { skipped++; continue; }
    at.encryptToFile(content, f);
    encrypted++;
    process.stdout.write('.');
  } catch (err) {
    errors++;
    process.stderr.write(\`\\n[!] \${f}: \${err.message}\\n\`);
  }
}
process.stdout.write('\\n');
console.log(\`Backfill complete — encrypted: \${encrypted}, already encrypted: \${skipped}, errors: \${errors}\`);
process.exit(errors > 0 ? 1 : 0);
"
