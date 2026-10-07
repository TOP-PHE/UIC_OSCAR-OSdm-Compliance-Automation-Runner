// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafileTemplates.js — datafile text the test engine would fill in
 * (audit tracker NEW-10, v1.11.209).
 *
 * Bruno fills in a double-brace template wherever a value is used, and the
 * template that names the run's access token gives that token. Two things in
 * the collection make the whole datafile such a value, not only the scenario
 * being run:
 *
 *   - before every run it stores the WHOLE datafile as one variable and reads
 *     it back for the schema check; Bruno fills in every template in it, in
 *     every scenario, and the schema check prints the value of a field that is
 *     not on its list of allowed values;
 *   - it then copies the scenario being run, and the entries it uses, into the
 *     variables that requests are built from.
 *
 * So text a tester typed into one of their own scenarios showed the token of
 * whoever ran ANY scenario of the company, in that run's log or in its HTTP
 * traffic, both of which every member of the company can read. Checked with
 * Bruno CLI 4.2.1.
 *
 * Bruno has no way to write two opening braces literally, and no datafile
 * needs them. They are refused:
 *
 *   - A save may not ADD them (templatesAddedBy). Only text that is not
 *     already stored counts, so text stored earlier, by anyone, never blocks a
 *     save of something else.
 *   - A run is not started while the datafile HOLDS them (templatesInDatafile,
 *     templatesForRunner), wherever they are and whoever wrote them. This is
 *     the rule that protects the person running, and the one that covers text
 *     stored before today.
 *
 * Both are needed. Bruno fetches the datafile itself, after the runner has
 * looked at it, so the run rule alone could be raced by a save; the save rule
 * alone would leave text stored before it existed.
 *
 * Left alone, on purpose: the two root keys only a Test Manager can write
 * (systemInfoParameters, knownDeviations) and the company's dedicated headers,
 * where a template is the documented way to reference a variable. A Test
 * Manager already decides where every token of the company is sent.
 *
 * Everything here is pure. Nothing here recurses, compares every place with
 * every other, or builds a text for each place found beyond the few it names:
 * the size and the depth of what a client sends are not ours to choose.
 */

const { viewForTester } = require('./datafileOwnership');

const OPEN = '{'.repeat(2);
const SEP = String.fromCodePoint(0);            // between a place and a text, in a map key
const TEST_MANAGER_ROOT_KEYS = Object.freeze(['systemInfoParameters', 'knownDeviations']);
const MAX_SHOWN = 3;            // places named in a message
const MAX_KEPT = 20;            // places kept once found; more are only counted
const SAME_PLACE_LIMIT = 5000;  // stored templates up to which "the same place" is looked at
const STOP_AFTER = 1000;       // found this many: stop looking, the answer is the same
const MAX_NAME = 60;            // characters of a name shown

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const shown = name => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME)}…` : name);

const holds = v => typeof v === 'string' && v.includes(OPEN);
const walkable = v => v !== null && typeof v === 'object';
const NOTHING = Object.freeze([]);
const ITSELF = '(the value itself)';

// A list or an object being walked: its path, its keys (none for a list) and
// how far along it we are.
function opened(v, at) {
  const keys = Array.isArray(v) ? null : Object.keys(v);
  return { v, at, keys, i: 0, n: (keys || v).length };
}

// The path of the child at `i` of a level.
function pathIn(level, i) {
  if (level.keys === null) return `${level.at}[${i}]`;
  const name = shown(level.keys[i]);
  return level.at ? `${level.at}.${name}` : name;
}

// Looks at the next child of the level on top of the stack. Goes into it when
// it is a list or an object, and returns the [path, text] pairs it gives by
// itself: its name, its text. A child with nothing to say costs no path.
function lookAtNext(stack) {
  const level = stack.at(-1);
  if (level.i >= level.n) { stack.pop(); return NOTHING; }
  const i = level.i++;
  const key = level.keys === null ? null : level.keys[i];
  const child = level.keys === null ? level.v[i] : level.v[key];
  const named = holds(key);
  const text = holds(child);
  const deeper = walkable(child);
  if (!named && !text && !deeper) return NOTHING;
  const here = pathIn(level, i);
  if (deeper) stack.push(opened(child, here));
  if (!named && !text) return NOTHING;
  const pairs = [];
  if (named) pairs.push([`${here} (the name of the field)`, key]);
  if (text) pairs.push([here || ITSELF, child]);
  return pairs;
}

/**
 * Every string, and every name of a field, inside `value` that holds two
 * opening braces, one [path, text] pair at a time; the path reads like
 * `passengers[0].firstName`. Walks with its own stack, one child at a time:
 * a caller who stops early has paid for what it read, not for the whole
 * value, and one who only counts keeps nothing.
 */
function* templateTexts(value) {
  if (holds(value)) yield [ITSELF, value];
  const stack = walkable(value) ? [opened(value, '')] : [];
  while (stack.length > 0) {
    const pairs = lookAtNext(stack);
    if (pairs !== NOTHING) yield* pairs;
  }
}

/** The paths alone. */
function templatePaths(value) {
  return Array.from(templateTexts(value), ([at]) => at);
}

/**
 * The parts of a datafile this rule looks at, each with the words that say
 * where it is: every scenario, every entry of every list at the root, and
 * every other root key, except the two a Test Manager alone can write.
 */
function* parts(datafile) {
  if (!isObj(datafile)) return;
  for (const key of Object.keys(datafile)) {
    if (TEST_MANAGER_ROOT_KEYS.includes(key)) continue;
    const value = datafile[key];
    if (key.includes(OPEN)) yield [`${shown(key)} (the name of a root key)`, key];
    if (key === 'scenarios' && Array.isArray(value)) {
      for (const sc of value) {
        yield [isObj(sc) && typeof sc.code === 'string' ? `scenario "${shown(sc.code)}"` : 'a scenario with no code', sc];
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) yield [`${shown(key)}, entry ${i + 1}`, value[i]];
    } else {
      yield [shown(key), value];
    }
  }
}

// Every template in the looked-at parts, one [what, at, text] at a time.
function* occurrences(datafile) {
  for (const [what, value] of parts(datafile)) {
    for (const [at, text] of templateTexts(value)) yield [what, at, text];
  }
}

// What the functions below hand back: the first places found, as texts, with
// `total`, the number found. Places past MAX_KEPT are counted only, and at
// STOP_AFTER the looking stops: `capped` then says the number is a floor.
function collector() {
  const kept = [];
  kept.total = 0;
  kept.elsewhere = false;
  kept.capped = false;
  return {
    kept,
    // Returns true when enough have been found and the caller should stop.
    add(what, at) {
      kept.total++;
      if (kept.length < MAX_KEPT) kept.push(`${what}: ${at}`);
      kept.capped = kept.total >= STOP_AFTER;
      return kept.capped;
    },
  };
}

/** The places where the datafile holds two opening braces, with every scenario named. */
function templatesInDatafile(datafile) {
  const found = collector();
  for (const [what, at] of occurrences(datafile)) {
    if (found.add(what, at)) break;
  }
  return found.kept;
}

/**
 * The same, for the person whose run it is. A Test Manager sees the whole
 * file, so every place is named. A tester is told the places in what they can
 * see in Test Config (utils/datafileOwnership viewForTester); for the rest,
 * only that there is something, in `elsewhere` — no code, no field, no number
 * of anything that belongs to someone else.
 */
function templatesForRunner(datafile, { testManager, email } = {}) {
  if (testManager === true) return templatesInDatafile(datafile);
  const visible = templatesInDatafile(viewForTester(datafile, email, null));
  // Is there one more in the whole file than in what they see? Counting stops
  // as soon as that is known.
  let all = 0;
  const every = occurrences(datafile);
  while (all <= visible.total && !every.next().done) all++;
  visible.elsewhere = !visible.capped && all > visible.total;
  return visible;
}

const placeKey = (text, what, at) => text + SEP + what + SEP + at;

// What `stored` holds. Per text: how many are stored, and room for what the
// sent file will show (`hits` still in place, `others` not, the first of those
// `kept`). Per text and place: how many are stored there, unless there are too
// many for "the same place" to be worth looking at.
function storedTemplates(stored) {
  const perText = new Map();
  let samePlace = new Map();
  let count = 0;
  for (const [what, at, text] of occurrences(stored)) {
    const e = perText.get(text) || { stored: 0, hits: 0, others: 0, kept: [] };
    e.stored++;
    perText.set(text, e);
    count++;
    if (count > SAME_PLACE_LIMIT) samePlace = null;
    if (samePlace) {
      const key = placeKey(text, what, at);
      samePlace.set(key, (samePlace.get(key) || 0) + 1);
    }
  }
  return { perText, samePlace };
}

// Is this copy where a stored one was? If so that stored one is used up: one
// stored place vouches for one copy there, not for two.
function stillInPlace(samePlace, e, text, what, at) {
  if (samePlace === null || e.hits >= e.stored) return false;
  const key = placeKey(text, what, at);
  const n = samePlace.get(key) || 0;
  if (n === 0) return false;
  samePlace.set(key, n - 1);
  e.hits++;
  return true;
}

// The copies of one text beyond the stored ones: new. Of the copies that are
// not where a stored one was, the first `free` are stored ones that moved.
function addExtra(added, e) {
  const free = e.stored - e.hits;
  const extra = e.others - free;
  if (extra <= 0) return;
  const named = e.kept.slice(free);
  for (const [what, at] of named) added.add(what, at);
  added.kept.total += extra - named.length;           // the rest are counted, not named
  added.kept.capped = added.kept.total >= STOP_AFTER;
}

/**
 * The places where `toStore` holds a template that `stored` does not. A
 * template counts as stored when the same text is there at the same place, or
 * failing that anywhere (the file may have been reordered); one more copy of a
 * stored one is new. Everything else about the file is ignored, so the fields
 * the editor fills in on its own never make old text look new.
 *
 * The work is bounded by what is stored, not by what is sent: a text with no
 * stored copy is new at once, for a text that is stored only as many places
 * are kept as could matter, and the looking stops once STOP_AFTER are known
 * to be new. Past SAME_PLACE_LIMIT stored templates the look at "the same
 * place" is given up, and texts alone are counted.
 */
function templatesAddedBy(stored, toStore) {
  const added = collector();
  const { perText, samePlace } = storedTemplates(stored);
  for (const [what, at, text] of occurrences(toStore)) {
    const e = perText.get(text);
    if (!e) {                                           // no stored copy of this text at all
      if (added.add(what, at)) return added.kept;
    } else if (!stillInPlace(samePlace, e, text, what, at)) {
      e.others++;
      if (e.kept.length < e.stored + MAX_KEPT) e.kept.push([what, at]);
      if (e.others - e.stored >= STOP_AFTER) break;     // at least that many are new: enough
    }
  }
  for (const e of perText.values()) addExtra(added, e);
  return added.kept;
}

// How many places a result stands for; a plain list of places counts as itself.
const totalOf = found => (typeof found.total === 'number' ? found.total : found.length);

// The places for a sentence: up to three, then how many more.
function listed(found) {
  const first = found.slice(0, MAX_SHOWN).join('; ');
  const more = totalOf(found) - Math.min(found.length, MAX_SHOWN);
  if (found.capped === true) return `${first}; and many more`;
  return more > 0 ? `${first}; and ${more} more` : first;
}

const WHY = `The test engine would replace "${OPEN}…" with the value of a variable`;

/** The sentence for a refused save, or null. */
function saveRefusal(found) {
  if (totalOf(found) === 0) return null;
  return `This text contains "${OPEN}" and cannot be saved. ${WHY}. Remove it in: ${listed(found)}.`;
}

/** The sentence for a run that is not started, or null. */
function runRefusal(found) {
  const mine = totalOf(found);
  if (mine === 0 && found.elsewhere !== true) return null;
  let where = '';
  if (mine > 0) where += ` Where: ${listed(found)}.`;
  if (found.elsewhere === true) {
    where += ` ${mine > 0 ? 'It is also' : 'It is'} in a part of the data file that you cannot see: ask your Test Manager, whose own run says where.`;
  }
  return `This run was not started: the data file holds text that contains "${OPEN}". ${WHY}, in every run of the company. `
    + `It has to be removed in Test Config first.${where}`;
}

module.exports = { templatePaths, templatesInDatafile, templatesForRunner, templatesAddedBy, saveRefusal, runRefusal, TEST_MANAGER_ROOT_KEYS };
