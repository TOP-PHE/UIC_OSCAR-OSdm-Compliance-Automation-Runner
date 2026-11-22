'use strict';

/**
 * ESLint flat config for the Bruno collection's library
 * (Bruno_Collection/library-bruno), read from the repository root:
 *
 *   npm run lint:library        (from Oscar_Server/)
 *
 * It lives here, not in Bruno_Collection/: the collection is what a run
 * loads and what a collection release versions, and a lint file is neither.
 * With `-c`, ESLint's base folder is the one it is started from, which is why
 * the script starts it from the repository root.
 *
 * Bug rules only (eslint.bug-rules.js), no style: the library was written
 * over two years in several hands, and the point is what breaks a run (a name
 * that does not exist, a variable nothing reads, a branch that cannot be
 * reached), not its layout.
 */

const BUG_RULES = require('./eslint.bug-rules');

const readonly = names => Object.fromEntries(names.map(name => [name, 'readonly']));

// Node, as Bruno's developer sandbox gives it, and Bruno's own objects.
const SANDBOX = readonly([
  'require', 'process', 'console', 'globalThis', 'Buffer', '__dirname', '__filename',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'atob', 'btoa',
  'bru', 'req', 'res', 'test', 'expect',
]);

/**
 * Names a library module uses without requiring them. Each module ends with
 * `Object.assign(globalThis, module.exports)`, and six modules reach what
 * another one exports through the global object: a reader cannot follow such
 * a call to its definition, and two modules that export one name overwrite
 * each other without a word.
 *
 * This list is what exists today, so that the rule can be turned on. **It may
 * only get shorter**: a module that needs another one requires it, and its
 * names leave the list (lint-config.test.js holds the count).
 */
const SHARED_THROUGH_GLOBAL = [
  // model.js classes, used by scenarioParser.js
  'AlightSpecification', 'AnonymousPassengerSpec', 'BoardSpecification', 'CarrierFilter', 'Contact',
  'DatedJourney', 'Detail', 'DetailContact', 'FulfillmentOption', 'NamedCompany', 'PassengerSpec',
  'ProductCategory', 'Purchaser', 'PurchaserContact', 'ServiceTime', 'StopPlaceRef', 'TRIP',
  'TimedLegSpecification', 'TripDataFilter', 'TripLegDefinition', 'TripLegSpecification', 'TripParameters',
  'TripSearchCriteria', 'TripSpecification', 'VehicleFilter',
  // functions and values
  'GV', 'buildOfferCollectionRequest', 'checkWarningsAndProblems', 'validateAppliedOverruleCode',
  'validateDataFileJsonWithTemplate', 'validateFulfillments', 'validateRefundFee', 'validateRefundableAmount',
  'validationLogger',
];

module.exports = [
  {
    files: ['Bruno_Collection/library-bruno/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...SANDBOX, ...readonly(SHARED_THROUGH_GLOBAL), module: 'writable', exports: 'writable' },
    },
    rules: BUG_RULES,
  },
];

module.exports.SHARED_THROUGH_GLOBAL = SHARED_THROUGH_GLOBAL;
