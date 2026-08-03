'use strict';

// Tests for the cache-unification refactor: CP, FP, and DP now share one
// cache mechanism (lib/admincom-common.js getCachedDataFromStorage/
// setCachedDataInStorage), replacing three independent, non-interoperable
// per-script caches. CP and FP genuinely share data here (both simulated
// against the same fake localStorage instance, mirroring same-origin
// peeringdb.com sharing in a real browser). DP is deliberately not covered
// by this file -- it runs on a different origin (peeringdb.deskpro.com) and
// physically cannot share storage with CP/FP; that's a browser guarantee,
// not something to test around.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, makeFakeStorage } = require('./helpers/browser-shim');

const CP_SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js');
const FP_SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-fp-consolidated-tools.user.js');

function loadCp(sharedLocalStorage, fetchMap = {}) {
  return loadScript(CP_SCRIPT_PATH, {
    hooksKey: '__pdbCpTestHooks__',
    pathname: '/cp/peeringdb_server/network/2906/change/',
    localStorage: sharedLocalStorage,
    fetchMap,
  }).hooks;
}

function loadFp(sharedLocalStorage, pathname, fetchMap = {}) {
  return loadScript(FP_SCRIPT_PATH, {
    hooksKey: '__pdbFpTestHooks__',
    pathname,
    localStorage: sharedLocalStorage,
    fetchMap,
  }).hooks;
}

test('CP resolving an org warms the shared cache for FP (same origin)', async () => {
  const sharedLocalStorage = makeFakeStorage();
  const cp = loadCp(sharedLocalStorage, {
    'https://www.peeringdb.com/api/org/111': { data: [{ id: '111', name: 'Netflix, Inc' }] },
  });

  const name = await cp.getOrganizationName('111');
  assert.equal(name, 'Netflix, Inc');

  // Fresh FP script load against the SAME simulated localStorage -- a real
  // browser would share this automatically since both scripts run on
  // www.peeringdb.com. (Field-by-field, not deepEqual: the two objects come
  // from separate vm realms, so deepStrictEqual's prototype check fails
  // despite identical own-property structure.)
  const fp = loadFp(sharedLocalStorage, '/org/111');
  const warmHit = fp.getCachedDataFromStorage('org', '111');
  assert.equal(warmHit?.id, '111');
  assert.equal(warmHit?.name, 'Netflix, Inc');
});

test('FP resolving an org page warms the shared cache for CP (same origin)', async () => {
  const sharedLocalStorage = makeFakeStorage();
  const fp = loadFp(sharedLocalStorage, '/org/222', {
    'https://www.peeringdb.com/api/org/222': { data: [{ id: '222', name: 'Example Org' }] },
  });

  const ctx = fp.getRouteContext();
  const payload = await fp.resolveEntityPayloadWithSharedCache(ctx);
  assert.equal(payload?.name, 'Example Org');

  const cp = loadCp(sharedLocalStorage);
  const warmName = await cp.getOrganizationName('222');
  assert.equal(warmName, 'Example Org');
});

test('shared cache entries expire per TTL, independent of which script wrote them', () => {
  const sharedLocalStorage = makeFakeStorage();
  const cp = loadCp(sharedLocalStorage);

  cp.setCachedDataInStorage('org', '333', { id: '333', name: 'Stale Org' }, -1);

  const fp = loadFp(sharedLocalStorage, '/org/333');
  assert.equal(fp.getCachedDataFromStorage('org', '333'), null);
});

test('CP: migrateLegacyOrgNameCacheKeys removes old pre-unification keys', () => {
  const sharedLocalStorage = makeFakeStorage();
  sharedLocalStorage.setItem('pdbCpConsolidated.orgNameCache.444', JSON.stringify({ v: 2, name: 'Old', expiresAt: Date.now() + 1e9 }));
  const cp = loadCp(sharedLocalStorage);

  cp.migrateLegacyOrgNameCacheKeys();

  assert.equal(sharedLocalStorage.getItem('pdbCpConsolidated.orgNameCache.444'), null);
});

test('FP: migrateLegacyApiPayloadCacheKeys removes old pre-unification keys', () => {
  const sharedLocalStorage = makeFakeStorage();
  sharedLocalStorage.setItem(
    'pdbFpConsolidated.apiPayloadCache.https://www.peeringdb.com/api/net/1',
    JSON.stringify({ v: 1, expiresAt: Date.now() + 1e9, payload: { id: '1' } }),
  );
  const fp = loadFp(sharedLocalStorage, '/net/1');

  fp.migrateLegacyApiPayloadCacheKeys();

  assert.equal(
    sharedLocalStorage.getItem('pdbFpConsolidated.apiPayloadCache.https://www.peeringdb.com/api/net/1'),
    null,
  );
});

test('CP: clearOrganizationNameCache sweeps the shared org.* namespace', async () => {
  const sharedLocalStorage = makeFakeStorage();
  const cp = loadCp(sharedLocalStorage, {
    'https://www.peeringdb.com/api/org/555': { data: [{ id: '555', name: 'Clearable Org' }] },
  });

  await cp.getOrganizationName('555');
  assert.ok(sharedLocalStorage.getItem('pdbAdmincom.cache.org.555'));

  cp.clearOrganizationNameCache();

  assert.equal(sharedLocalStorage.getItem('pdbAdmincom.cache.org.555'), null);
  assert.equal(cp.getCachedOrganizationName('555'), null);
});
