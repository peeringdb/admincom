'use strict';

// Tests for lib/admincom-shared-helpers.js, the cross-script helper
// fragment inlined into CP, FP and DP: formatSpeedLabel,
// getTabSessionStorage, the editable-region predicates, and the
// ASN -> network-name resolver fetchAsnNetworkName.
//
// Loaded through DP's hooks (the shared-cache precedent: the fragment is
// inlined identically into all three scripts, so any host proves the
// shipped code; DP hosts the rest of the resolver-adjacent tests already).
// The resolver is exercised through its injectable fetchJson transport
// rather than the shim's fetchMap, because transport injection is the
// contract itself: CP/FP default to same-origin fetchWithRetry while
// cross-origin DP must pass its own GM_xmlhttpRequest-backed transport,
// and a stub transport lets the cases count calls and simulate failures
// directly. All expected values below were captured empirically from the
// real functions before being hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

function loadDp(opts = {}) {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbDpTestHooks__', pathname: '/app/ticket', ...opts });
}

// Minimal transport stub: returns the given payload (or throws), and
// counts calls so cache behavior is observable.
function makeFetchJsonStub(payload, { fail = false } = {}) {
  const stub = async () => {
    stub.calls += 1;
    if (fail) throw new Error('transport down');
    return payload;
  };
  stub.calls = 0;
  return stub;
}

const NET_64500 = { asn: 64500, status: 'ok', name: 'Example Net' };

test('formatSpeedLabel', async (t) => {
  const { hooks } = loadDp();

  await t.test('sub-gigabit stays in megabits', () => {
    assert.equal(hooks.formatSpeedLabel(750), '750M');
  });

  await t.test('gigabit and terabit tiers round to whole units', () => {
    assert.equal(hooks.formatSpeedLabel(1000), '1G');
    assert.equal(hooks.formatSpeedLabel(10000), '10G');
    assert.equal(hooks.formatSpeedLabel(1500), '2G');
    assert.equal(hooks.formatSpeedLabel(1000000), '1T');
    assert.equal(hooks.formatSpeedLabel(2500000), '3T');
  });

  await t.test('zero, negative, and non-numeric report "speed n/a"', () => {
    for (const bad of [0, -100, '', 'fast', null, undefined, NaN]) {
      assert.equal(hooks.formatSpeedLabel(bad), 'speed n/a', String(bad));
    }
  });
});

test('getTabSessionStorage', async (t) => {
  await t.test('returns the window sessionStorage instance', () => {
    const { hooks, window } = loadDp();
    assert.equal(hooks.getTabSessionStorage(), window.sessionStorage);
  });
});

test('editable-region predicates', async (t) => {
  const { hooks } = loadDp();

  // Hand-rolled minimal nodes: the shim's FakeElement always answers
  // closest() with null, so the positive case needs an object whose
  // closest() recognizes the contenteditable selector.
  const editableAncestorEl = {
    nodeType: 1,
    closest: (selector) => (selector === '[contenteditable="true"]' ? {} : null),
  };
  const plainEl = { nodeType: 1, closest: () => null };

  await t.test('element inside a contenteditable ancestor is editable', () => {
    assert.equal(hooks.isNodeInsideEditableRegion(editableAncestorEl), true);
    assert.equal(hooks.isAnchorInsideEditableRegion(editableAncestorEl), true);
  });

  await t.test('element outside any editable region is not', () => {
    assert.equal(hooks.isNodeInsideEditableRegion(plainEl), false);
  });

  await t.test('a text node is judged by its parent element', () => {
    const textNode = { nodeType: 3, parentElement: editableAncestorEl };
    assert.equal(hooks.isNodeInsideEditableRegion(textNode), true);
    const orphanTextNode = { nodeType: 3, parentElement: null };
    assert.equal(hooks.isNodeInsideEditableRegion(orphanTextNode), false);
  });

  await t.test('null input is not editable', () => {
    assert.equal(hooks.isNodeInsideEditableRegion(null), false);
  });
});

test('fetchAsnNetworkName', async (t) => {
  await t.test('resolves a name and serves the repeat call from memory', async () => {
    const { hooks } = loadDp();
    const fetchJson = makeFetchJsonStub({ data: [NET_64500] });

    assert.equal(await hooks.fetchAsnNetworkName(64500, { fetchJson }), 'Example Net');
    assert.equal(await hooks.fetchAsnNetworkName(64500, { fetchJson }), 'Example Net');
    assert.equal(fetchJson.calls, 1);
  });

  await t.test('prefers name_long over name', async () => {
    const { hooks } = loadDp();
    const fetchJson = makeFetchJsonStub({
      data: [{ asn: 64500, status: 'ok', name: 'Short', name_long: 'Long Legal Name Ltd.' }],
    });
    assert.equal(await hooks.fetchAsnNetworkName(64500, { fetchJson }), 'Long Legal Name Ltd.');
  });

  await t.test('prefers the exact-ASN active row over an earlier stale row', async () => {
    const { hooks } = loadDp();
    const fetchJson = makeFetchJsonStub({
      data: [
        { asn: 64500, status: 'deleted', name: 'Old Net' },
        { asn: 64500, status: 'ok', name: 'Current Net' },
      ],
    });
    assert.equal(await hooks.fetchAsnNetworkName(64500, { fetchJson }), 'Current Net');
  });

  await t.test('a persisted shared-cache name short-circuits the transport', async () => {
    const { hooks } = loadDp();
    hooks.setCachedDataInStorage('asn', '64501', { name: 'Persisted Net' });
    const fetchJson = makeFetchJsonStub(null, { fail: true });

    assert.equal(await hooks.fetchAsnNetworkName(64501, { fetchJson }), 'Persisted Net');
    assert.equal(fetchJson.calls, 0);
  });

  await t.test('an empty result is "" and the miss is memory-cached', async () => {
    const { hooks } = loadDp();
    const fetchJson = makeFetchJsonStub({ data: [] });

    assert.equal(await hooks.fetchAsnNetworkName(64502, { fetchJson }), '');
    assert.equal(await hooks.fetchAsnNetworkName(64502, { fetchJson }), '');
    assert.equal(fetchJson.calls, 1);
  });

  await t.test('a transport failure is "" but NOT cached -- the next call retries', async () => {
    const { hooks } = loadDp();
    const fetchJson = makeFetchJsonStub(null, { fail: true });

    assert.equal(await hooks.fetchAsnNetworkName(64503, { fetchJson }), '');
    assert.equal(await hooks.fetchAsnNetworkName(64503, { fetchJson }), '');
    assert.equal(fetchJson.calls, 2);
  });

  await t.test('concurrent calls for one ASN share a single in-flight request', async () => {
    const { hooks } = loadDp();
    const fetchJson = makeFetchJsonStub({ data: [NET_64500] });

    const [first, second] = await Promise.all([
      hooks.fetchAsnNetworkName(64500, { fetchJson }),
      hooks.fetchAsnNetworkName(64500, { fetchJson }),
    ]);
    assert.equal(first, 'Example Net');
    assert.equal(second, 'Example Net');
    assert.equal(fetchJson.calls, 1);
  });

  await t.test('non-numeric ASN input is "" with no transport call', async () => {
    const { hooks } = loadDp();
    const fetchJson = makeFetchJsonStub({ data: [NET_64500] });

    for (const bad of ['', 'AS64500', 'abc', null, undefined]) {
      assert.equal(await hooks.fetchAsnNetworkName(bad, { fetchJson }), '', String(bad));
    }
    assert.equal(fetchJson.calls, 0);
  });
});
