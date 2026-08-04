'use strict';

// Tests for the retry/backoff decision logic in lib/admincom-common.js --
// shared by every GM_xmlhttpRequest/fetch call in all three scripts via
// gmRequestWithRetry/fetchWithRetry. Only the pure decision functions are
// tested directly (parseRetryAfterMs/classifyRetry); the two wrappers that
// actually perform requests are integration-tested indirectly through the
// CP/FP/DP fetch* functions already covered elsewhere.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadPureLib } = require('./helpers/pure-lib-loader');

const lib = loadPureLib(
  path.join(__dirname, '..', 'lib', 'admincom-common.js'),
  ['parseRetryAfterMs', 'classifyRetry'],
);

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
