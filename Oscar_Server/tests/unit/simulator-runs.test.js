// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #930 PR 4: the test sets OSCAR sent to the simulator, counted from OSCAR's runs.

const { providerOfBase, summarise } = require('../../src/utils/simulatorRuns');

const SIM = 'https://sim.example.org';

test('a run went to the simulator when its endpoint is under the simulator address; the provider is the next segment', () => {
  expect(providerOfBase('https://sim.example.org/gamma', SIM)).toBe('gamma');
  expect(providerOfBase('https://SIM.example.org/gamma/', SIM)).toBe('gamma');
  expect(providerOfBase(' https://sim.example.org/zeta/v3 ', SIM)).toBe('zeta');
  expect(providerOfBase('https://sim.example.org/osdm/gamma', 'https://sim.example.org/osdm')).toBe('gamma');
  for (const base of ['https://sim.example.org.evil.net/gamma', 'http://sim.example.org/gamma', 'https://sim.example.org:8443/gamma',
    'https://sim.example.org/', 'https://sim.example.org/Gamma', 'not a url', null]) {
    expect([base, providerOfBase(base, SIM)]).toEqual([base, null]);
  }
  expect(providerOfBase('https://sim.example.org/osdmx/gamma', 'https://sim.example.org/osdm')).toBeNull();
  expect(providerOfBase('https://sim.example.org/gamma', null)).toBeNull();
});

test('sets, scenarios and failures per provider and user; other providers left out', () => {
  const rows = [
    { id: 'r1', api_base_used: `${SIM}/gamma`, batch_id: 'b1', email: 'b@x', failed_checks: 0 },
    { id: 'r2', api_base_used: `${SIM}/gamma`, batch_id: 'b1', email: 'b@x', failed_checks: 3 },
    { id: 'r3', api_base_used: `${SIM}/gamma`, batch_id: 'b2', email: 'b@x', failed_checks: 1 },
    { id: 'r4', api_base_used: `${SIM}/gamma`, batch_id: null, email: 'a@x', failed_checks: 0 },
    { id: 'r5', api_base_used: `${SIM}/alpha`, batch_id: 'b3', email: 'a@x', failed_checks: 2 },
    { id: 'r6', api_base_used: 'https://provider.example.com/osdm', batch_id: 'b4', email: 'a@x', failed_checks: 9 },
  ];
  expect(summarise(rows, SIM)).toEqual([
    { provider: 'alpha', totals: { sets: 1, scenarios: 1, scenariosPerSet: 1, scenariosFailed: 1, failedChecks: 2 },
      users: [{ email: 'a@x', sets: 1, scenarios: 1, scenariosPerSet: 1, scenariosFailed: 1, failedChecks: 2 }] },
    { provider: 'gamma', totals: { sets: 3, scenarios: 4, scenariosPerSet: 1.3, scenariosFailed: 2, failedChecks: 4 },
      users: [
        { email: 'a@x', sets: 1, scenarios: 1, scenariosPerSet: 1, scenariosFailed: 0, failedChecks: 0 },
        { email: 'b@x', sets: 2, scenarios: 3, scenariosPerSet: 1.5, scenariosFailed: 2, failedChecks: 4 },
      ] },
  ]);
  expect(summarise([], SIM)).toEqual([]);
});
