'use strict';

// The test harness itself, pinned.
//
// This file exists because a gap in the harness -- not in the code under test
// -- is what let a critical bug ship. lib/admincom-common.js's fetchWithRetry
// reads response.headers.get('retry-after'), and the fake response used to
// expose only forEach(), so any 503 fixture threw TypeError before reaching
// the retry logic. The retry path was not merely untested; it was inexpressible.
// A harness whose limits are invisible produces confident, empty coverage, so
// the capabilities other tests depend on are asserted here directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, makeFakeResponse } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

test('fake response headers support get(), not just forEach()', () => {
  const res = makeFakeResponse(503, {}, { 'Retry-After': '3' });

  assert.equal(res.status, 503);
  assert.equal(res.ok, false);
  assert.equal(res.headers.get('Retry-After'), '3');
  assert.equal(res.headers.get('retry-after'), '3', 'header lookup must be case-insensitive');
  assert.equal(res.headers.get('absent'), null, 'a missing header reads as null, like the real API');
  assert.equal(res.headers.has('retry-after'), true);
});

test('a 2xx status is ok, a 4xx/5xx is not', () => {
  assert.equal(makeFakeResponse(200, {}).ok, true);
  assert.equal(makeFakeResponse(204, {}).ok, true);
  assert.equal(makeFakeResponse(404, {}).ok, false);
  assert.equal(makeFakeResponse(503, {}).ok, false);
});

test('fetchMap accepts a response descriptor alongside a bare body', async () => {
  const url = 'https://www.peeringdb.com/api/net/1';
  const { window } = loadScript(SCRIPT_PATH, {
    hooksKey: '__pdbDpTestHooks__',
    pathname: '/app/ticket',
    fetchMap: {
      [url]: { __response: true, status: 503, body: { detail: 'busy' }, headers: { 'Retry-After': '1' } },
      'https://www.peeringdb.com/api/net/2': { data: [{ id: 2 }] },
    },
  });

  const failing = await window.fetch(url);
  assert.equal(failing.status, 503);
  assert.equal(failing.headers.get('retry-after'), '1');
  assert.deepEqual(await failing.json(), { detail: 'busy' });

  // The bare-body form must keep working unchanged -- every pre-existing test
  // depends on it.
  const ok = await window.fetch('https://www.peeringdb.com/api/net/2');
  assert.equal(ok.status, 200);
  assert.equal(ok.ok, true);
  assert.deepEqual(await ok.json(), { data: [{ id: 2 }] });

  // An unmapped URL still 404s rather than throwing.
  const missing = await window.fetch('https://www.peeringdb.com/api/net/999');
  assert.equal(missing.status, 404);
});

test('every request is recorded with its method, so retries are observable', async () => {
  const url = 'https://www.peeringdb.com/api/netixlan/7';
  const { window, fetchCalls } = loadScript(SCRIPT_PATH, {
    hooksKey: '__pdbDpTestHooks__',
    pathname: '/app/ticket',
    fetchMap: { [url]: { data: [] } },
  });

  assert.equal(fetchCalls.length, 0, 'no requests before anything runs');

  await window.fetch(url);
  await window.fetch(url, { method: 'delete' });
  await window.fetch(url, { method: 'PUT', body: '{"speed":1000}' });

  assert.equal(fetchCalls.length, 3);
  assert.deepEqual(fetchCalls.map((c) => c.method), ['GET', 'DELETE', 'PUT'], 'method is captured and upper-cased');
  assert.equal(fetchCalls[0].url, url);
  assert.equal(fetchCalls[2].body, '{"speed":1000}');
});
