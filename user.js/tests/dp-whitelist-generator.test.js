'use strict';

// Tests for the pure parsing helpers behind DP's "Generate Whitelist CMD"
// feature (pihole allow-command generation for IX/NET/FAC/Carrier approval
// tickets). deriveWhitelistCandidates (eTLD+1 resolution) is deliberately
// not covered here -- it depends on the PSL library loaded via @require,
// which isn't available in this offline test environment, and its own
// typeof-guarded fallback path (bare hostname, no real eTLD+1 stripping)
// isn't representative of production behavior with PSL loaded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

function loadDp() {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbDpTestHooks__', pathname: '/app/ticket' }).hooks;
}

// Field-by-field, not deepEqual: the parsed result comes from a separate vm
// realm (the loaded script's sandbox), so deepStrictEqual's prototype check
// fails against a plain object literal here despite identical structure.
function assertWlMatch(actual, expected) {
  assert.ok(actual, `expected a match, got ${actual}`);
  assert.equal(actual.model, expected.model);
  assert.equal(actual.id, expected.id);
  assert.equal(actual.api, expected.api);
  assert.equal(actual.label, expected.label);
}

test('parseWhitelistChangeHref', async (t) => {
  const hooks = loadDp();

  await t.test('parses each of the four supported model types', () => {
    assertWlMatch(
      hooks.parseWhitelistChangeHref('https://www.peeringdb.com/cp/peeringdb_server/network/123/change/'),
      { model: 'network', id: '123', api: 'net', label: 'Network' },
    );
    assertWlMatch(
      hooks.parseWhitelistChangeHref('https://www.peeringdb.com/cp/peeringdb_server/internetexchange/45/change/'),
      { model: 'internetexchange', id: '45', api: 'ix', label: 'Internet Exchange' },
    );
    assertWlMatch(
      hooks.parseWhitelistChangeHref('https://www.peeringdb.com/cp/peeringdb_server/facility/7/change/'),
      { model: 'facility', id: '7', api: 'fac', label: 'Facility' },
    );
    assertWlMatch(
      hooks.parseWhitelistChangeHref('https://www.peeringdb.com/cp/peeringdb_server/carrier/9/change/'),
      { model: 'carrier', id: '9', api: 'carrier', label: 'Carrier' },
    );
  });

  await t.test('tolerates doubled slashes (defensive, since the double-slash normalizer runs first)', () => {
    assertWlMatch(
      hooks.parseWhitelistChangeHref('https://www.peeringdb.com//cp//peeringdb_server//facility//7//change//'),
      { model: 'facility', id: '7', api: 'fac', label: 'Facility' },
    );
  });

  await t.test('returns null for a model not in WL_TYPE_MAP (e.g. user)', () => {
    assert.equal(
      hooks.parseWhitelistChangeHref('https://www.peeringdb.com/cp/peeringdb_server/user/9/change/'),
      null,
    );
  });

  await t.test('returns null for a non-change URL', () => {
    assert.equal(hooks.parseWhitelistChangeHref('https://www.peeringdb.com/net/123'), null);
  });

  await t.test('returns null for empty/missing input', () => {
    assert.equal(hooks.parseWhitelistChangeHref(''), null);
    assert.equal(hooks.parseWhitelistChangeHref(undefined), null);
  });
});

test('extractWhitelistHostname', async (t) => {
  const hooks = loadDp();

  await t.test('bare hostname (no scheme) resolves via the https:// fallback', () => {
    assert.equal(hooks.extractWhitelistHostname('example.com'), 'example.com');
  });

  await t.test('full URL is lowercased and reduced to hostname only', () => {
    assert.equal(hooks.extractWhitelistHostname('https://Example.COM/path'), 'example.com');
  });

  await t.test('port and path are stripped, subdomain preserved', () => {
    assert.equal(hooks.extractWhitelistHostname('http://sub.example.com:8080/x'), 'sub.example.com');
  });

  await t.test('empty input returns empty string', () => {
    assert.equal(hooks.extractWhitelistHostname(''), '');
  });

  await t.test('unparseable input falls back to a best-effort strip', () => {
    assert.equal(hooks.extractWhitelistHostname('not a url at all'), 'not a url at all');
  });
});
