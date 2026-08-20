'use strict';

// Tests for the do-not-touch write guard on FP's two destructive netixlan
// write paths, resolveIxfDiscrepancy (PUT) and removeNetixlanEntry (DELETE).
//
// Contract: the PeeringDB Example Organization objects -- org 25554 and
// every child record it owns -- are records these scripts MUST never
// touch in any way: no writes, no flagging for changes, no mutation of
// any kind. EXAMPLE_ORG_DO_NOT_TOUCH_ENTITY_IDS encodes that contract;
// the first test below pins the full cluster so an entry cannot
// silently drop out, and the write-path cases enforce it where FP
// actually writes today.
//
// Context: CP has long blocked script-driven writes against the protected
// "Example Organization" records
// (isWriteActionBlockedForUpdateNameExcludedEntity),
// but FP's copy of the exclusion cluster sat unwired while FP gained its
// first write capability (the per-row IX-F verify/resolve flow on the
// network page). A netixlan row is not itself in the exclusion sets, so the
// guard maps the row's parent ids -- net_id, and ix_id (with ixlan_id as a
// fallback, PeeringDB pinning each ixlan's id to its parent ix's id) -- to
// the protected sets.
//
// The guard deliberately keys on EXAMPLE_ORG_DO_NOT_TOUCH_ENTITY_IDS, NOT on
// the broader UPDATE_NAME_EXCLUDED_ENTITY_IDS: that map was built for the
// update-name tooling and mostly lists real third-party records (AFNIC's
// net 2858, DNS-OARC's net 10664, ...) whose names must not be auto-edited
// but whose peering data remains writable via normal admin writes. Only
// PeeringDB's own Example Organization records block the write paths:
// nets 32281 and 666, and ix 4095 (all under org 25554 "PeeringDB Example
// Organization"; verified against the public API 2026-08-20). Half the
// cases below pin exactly that distinction -- a name-tooling-excluded
// parent must NOT block the write.
//
// Same precedent as cp-ixf-merge-apply.test.js: the write paths are driven
// for real through the shim's fake fetch, and the load-bearing assertions
// are negative -- no PUT/DELETE recorded when the parent is protected. Each
// blocked case is paired with a non-excluded control that proves the same
// call *does* issue the write, so a regression that breaks the whole path
// (rather than the guard) cannot masquerade as the guard holding.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-fp-consolidated-tools.user.js');

function loadFp(opts = {}) {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbFpTestHooks__', hostname: 'www.peeringdb.com', ...opts });
}

// A netixlan row as /api/netixlan/<id> returns it, parented as directed.
function netixlanRow({ id = 555, netId = 999, ixId = 111, ixlanId = ixId } = {}) {
  return {
    id,
    net_id: netId,
    ix_id: ixId,
    ixlan_id: ixlanId,
    asn: 64500,
    ipaddr4: '80.81.194.210',
    ipaddr6: '',
    speed: 10000,
    is_rs_peer: true,
    operational: true,
  };
}

const API_URL = 'https://www.peeringdb.com/api/netixlan/555';

test('contract: the write-guard map holds org 25554 and all its children, and nothing else', () => {
  // The full PeeringDB Example Organization cluster per the public API
  // (2026-08-20). Removing an entry here is a contract break, not a
  // cleanup: these are objects the scripts MUST never touch at all.
  // "Nothing else" is the other half of the contract -- a real
  // third-party record added to this map would be over-blocked.
  const EXAMPLE_ORG_CLUSTER = {
    net: ['666', '32281'],
    ix: ['4095'],
    org: ['25554'],
    fac: ['13346', '13399'],
    carrier: ['66'],
    campus: ['25'],
  };

  const { hooks } = loadFp({ pathname: '/net/999' });
  const map = hooks.EXAMPLE_ORG_DO_NOT_TOUCH_ENTITY_IDS;

  assert.deepEqual(Object.keys(map).sort(), Object.keys(EXAMPLE_ORG_CLUSTER).sort());
  for (const [type, ids] of Object.entries(EXAMPLE_ORG_CLUSTER)) {
    for (const id of ids) {
      assert.equal(map[type].has(id), true, `${type} ${id} must be write-guard protected`);
    }
    assert.equal(map[type].size, ids.length, `${type} set must hold exactly ${ids.length} id(s)`);
  }

  // The update-name exclusions are derived from the do-not-touch map
  // (never touched at all implies never name-edited), so every entry
  // above must also be update-name excluded. Pins the derivation
  // against a regression back to two hand-maintained ID lists.
  const updateNameMap = hooks.UPDATE_NAME_EXCLUDED_ENTITY_IDS;
  for (const [type, ids] of Object.entries(EXAMPLE_ORG_CLUSTER)) {
    for (const id of ids) {
      assert.equal(updateNameMap[type].has(id), true, `${type} ${id} must also be update-name excluded`);
    }
  }
});

test('getDoNotTouchNetixlanParentInfo', async (t) => {
  const { hooks } = loadFp({ pathname: '/net/999' });

  // Field-by-field rather than deepEqual: the hooks live in a vm context, so
  // their return values have a different realm's Object.prototype and
  // deepStrictEqual rejects them as "same structure but not reference-equal".
  await t.test('flags a row whose net is write-guard protected', () => {
    // Both Example networks under org 25554: 32281 (16-bit) and 666 (32-bit).
    for (const netId of [32281, 666]) {
      const info = hooks.getDoNotTouchNetixlanParentInfo(netixlanRow({ netId }));
      assert.equal(info.type, 'net', `net ${netId}`);
      assert.equal(info.id, String(netId), `net ${netId}`);
    }
  });

  await t.test('flags a row whose ix is write-guard protected', () => {
    const info = hooks.getDoNotTouchNetixlanParentInfo(netixlanRow({ ixId: 4095 }));
    assert.equal(info.type, 'ix');
    assert.equal(info.id, '4095');
  });

  await t.test('does NOT flag parents that are only name-tooling exclusions', () => {
    // Every non-protected net in UPDATE_NAME_EXCLUDED_ENTITY_IDS.net: real
    // third-party records (AFNIC, DNS-OARC, NIC.br, AS8882, Digital
    // Example). Applying the name-tooling list 1:1 to the write guard
    // was the original review finding.
    for (const netId of [31754, 29032, 14185, 2858, 24084, 10664]) {
      assert.equal(hooks.getDoNotTouchNetixlanParentInfo(netixlanRow({ netId })), null, `net ${netId}`);
    }
  });

  await t.test('falls back to ixlan_id when the row carries no ix_id', () => {
    const row = netixlanRow({ ixlanId: 4095 });
    delete row.ix_id;
    const info = hooks.getDoNotTouchNetixlanParentInfo(row);
    assert.equal(info.type, 'ix');
    assert.equal(info.id, '4095');
  });

  await t.test('null for a row with unremarkable parents', () => {
    assert.equal(hooks.getDoNotTouchNetixlanParentInfo(netixlanRow()), null);
  });

  await t.test('null for a row missing its parent ids entirely', () => {
    assert.equal(hooks.getDoNotTouchNetixlanParentInfo({}), null);
  });
});

test('resolveIxfDiscrepancy do-not-touch guard', async (t) => {
  await t.test('no PUT is issued for a row on a do-not-touch net', async () => {
    const { hooks, document, fetchCalls } = loadFp({ pathname: '/net/32281', fetchMap: { [API_URL]: {} } });
    const panel = document.createElement('div');
    const resolveBtn = document.createElement('button');

    await hooks.resolveIxfDiscrepancy(panel, 555, netixlanRow({ netId: 32281 }), [], resolveBtn);

    assert.equal(fetchCalls.length, 0);
    assert.match(panel.children[0].textContent, /Blocked: netixlan #555 belongs to do-not-touch net#32281/);
    // The button is left untouched: re-clicking must re-explain, not hang disabled.
    assert.notEqual(resolveBtn.disabled, true);
  });

  await t.test('no PUT is issued for a row at a do-not-touch ix either', async () => {
    const { hooks, document, fetchCalls } = loadFp({ pathname: '/net/999', fetchMap: { [API_URL]: {} } });
    const panel = document.createElement('div');

    await hooks.resolveIxfDiscrepancy(panel, 555, netixlanRow({ ixId: 4095 }), [], document.createElement('button'));

    assert.equal(fetchCalls.length, 0);
    assert.match(panel.children[0].textContent, /do-not-touch ix#4095/);
  });

  await t.test('control: the same call PUTs for an unremarkable row', async () => {
    // Proves the blocked cases above hold because of the guard, not because
    // the path stopped writing altogether.
    const { hooks, document, fetchCalls } = loadFp({ pathname: '/net/999', fetchMap: { [API_URL]: {} } });
    const panel = document.createElement('div');

    await hooks.resolveIxfDiscrepancy(panel, 555, netixlanRow(), [], document.createElement('button'));

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].method, 'PUT');
    assert.equal(fetchCalls[0].url, API_URL);
  });

  await t.test('a name-tooling-excluded parent (AFNIC net 2858) does NOT block the PUT', async () => {
    const { hooks, document, fetchCalls } = loadFp({ pathname: '/net/2858', fetchMap: { [API_URL]: {} } });
    const panel = document.createElement('div');

    await hooks.resolveIxfDiscrepancy(panel, 555, netixlanRow({ netId: 2858 }), [], document.createElement('button'));

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].method, 'PUT');
  });
});

test('removeNetixlanEntry do-not-touch guard', async (t) => {
  await t.test('no confirm() and no DELETE for a row on the protected net', async () => {
    const { hooks, window, document, fetchCalls } = loadFp({ pathname: '/net/32281', fetchMap: { [API_URL]: {} } });
    let confirmCalls = 0;
    window.confirm = () => { confirmCalls += 1; return true; };
    const panel = document.createElement('div');
    const removeBtn = document.createElement('button');

    await hooks.removeNetixlanEntry(panel, 555, netixlanRow({ netId: 32281 }), removeBtn);

    // Blocked before the browser dialog: the admin is never asked to confirm
    // a delete the script will not perform.
    assert.equal(confirmCalls, 0);
    assert.equal(fetchCalls.length, 0);
    assert.match(panel.children[0].textContent, /Blocked: netixlan #555 belongs to do-not-touch net#32281/);
    assert.notEqual(removeBtn.disabled, true);
  });

  await t.test('no DELETE for a row at a do-not-touch ix either', async () => {
    const { hooks, window, document, fetchCalls } = loadFp({ pathname: '/net/999', fetchMap: { [API_URL]: {} } });
    window.confirm = () => true;
    const panel = document.createElement('div');

    await hooks.removeNetixlanEntry(panel, 555, netixlanRow({ ixId: 4095 }), document.createElement('button'));

    assert.equal(fetchCalls.length, 0);
    assert.match(panel.children[0].textContent, /do-not-touch ix#4095/);
  });

  await t.test('control: the same call DELETEs a confirmed, unremarkable row', async () => {
    const { hooks, window, document, fetchCalls } = loadFp({ pathname: '/net/999', fetchMap: { [API_URL]: {} } });
    window.confirm = () => true;
    const panel = document.createElement('div');

    await hooks.removeNetixlanEntry(panel, 555, netixlanRow(), document.createElement('button'));

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].method, 'DELETE');
    assert.equal(fetchCalls[0].url, API_URL);
  });

  await t.test('no confirm() and no DELETE for a row on Example net 666 either', async () => {
    // net 666 "PeeringDB Example 32-bit Network" is org 25554's second
    // Example network; this case previously pinned the opposite.
    const { hooks, window, document, fetchCalls } = loadFp({ pathname: '/net/666', fetchMap: { [API_URL]: {} } });
    let confirmCalls = 0;
    window.confirm = () => { confirmCalls += 1; return true; };
    const panel = document.createElement('div');

    await hooks.removeNetixlanEntry(panel, 555, netixlanRow({ netId: 666 }), document.createElement('button'));

    assert.equal(confirmCalls, 0);
    assert.equal(fetchCalls.length, 0);
    assert.match(panel.children[0].textContent, /Blocked: netixlan #555 belongs to do-not-touch net#666/);
  });

  await t.test('a name-tooling-excluded parent (DNS-OARC net 10664) does NOT block the DELETE', async () => {
    // A real third-party record from UPDATE_NAME_EXCLUDED_ENTITY_IDS.net: the
    // destructive path stays available (the confirm() dialog is still the
    // gate, as for any other row).
    const { hooks, window, document, fetchCalls } = loadFp({ pathname: '/net/10664', fetchMap: { [API_URL]: {} } });
    let confirmCalls = 0;
    window.confirm = () => { confirmCalls += 1; return true; };
    const panel = document.createElement('div');

    await hooks.removeNetixlanEntry(panel, 555, netixlanRow({ netId: 10664 }), document.createElement('button'));

    assert.equal(confirmCalls, 1);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].method, 'DELETE');
  });
});
