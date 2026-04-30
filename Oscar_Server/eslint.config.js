'use strict';

/**
 * ESLint flat config for OSCAR server.
 * Run: `npm run lint`
 * Auto-fix: `npm run lint:fix`
 */

module.exports = [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        global: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      // Catch real bugs
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-var': 'warn',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'smart'],
      // Style — non-blocking
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      'indent': ['off'],   // existing code uses mixed alignment; not enforcing
    },
  },
  {
    ignores: ['node_modules/', 'data/', 'public/', '.claude/', 'oscar_dev_docs/'],
  },
];
