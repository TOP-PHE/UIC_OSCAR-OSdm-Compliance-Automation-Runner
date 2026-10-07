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
        structuredClone: 'readonly',
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
    // S11b — the browser code under public/ used to be unlinted (that is how the
    // S11 XSS sinks went unnoticed). Lint the .js files there with browser
    // globals and the real-bug rules, so a fixed sink cannot silently regress.
    // Style rules are left off: these files are not written to the src style and
    // enforcing it would be thousands of non-security warnings.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly', fetch: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', location: 'readonly', history: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', FormData: 'readonly', Headers: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly', navigator: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', crypto: 'readonly',
        CustomEvent: 'readonly', Event: 'readonly', FileReader: 'readonly', atob: 'readonly', btoa: 'readonly',
        module: 'writable', require: 'readonly', globalThis: 'readonly', structuredClone: 'readonly',
      },
      // Shared OSCAR browser globals that one public/ file defines and another
      // uses are declared per-file with a /* global … */ comment (the file that
      // DEFINES one must not also list it, or no-redeclare fires), so they are
      // not set here.
    },
    rules: {
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'warn',
      // Off for public/: handlers are invoked from inline-HTML onclick="fn()",
      // which ESLint cannot see, so no-unused-vars is mostly false positives
      // here. The real-bug rules above are the point (they catch an undefined
      // reference — e.g. a fixed XSS sink that lost its esc() call).
      'no-unused-vars': 'off',
    },
  },
  {
    // public/vendor/ is third-party bundled libraries (ES modules, minified) —
    // not ours to lint.
    ignores: ['node_modules/', 'data/', '.claude/', 'oscar_dev_docs/', 'public/vendor/'],
  },
];
