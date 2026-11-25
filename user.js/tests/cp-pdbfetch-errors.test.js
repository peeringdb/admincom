'use strict';

// pdbFetch's failure contract.
//
// It used to resolve to null for every failure mode -- HTTP error, JSON parse
// failure, transport error, timeout. That silently turned `catch` blocks around
// it into dead code. fetchRecentNetixlanChanges is the clearest casualty: its
// first `try` always reached its return, so a rejected updated__gte filter
// reported "0 rows, no error" and the client-side fallback below it could never
// run. An admin verifying a renumber would conclude nothing had changed.
//
// These cases pin the new contract: a resolved value is always a parsed
// payload, and every failure rejects with a PdbFetchError.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js');
const API = 'https://www.peeringdb.com/api';

function loadCp(fetchMap = {}) {
  return loadScript(SCRIPT_PATH, {
    hooksKey: '__pdbCpTestHooks__',
    pathname: '/cp/peeringdb_server/networkixlan/',
    fetchMap,
  });
}

test('pdbFetch rejects rather than resolving null', async (t) => {
  await t.test('an HTTP error rejects with a typed, inspectable error', async () => {
    const url = `${API}/net/1`;
    const { hooks } = loadCp({ [url]: { __response: true, status: 500, body: {} } });

    await assert.rejects(
      () => hooks.pdbFetch(url),
      (err) => {
        assert.equal(err.name, 'PdbFetchError', 'callers need to distinguish this from a bug');
        assert.equal(err.status, 500);
        assert.equal(err.url, url);
        assert.equal(err.detail.type, 'http');
        return true;
      },
    );
  });

  await t.test('an unmapped URL (404) rejects too', async () => {
    const { hooks } = loadCp({});
    await assert.rejects(() => hooks.pdbFetch(`${API}/net/999`), { name: 'PdbFetchError' });
  });

  await t.test('a successful response still resolves to the parsed payload', async () => {
    const url = `${API}/net/2`;
    const { hooks } = loadCp({ [url]: { data: [{ id: 2, name: 'Example Net' }] } });
    const payload = await hooks.pdbFetch(url);
    assert.equal(payload.data[0].name, 'Example Net');
  });
});

test('fetchRecentNetixlanChanges falls back to client-side filtering', async (t) => {
  const ixlanId = '42';
  const unfiltered = `${API}/netixlan?ixlan_id=42&depth=0&limit=250`;

  await t.test('the fallback runs when the server-side filter is rejected', async () => {
    // The whole point of the fix: this path was unreachable before, because the
    // failing pdbFetch returned null instead of throwing and the try returned
    // "0 rows, no error" regardless.
    const { hooks, fetchCalls } = loadCp({
      [unfiltered]: {
        data: [
          { id: 1, updated: new Date().toISOString() },
          { id: 2, updated: '2001-01-01T00:00:00Z' },
        ],
      },
    });

    const result = await hooks.fetchRecentNetixlanChanges(ixlanId, 60);

    assert.equal(result.source, 'client-filter', 'must report which path produced the rows');
    assert.equal(result.error, '');
    assert.equal(result.rows.length, 1, 'the stale row is filtered out by date');
    assert.equal(result.rows[0].id, 1);
    assert.equal(fetchCalls.length, 2, 'server-filter attempt, then the fallback');
    assert.ok(fetchCalls[0].url.includes('updated__gte'), 'server-side filter is still tried first');
  });

  await t.test('both attempts failing reports an error instead of an empty success', async () => {
    const { hooks } = loadCp({});
    const result = await hooks.fetchRecentNetixlanChanges(ixlanId, 60);

    assert.equal(result.error, 'fetch-failed', 'silence here is what misled an admin mid-renumber');
    assert.equal(result.rows.length, 0);
    assert.equal(result.source, '');
  });

});
