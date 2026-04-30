'use strict';

/**
 * contextExtractors.test.js — Unit tests for per-endpoint request-context extraction
 *
 * Covers extractRequestContext with all URL dispatch patterns and edge cases.
 */

const { extractRequestContext } = require('../../src/reports/contextExtractors');

// Helper to build a minimal Bruno result entry
function makeEntry(url, bodyData) {
  return {
    request: {
      url,
      data: bodyData,
    },
  };
}

// ── Refund context ─────────────────────────────────────────────────────────────

describe('extractRequestContext — /refund-offers', () => {
  test('voluntary refund (no overruleCode) → mode: voluntary', () => {
    const entry = makeEntry('https://api.example.com/refund-offers', {});
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.mode).toBe('voluntary');
    expect(ctx.overruleCode).toBeNull();
  });

  test('reason-code refund (overruleCode present) → mode: reason-code', () => {
    const entry = makeEntry('https://api.example.com/refund-offers', {
      overruleCode: 'MEDICAL',
    });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.mode).toBe('reason-code');
    expect(ctx.overruleCode).toBe('MEDICAL');
  });

  test('reasonCode field is also detected', () => {
    const entry = makeEntry('https://api.example.com/refund-offers', {
      reasonCode: 'FORCE_MAJEURE',
    });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.mode).toBe('reason-code');
    expect(ctx.overruleCode).toBe('FORCE_MAJEURE');
  });

  test('URL with query string is matched', () => {
    const entry = makeEntry('https://api.example.com/refund-offers?bookingId=abc', {});
    const result = extractRequestContext(entry);
    expect(result).not.toBeNull();
  });

  test('URL with trailing slash is matched', () => {
    const entry = makeEntry('https://api.example.com/refund-offers/', {});
    const result = extractRequestContext(entry);
    expect(result).not.toBeNull();
  });

  test('no body → null', () => {
    const entry = { request: { url: 'https://api.example.com/refund-offers' } };
    const result = extractRequestContext(entry);
    expect(result).toBeNull();
  });

  test('body as JSON string is parsed', () => {
    const entry = makeEntry(
      'https://api.example.com/refund-offers',
      JSON.stringify({ overruleCode: 'PARSED' })
    );
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.overruleCode).toBe('PARSED');
  });
});

// ── Exchange context ───────────────────────────────────────────────────────────

describe('extractRequestContext — /exchange-offers', () => {
  test('voluntary exchange (no overruleCode) → mode: voluntary', () => {
    const entry = makeEntry('https://api.example.com/exchange-offers', {});
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.mode).toBe('voluntary');
    expect(ctx.overruleCode).toBeNull();
  });

  test('reason-code exchange → mode: reason-code', () => {
    const entry = makeEntry('https://api.example.com/exchange-offers', {
      overruleCode: 'DISRUPTION',
    });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.mode).toBe('reason-code');
  });
});

// ── Offer context ──────────────────────────────────────────────────────────────

describe('extractRequestContext — /offers', () => {
  test('flexibility in tripSearchCriteria', () => {
    const entry = makeEntry('https://api.example.com/offers', {
      tripSearchCriteria: { flexibility: 'FULL_FLEX' },
    });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.flexibility).toBe('FULL_FLEX');
  });

  test('desiredFlexibility also captured', () => {
    const entry = makeEntry('https://api.example.com/offers', {
      tripSearchCriteria: { desiredFlexibility: 'SEMI_FLEX' },
    });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.flexibility).toBe('SEMI_FLEX');
  });

  test('anonymousPassengerSpecifications count', () => {
    const entry = makeEntry('https://api.example.com/offers', {
      tripSearchCriteria: {
        anonymousPassengerSpecifications: [{ type: 'ADULT' }, { type: 'CHILD' }],
      },
    });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.paxCount).toBe(2);
  });

  test('passengerSpecifications at root body', () => {
    const entry = makeEntry('https://api.example.com/offers', {
      passengerSpecifications: [{ type: 'ADULT' }],
    });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.paxCount).toBe(1);
  });

  test('no useful fields → null', () => {
    const entry = makeEntry('https://api.example.com/offers', {});
    const result = extractRequestContext(entry);
    expect(result).toBeNull();
  });

  test('/refund-offers is matched before /offers (first-match wins)', () => {
    // /refund-offers should NOT fall through to offer extractor
    const entry = makeEntry('https://api.example.com/refund-offers', { overruleCode: 'X' });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.mode).toBeDefined();  // refund context, not offer context
    expect(ctx.flexibility).toBeUndefined();
  });

  test('URL with /offers/ subpath is matched', () => {
    const entry = makeEntry('https://api.example.com/offers/search', {
      tripSearchCriteria: { flexibility: 'FULL' },
    });
    const result = extractRequestContext(entry);
    expect(result).not.toBeNull();
  });
});

// ── Booking context ────────────────────────────────────────────────────────────

describe('extractRequestContext — /bookings', () => {
  test('passengers array count and currency', () => {
    const entry = makeEntry('https://api.example.com/bookings', {
      passengers: [{ id: 'p1' }, { id: 'p2' }],
      currency: 'EUR',
    });
    const ctx = JSON.parse(extractRequestContext(entry));
    expect(ctx.paxCount).toBe(2);
    expect(ctx.currency).toBe('EUR');
  });

  test('no passengers → null (empty context)', () => {
    const entry = makeEntry('https://api.example.com/bookings', {});
    const result = extractRequestContext(entry);
    expect(result).toBeNull();
  });

  test('/bookings with "refund" in path does not match booking extractor', () => {
    // Regex: /\/bookings(\/|$|\?)(?!.*refund|.*exchange)/i
    const entry = makeEntry('https://api.example.com/bookings/123/refund-offers', {
      passengers: [{ id: 'p1' }],
    });
    // The booking pattern won't match because "refund" follows /bookings/...
    // The refund-offers pattern will match instead
    const result = extractRequestContext(entry);
    // Result could be from refund extractor (no body overruleCode → null) or null
    // Either way, it should not return booking context
    if (result) {
      const ctx = JSON.parse(result);
      expect(ctx.paxCount).toBeUndefined();
    }
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────────

describe('extractRequestContext — edge cases', () => {
  test('null entry → null', () => {
    expect(extractRequestContext(null)).toBeNull();
  });

  test('no URL on entry → null', () => {
    expect(extractRequestContext({})).toBeNull();
  });

  test('unrecognized URL → null', () => {
    const entry = makeEntry('https://api.example.com/system-infos', {});
    expect(extractRequestContext(entry)).toBeNull();
  });

  test('invalid JSON string body → null (refund context)', () => {
    const entry = makeEntry('https://api.example.com/refund-offers', 'not-valid-json{');
    // parseBody returns null → refundContext returns null → extractRequestContext returns null
    expect(extractRequestContext(entry)).toBeNull();
  });

  test('body is null → null (refund context)', () => {
    const entry = makeEntry('https://api.example.com/refund-offers', null);
    expect(extractRequestContext(entry)).toBeNull();
  });
});
