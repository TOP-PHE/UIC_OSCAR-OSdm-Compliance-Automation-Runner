/**
 * afterSalesRules.js — schedule-aware effective refundability (#391).
 *
 * The OBB exchange on the 18-offer NJ catalog showed why the refundable /
 * exchangeable FLAG cannot be read alone: admissions were pinned to NO while
 * the afterSalesConditions said three different things —
 *   Sparschiene   one window, fee = 100% of price → a refund returns 0:
 *                 the flag is CONSISTENT (the schedule documents WHY it's NO);
 *   Komfort       fee = 50% until the eve of travel → effectively refundable
 *                 under conditions: the flag SHOULD be WITH_CONDITION;
 *   Normalpreis   fee = 0 until the eve of travel → freely refundable before
 *                 travel: the flag SHOULD be WITH_CONDITION.
 *
 * Rule (RefundType × afterSalesConditions consistency): a part is effectively
 * refundable iff SOME declared window charges a fee BELOW the part's price.
 * Mere presence of conditions proves nothing — their CONTENT decides.
 *
 * Pure module: no Bruno globals, fully unit-testable.
 */

/**
 * Analyse one offer/booking part's ${action} permissibility by reading the
 * flag THROUGH its after-sales schedule.
 *
 * @param {object} part   offer part (price, refundable/exchangeable,
 *                        afterSalesConditions)
 * @param {number} atMs   instant for the active-window lookup (epoch ms)
 * @param {string} action 'REFUND' (default) or 'EXCHANGE'
 * @returns {{
 *   effective: 'WITH_CONDITION'|'NO'|'FLAG',  // FLAG = no decodable schedule, the flag rules
 *   flag: any, flagLabel: string,
 *   schedule: boolean,            // a decodable schedule was found (fees + price comparable)
 *   windows: number, refundableWindows: number, freeWindow: boolean,
 *   activeFee: number|null,       // fee of the window covering atMs (null: none / ambiguous)
 *   activeAmbiguous: boolean,     // overlapping active windows with different fees
 *   priceAmount: number|null, currency: string|null, scale: number|null,
 *   contradiction: 'FLAG_NO_SCHEDULE_REFUNDABLE'|'FLAG_YES_ZERO_WINDOW'|'FLAG_WC_NO_SCHEDULE'|null
 * }}
 */
function effectiveRefundability(part, atMs, action) {
  action = action || 'REFUND';
  const flag = part ? (action === 'EXCHANGE' ? part.exchangeable : part.refundable) : undefined;
  const out = {
    effective: 'FLAG',
    flag: flag,
    flagLabel: flag == null ? '(absent)' : String(flag),
    schedule: false,
    windows: 0,
    refundableWindows: 0,
    freeWindow: false,
    activeFee: null,
    activeAmbiguous: false,
    priceAmount: null,
    currency: null,
    scale: null,
    contradiction: null,
  };
  if (!part || typeof part !== 'object') return out;

  const conds = (Array.isArray(part.afterSalesConditions) ? part.afterSalesConditions : [])
    .filter((c) => c && c.condition === action);
  out.windows = conds.length;
  if (conds.length === 0) {
    // WITH_CONDITION promises conditions the client cannot read.
    if (flag === 'WITH_CONDITION') out.contradiction = 'FLAG_WC_NO_SCHEDULE';
    return out;
  }

  // Decodability: fee-vs-price needs a positive price, numeric fees, and one
  // currency/scale across all compared amounts. A 0-price part (typical OBB
  // reservation) carries no value to refund — the flag rules there.
  const price = part.price;
  const priceOk = !!(price && typeof price.amount === 'number' && price.amount > 0);
  const feesOk = conds.every((c) => c.afterSaleFee && typeof c.afterSaleFee.amount === 'number');
  const currencies = [...new Set(conds.map((c) => c.afterSaleFee && c.afterSaleFee.currency)
    .concat(priceOk ? [price.currency] : []).filter(Boolean))];
  const scales = [...new Set(conds.map((c) => c.afterSaleFee && c.afterSaleFee.scale)
    .concat(priceOk ? [price.scale] : []).filter((v) => v != null))];
  if (!priceOk || !feesOk || currencies.length > 1 || scales.length > 1) return out;

  out.schedule = true;
  out.priceAmount = price.amount;
  out.currency = currencies[0] || null;
  out.scale = scales[0] != null ? scales[0] : null;

  const at = typeof atMs === 'number' ? atMs : Date.now();
  const activeFees = [];
  conds.forEach((c) => {
    const fee = c.afterSaleFee.amount;
    if (fee < price.amount) out.refundableWindows++;
    if (fee === 0) out.freeWindow = true;
    const fromOk = !c.validFrom || new Date(c.validFrom).getTime() <= at;
    const untilOk = !c.validUntil || at <= new Date(c.validUntil).getTime();
    if (fromOk && untilOk) activeFees.push(fee);
  });
  const distinctActive = [...new Set(activeFees)];
  if (distinctActive.length === 1) out.activeFee = distinctActive[0];
  else if (distinctActive.length > 1) out.activeAmbiguous = true;

  out.effective = out.refundableWindows > 0 ? 'WITH_CONDITION' : 'NO';
  if (flag === 'NO' && out.refundableWindows > 0) {
    out.contradiction = 'FLAG_NO_SCHEDULE_REFUNDABLE';
  } else if (flag === 'YES' && (out.refundableWindows < out.windows || !out.freeWindow)) {
    out.contradiction = 'FLAG_YES_ZERO_WINDOW';
  }
  return out;
}

/**
 * What the declared schedules say a FULL refund at `atMs` must return:
 * Σ over value-bearing parts of (price − active-window fee). A part whose
 * schedule has NO active window contributes 0 (no refund right now per its
 * own declaration). Only meaningful when every value-bearing part has a
 * decodable schedule, unambiguous active fees and one currency.
 *
 * @returns {{ ok: boolean, expectedRefundable: number, expectedFee: number,
 *            currency: string|null, detail: string[], reason: string|null }}
 */
function expectedRefundForParts(parts, atMs, action) {
  const res = { ok: true, expectedRefundable: 0, expectedFee: 0, currency: null, detail: [], reason: null };
  const list = (Array.isArray(parts) ? parts : [])
    .filter((p) => p && p.price && typeof p.price.amount === 'number' && p.price.amount > 0);
  if (list.length === 0) {
    res.ok = false;
    res.reason = 'no value-bearing parts';
    return res;
  }
  for (const p of list) {
    const a = effectiveRefundability(p, atMs, action);
    if (!a.schedule) {
      res.ok = false;
      res.reason = `a value-bearing part has no decodable ${action || 'REFUND'} schedule`;
      return res;
    }
    if (a.activeAmbiguous) {
      res.ok = false;
      res.reason = 'overlapping active windows with different fees';
      return res;
    }
    if (res.currency && a.currency && res.currency !== a.currency) {
      res.ok = false;
      res.reason = 'mixed currencies across parts';
      return res;
    }
    res.currency = res.currency || a.currency;
    const back = a.activeFee == null ? 0 : Math.max(0, a.priceAmount - a.activeFee);
    res.expectedRefundable += back;
    res.expectedFee += a.activeFee == null ? a.priceAmount : Math.min(a.activeFee, a.priceAmount);
    res.detail.push(`${a.priceAmount} − ${a.activeFee == null ? 'no active window' : 'fee ' + a.activeFee} → ${back}`);
  }
  return res;
}

module.exports = {
  effectiveRefundability,
  expectedRefundForParts,
};

// Expose to global for convenience in eval/require loader flows (matches the
// other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
