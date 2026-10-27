// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// Company names and the start of a file name they give (#1002): the server's
// rule (file-names.test.js) and the page's (ui-scripts.test.js) run over them.
const SAMPLES = [
  ['Provider A', 'Provider-A'],
  ['ČD Test', 'CD-Test'],
  ['  ÖBB / Nightjet  ', 'OBB-Nightjet'],
  ['Provider <P>', 'Provider-P'],
  ['a"\r\nb', 'a-b'],
  ['../../etc', 'etc'],
  ['日本', ''],
  ['', ''],
  [null, ''],
  [undefined, ''],
  [42, '42'],
];

module.exports = { SAMPLES };
