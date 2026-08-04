'use strict';

// Tests for DP's CP-fallback-on-404 flow (frontend entity kind -> CP model
// mapping, CP change-URL/API-probe-URL builders, and the entity-existence
// check backing it), the mailto decoration helpers, and the shared
// retry/abort error classifier. All expected values below were captured
// empirically from the real functions before being hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

function loadDp(opts = {}) {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbDpTestHooks__', pathname: '/app/ticket', ...opts }).hooks;
}

test('getCpModelForFrontendKind', async (t) => {
  const hooks = loadDp();

  await t.test('maps each supported frontend kind to its CP model name', () => {
    assert.equal(hooks.getCpModelForFrontendKind('asn'), 'network');
    assert.equal(hooks.getCpModelForFrontendKind('net'), 'network');
    assert.equal(hooks.getCpModelForFrontendKind('ix'), 'internetexchange');
    assert.equal(hooks.getCpModelForFrontendKind('fac'), 'facility');
    assert.equal(hooks.getCpModelForFrontendKind('org'), 'organization');
    assert.equal(hooks.getCpModelForFrontendKind('user'), 'user');
  });

  await t.test('normalizes case', () => {
    assert.equal(hooks.getCpModelForFrontendKind('ASN'), 'network');
  });

  await t.test('returns empty string for carrier (not yet mapped) and unknown/empty kinds', () => {
    assert.equal(hooks.getCpModelForFrontendKind('carrier'), '');
    assert.equal(hooks.getCpModelForFrontendKind('bogus'), '');
    assert.equal(hooks.getCpModelForFrontendKind(''), '');
  });
});

test('buildCpChangeUrl', async (t) => {
  const hooks = loadDp();

  await t.test('builds the canonical CP change URL', () => {
    assert.equal(hooks.buildCpChangeUrl('network', '123'), 'https://www.peeringdb.com/cp/peeringdb_server/network/123/change/');
  });

  await t.test('accepts a numeric id', () => {
    assert.equal(hooks.buildCpChangeUrl('network', 123), 'https://www.peeringdb.com/cp/peeringdb_server/network/123/change/');
  });

  await t.test('lowercases the model name', () => {
    assert.equal(hooks.buildCpChangeUrl('NETWORK', '123'), 'https://www.peeringdb.com/cp/peeringdb_server/network/123/change/');
  });

  await t.test('rejects a non-numeric id', () => {
    assert.equal(hooks.buildCpChangeUrl('network', 'abc'), '');
  });

  await t.test('rejects an empty model', () => {
    assert.equal(hooks.buildCpChangeUrl('', '123'), '');
  });
});

test('getFrontendExistenceProbeUrl', async (t) => {
  const hooks = loadDp();

  await t.test('builds the API probe URL for each supported kind', () => {
    assert.equal(hooks.getFrontendExistenceProbeUrl('net', '123'), 'https://www.peeringdb.com/api/net/123');
    assert.equal(hooks.getFrontendExistenceProbeUrl('ix', '5'), 'https://www.peeringdb.com/api/ix/5');
    assert.equal(hooks.getFrontendExistenceProbeUrl('fac', '5'), 'https://www.peeringdb.com/api/fac/5');
    assert.equal(hooks.getFrontendExistenceProbeUrl('org', '5'), 'https://www.peeringdb.com/api/org/5');
    assert.equal(hooks.getFrontendExistenceProbeUrl('user', '5'), 'https://www.peeringdb.com/api/user/5');
  });

  await t.test('returns empty for a kind not in the probe mapping (e.g. asn)', () => {
    assert.equal(hooks.getFrontendExistenceProbeUrl('asn', '5'), '');
  });

  await t.test('returns empty for a non-numeric id', () => {
    assert.equal(hooks.getFrontendExistenceProbeUrl('net', 'abc'), '');
  });
});

test('isFrontendEntityMissing', async (t) => {
  await t.test('returns false when the probe URL resolves OK', async () => {
    const hooks = loadDp({ fetchMap: { 'https://www.peeringdb.com/api/net/123': { data: [{ id: 123 }] } } });
    assert.equal(await hooks.isFrontendEntityMissing('net', '123'), false);
  });

  await t.test('returns true when the probe URL 404s (unmapped in fetchMap)', async () => {
    const hooks = loadDp({ fetchMap: {} });
    assert.equal(await hooks.isFrontendEntityMissing('net', '999'), true);
  });

  await t.test('returns false without fetching for an unsupported kind', async () => {
    const hooks = loadDp({ fetchMap: {} });
    assert.equal(await hooks.isFrontendEntityMissing('carrier', '123'), false);
  });

  await t.test('returns false for a non-numeric id', async () => {
    const hooks = loadDp({ fetchMap: {} });
    assert.equal(await hooks.isFrontendEntityMissing('net', 'abc'), false);
  });
});

test('extractMailtoAddress', async (t) => {
  const hooks = loadDp();

  await t.test('extracts a plain mailto address', () => {
    assert.equal(hooks.extractMailtoAddress('mailto:foo@example.com'), 'foo@example.com');
  });

  await t.test('strips a trailing query string (e.g. ?subject=)', () => {
    assert.equal(hooks.extractMailtoAddress('mailto:foo@example.com?subject=Hi'), 'foo@example.com');
  });

  await t.test('the mailto: scheme match is case-insensitive', () => {
    assert.equal(hooks.extractMailtoAddress('MAILTO:Foo@Example.com'), 'Foo@Example.com');
  });

  await t.test('percent-encoded addresses are decoded', () => {
    assert.equal(hooks.extractMailtoAddress('mailto:foo%2Bbar@example.com'), 'foo+bar@example.com');
  });

  await t.test('a non-mailto href returns empty string', () => {
    assert.equal(hooks.extractMailtoAddress('https://example.com'), '');
  });

  await t.test('empty input and a bare "mailto:" both return empty string', () => {
    assert.equal(hooks.extractMailtoAddress(''), '');
    assert.equal(hooks.extractMailtoAddress('mailto:'), '');
  });
});

test('buildCpEmailSearchUrl', async (t) => {
  const hooks = loadDp();

  await t.test('builds the CP account email-search URL', () => {
    assert.equal(hooks.buildCpEmailSearchUrl('foo@example.com'), 'https://www.peeringdb.com/cp/account/emailaddress/?q=foo%40example.com');
  });

  await t.test('trims surrounding whitespace before encoding', () => {
    assert.equal(hooks.buildCpEmailSearchUrl('  foo@example.com  '), 'https://www.peeringdb.com/cp/account/emailaddress/?q=foo%40example.com');
  });

  await t.test('returns empty string for empty input', () => {
    assert.equal(hooks.buildCpEmailSearchUrl(''), '');
  });

  await t.test('URL-encodes special characters', () => {
    assert.equal(hooks.buildCpEmailSearchUrl('foo+bar@example.com'), 'https://www.peeringdb.com/cp/account/emailaddress/?q=foo%2Bbar%40example.com');
  });
});

test('classifyError', async (t) => {
  const hooks = loadDp();

  await t.test('429 and 503 classify as transient/retryable with a 5s backoff', () => {
    for (const status of [429, 503]) {
      const r = hooks.classifyError(status);
      assert.equal(r.type, 'transient');
      assert.equal(r.retryable, true);
      assert.equal(r.backoffMs, 5000);
    }
  });

  await t.test('404 classifies as not_found, non-retryable, with a 1.5h negative-cache TTL', () => {
    const r = hooks.classifyError(404);
    assert.equal(r.type, 'not_found');
    assert.equal(r.retryable, false);
    assert.equal(r.ttl, 1.5 * 3600 * 1000);
  });

  await t.test('401 and 403 classify as auth/non-retryable', () => {
    for (const status of [401, 403]) {
      const r = hooks.classifyError(status);
      assert.equal(r.type, 'auth');
      assert.equal(r.retryable, false);
    }
  });

  await t.test('5xx (other than 503) classifies as server/retryable with a 10s backoff', () => {
    for (const status of [500, 502]) {
      const r = hooks.classifyError(status);
      assert.equal(r.type, 'server');
      assert.equal(r.retryable, true);
      assert.equal(r.backoffMs, 10000);
    }
  });

  await t.test('a missing/null status classifies as network/retryable with a 3s backoff', () => {
    for (const status of [undefined, null]) {
      const r = hooks.classifyError(status);
      assert.equal(r.type, 'network');
      assert.equal(r.retryable, true);
      assert.equal(r.backoffMs, 3000);
    }
  });

  await t.test('an unrecognized status classifies as unknown/non-retryable', () => {
    const r = hooks.classifyError(418);
    assert.equal(r.type, 'unknown');
    assert.equal(r.retryable, false);
    assert.equal(r.label, 'Unknown error (HTTP 418)');
  });
});
