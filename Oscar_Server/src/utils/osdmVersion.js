// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * osdmVersion.js — the OSDM version a scenario runs with (#785). Pure.
 *
 * The run sends it in every `Content-Type` (`application/json;version=…`).
 * A version typed `3..0.5` in a Test Framework once went into every copied
 * scenario, and a whole batch failed at the provider. So:
 * - a version is digits, a dot, digits, and optionally a dot and digits;
 * - a scenario follows the Test Framework's version unless it names its own;
 * - a run whose version is not one is refused before anything is sent.
 */

const OSDM_VERSION = /^\d{1,2}\.\d{1,2}(?:\.\d{1,3})?$/;

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** True when `v` is a version: "3.8" or "3.8.0". */
function isOsdmVersion(v) {
  return OSDM_VERSION.test(text(v));
}

/** The version a scenario runs with: its own when it names one, else the framework's; '' when neither does. */
function scenarioVersion(scenario, frameworkVersion) {
  return text(scenario?.osdmVersion) || text(frameworkVersion);
}

/**
 * The run's copy of the data file: each scenario naming no version gets the
 * framework's, when that one is a version. Changes `datafile`; returns how
 * many scenarios got it.
 */
function withFrameworkVersion(datafile, frameworkVersion) {
  if (!isOsdmVersion(frameworkVersion) || !Array.isArray(datafile?.scenarios)) return 0;
  let count = 0;
  for (const sc of datafile.scenarios) {
    if (sc && typeof sc === 'object' && !text(sc.osdmVersion)) {
      sc.osdmVersion = text(frameworkVersion);
      count += 1;
    }
  }
  return count;
}

/** Why a run of `code` may not start because of its version, or null. */
function versionRefusal(datafile, code, frameworkVersion) {
  const scenario = Array.isArray(datafile?.scenarios)
    ? datafile.scenarios.find((s) => s && typeof s === 'object' && s.code === code) : null;
  if (!scenario) return null;
  const version = scenarioVersion(scenario, frameworkVersion);
  if (!version || isOsdmVersion(version)) return null;
  const where = text(scenario.osdmVersion) ? 'the scenario (Test Config, OSDM Version)' : 'the Test Framework (OSDM Version)';
  return `This run was not started. The OSDM version "${version.slice(0, 40)}" is not a version (digits and dots, such as 3.8 or 3.0.5), and every request would carry it. Correct it in ${where}, then run again.`;
}

module.exports = { OSDM_VERSION, isOsdmVersion, scenarioVersion, withFrameworkVersion, versionRefusal };
