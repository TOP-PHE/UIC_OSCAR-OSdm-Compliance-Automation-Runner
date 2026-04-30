'use strict';

/**
 * validate.js — Express middleware that runs an array of express-validator
 * validation chains and short-circuits to 400 when any fails. Centralises
 * the otherwise-repeated `if (!result.isEmpty()) return res.status(400)`
 * boilerplate at every endpoint.
 *
 * Usage:
 *   const { v, validate } = require('../middleware/validate');
 *   router.post('/login',
 *     validate([
 *       v.body('email').isEmail().normalizeEmail(),
 *       v.body('password').isString().isLength({ min: 1, max: 200 }),
 *     ]),
 *     (req, res) => { ... });
 *
 * Why this exists: the codebase already does manual checks (whitelisted
 * filenames in runner.js, length checks in some auth endpoints). This
 * standardises the pattern, surfaces field names + reasons in a structured
 * 400 response, and prevents the "next field added without a check" drift.
 */

const { body, param, query, header, validationResult } = require('express-validator');

function validate(chains) {
  // Allow callers to pass either an array of chains or a single chain.
  const list = Array.isArray(chains) ? chains : [chains];
  return async (req, res, next) => {
    // Run all chains in parallel for slight speed-up — express-validator
    // chains are independent, no shared mutable state across them.
    await Promise.all(list.map(c => c.run(req)));
    const result = validationResult(req);
    if (result.isEmpty()) return next();
    // Compact error shape: which field, what was wrong, what the user sent
    // (echoing back the value helps the UI but is harmless for us — no
    // secrets pass through this middleware on success paths, and on failure
    // the 400 stops processing before any sensitive lookup happens).
    return res.status(400).json({
      status: 400,
      title: 'Validation failed',
      detail: 'One or more fields are invalid.',
      errors: result.array().map(e => ({
        field: e.path || e.param,
        location: e.location,
        message: e.msg
      }))
    });
  };
}

// Re-export the chain builders so callers only need to import this module.
const v = { body, param, query, header };

module.exports = { validate, v };
