/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * clockTolerance.js — how far a provider's clock may be ahead of OSCAR's
 * (#644, #1334).
 *
 * A time the provider says is "now" (a createdOn) is compared with the run's
 * own clock. The two machines' clocks differ by a few milliseconds at least,
 * and a fresh answer may come back faster than that: a createdOn "in the
 * future" by less than CLOCK_TOLERANCE_MS is not a fault. Every check of the
 * form "at or before now" adds it.
 */

const CLOCK_TOLERANCE_MS = 120000;

module.exports = { CLOCK_TOLERANCE_MS };
