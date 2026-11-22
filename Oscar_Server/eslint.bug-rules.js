'use strict';

/**
 * The rules ESLint applies to code that is not held to the server's style:
 * the tests, the scripts and the Bruno collection's library. Each one names
 * something that is wrong whatever the layout: a name that does not exist, a
 * variable nothing reads, code that cannot run, a comparison that is always
 * the same. No rule here is about how the code looks.
 */
module.exports = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-unreachable': 'error',
  'no-unreachable-loop': 'error',
  'no-const-assign': 'error',
  'no-class-assign': 'error',
  'no-func-assign': 'error',
  'no-ex-assign': 'error',
  'no-global-assign': 'error',
  'no-import-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-redeclare': 'error',
  'no-shadow-restricted-names': 'error',
  'no-cond-assign': 'error',
  'no-constant-binary-expression': 'error',
  'no-compare-neg-zero': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-async-promise-executor': 'error',
  'no-setter-return': 'error',
  'getter-return': 'error',
  'for-direction': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-obj-calls': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-this-before-super': 'error',
  'constructor-super': 'error',
  'no-sparse-arrays': 'error',
  'no-empty-pattern': 'error',
  'no-fallthrough': 'error',
  'no-loss-of-precision': 'error',
  'no-invalid-regexp': 'error',
  'no-empty-character-class': 'error',
  'no-useless-backreference': 'error',
  'no-misleading-character-class': 'error',
  'no-irregular-whitespace': 'error',
  'no-unused-labels': 'error',
  'no-delete-var': 'error',
  'no-octal': 'error',
  'no-with': 'error',
};
