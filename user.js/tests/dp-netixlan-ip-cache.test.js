'use strict';

// Tests for DP's fetchNetixlanByIp cache path (staged IP-tooltip enrichment
// cluster). The function is @staged wip -- no production caller yet -- but
// staged code must still be correct: these cases pin the shared
// (type, id, data, ttl) cache signatures, the null-means-miss contract, and
// negative-caching of empty lookups, which were all wrong before the fix
// (single-string cache key, `cached !== undefined` miss-check that made the
// function unconditionally return null without ever fetching).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

const IP = '185.1.184.10';
const API_URL = `https://www.peeringdb.com/api/netixlan?ipaddr4=${encodeURIComponent(IP)}&depth=2`;
const NETIXLAN_ROW = { id: 42, asn: 64500, ipaddr4: IP, ix: { id: 7, name: 'Test-IX' } };

function loadDp(opts = {}) {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbDpTestHooks__', pathname: '/app/ticket', ...opts });
}

test('fetchNetixlanByIp cache behavior', async (t) => {
  await t.test('miss then hit: fetches once, second call served from the shared cache', async () => {
    const { hooks, fetchCalls } = loadDp({ fetchMap: { [API_URL]: { data: [NETIXLAN_ROW] } } });

    const first = await hooks.fetchNetixlanByIp(IP);
    assert.equal(first.id, 42);
    assert.equal(first.ix.name, 'Test-IX');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, API_URL);

    const second = await hooks.fetchNetixlanByIp(IP);
    assert.equal(second.id, 42);
    assert.equal(fetchCalls.length, 1, 'cache hit must not re-fetch');
  });

  await t.test('stores under the shared (type, id) cache key namespace', async () => {
    const { hooks, window } = loadDp({ fetchMap: { [API_URL]: { data: [NETIXLAN_ROW] } } });

    await hooks.fetchNetixlanByIp(IP);
    const storageKey = hooks.getSharedCacheStorageKey('netixlan_ip', IP);
    assert.ok(storageKey, 'cache key must be valid for the netixlan_ip type');
    const raw = window.localStorage.getItem(storageKey);
    assert.ok(raw, 'entry must be persisted under the shared cache key');
    assert.equal(JSON.parse(raw).data.id, 42);
  });

  await t.test('empty API result is negative-cached: returns null, second call does not re-fetch', async () => {
    const { hooks, fetchCalls } = loadDp({ fetchMap: { [API_URL]: { data: [] } } });

    assert.equal(await hooks.fetchNetixlanByIp(IP), null);
    assert.equal(fetchCalls.length, 1);
    assert.equal(await hooks.fetchNetixlanByIp(IP), null);
    assert.equal(fetchCalls.length, 1, 'negative-cache hit must not re-fetch');
  });

  await t.test('blank input returns null without fetching', async () => {
    const { hooks, fetchCalls } = loadDp({ fetchMap: {} });
    assert.equal(await hooks.fetchNetixlanByIp(''), null);
    assert.equal(await hooks.fetchNetixlanByIp(null), null);
    assert.equal(fetchCalls.length, 0);
  });
});
