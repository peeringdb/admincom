'use strict';

// Tests for the "ASN search returned zero results -> redirect to CP" flow.
//
// Context: peeringdb.com's frontend used to route a quick-search for
// "AS<digits>" straight to /asn/<digits>, which 404'd server-side when the
// ASN didn't exist; the sibling asn-404-cp-search-redirect module detected
// that 404 page and bounced the admin to a CP network search instead. The
// site changed behavior: a search for "AS<digits>" now stays on
// /search?q=AS<digits> and renders a zero-matches results page instead of
// ever reaching /asn/<digits>, silently breaking that redirect. This module
// (asn-search-zero-result-cp-redirect) detects the new zero-result /search
// page instead. asn-404-cp-search-redirect itself is untouched -- a direct
// link to /asn/<digits> still 404s server-side (verified against the live
// site), so it's kept as a fallback for that path.
//
// Unlike asn-404-cp-search-redirect (deliberately left untested per
// fp-admin-ops-builders.test.js's header -- see there for why), this
// module's run() is exercised end-to-end here by stubbing
// window.location.replace directly on the shim's returned sandbox window,
// since the shim's fake location object has no such method by default. All
// expected values below were captured empirically from the real functions
// before being hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, el } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-fp-consolidated-tools.user.js');

function loadFp(opts = {}) {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbFpTestHooks__', hostname: 'www.peeringdb.com', ...opts });
}

function zeroResultElements() {
  return { '#search-list-view .mb-3': el({ innerText: 'About 0 results' }) };
}

function nonZeroResultElements(count) {
  return { '#search-list-view .mb-3': el({ innerText: `About ${count} results` }) };
}

test('extractAsnFromSearchQuery', async (t) => {
  const { hooks } = loadFp({ pathname: '/search', search: '?q=AS141743' });

  await t.test('matches an "AS<digits>" query', () => {
    assert.equal(hooks.extractAsnFromSearchQuery('AS141743'), '141743');
  });

  await t.test('is case-insensitive and tolerates a space after AS', () => {
    assert.equal(hooks.extractAsnFromSearchQuery('as 15169'), '15169');
    assert.equal(hooks.extractAsnFromSearchQuery('AS 64500'), '64500');
  });

  await t.test('rejects plain digits with no "AS" prefix', () => {
    assert.equal(hooks.extractAsnFromSearchQuery('141743'), '');
  });

  await t.test('rejects a non-ASN query (facility/org name)', () => {
    assert.equal(hooks.extractAsnFromSearchQuery('Equinix DA2'), '');
  });

  await t.test('rejects trailing junk after the digits', () => {
    assert.equal(hooks.extractAsnFromSearchQuery('AS141743x'), '');
  });

  await t.test('rejects an empty query', () => {
    assert.equal(hooks.extractAsnFromSearchQuery(''), '');
  });
});

test('isFrontendZeroResultSearchPage', async (t) => {
  await t.test('true for "About 0 results"', () => {
    const { hooks } = loadFp({ pathname: '/search', search: '?q=AS141743', elements: zeroResultElements() });
    assert.equal(hooks.isFrontendZeroResultSearchPage(), true);
  });

  await t.test('false for a non-zero result count', () => {
    const { hooks } = loadFp({ pathname: '/search', search: '?q=AS15169', elements: nonZeroResultElements(1) });
    assert.equal(hooks.isFrontendZeroResultSearchPage(), false);
  });

  await t.test('false when the summary element is missing entirely', () => {
    const { hooks } = loadFp({ pathname: '/search', search: '?q=AS141743' });
    assert.equal(hooks.isFrontendZeroResultSearchPage(), false);
  });
});

test('asn-search-zero-result-cp-redirect module', async (t) => {
  await t.test('match() is true only on the /search route', () => {
    const { hooks } = loadFp({ pathname: '/search', search: '?q=AS141743' });
    const mod = hooks.modules.find((m) => m.id === 'asn-search-zero-result-cp-redirect');
    assert.equal(mod.match(hooks.getRouteContext()), true);
  });

  await t.test('match() is false on an unrelated route', () => {
    const { hooks } = loadFp({ pathname: '/net/1234', search: '' });
    const mod = hooks.modules.find((m) => m.id === 'asn-search-zero-result-cp-redirect');
    assert.equal(mod.match(hooks.getRouteContext()), false);
  });

  await t.test('redirects to the CP network search when the ASN query has zero results', () => {
    const { hooks, window } = loadFp({ pathname: '/search', search: '?q=AS141743', elements: zeroResultElements() });
    const calls = [];
    window.location.replace = (url) => calls.push(url);
    const mod = hooks.modules.find((m) => m.id === 'asn-search-zero-result-cp-redirect');
    mod.run(hooks.getRouteContext());
    assert.deepEqual(calls, ['https://www.peeringdb.com/cp/peeringdb_server/network/?q=141743']);
  });

  await t.test('also redirects when the query is carried under the legacy term= param', () => {
    const { hooks, window } = loadFp({ pathname: '/search', search: '?term=AS141743', elements: zeroResultElements() });
    const calls = [];
    window.location.replace = (url) => calls.push(url);
    const mod = hooks.modules.find((m) => m.id === 'asn-search-zero-result-cp-redirect');
    mod.run(hooks.getRouteContext());
    assert.deepEqual(calls, ['https://www.peeringdb.com/cp/peeringdb_server/network/?q=141743']);
  });

  await t.test('does not redirect for a non-ASN search query', () => {
    const { hooks, window } = loadFp({ pathname: '/search', search: '?q=Equinix', elements: zeroResultElements() });
    const calls = [];
    window.location.replace = (url) => calls.push(url);
    const mod = hooks.modules.find((m) => m.id === 'asn-search-zero-result-cp-redirect');
    mod.run(hooks.getRouteContext());
    assert.deepEqual(calls, []);
  });

  await t.test('does not redirect when the ASN search actually has results', () => {
    const { hooks, window } = loadFp({ pathname: '/search', search: '?q=AS15169', elements: nonZeroResultElements(1) });
    const calls = [];
    window.location.replace = (url) => calls.push(url);
    const mod = hooks.modules.find((m) => m.id === 'asn-search-zero-result-cp-redirect');
    mod.run(hooks.getRouteContext());
    assert.deepEqual(calls, []);
  });
});
