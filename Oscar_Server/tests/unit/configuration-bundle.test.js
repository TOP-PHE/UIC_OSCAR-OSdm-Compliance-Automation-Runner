// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #810: the rules of a full configuration file (utils/configurationBundle.js).

const {
  CONFIGURATION_KEY, MAX_DEPTH, MAX_RESOURCES,
  buildConfiguration, isConfiguration, readConfiguration, readChoices, planTestData, canonical, deeperThan,
} = require('../../src/utils/configurationBundle');

const marker = { [CONFIGURATION_KEY]: { format: 1 } };
const train = (id, n, extra = {}) => ({ id, resource_type: 'TRAIN', label: `T${n}`, data: { services: [{ vehicleNumber: String(n) }], originURN: 'a', ...extra } });
const journey = (id, legs) => ({ id, resource_type: 'JOURNEY', label: `J${id}`, data: { legs: legs.map(t => ({ trainResourceId: t, serviceIndex: 0 })) } });
const ids = () => { let n = 0; return () => `new-${++n}`; };

describe('buildConfiguration', () => {
  test('keeps TRAIN and JOURNEY entries with the fields the import reads, and marks the file', () => {
    const b = buildConfiguration({
      datafile: { scenarios: [] }, framework: { osdmVersion: '3.8' }, company: 'acme', exportedBy: 'tm@x', exportedAt: 'now',
      resources: [
        { ...train(1, 1), created_at: 'x', company_id: 'secret' },
        journey(2, [1]),
        { id: 3, resource_type: 'MULTIMODAL', label: 'M', data: {} },
        { id: 4, resource_type: 'TRAIN', label: 'bad data', data: 'text' },
      ],
    });
    expect(b[CONFIGURATION_KEY]).toMatchObject({ format: 1, company: 'acme', exported_by: 'tm@x', exported_at: 'now' });
    expect(b.testResources.map(r => Object.keys(r).sort((a, b) => a.localeCompare(b)))).toEqual(Array(3).fill(['data', 'id', 'label', 'resource_type']));
    expect(b.testResources[2].data).toEqual({});
    expect(isConfiguration(b)).toBe(true);
    expect(readConfiguration(b).configuration.testResources).toHaveLength(3);
  });

  test('a part that is not an object is null', () => {
    const b = buildConfiguration({ datafile: [], framework: null, resources: null });
    expect(b.datafile).toBeNull();
    expect(b.framework).toBeNull();
    expect(b.testResources).toEqual([]);
  });
});

describe('readConfiguration refuses', () => {
  const refusal = v => readConfiguration(v).refusal;
  test.each([
    ['a data file', { scenarios: [] }, /not a full OSCAR configuration/],
    ['a newer format', { [CONFIGURATION_KEY]: { format: 2 } }, /newer OSCAR \(format 2\)/],
    ['no format', { [CONFIGURATION_KEY]: true }, /no format/],
    ['a list as datafile', { ...marker, datafile: [] }, /"datafile" must be an object/],
    ['a list as framework', { ...marker, framework: [] }, /"framework" must be an object/],
    ['resources not a list', { ...marker, testResources: {} }, /must be a list/],
    ['an unknown type', { ...marker, testResources: [{ ...train(1, 1), resource_type: 'BUS' }] }, /entry 1: "resource_type"/],
    ['an id twice', { ...marker, testResources: [train(1, 1), train('1', 2)] }, /entry 2: the id "1" is used twice/],
    ['an object id', { ...marker, testResources: [{ ...train(1, 1), id: {} }] }, /"id" must be/],
    ['an empty label', { ...marker, testResources: [{ ...train(1, 1), label: '  ' }] }, /"label" is required/],
    ['a long label', { ...marker, testResources: [{ ...train(1, 1), label: 'x'.repeat(201) }] }, /longer than 200/],
    ['data not an object', { ...marker, testResources: [{ ...train(1, 1), data: [] }] }, /"data" must be an object/],
    ['an entry not an object', { ...marker, testResources: [null] }, /not an object/],
  ])('%s', (_, value, re) => expect(refusal(value)).toMatch(re));

  test('more entries than allowed', () => {
    const many = Array.from({ length: MAX_RESOURCES + 1 }, (_, i) => train(i, i));
    expect(refusal({ ...marker, testResources: many })).toMatch(/more than 5000/);
  });

  test('a value nested deeper than the limit, without recursing', () => {
    let deep = {};
    const root = deep;
    for (let i = 0; i < 200000; i++) { deep.a = {}; deep = deep.a; }
    expect(refusal({ ...marker, datafile: root })).toMatch(/nested more than 64/);
  });

  test('a configuration with every part absent reads as three empty parts', () => {
    expect(readConfiguration(marker).configuration).toEqual({ datafile: null, framework: null, testResources: [] });
  });
});

test('deeperThan counts levels of objects and lists alike', () => {
  const nest = n => { let v = 1; for (let i = 0; i < n; i++) v = i % 2 ? { a: v } : [v]; return v; };
  expect(deeperThan(nest(MAX_DEPTH), MAX_DEPTH)).toBe(false);
  expect(deeperThan(nest(MAX_DEPTH + 1), MAX_DEPTH)).toBe(true);
});

describe('readChoices', () => {
  const full = { datafile: {}, framework: {}, testResources: [] };
  test('every choice must be named', () => {
    expect(readChoices({ scenarios: 'replace', framework: 'keep' }, full).refusal).toMatch(/"testData"/);
    expect(readChoices({ scenarios: 'all', framework: 'keep', testData: 'add' }, full).refusal).toMatch(/"scenarios"/);
    expect(readChoices({ scenarios: 'keep', framework: 'yes', testData: 'add' }, full).refusal).toMatch(/"framework"/);
    expect(readChoices(null, full).refusal).toMatch(/"scenarios"/);
  });
  test('a part the file does not have cannot replace the stored one', () => {
    expect(readChoices({ scenarios: 'replace', framework: 'keep', testData: 'keep' }, { ...full, datafile: null }).refusal).toMatch(/no data file/);
    expect(readChoices({ scenarios: 'keep', framework: 'replace', testData: 'keep' }, { ...full, framework: null }).refusal).toMatch(/no Test Framework/);
  });
  test('keeping everything is refused; anything else is taken as given', () => {
    expect(readChoices({ scenarios: 'keep', framework: 'keep', testData: 'keep' }, full).refusal).toMatch(/Nothing to import/);
    expect(readChoices({ scenarios: 'keep', framework: 'keep', testData: 'replace', extra: 1 }, full).choices)
      .toEqual({ scenarios: 'keep', framework: 'keep', testData: 'replace' });
  });
});

describe('planTestData', () => {
  test('keep plans nothing', () => {
    expect(planTestData([train('x', 1)], [train(1, 2)], 'keep', ids())).toMatchObject({ deleteIds: [], create: [] });
  });

  test('add: a train already held (in any key order) is not added, and journeys name the held one', () => {
    const held = { id: 'held', resource_type: 'TRAIN', label: 'mine', data: { originURN: 'a', services: [{ vehicleNumber: '1' }] } };
    const plan = planTestData([held], [train(1, 1), train(2, 2), journey(3, [1, 2])], 'add', ids());
    expect(plan.deleteIds).toEqual([]);
    expect(plan.alreadyThere).toBe(1);
    expect(plan.create.map(r => [r.id, r.label])).toEqual([['new-1', 'T2'], ['new-2', 'J3']]);
    expect(plan.create[1].data.legs.map(l => l.trainResourceId)).toEqual(['held', 'new-1']);
    expect(plan).toMatchObject({ trainsAdded: 1, journeysAdded: 1, unresolvedLegs: 0 });
  });

  test('add: a journey already held after remapping is not added again', () => {
    const first = planTestData([], [train(1, 1), journey(2, [1])], 'add', ids());
    const target = first.create;
    const second = planTestData(target, [train(1, 1), journey(2, [1])], 'add', ids());
    expect(second.create).toEqual([]);
    expect(second.alreadyThere).toBe(2);
  });

  test('a leg naming a train that is nowhere is kept as it is and counted; one naming a kept train is not', () => {
    const kept = train('kept', 9);
    const plan = planTestData([kept], [journey(5, ['gone', 'kept'])], 'add', ids());
    expect(plan.create[0].data.legs.map(l => l.trainResourceId)).toEqual(['gone', 'kept']);
    expect(plan.unresolvedLegs).toBe(1);
    // Under replace the kept train goes, so its leg cannot be resolved either.
    expect(planTestData([kept], [journey(5, ['kept'])], 'replace', ids()).unresolvedLegs).toBe(1);
  });

  test('replace: removes the target\'s trains and journeys only, adds everything with new ids', () => {
    const target = [train('t', 1), journey('j', ['t']), { id: 'm', resource_type: 'MULTIMODAL', label: 'M', data: {} }];
    const plan = planTestData(target, [train(1, 1), journey(2, [1])], 'replace', ids());
    expect(plan.deleteIds).toEqual(['t', 'j']);
    expect(plan.create.map(r => r.id)).toEqual(['new-1', 'new-2']);
    expect(plan.create[1].data.legs[0].trainResourceId).toBe('new-1');
    expect(plan.alreadyThere).toBe(0);
  });

  test('ids are compared as text, and the same train twice in the file is added once', () => {
    const plan = planTestData([], [train(7, 1), { ...train(8, 1), label: 'copy' }, journey(9, ['7', 8])], 'add', ids());
    expect(plan.trainsAdded).toBe(1);
    expect(plan.create[1].data.legs.map(l => l.trainResourceId)).toEqual(['new-1', 'new-1']);
  });

  test('legs without a train, and journeys without legs, are left alone', () => {
    const plan = planTestData([], [{ id: 1, resource_type: 'JOURNEY', label: 'J', data: { legs: [{ trainResourceId: '' }, null] } },
      { id: 2, resource_type: 'JOURNEY', label: 'K', data: { note: 1 } }], 'add', ids());
    expect(plan.create.map(r => r.data)).toEqual([{ legs: [{ trainResourceId: '' }, null] }, { note: 1 }]);
    expect(plan.unresolvedLegs).toBe(0);
  });
});

test('canonical ignores key order only', () => {
  expect(canonical({ b: [1, { d: 1, c: 2 }], a: null })).toBe(canonical({ a: null, b: [1, { c: 2, d: 1 }] }));
  expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  expect(canonical({ a: undefined })).toBe('{"a":null}');
});
