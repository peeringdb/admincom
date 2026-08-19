'use strict';

// Integration tests for CP's IX-F merge apply loop (applyIxfMerges).
//
// Unlike cp-ixf-merge-gates.test.js, which unit tests the pure candidate and
// gate helpers, these drive the real write path end to end through the shim:
// pdbPost and fetchNetixlanRowById both go through window.fetch for
// same-origin requests, and the shim's fake fetch records every call's method
// and body. That recording is what makes the ordering assertions below
// possible -- notably "no DELETE was issued", which is the entire point of
// the read-back verification.
//
// The loop previously wrote from the refresh()-time snapshot and PUT only
// ipaddr4/ipaddr6, so a DELETE destroyed any speed/is_rs_peer/bfd_support/
// operational/notes value carried solely by the doomed row, and a row edited
// between render and Apply was merged on stale premises. It also never
// re-read the keeper before deleting the only other copy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js');
const ORIGIN = 'https://www.peeringdb.com';
const rowUrl = (id) => `${ORIGIN}/api/netixlan/${id}?depth=0`;
const writeUrl = (id) => `${ORIGIN}/api/netixlan/${id}`;

const KEEPER_ID = 100; // lower id -> keeper
const OTHER_ID = 200;
const V4 = '80.81.194.210';
const V6 = '2001:7f8:1::a500:64500:1';

/**
 * Builds a netixlan row with the fields the merge path cares about.
 * @param {number} id - Row id.
 * @param {object} overrides - Field overrides.
 * @returns {object} Netixlan row.
 */
function row(id, overrides = {}) {
  return {
    id,
    asn: 64500,
    ixlan_id: 42,
    ipaddr4: '',
    ipaddr6: '',
    speed: 10000,
    operational: true,
    is_rs_peer: false,
    bfd_support: false,
    notes: '',
    status: 'ok',
    net_id: 7,
    ...overrides,
  };
}

const v4Only = () => row(KEEPER_ID, { ipaddr4: V4 });
const v6Only = () => row(OTHER_ID, { ipaddr6: V6 });

/**
 * Loads CP against a fake API where each netixlan id resolves to a given row.
 * @param {object} opts - Rows to serve and optional per-id write responses.
 * @returns {object} Test hooks, recorded fetch calls, and an IX-F map.
 */
function loadMergeScenario({ keeper, other, keeperReadback }) {
  const fetchMap = {
    // The keeper is read twice: once to decide the merge, once after the PUT
    // to confirm it landed. Without keeperReadback the second read returns the
    // unchanged row, which is exactly the "PUT said 2xx but did not persist"
    // case the DELETE must refuse to follow.
    [rowUrl(KEEPER_ID)]: { __sequence: [{ data: [keeper] }, { data: [keeperReadback || keeper] }] },
    [rowUrl(OTHER_ID)]: { data: [other] },
    [writeUrl(KEEPER_ID)]: { data: [keeperReadback || keeper] },
    [writeUrl(OTHER_ID)]: { data: [other] },
  };
  const { hooks, fetchCalls } = loadScript(SCRIPT_PATH, {
    hooksKey: '__pdbCpTestHooks__',
    pathname: '/cp/peeringdb_server/networkixlan/',
    fetchMap,
  });
  const ixfMap = new Map([['64500', [{ v4: V4, v6: V6, v6Norm: V6.toLowerCase() }]]]);
  return { hooks, fetchCalls, ixfMap };
}

/**
 * Returns the single candidate findIxfMergeCandidates produces for a pair.
 * Built by the real finder rather than hand-rolled, so a fixture that stops
 * being a valid merge candidate fails loudly here instead of silently
 * exercising a shape the tool would never produce.
 * @param {object} hooks - Script test hooks.
 * @param {object} keeper - Keeper row.
 * @param {object} other - Doomed row.
 * @param {Map} ixfMap - IX-F pairs by ASN.
 * @returns {object} Merge candidate.
 */
function candidateFor(hooks, keeper, other, ixfMap) {
  const found = hooks.findIxfMergeCandidates([keeper, other], ixfMap);
  assert.equal(found.length, 1, 'fixture must produce exactly one merge candidate');
  return found[0];
}

test('summarizeIxfMergeEffects reports what the DELETE would destroy', async (t) => {
  const { hooks, ixfMap } = loadMergeScenario({ keeper: v4Only(), other: v6Only() });

  await t.test('a field only the doomed row carries is absorbed', () => {
    const keeper = v4Only();
    const other = row(OTHER_ID, { ipaddr6: V6, notes: 'LAG member' });
    const effects = hooks.summarizeIxfMergeEffects(candidateFor(hooks, keeper, other, ixfMap));
    assert.equal(effects.merge.notes, 'LAG member');
    // Length, not deepEqual: arrays crossing the vm realm boundary fail
    // deepStrictEqual on prototype identity.
    assert.equal(effects.mismatches.length, 0);
  });

  await t.test('a field both rows carry differently is a mismatch, not a merge', () => {
    const keeper = row(KEEPER_ID, { ipaddr4: V4, speed: 10000 });
    const other = row(OTHER_ID, { ipaddr6: V6, speed: 1000 });
    const effects = hooks.summarizeIxfMergeEffects(candidateFor(hooks, keeper, other, ixfMap));
    assert.equal('speed' in effects.merge, false, 'a disagreement must not be auto-absorbed');
    assert.equal(effects.mismatches.length, 1);
    assert.equal(effects.mismatches[0].field, 'speed');
    assert.equal(effects.mismatches[0].keeper, 10000);
    assert.equal(effects.mismatches[0].doomed, 1000);
  });

  await t.test('neither IP family is ever part of the plan', () => {
    // applyIxfMerges writes both addresses explicitly from the IX-F pair, so
    // a plan that also carried them could fight that explicit assignment.
    const effects = hooks.summarizeIxfMergeEffects(candidateFor(hooks, v4Only(), v6Only(), ixfMap));
    assert.equal('ipaddr4' in effects.merge, false);
    assert.equal('ipaddr6' in effects.merge, false);
  });

  await t.test('the mismatch key changes when the disagreement changes', () => {
    const a = hooks.summarizeIxfMergeEffects(candidateFor(
      hooks, row(KEEPER_ID, { ipaddr4: V4, speed: 10000 }), row(OTHER_ID, { ipaddr6: V6, speed: 1000 }), ixfMap,
    ));
    const b = hooks.summarizeIxfMergeEffects(candidateFor(
      hooks, row(KEEPER_ID, { ipaddr4: V4, speed: 10000 }), row(OTHER_ID, { ipaddr6: V6, speed: 2000 }), ixfMap,
    ));
    assert.notEqual(a.mismatchKey, b.mismatchKey, 'an acknowledgement must not carry across a changed value');
  });
});

test('applyIxfMerges absorbs fields the DELETE would otherwise destroy', async () => {
  const keeper = v4Only();
  const other = row(OTHER_ID, { ipaddr6: V6, notes: 'LAG member', is_rs_peer: true });
  // The keeper reads back with everything applied, so verification passes and
  // the loop is allowed to reach its DELETE.
  const keeperReadback = row(KEEPER_ID, {
    ipaddr4: V4, ipaddr6: V6, notes: 'LAG member', is_rs_peer: true,
  });
  const { hooks, fetchCalls, ixfMap } = loadMergeScenario({ keeper, other, keeperReadback });

  const outcomes = await hooks.applyIxfMerges(
    [{ ...candidateFor(hooks, keeper, other, ixfMap), acknowledgedMismatchKey: '' }],
    ixfMap,
    { cancelled: false },
    () => {},
  );

  assert.equal(outcomes.length, 1);
  const put = fetchCalls.find((c) => c.method === 'PUT' && c.url === writeUrl(KEEPER_ID));
  assert.ok(put, 'the keeper must be PUT');
  const body = JSON.parse(put.body);
  assert.equal(body.ipaddr4, V4);
  assert.equal(body.ipaddr6, V6);
  assert.equal(body.notes, 'LAG member', 'notes carried only by the doomed row must be absorbed');
  assert.equal(body.is_rs_peer, true, 'is_rs_peer carried only by the doomed row must be absorbed');
  assert.equal(outcomes[0].absorbed.notes, 'LAG member', 'the audit log must record what was absorbed');
});

test('applyIxfMerges refuses a candidate whose mismatch was never acknowledged', async () => {
  const keeper = row(KEEPER_ID, { ipaddr4: V4, speed: 10000 });
  const other = row(OTHER_ID, { ipaddr6: V6, speed: 1000 });
  const { hooks, fetchCalls, ixfMap } = loadMergeScenario({ keeper, other });

  const outcomes = await hooks.applyIxfMerges(
    [{ ...candidateFor(hooks, keeper, other, ixfMap), acknowledgedMismatchKey: '' }],
    ixfMap,
    { cancelled: false },
    () => {},
  );

  assert.equal(outcomes[0].status, 'aborted');
  assert.equal(outcomes[0].gateFailed, 'mismatch-ack');
  assert.match(outcomes[0].error, /unacknowledged-mismatch:speed/);
  assert.equal(fetchCalls.some((c) => c.method === 'DELETE'), false, 'nothing may be deleted');
  assert.equal(fetchCalls.some((c) => c.method === 'PUT'), false, 'nothing may be written');
});

test('an acknowledgement for a different disagreement does not carry over', async () => {
  const keeper = row(KEEPER_ID, { ipaddr4: V4, speed: 10000 });
  const other = row(OTHER_ID, { ipaddr6: V6, speed: 1000 });
  const { hooks, fetchCalls, ixfMap } = loadMergeScenario({ keeper, other });

  const outcomes = await hooks.applyIxfMerges(
    // Correctly shaped, but for a doomed value the live rows no longer carry.
    [{ ...candidateFor(hooks, keeper, other, ixfMap), acknowledgedMismatchKey: 'speed=10000|2000' }],
    ixfMap,
    { cancelled: false },
    () => {},
  );

  assert.equal(outcomes[0].status, 'aborted');
  assert.equal(outcomes[0].gateFailed, 'mismatch-ack');
  assert.equal(fetchCalls.some((c) => c.method === 'DELETE'), false);
});

test('an acknowledgement matching the live disagreement lets the merge run', async () => {
  // The other half of the gate: it must not be unconditionally closed, or the
  // three assertions above would pass against a tool that never merges.
  const keeper = row(KEEPER_ID, { ipaddr4: V4, speed: 10000 });
  const other = row(OTHER_ID, { ipaddr6: V6, speed: 1000 });
  const keeperReadback = row(KEEPER_ID, { ipaddr4: V4, ipaddr6: V6, speed: 10000 });
  const { hooks, fetchCalls, ixfMap } = loadMergeScenario({ keeper, other, keeperReadback });

  const candidate = candidateFor(hooks, keeper, other, ixfMap);
  const { mismatchKey } = hooks.summarizeIxfMergeEffects(candidate);
  const outcomes = await hooks.applyIxfMerges(
    [{ ...candidate, acknowledgedMismatchKey: mismatchKey }],
    ixfMap,
    { cancelled: false },
    () => {},
  );

  assert.equal(outcomes[0].status, 'done');
  assert.equal(outcomes[0].acknowledgedMismatches.length, 1);
  assert.equal(outcomes[0].acknowledgedMismatches[0], 'speed');
  assert.ok(
    fetchCalls.some((c) => c.method === 'DELETE' && c.url === writeUrl(OTHER_ID)),
    'an acknowledged merge must still complete',
  );
  const put = fetchCalls.find((c) => c.method === 'PUT' && c.url === writeUrl(KEEPER_ID));
  assert.equal(JSON.parse(put.body).speed, 10000, 'the keeper value stands on a disagreement');
});

test('applyIxfMerges aborts when the live rows no longer merge', async () => {
  // The table was rendered from a clean v4-only/v6-only split, but by apply
  // time the sibling has grown a v4 and the pair is no longer that shape.
  const rendered = loadMergeScenario({ keeper: v4Only(), other: v6Only() });
  const candidate = candidateFor(rendered.hooks, v4Only(), v6Only(), rendered.ixfMap);

  const live = loadMergeScenario({
    keeper: v4Only(),
    other: row(OTHER_ID, { ipaddr4: '80.81.194.211', ipaddr6: V6 }),
  });
  const outcomes = await live.hooks.applyIxfMerges(
    [{ ...candidate, acknowledgedMismatchKey: '' }],
    live.ixfMap,
    { cancelled: false },
    () => {},
  );

  assert.equal(outcomes[0].status, 'aborted');
  assert.equal(outcomes[0].gateFailed, 'live-recheck');
  assert.equal(live.fetchCalls.some((c) => c.method === 'DELETE'), false, 'a stale premise must not delete');
});

test('applyIxfMerges never DELETEs when the keeper read-back disagrees', async () => {
  const keeper = v4Only();
  const other = row(OTHER_ID, { ipaddr6: V6, notes: 'LAG member' });
  // No keeperReadback override: the keeper still reads back v4-only, i.e. the
  // PUT reported success but did not persist. The doomed row is therefore
  // still the only carrier of ipaddr6 and notes.
  const { hooks, fetchCalls, ixfMap } = loadMergeScenario({ keeper, other });

  const outcomes = await hooks.applyIxfMerges(
    [{ ...candidateFor(hooks, keeper, other, ixfMap), acknowledgedMismatchKey: '' }],
    ixfMap,
    { cancelled: false },
    () => {},
  );

  assert.equal(outcomes[0].status, 'keeper-verify-failed');
  assert.match(outcomes[0].error, /^mismatch:/);
  assert.equal(fetchCalls.some((c) => c.method === 'DELETE'), false, 'the last carrier must survive');
});

test('applyIxfMerges aborts rather than guessing when the IX-F map is unavailable', async () => {
  const keeper = v4Only();
  const other = v6Only();
  const { hooks, fetchCalls, ixfMap } = loadMergeScenario({ keeper, other });

  const outcomes = await hooks.applyIxfMerges(
    [{ ...candidateFor(hooks, keeper, other, ixfMap), acknowledgedMismatchKey: '' }],
    null,
    { cancelled: false },
    () => {},
  );

  assert.equal(outcomes[0].status, 'aborted');
  assert.equal(outcomes[0].error, 'ixf-map-unavailable');
  assert.equal(fetchCalls.some((c) => c.method === 'DELETE'), false);
});
