'use strict';

// Tests for the IX-F Member Audit merge-detection logic and the IXLAN
// Conflict Resolver's 8-gate safety verification -- the highest
// consequence-of-failure surface in the repo, since a false-positive gate
// pass leads directly to an operator DELETE-ing a live netixlan row. All
// expected values below were captured empirically from the real functions
// before being hardcoded, including the two shapes' operator-discovered
// edge cases documented in the source comments (ixlan #3990, AS211750).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js');

function loadCp() {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbCpTestHooks__', pathname: '/cp/' }).hooks;
}

function mapToObj(map) {
  const obj = {};
  for (const [k, v] of map.entries()) obj[k] = v;
  return obj;
}

test('extractIxfAsnIpPairs', async (t) => {
  const hooks = loadCp();

  await t.test('builds an ASN-keyed map from member_list/connection_list/vlan_list, accepting both asnum and asn keys', () => {
    const ixfMap = hooks.extractIxfAsnIpPairs({
      member_list: [
        {
          asnum: 211750,
          connection_list: [{
            ixp_id: 5,
            vlan_list: [{ ipv4: { address: '185.1.184.10' }, ipv6: { address: '2001:7f8:1::10' } }],
          }],
        },
        {
          asn: '64500',
          connection_list: [{ ixp_id: 6, vlan_list: [{ ipv4: { address: '185.1.184.20' } }] }],
        },
      ],
    });
    const obj = mapToObj(ixfMap);
    assert.deepEqual(Object.keys(obj).sort(), ['211750', '64500']);
    assert.equal(obj['211750'][0].v4, '185.1.184.10');
    assert.equal(obj['211750'][0].v6, '2001:7f8:1::10');
    assert.equal(obj['211750'][0].v6Norm, '2001:7f8:1::10');
    assert.equal(obj['211750'][0].ixpId, 5);
    assert.equal(obj['64500'][0].v4, '185.1.184.20');
  });

  await t.test('returns an empty map for malformed/empty/null input', () => {
    assert.equal(hooks.extractIxfAsnIpPairs({}).size, 0);
    assert.equal(hooks.extractIxfAsnIpPairs(null).size, 0);
  });

  await t.test('skips a vlan entry with neither v4 nor v6', () => {
    const ixfMap = hooks.extractIxfAsnIpPairs({
      member_list: [{ asnum: 100, connection_list: [{ vlan_list: [{ ipv4: {}, ipv6: {} }] }] }],
    });
    assert.equal(ixfMap.size, 0);
  });

  await t.test('skips a member with no ASN at all', () => {
    const ixfMap = hooks.extractIxfAsnIpPairs({
      member_list: [{ connection_list: [{ vlan_list: [{ ipv4: { address: '1.1.1.1' } }] }] }],
    });
    assert.equal(ixfMap.size, 0);
  });
});

test('findIxfMergeCandidates: shape "split"', async (t) => {
  const hooks = loadCp();
  const ixfMap = hooks.extractIxfAsnIpPairs({
    member_list: [{
      asnum: 211750,
      connection_list: [{ ixp_id: 5, vlan_list: [{ ipv4: { address: '185.1.184.10' }, ipv6: { address: '2001:7f8:1::10' } }] }],
    }],
  });

  await t.test('detects a v4-only + v6-only pair confirmed by IX-F, keeper is the lower id', () => {
    const rows = [
      { id: 10, asn: '211750', ipaddr4: '185.1.184.10', ipaddr6: '' },
      { id: 11, asn: '211750', ipaddr4: '', ipaddr6: '2001:7f8:1::10' },
    ];
    const [candidate] = hooks.findIxfMergeCandidates(rows, ixfMap);
    assert.equal(candidate.asn, '211750');
    assert.equal(candidate.keeperRow.id, 10);
    assert.equal(candidate.otherRow.id, 11);
    assert.equal(candidate.ipv4, '185.1.184.10');
    assert.equal(candidate.ipv6, '2001:7f8:1::10');
    assert.equal(candidate.shape, 'split');
  });

  await t.test('keeper is still whichever row has the lower id, regardless of which side is v4/v6', () => {
    const rows = [
      { id: 9, asn: '211750', ipaddr4: '', ipaddr6: '2001:7f8:1::10' },
      { id: 10, asn: '211750', ipaddr4: '185.1.184.10', ipaddr6: '' },
    ];
    const [candidate] = hooks.findIxfMergeCandidates(rows, ixfMap);
    assert.equal(candidate.keeperRow.id, 9);
    assert.equal(candidate.otherRow.id, 10);
  });

  await t.test('does not match when exactly 2 rows exist for the ASN but IX-F does not confirm the pairing', () => {
    const rows = [
      { id: 1, asn: '211750', ipaddr4: '9.9.9.9', ipaddr6: '' },
      { id: 2, asn: '211750', ipaddr4: '', ipaddr6: '::9' },
    ];
    assert.equal(hooks.findIxfMergeCandidates(rows, ixfMap).length, 0);
  });

  await t.test('skips an ASN with 3 rows (only exactly-2-row groups are considered)', () => {
    const rows = [
      { id: 1, asn: '211750', ipaddr4: '185.1.184.10', ipaddr6: '' },
      { id: 2, asn: '211750', ipaddr4: '', ipaddr6: '2001:7f8:1::10' },
      { id: 3, asn: '211750', ipaddr4: '2.2.2.2', ipaddr6: '' },
    ];
    assert.equal(hooks.findIxfMergeCandidates(rows, ixfMap).length, 0);
  });

  await t.test('skips an ASN with no IX-F entries at all', () => {
    const rows = [
      { id: 1, asn: '999', ipaddr4: '1.1.1.1', ipaddr6: '' },
      { id: 2, asn: '999', ipaddr4: '', ipaddr6: '::1' },
    ];
    assert.equal(hooks.findIxfMergeCandidates(rows, ixfMap).length, 0);
  });
});

test('findIxfMergeCandidates: shape "stale-dual"', async (t) => {
  const hooks = loadCp();
  const ixfMap = hooks.extractIxfAsnIpPairs({
    member_list: [{
      asnum: 300,
      connection_list: [{ ixp_id: 1, vlan_list: [{ ipv4: { address: '185.1.184.99' }, ipv6: { address: '2001:db8::99' } }] }],
    }],
  });

  await t.test('absorbs a stale dual row into the fresh v4-only keeper (the ixlan #3990/AS211750 case)', () => {
    const rows = [
      { id: 20, asn: '300', ipaddr4: '185.1.184.99', ipaddr6: '' },
      { id: 21, asn: '300', ipaddr4: '185.0.1.99', ipaddr6: '2001:db8::99' },
    ];
    const [candidate] = hooks.findIxfMergeCandidates(rows, ixfMap);
    assert.equal(candidate.keeperRow.id, 20);
    assert.equal(candidate.otherRow.id, 21);
    assert.equal(candidate.ipv4, '185.1.184.99');
    assert.equal(candidate.ipv6, '2001:db8::99');
    assert.equal(candidate.shape, 'stale-dual');
  });

  await t.test('does not match shape 2 when the dual row already carries the IX-F v4 (ambiguous case for renumber/conflict-resolve instead)', () => {
    const rows = [
      { id: 1, asn: '300', ipaddr4: '185.1.184.99', ipaddr6: '' },
      { id: 2, asn: '300', ipaddr4: '185.1.184.99', ipaddr6: '2001:db8::99' },
    ];
    assert.equal(hooks.findIxfMergeCandidates(rows, ixfMap).length, 0);
  });
});

test('buildMergePlan', async (t) => {
  const hooks = loadCp();

  await t.test('auto-merges fields the doomed row has and the keeper lacks, skipping the conflicting family', () => {
    const plan = hooks.buildMergePlan({
      doomedRow: { ipaddr4: '1.1.1.1', ipaddr6: '2001:db8::99', speed: 1000, notes: 'old note' },
      keeperRow: { ipaddr4: '185.1.184.99', ipaddr6: '', speed: 0, notes: '' },
      family: 6,
    });
    assert.equal(plan.merge.speed, 1000);
    assert.equal(plan.merge.notes, 'old note');
    assert.equal(plan.merge.ipaddr6, undefined, 'conflicting family (6) must be skipped, not auto-merged');
    assert.equal(plan.blockers.length, 1);
    assert.equal(plan.blockers[0].field, 'ipaddr4');
    assert.equal(plan.blockers[0].kind, 'field-mismatch');
  });

  await t.test('blocks on a field where both rows carry differing non-empty values', () => {
    const plan = hooks.buildMergePlan({ doomedRow: { speed: 1000 }, keeperRow: { speed: 2000 }, family: 4 });
    assert.equal(Object.keys(plan.merge).length, 0);
    assert.equal(plan.blockers[0].kind, 'field-mismatch');
    assert.equal(plan.blockers[0].field, 'speed');
  });

  await t.test('returns an empty plan when either row is missing', () => {
    const plan = hooks.buildMergePlan({});
    assert.equal(Object.keys(plan.merge).length, 0);
    assert.equal(plan.blockers.length, 0);
  });

  await t.test('treats numeric 0 and boolean false as "empty" (not mergeable, not a mismatch)', () => {
    const plan = hooks.buildMergePlan({
      doomedRow: { operational: true, bfd_support: false, is_rs_peer: 0 },
      keeperRow: {},
      family: 4,
    });
    assert.equal(plan.merge.operational, true);
    assert.equal(Object.keys(plan.merge).length, 1);
    assert.equal(plan.blockers.length, 0);
  });
});

test('verifyConflictGates', async (t) => {
  const hooks = loadCp();
  const payload = { hasV4: true, old4: '185.0.1.0/24', new4: '185.1.184.0/23', hasV6: false };
  const doomed = { id: 21, asn: '300', ixlan_id: '7', ipaddr4: '185.0.1.99', ipaddr6: '' };
  const keeper = { id: 20, asn: '300', ixlan_id: '7', ipaddr4: '185.1.184.99', ipaddr6: '' };
  const ixfMap = hooks.extractIxfAsnIpPairs({
    member_list: [{ asnum: 300, connection_list: [{ vlan_list: [{ ipv4: { address: '185.1.184.99' } }] }] }],
  });

  function gate(result, name) {
    return result.gates.find((g) => g.name === name);
  }

  await t.test('all 8 gates pass for a clean, correctly-set-up conflict pair', () => {
    const result = hooks.verifyConflictGates({ doomedRow: doomed, keeperRow: keeper, payload, ixfMap, family: 4 });
    assert.equal(result.gates.length, 8);
    assert.equal(result.ok, true);
    assert.equal(Object.keys(result.mergePlan.merge).length, 0);
    assert.equal(result.mergePlan.blockers.length, 0);
  });

  await t.test('gate asn-match fails on an ASN mismatch and the whole verification fails', () => {
    const result = hooks.verifyConflictGates({
      doomedRow: { ...doomed, asn: '999' }, keeperRow: keeper, payload, ixfMap, family: 4,
    });
    assert.equal(gate(result, 'asn-match').ok, false);
    assert.equal(result.ok, false);
  });

  await t.test('gate same-ixlan fails when the rows live on different ixlans', () => {
    const result = hooks.verifyConflictGates({
      doomedRow: { ...doomed, ixlan_id: '8' }, keeperRow: keeper, payload, ixfMap, family: 4,
    });
    assert.equal(gate(result, 'same-ixlan').ok, false);
    assert.equal(result.ok, false);
  });

  await t.test('gate keeper-ip-is-target fails when the keeper does not hold the renumber target IP', () => {
    const result = hooks.verifyConflictGates({
      doomedRow: doomed, keeperRow: { ...keeper, ipaddr4: '9.9.9.9' }, payload, ixfMap, family: 4,
    });
    assert.equal(gate(result, 'keeper-ip-is-target').ok, false);
    assert.equal(result.ok, false);
  });

  await t.test('gate doomed-ip-in-source-prefix fails when the doomed IP is not in the renumber source prefix', () => {
    const result = hooks.verifyConflictGates({
      doomedRow: { ...doomed, ipaddr4: '10.0.0.5' }, keeperRow: keeper, payload, ixfMap, family: 4,
    });
    assert.equal(gate(result, 'doomed-ip-in-source-prefix').ok, false);
    assert.equal(result.ok, false);
  });

  await t.test('gates ixf-asserts-keeper and ixf-does-not-assert-doomed both hard-fail when ixfMap is unavailable (never assume "probably fine")', () => {
    const result = hooks.verifyConflictGates({ doomedRow: doomed, keeperRow: keeper, payload, ixfMap: null, family: 4 });
    assert.equal(gate(result, 'ixf-asserts-keeper').ok, false);
    assert.equal(gate(result, 'ixf-asserts-keeper').detail, 'ixf-unavailable');
    assert.equal(gate(result, 'ixf-does-not-assert-doomed').ok, false);
    assert.equal(result.ok, false);
  });

  await t.test('gate ixf-asserts-keeper fails when IX-F does not name the keeper IP for this ASN', () => {
    const wrongIxfMap = hooks.extractIxfAsnIpPairs({
      member_list: [{ asnum: 300, connection_list: [{ vlan_list: [{ ipv4: { address: '1.2.3.4' } }] }] }],
    });
    const result = hooks.verifyConflictGates({ doomedRow: doomed, keeperRow: keeper, payload, ixfMap: wrongIxfMap, family: 4 });
    assert.equal(gate(result, 'ixf-asserts-keeper').ok, false);
    assert.equal(result.ok, false);
  });

  await t.test('gate ixf-does-not-assert-doomed fails when IX-F ALSO names the doomed IP (protects a legitimately dual-attached member)', () => {
    const dualAttachedIxfMap = hooks.extractIxfAsnIpPairs({
      member_list: [{
        asnum: 300,
        connection_list: [{ vlan_list: [
          { ipv4: { address: '185.1.184.99' } },
          { ipv4: { address: '185.0.1.99' } },
        ] }],
      }],
    });
    const result = hooks.verifyConflictGates({ doomedRow: doomed, keeperRow: keeper, payload, ixfMap: dualAttachedIxfMap, family: 4 });
    assert.equal(gate(result, 'ixf-asserts-keeper').ok, true);
    assert.equal(gate(result, 'ixf-does-not-assert-doomed').ok, false);
    assert.equal(result.ok, false);
  });

  await t.test('gate no-data-loss-on-delete fails on a genuine field mismatch (the ixlan #3990 speed-disagreement case)', () => {
    const result = hooks.verifyConflictGates({
      doomedRow: { ...doomed, speed: 1000 }, keeperRow: { ...keeper, speed: 2000 }, payload, ixfMap, family: 4,
    });
    assert.equal(gate(result, 'no-data-loss-on-delete').ok, false);
    assert.equal(gate(result, 'no-data-loss-on-delete').detail, 'field-mismatch:speed');
    assert.equal(result.ok, false);
  });

  await t.test('gate no-data-loss-on-delete passes and reports an auto-merge summary when the doomed row has a field the keeper is missing', () => {
    const result = hooks.verifyConflictGates({
      doomedRow: { ...doomed, notes: 'important note' }, keeperRow: keeper, payload, ixfMap, family: 4,
    });
    assert.equal(gate(result, 'no-data-loss-on-delete').ok, true);
    assert.equal(gate(result, 'no-data-loss-on-delete').detail, 'auto-merge: notes');
    assert.equal(result.ok, true);
    assert.equal(result.mergePlan.merge.notes, 'important note');
    assert.equal(Object.keys(result.mergePlan.merge).length, 1);
  });
});
