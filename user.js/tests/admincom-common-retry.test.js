'use strict';

// Tests for the retry/backoff logic in lib/admincom-common.js -- shared by
// every GM_xmlhttpRequest/fetch call in all three scripts via
// gmRequestWithRetry/fetchWithRetry.
//
// The pure decision functions (parseRetryAfterMs/classifyRetry) are tested
// directly through pure-lib-loader. fetchWithRetry needs window/fetch, so per
// pure-lib-loader's own docs it is loaded through browser-shim instead, from a
// generated .user.js -- which means these assertions run against the real
// inlined code an admin installs, not a re-implementation.
//
// This file previously claimed the wrappers were "integration-tested
// indirectly through the CP/FP/DP fetch* functions already covered elsewhere".
// That was not true: no test ever returned a retryable status, and the fake
// response had no headers.get() for fetchWithRetry to read Retry-After from,
// so the retry path could not execute at all. It is what let writes be
// replayed unnoticed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadPureLib } = require('./helpers/pure-lib-loader');
const { loadScript } = require('./helpers/browser-shim');

const lib = loadPureLib(
  path.join(__dirname, '..', 'lib', 'admincom-common.js'),
  ['parseRetryAfterMs', 'classifyRetry'],
);

const DP_SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');
const BUSY_URL = 'https://www.peeringdb.com/api/netixlan/7';

/**
 * Loads the real fetchWithRetry with a URL that always answers 503.
 * Retry-After: 0 keeps the backoff at zero so the test doesn't sleep through
 * the 1s/2s exponential curve.
 */
function loadBusyEndpoint() {
  return loadScript(DP_SCRIPT_PATH, {
    hooksKey: '__pdbDpTestHooks__',
    pathname: '/app/ticket',
    fetchMap: {
      [BUSY_URL]: { __response: true, status: 503, body: {}, headers: { 'Retry-After': '0' } },
    },
  });
}

test('parseRetryAfterMs', async (t) => {
  await t.test('falsy input returns null', () => {
    assert.equal(lib.parseRetryAfterMs(null), null);
    assert.equal(lib.parseRetryAfterMs(undefined), null);
    assert.equal(lib.parseRetryAfterMs(''), null);
  });

  await t.test('a delay-seconds value converts to milliseconds', () => {
    assert.equal(lib.parseRetryAfterMs('5'), 5000);
    assert.equal(lib.parseRetryAfterMs('0'), 0);
  });

  await t.test('a negative delay-seconds value is clamped to zero, not negative', () => {
    assert.equal(lib.parseRetryAfterMs('-5'), 0);
  });

  await t.test('an unparseable value returns null', () => {
    assert.equal(lib.parseRetryAfterMs('not-a-date-or-number'), null);
  });

  await t.test('an HTTP-date value converts to a millisecond delay from now', () => {
    const future = new Date(Date.now() + 10000).toUTCString();
    const ms = lib.parseRetryAfterMs(future);
    // Allow slack for time elapsed between building the fixture and the
    // function call reading Date.now() again -- assert a range, not an
    // exact value.
    assert.ok(ms > 8000 && ms <= 10000, `expected ms in (8000, 10000], got ${ms}`);
  });

  await t.test('a past HTTP-date value is clamped to zero, not negative', () => {
    const past = new Date(Date.now() - 10000).toUTCString();
    assert.equal(lib.parseRetryAfterMs(past), 0);
  });
});

test('classifyRetry', async (t) => {
  await t.test('a retryable status (429/502/503/504) is retryable with exponential backoff', () => {
    assert.deepEqual(lib.classifyRetry({ status: 429, attempt: 1 }), { retryable: true, backoffMs: 1000 });
    assert.deepEqual(lib.classifyRetry({ status: 502, attempt: 1 }), { retryable: true, backoffMs: 1000 });
    assert.deepEqual(lib.classifyRetry({ status: 503, attempt: 1 }), { retryable: true, backoffMs: 1000 });
    assert.deepEqual(lib.classifyRetry({ status: 504, attempt: 1 }), { retryable: true, backoffMs: 1000 });
  });

  await t.test('a non-retryable HTTP status is not retryable', () => {
    assert.deepEqual(lib.classifyRetry({ status: 500, attempt: 1 }), { retryable: false, backoffMs: 0 });
    assert.deepEqual(lib.classifyRetry({ status: 404, attempt: 1 }), { retryable: false, backoffMs: 0 });
  });

  await t.test('a null status (network-level failure) is retryable', () => {
    assert.deepEqual(lib.classifyRetry({ status: null, attempt: 1 }), { retryable: true, backoffMs: 1000 });
  });

  await t.test('backoff doubles per attempt, capped at REQUEST_TIMEOUT_MS (15000)', () => {
    assert.equal(lib.classifyRetry({ status: 429, attempt: 1 }).backoffMs, 1000);
    assert.equal(lib.classifyRetry({ status: 429, attempt: 2 }).backoffMs, 2000);
    assert.equal(lib.classifyRetry({ status: 429, attempt: 4 }).backoffMs, 8000);
    assert.equal(lib.classifyRetry({ status: 429, attempt: 10 }).backoffMs, 15000);
  });

  await t.test('a Retry-After header overrides the exponential backoff', () => {
    assert.deepEqual(
      lib.classifyRetry({ status: 429, attempt: 1, retryAfterHeader: '2' }),
      { retryable: true, backoffMs: 2000 },
    );
  });
});

test('fetchWithRetry only replays safe methods', async (t) => {
  await t.test('GET is retried up to MAX_RETRIES', async () => {
    const { hooks, fetchCalls } = loadBusyEndpoint();
    const res = await hooks.fetchWithRetry(BUSY_URL);
    assert.equal(res.status, 503, 'the final response is still surfaced, not swallowed');
    assert.equal(fetchCalls.length, 3, 'GET should exhaust MAX_RETRIES');
    assert.ok(fetchCalls.every((c) => c.method === 'GET'));
  });

  // The three below are the actual defect. Each previously issued 3 requests:
  // a 502/503/504 means the *response* was lost, not necessarily the request,
  // so replaying a write re-applies an operation that may already have landed.
  for (const method of ['POST', 'PUT', 'DELETE']) {
    await t.test(`${method} is not retried`, async () => {
      const { hooks, fetchCalls } = loadBusyEndpoint();
      const res = await hooks.fetchWithRetry(BUSY_URL, { method });
      assert.equal(res.status, 503);
      assert.equal(fetchCalls.length, 1, `${method} must be issued exactly once`);
    });
  }

  await t.test('a write can still opt in explicitly', async () => {
    const { hooks, fetchCalls } = loadBusyEndpoint();
    await hooks.fetchWithRetry(BUSY_URL, { method: 'DELETE', retryWrites: true });
    assert.equal(fetchCalls.length, 3, 'retryWrites: true restores the old behavior on request');
  });

  await t.test('retry: false still disables retries for a GET', async () => {
    const { hooks, fetchCalls } = loadBusyEndpoint();
    await hooks.fetchWithRetry(BUSY_URL, { retry: false });
    assert.equal(fetchCalls.length, 1);
  });

  await t.test('a non-retryable status is returned immediately for any method', async () => {
    const { hooks, fetchCalls } = loadScript(DP_SCRIPT_PATH, {
      hooksKey: '__pdbDpTestHooks__',
      pathname: '/app/ticket',
      fetchMap: { [BUSY_URL]: { __response: true, status: 404, body: {} } },
    });
    const res = await hooks.fetchWithRetry(BUSY_URL);
    assert.equal(res.status, 404);
    assert.equal(fetchCalls.length, 1, '404 is not in RETRYABLE_STATUS');
  });
});

test('classifyRetry refuses non-safe methods unless opted in', async (t) => {
  await t.test('safe methods stay retryable', () => {
    assert.equal(lib.classifyRetry({ status: 503, attempt: 1, method: 'GET' }).retryable, true);
    assert.equal(lib.classifyRetry({ status: 503, attempt: 1, method: 'HEAD' }).retryable, true);
    assert.equal(lib.classifyRetry({ status: 503, attempt: 1, method: 'get' }).retryable, true, 'case-insensitive');
  });

  await t.test('writes are refused', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal(lib.classifyRetry({ status: 503, attempt: 1, method }).retryable, false, method);
    }
  });

  await t.test('retryWrites opts a write back in', () => {
    assert.equal(lib.classifyRetry({ status: 503, attempt: 1, method: 'DELETE', retryWrites: true }).retryable, true);
  });

  await t.test('an omitted method is treated as GET', () => {
    assert.equal(lib.classifyRetry({ status: 503, attempt: 1 }).retryable, true);
  });
});
