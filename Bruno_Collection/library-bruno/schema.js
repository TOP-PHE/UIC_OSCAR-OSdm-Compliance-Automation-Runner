/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * schema.js — `schemaData` placeholder for the OSDM offer schema.
 *
 * Currently an empty stub (OSDM_OFFER_SCHEMA: "") exposed on module + globalThis,
 * kept for compatibility with code that references `schemaData`. Live schema
 * validation is in validators.js / osdmSchema(s).js.
 */
const schemaData = {
  OSDM_OFFER_SCHEMA: ""
};

module.exports = { schemaData };

// Also expose globally for convenience (optional)
try {
  Object.assign(globalThis, { schemaData });
} catch (e) {
  // no-op
}
