'use strict';

/**
 * ESLint flat config for the OSDM simulator.
 *
 * The simulator has no dependency of its own, so it is linted with the ESLint
 * that Oscar_Server installs:
 *
 *   node ../Oscar_Server/node_modules/eslint/bin/eslint.js .
 *
 * The rules are the ones of Oscar_Server/eslint.config.js for server code.
 */

module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-var': 'warn',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    },
  },
];
