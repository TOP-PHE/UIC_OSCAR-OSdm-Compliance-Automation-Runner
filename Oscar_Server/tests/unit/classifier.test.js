// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * classifier.test.js — Unit tests for the assertion classification engine
 *
 * Covers all seven exported functions:
 *   classifyCategory, classifyDomain, classifyOfferPart,
 *   classifySeverity, isParameterized, extractExpected, extractActual
 */

const {
  classifyCategory,
  classifyDomain,
  classifyOfferPart,
  classifySeverity,
  isParameterized,
  extractExpected,
  extractActual,
} = require('../../src/reports/classifier');

// ── classifyCategory ──────────────────────────────────────────────────────────

describe('classifyCategory', () => {
  describe('environment_check', () => {
    test('"API base is available" → environment_check', () => {
      expect(classifyCategory('API base is available')).toBe('environment_check');
    });
    test('"Library base is available" → environment_check', () => {
      expect(classifyCategory('Library base is available')).toBe('environment_check');
    });
    test('"data file is available" → environment_check', () => {
      expect(classifyCategory('data file is available')).toBe('environment_check');
    });
    test('"trip search criteria has at least one leg" → environment_check', () => {
      expect(classifyCategory('trip search criteria has at least one leg')).toBe('environment_check');
    });
  });

  describe('http_status', () => {
    test('"Status code is 200" → http_status', () => {
      expect(classifyCategory('Status code is 200')).toBe('http_status');
    });
    test('"→ 404" → http_status', () => {
      expect(classifyCategory('→ 404')).toBe('http_status');
    });
    test('"-> 201" → http_status', () => {
      expect(classifyCategory('-> 201')).toBe('http_status');
    });
    test('"→ unexpected status" → http_status', () => {
      expect(classifyCategory('→ unexpected status')).toBe('http_status');
    });
    test('"server error" → http_status', () => {
      expect(classifyCategory('server error')).toBe('http_status');
    });
    test('"unauthorized" → http_status', () => {
      expect(classifyCategory('unauthorized')).toBe('http_status');
    });
    test('"forbidden" → http_status', () => {
      expect(classifyCategory('forbidden')).toBe('http_status');
    });
    test('"not found" → http_status', () => {
      expect(classifyCategory('not found')).toBe('http_status');
    });
  });

  describe('content_type', () => {
    test('"response content-type is application/json" → content_type', () => {
      expect(classifyCategory('response content-type is application/json')).toBe('content_type');
    });
  });

  describe('script_error', () => {
    test('"post-response script error" → script_error', () => {
      expect(classifyCategory('post-response script error')).toBe('script_error');
    });
    test('"pre-request script error" → script_error', () => {
      expect(classifyCategory('pre-request script error')).toBe('script_error');
    });
  });

  describe('prerequisite', () => {
    test('"prerequisite: offerId must be set" → prerequisite', () => {
      expect(classifyCategory('prerequisite: offerId must be set')).toBe('prerequisite');
    });
  });

  describe('data_consistency', () => {
    test('"matches between offer and booking" → data_consistency', () => {
      expect(classifyCategory('matches between offer and booking')).toBe('data_consistency');
    });
    test('"matches offer currency" → data_consistency', () => {
      expect(classifyCategory('matches offer currency')).toBe('data_consistency');
    });
    test('"currency consistency across offer parts" → data_consistency', () => {
      expect(classifyCategory('currency consistency across offer parts')).toBe('data_consistency');
    });
    test('"matches confirmedprice" → data_consistency', () => {
      expect(classifyCategory('matches confirmedprice')).toBe('data_consistency');
    });
    test('"in both offer and booking" → data_consistency', () => {
      expect(classifyCategory('in both offer and booking')).toBe('data_consistency');
    });
  });

  describe('response_structure', () => {
    test('"array exists" → response_structure', () => {
      expect(classifyCategory('array exists')).toBe('response_structure');
    });
    test('"object exists" → response_structure', () => {
      expect(classifyCategory('object exists')).toBe('response_structure');
    });
    test('"response body is present" → response_structure', () => {
      expect(classifyCategory('response body is present')).toBe('response_structure');
    });
    test('"is a non-empty string" → response_structure', () => {
      expect(classifyCategory('is a non-empty string')).toBe('response_structure');
    });
    test('"is present" → response_structure', () => {
      expect(classifyCategory('offerId is present')).toBe('response_structure');
    });
    test('"is defined" → response_structure', () => {
      expect(classifyCategory('field is defined')).toBe('response_structure');
    });
  });

  describe('field_validation', () => {
    test('"is a valid iso date" → field_validation', () => {
      expect(classifyCategory('is a valid iso date')).toBe('field_validation');
    });
    test('"is a valid date" → field_validation', () => {
      expect(classifyCategory('is a valid date')).toBe('field_validation');
    });
    test('"is a boolean" → field_validation', () => {
      expect(classifyCategory('is a boolean')).toBe('field_validation');
    });
    test('"is a valid future date" → field_validation', () => {
      expect(classifyCategory('is a valid future date')).toBe('field_validation');
    });
    test('"valid datetime" → field_validation', () => {
      expect(classifyCategory('valid datetime')).toBe('field_validation');
    });
    test('"temporal order is correct" → field_validation', () => {
      expect(classifyCategory('temporal order is correct')).toBe('field_validation');
    });
  });

  describe('parameter_probe', () => {
    test('"baseline request" → parameter_probe', () => {
      expect(classifyCategory('baseline request')).toBe('parameter_probe');
    });
    test('"offer baseline" → parameter_probe', () => {
      expect(classifyCategory('offer baseline')).toBe('parameter_probe');
    });
    test('"param probe for paxCount" → parameter_probe', () => {
      expect(classifyCategory('param probe for paxCount')).toBe('parameter_probe');
    });
  });

  describe('scenario_config', () => {
    test('"scenario: full booking flow" → scenario_config', () => {
      expect(classifyCategory('scenario: full booking flow')).toBe('scenario_config');
    });
    test('"version used is 3.1" → scenario_config', () => {
      expect(classifyCategory('version used is 3.1')).toBe('scenario_config');
    });
    test('"version consistency" → scenario_config', () => {
      expect(classifyCategory('version consistency')).toBe('scenario_config');
    });
  });

  describe('business_logic (default)', () => {
    test('unmatched name → business_logic', () => {
      expect(classifyCategory('some custom assertion about pricing rules')).toBe('business_logic');
    });
  });
});

// ── classifyDomain ────────────────────────────────────────────────────────────

describe('classifyDomain', () => {
  test('"api base is set" → infrastructure', () => {
    expect(classifyDomain('api base is set', '')).toBe('infrastructure');
  });
  test('"library base is available" → infrastructure', () => {
    expect(classifyDomain('library base is available', '')).toBe('infrastructure');
  });
  test('"content-type is json" → infrastructure', () => {
    expect(classifyDomain('content-type is json', '')).toBe('infrastructure');
  });
  test('"data file exists" → infrastructure', () => {
    expect(classifyDomain('data file exists', '')).toBe('infrastructure');
  });

  test('suite "03-Refund" → refund', () => {
    expect(classifyDomain('status code is 200', '03-Refund')).toBe('refund');
  });
  test('name with standalone "refund" word → refund', () => {
    expect(classifyDomain('refund amount is correct', '')).toBe('refund');
  });
  test('"refundable" in name does NOT map to refund', () => {
    // "refundable" should not match \brefund\b
    expect(classifyDomain('offer is refundable', '')).not.toBe('refund');
  });

  test('suite "04-Exchange" → exchange', () => {
    expect(classifyDomain('status code is 200', '04-Exchange')).toBe('exchange');
  });
  test('"exchange" word in name → exchange', () => {
    expect(classifyDomain('exchange is valid', '')).toBe('exchange');
  });
  test('"exchangeable" does NOT map to exchange', () => {
    expect(classifyDomain('offer is exchangeable', '')).not.toBe('exchange');
  });

  test('"fulfillment exists" → fulfillment', () => {
    expect(classifyDomain('fulfillment exists', '')).toBe('fulfillment');
  });

  test('"passenger first name is set" → passenger', () => {
    expect(classifyDomain('passenger first name is set', '')).toBe('passenger');
  });
  test('"first name is correct" → passenger', () => {
    expect(classifyDomain('first name is correct', '')).toBe('passenger');
  });

  test('"booking contains offer" → booking', () => {
    expect(classifyDomain('booking contains offer', '')).toBe('booking');
  });
  test('"bookedOffer is present" → booking', () => {
    expect(classifyDomain('bookedOffer is present', '')).toBe('booking');
  });

  test('"offer array exists" → offer', () => {
    expect(classifyDomain('offer array exists', '')).toBe('offer');
  });
  test('"admission part has fare" → offer', () => {
    expect(classifyDomain('admission part has fare', '')).toBe('offer');
  });
  test('"reservation is present" → offer', () => {
    expect(classifyDomain('reservation is present', '')).toBe('offer');
  });

  test('suite containing "system infos" → system', () => {
    expect(classifyDomain('GET system version', 'system infos')).toBe('system');
  });
  test('"scenario" in name → system', () => {
    expect(classifyDomain('scenario is set', '')).toBe('system');
  });

  test('default → offer', () => {
    expect(classifyDomain('some unrelated assertion', '')).toBe('offer');
  });
});

// ── classifyOfferPart ─────────────────────────────────────────────────────────

describe('classifyOfferPart', () => {
  test('"admission part" → admission', () => {
    expect(classifyOfferPart('admission part exists')).toBe('admission');
  });
  test('"reservation part" → reservation', () => {
    expect(classifyOfferPart('reservation part exists')).toBe('reservation');
  });
  test('"ancillary offer" → ancillary', () => {
    expect(classifyOfferPart('ancillary offer exists')).toBe('ancillary');
  });
  test('"booking fee is present" → fee (not refund)', () => {
    expect(classifyOfferPart('booking fee is present')).toBe('fee');
  });
  test('"refund fee" → NOT fee (contains refund)', () => {
    expect(classifyOfferPart('refund fee is present')).not.toBe('fee');
  });
  test('"exchange fee" → NOT fee (contains exchange)', () => {
    expect(classifyOfferPart('exchange fee is present')).not.toBe('fee');
  });
  test('"fare is valid" → fare', () => {
    expect(classifyOfferPart('fare is valid')).toBe('fare');
  });
  test('unrelated assertion → null', () => {
    expect(classifyOfferPart('status code is 200')).toBeNull();
  });
});

// ── classifySeverity ──────────────────────────────────────────────────────────

describe('classifySeverity', () => {
  test('passed assertion is always "info"', () => {
    expect(classifySeverity('status code is 500', 'http_status', true)).toBe('info');
    expect(classifySeverity('post-response script error', 'script_error', true)).toBe('info');
  });

  test('script_error failed → critical', () => {
    expect(classifySeverity('post-response script error', 'script_error', false)).toBe('critical');
  });
  test('prerequisite failed → critical', () => {
    expect(classifySeverity('prerequisite check', 'prerequisite', false)).toBe('critical');
  });
  test('401 in name failed → critical', () => {
    expect(classifySeverity('→ 401', 'http_status', false)).toBe('critical');
  });
  test('"unauthorized" in name failed → critical', () => {
    expect(classifySeverity('unauthorized access', 'http_status', false)).toBe('critical');
  });
  test('"forbidden" in name failed → critical (matches auth regex)', () => {
    // "forbidden" matches the /401|unauthorized|forbidden|.../ critical regex
    expect(classifySeverity('forbidden response', 'http_status', false)).toBe('critical');
  });
  test('500 in name failed → critical', () => {
    expect(classifySeverity('→ 500 server error', 'http_status', false)).toBe('critical');
  });
  test('"token.*error" pattern → critical', () => {
    expect(classifySeverity('token fetch error', 'business_logic', false)).toBe('critical');
  });

  test('http_status failed → major', () => {
    expect(classifySeverity('status code is 200', 'http_status', false)).toBe('major');
  });
  test('business_logic failed → major', () => {
    expect(classifySeverity('price matches offer', 'business_logic', false)).toBe('major');
  });
  test('data_consistency failed → major', () => {
    expect(classifySeverity('currency consistency', 'data_consistency', false)).toBe('major');
  });
  test('field_validation failed → major', () => {
    expect(classifySeverity('is a valid iso date', 'field_validation', false)).toBe('major');
  });

  test('response_structure failed → minor', () => {
    expect(classifySeverity('array exists', 'response_structure', false)).toBe('minor');
  });
  test('content_type failed → minor', () => {
    expect(classifySeverity('content-type is json', 'content_type', false)).toBe('minor');
  });

  test('environment_check failed → info', () => {
    expect(classifySeverity('api base is available', 'environment_check', false)).toBe('info');
  });
  test('scenario_config failed → info', () => {
    expect(classifySeverity('scenario version', 'scenario_config', false)).toBe('info');
  });

  test('unknown category failed → major (default)', () => {
    expect(classifySeverity('something else', 'unknown_category', false)).toBe('major');
  });
});

// ── isParameterized ───────────────────────────────────────────────────────────

describe('isParameterized', () => {
  test('UUID in name → true', () => {
    expect(isParameterized('offerId: 123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });
  test('"expected: X, actual:" pattern → true', () => {
    expect(isParameterized('expected: EUR, actual: GBP')).toBe(true);
  });
  test('HTTP URL in name → true', () => {
    expect(isParameterized('https://api.example.com/offers/123')).toBe(true);
  });
  test('ISO 8601 datetime → true', () => {
    expect(isParameterized('validFrom: 2024-01-15T10:00:00Z')).toBe(true);
  });
  test('"amount: 42" → true', () => {
    expect(isParameterized('amount: 42 EUR')).toBe(true);
  });
  test('"count: 5" → true', () => {
    expect(isParameterized('count: 5 offers')).toBe(true);
  });
  test('"length: 3" → true', () => {
    expect(isParameterized('length: 3 items')).toBe(true);
  });
  test('plain assertion name → false', () => {
    expect(isParameterized('offer array exists')).toBe(false);
  });
  test('empty string → false', () => {
    expect(isParameterized('')).toBe(false);
  });
});

// ── extractExpected ───────────────────────────────────────────────────────────

describe('extractExpected', () => {
  test('"expected: EUR, actual: GBP" → "EUR"', () => {
    expect(extractExpected('expected: EUR, actual: GBP')).toBe('EUR');
  });
  test('"→ 404" → "404"', () => {
    expect(extractExpected('response → 404')).toBe('404');
  });
  test('"Status code is 201" → "201"', () => {
    expect(extractExpected('Status code is 201')).toBe('201');
  });
  test('"-> 500" → "500"', () => {
    expect(extractExpected('-> 500 server error')).toBe('500');
  });
  test('no match → null', () => {
    expect(extractExpected('offer array exists')).toBeNull();
  });
  test('empty string → null', () => {
    expect(extractExpected('')).toBeNull();
  });
  test('"expected: true)" trims trailing parenthesis', () => {
    expect(extractExpected('assertion (expected: true)')).toBe('true');
  });
});

// ── extractActual ─────────────────────────────────────────────────────────────

describe('extractActual', () => {
  test('"expected: EUR, actual: GBP" → "GBP"', () => {
    expect(extractActual('expected: EUR, actual: GBP')).toBe('GBP');
  });
  test('no "actual:" → null', () => {
    expect(extractActual('expected: EUR')).toBeNull();
  });
  test('empty string → null', () => {
    expect(extractActual('')).toBeNull();
  });
  test('"actual: 3 items)" trims parenthesis', () => {
    expect(extractActual('expected: 2, actual: 3')).toBe('3');
  });
});
