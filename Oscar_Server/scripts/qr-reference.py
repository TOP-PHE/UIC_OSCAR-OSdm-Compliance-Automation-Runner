# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0

"""Reference matrices for the QR code encoder's test (#1414).

Reads tests/helpers/qr-reference.json, encodes each case with segno (another
encoder, https://pypi.org/project/segno/) at level M in byte mode with each
of the eight masks, and writes back the version and a short hash of each
matrix. Not run by CI: rerun it only when the cases
change, with segno on the Python path, for example

    PYTHONPATH=<folder holding segno> python scripts/qr-reference.py

The text of a case is `text`, or `length` characters made by case_text(),
which tests/unit/qr-code.test.js makes the same way.
"""

import hashlib
import json
import pathlib

import segno
import segno.encoder
from segno import consts


def padding_bits_per_standard(buff, version, length):
    """segno 1.6.6 adds eight 0 bits when the data stream already ends on a
    codeword boundary (its `8 - (length % 8)` is 8 then); ISO/IEC 18004
    7.4.10, which its own comment quotes, adds none. Readers stop at the
    character count either way, but the pad codewords then start one byte
    later. In byte mode the stream always ends on a boundary after the
    terminator, so every code with pad codewords would differ."""
    if version not in (consts.VERSION_M1, consts.VERSION_M3):
        buff.extend([0] * ((8 - (length % 8)) % 8))


segno.encoder.write_padding_bits = padding_bits_per_standard

FIXTURE = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'helpers' / 'qr-reference.json'


def case_text(length, seed):
    return ''.join(chr(33 + ((i * 7 + i // 5 + seed * 13) % 94)) for i in range(length))


def matrix_hash(qr):
    rows = [''.join('1' if module else '0' for module in row) for row in qr.matrix_iter(border=0)]
    return hashlib.sha256('\n'.join(rows).encode('ascii')).hexdigest()[:16]


def reference(case):
    text = case['text'] if 'text' in case else case_text(case['length'], case['seed'])
    data = text.encode('utf-8')
    codes = [segno.make_qr(data, error='m', mode='byte', boost_error=False, mask=mask) for mask in range(8)]
    assert len({qr.version for qr in codes}) == 1
    return {'version': codes[0].version, 'masks': [matrix_hash(qr) for qr in codes]}


def main():
    fixture = json.loads(FIXTURE.read_text(encoding='utf-8'))
    fixture['generator'] = 'segno ' + segno.__version__ + ', padding bits per ISO/IEC 18004 7.4.10'
    for case in fixture['cases']:
        case.update(reference(case))
    FIXTURE.write_text(json.dumps(fixture, indent=1, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
