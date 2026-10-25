'use strict';

/**
 * afterSales.js — the after-sales conditions of a part sold WITH_CONDITION
 * (#950).
 *
 * A semi-flexible part is refunded and exchanged for a quarter of its price
 * (`SEMI_FLEXIBLE_FEE_SHARE`, used by refunds.js and exchanges.js). Its offer
 * part says so in `afterSalesConditions`, its booked part in
 * `afterSaleConditions` (OSDM's two spellings), so a client can read the
 * conditions the flag promises. The fee holds at any time, so a condition
 * names no window. A part refundable YES or NO says nothing more: the flag is
 * the whole rule.
 */

const SEMI_FLEXIBLE_FEE_SHARE = 0.25;

const feeOf = (amount) => Math.round(amount * SEMI_FLEXIBLE_FEE_SHARE);

/**
 * The conditions of `part` (refundable / exchangeable flags, `price`), or
 * null when neither flag is WITH_CONDITION.
 */
function conditionsOf(part) {
  const price = part?.price;
  if (!price || typeof price.amount !== 'number') return null;
  const conditions = [['REFUND', part.refundable], ['EXCHANGE', part.exchangeable]]
    .filter(([, flag]) => flag === 'WITH_CONDITION')
    .map(([condition]) => ({
      condition,
      afterSaleFee: { amount: feeOf(price.amount), currency: price.currency, scale: price.scale ?? 2 },
    }));
  return conditions.length > 0 ? conditions : null;
}

/** `part` with its offer part's conditions, when it has some. */
function withOfferConditions(part) {
  const conditions = conditionsOf(part);
  return conditions ? { ...part, afterSalesConditions: conditions } : part;
}

/** `part` with its booked part's conditions, when it has some. */
function withBookedConditions(part) {
  const conditions = conditionsOf(part);
  return conditions ? { ...part, afterSaleConditions: conditions } : part;
}

module.exports = { SEMI_FLEXIBLE_FEE_SHARE, feeOf, conditionsOf, withOfferConditions, withBookedConditions };
