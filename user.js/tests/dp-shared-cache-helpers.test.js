'use strict';

// Tests for the shared cache helpers in lib/admincom-common.js that
// shared-cache.test.js only exercises indirectly through CP/FP's
// higher-level org-resolution flow: getSharedCacheStorageKey's key-
// validation/normalization branch, and the negative-cache pair
// (cacheNegativeLookup/isNegativeCacheEntry) DP uses across all of its
// entity fetchers to avoid repeated failed lookups. Loaded through DP
// since it's the current sole direct caller of these three; the
// underlying lib fragment is identical across all three scripts. All
// expected values below were captured empirically from the real functions
// before being hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

function loadDp() {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbDpTestHooks__', pathname: '/app/ticket' }).hooks;
}

test('getSharedCacheStorageKey', async (t) => {
  const hooks = loadDp();

  await t.test('builds the namespaced key for a valid type/id pair', () => {
    assert.equal(hooks.getSharedCacheStorageKey('org', '123'), 'pdbAdmincom.cache.org.123');
  });

  await t.test('normalizes the type to lowercase', () => {
    assert.equal(hooks.getSharedCacheStorageKey('ORG', '123'), 'pdbAdmincom.cache.org.123');
  });

  await t.test('allows underscores in the type (e.g. net_id)', () => {
    assert.equal(hooks.getSharedCacheStorageKey('net_id', '5'), 'pdbAdmincom.cache.net_id.5');
  });

  await t.test('coerces a numeric id to a string', () => {
    assert.equal(hooks.getSharedCacheStorageKey('asn', 64500), 'pdbAdmincom.cache.asn.64500');
  });

  await t.test('rejects a type containing a digit or a dash', () => {
    assert.equal(hooks.getSharedCacheStorageKey('org1', '123'), '');
    assert.equal(hooks.getSharedCacheStorageKey('org-x', '123'), '');
  });

  await t.test('rejects an empty type or an empty/whitespace-only id', () => {
    assert.equal(hooks.getSharedCacheStorageKey('', '123'), '');
    assert.equal(hooks.getSharedCacheStorageKey('org', ''), '');
    assert.equal(hooks.getSharedCacheStorageKey('org', '   '), '');
  });
});

test('isNegativeCacheEntry', async (t) => {
  const hooks = loadDp();

  await t.test('returns true for a negative-cache marker', () => {
    assert.equal(hooks.isNegativeCacheEntry({ error: 'not_found', timestamp: 123 }), true);
  });

  await t.test('returns false for a normal data object', () => {
    assert.equal(hooks.isNegativeCacheEntry({ id: 5, name: 'Foo' }), false);
  });

  await t.test('returns false for an object with a different error value', () => {
    assert.equal(hooks.isNegativeCacheEntry({ error: 'other' }), false);
  });

  await t.test('returns the falsy input itself (not coerced to boolean false) for null/undefined -- a real discrepancy from the JSDoc\'s declared boolean return type, not fixed here per "lock in current behavior"', () => {
    assert.equal(hooks.isNegativeCacheEntry(null), null);
    assert.equal(hooks.isNegativeCacheEntry(undefined), undefined);
  });
});

test('cacheNegativeLookup', async (t) => {
  await t.test('writes a negative-cache marker that round-trips through getCachedDataFromStorage/isNegativeCacheEntry', () => {
    const hooks = loadDp();
    hooks.cacheNegativeLookup('org', '999');
    const cached = hooks.getCachedDataFromStorage('org', '999');
    assert.equal(cached.error, 'not_found');
    assert.equal(typeof cached.timestamp, 'number');
    assert.equal(hooks.isNegativeCacheEntry(cached), true);
  });

  await t.test('does not affect an unrelated cache entry', () => {
    const hooks = loadDp();
    hooks.cacheNegativeLookup('org', '999');
    assert.equal(hooks.getCachedDataFromStorage('org', '1000'), null);
  });

  await t.test('respects a custom ttl argument', () => {
    const hooks = loadDp();
    hooks.cacheNegativeLookup('net', '42', 1000);
    const cached = hooks.getCachedDataFromStorage('net', '42');
    assert.equal(hooks.isNegativeCacheEntry(cached), true);
  });
});
