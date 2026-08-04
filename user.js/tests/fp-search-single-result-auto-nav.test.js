'use strict';

// Tests for the "frontend /search returned exactly one result -> navigate
// straight to it" flow.
//
// Context: peeringdb.com's /search results page renders both a hidden
// list-view (#search-list-view, one <h4><a> per match, used here since it's
// a single flat list regardless of category) and a visible category-view.
// When a search narrows to exactly one match across every category, this
// module (search-single-result-auto-nav) skips the results page entirely and
// navigates the admin directly to that match, the same way a human would
// click the only link. It is independent of the ASN-specific zero-result
// redirect (asn-search-zero-result-cp-redirect) -- this one applies to any
// /search query, not just ASN lookups -- and the two are mutually exclusive
// since one requires a zero count and the other requires exactly one.
//
// Like asn-search-zero-result-cp-redirect, this module's run() is exercised
// end-to-end by stubbing window.location.replace directly on the shim's
// returned sandbox window. The "About N results" summary text and the
// #search-list-view markup shape were captured from a real single-result
// /search page fixture before being hardcoded here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, el } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-fp-consolidated-tools.user.js');

function loadFp(opts = {}) {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbFpTestHooks__', hostname: 'www.peeringdb.com', ...opts });
}

function resultElements(count, links) {
  const elements = { '#search-list-view .mb-3': el({ innerText: `About ${count} results` }) };
  const elementLists = { '#search-list-view .mb-4 h4 a': links };
  return { elements, elementLists };
}

test('getFrontendSearchResultCount', async (t) => {
  await t.test('parses the "About N results" summary', () => {
    const { hooks } = loadFp({
      pathname: '/search', search: '?q=150506',
      elements: { '#search-list-view .mb-3': el({ innerText: 'About 1 results' }) },
    });
    assert.equal(hooks.getFrontendSearchResultCount(), 1);
  });

  await t.test('parses a zero count', () => {
    const { hooks } = loadFp({
      pathname: '/search', search: '?q=AS141743',
      elements: { '#search-list-view .mb-3': el({ innerText: 'About 0 results' }) },
    });
    assert.equal(hooks.getFrontendSearchResultCount(), 0);
  });

  await t.test('returns NaN when the summary element is missing', () => {
    const { hooks } = loadFp({ pathname: '/search', search: '?q=foo' });
    assert.ok(Number.isNaN(hooks.getFrontendSearchResultCount()));
  });
});

test('getSingleFrontendSearchResultUrl', async (t) => {
  await t.test('returns the absolute URL of the single result link', () => {
    const { elements, elementLists } = resultElements(1, [el({ attrs: { href: '/net/39743' } })]);
    const { hooks } = loadFp({ pathname: '/search', search: '?q=150506', elements, elementLists });
    assert.equal(hooks.getSingleFrontendSearchResultUrl(), 'https://www.peeringdb.com/net/39743');
  });

  await t.test('returns "" when the result count is zero', () => {
    const { elements, elementLists } = resultElements(0, []);
    const { hooks } = loadFp({ pathname: '/search', search: '?q=AS141743', elements, elementLists });
    assert.equal(hooks.getSingleFrontendSearchResultUrl(), '');
  });

  await t.test('returns "" when the result count is more than one', () => {
    const { elements, elementLists } = resultElements(2, [
      el({ attrs: { href: '/net/1' } }),
      el({ attrs: { href: '/net/2' } }),
    ]);
    const { hooks } = loadFp({ pathname: '/search', search: '?q=Equinix', elements, elementLists });
    assert.equal(hooks.getSingleFrontendSearchResultUrl(), '');
  });

  await t.test('returns "" when the count says one but the link markup does not match (defensive)', () => {
    const { elements, elementLists } = resultElements(1, []);
    const { hooks } = loadFp({ pathname: '/search', search: '?q=150506', elements, elementLists });
    assert.equal(hooks.getSingleFrontendSearchResultUrl(), '');
  });
});

test('search-single-result-auto-nav module', async (t) => {
  await t.test('match() is true only on the /search route', () => {
    const { hooks } = loadFp({ pathname: '/search', search: '?q=150506' });
    const mod = hooks.modules.find((m) => m.id === 'search-single-result-auto-nav');
    assert.equal(mod.match(hooks.getRouteContext()), true);
  });

  await t.test('match() is false on an unrelated route', () => {
    const { hooks } = loadFp({ pathname: '/net/1234', search: '' });
    const mod = hooks.modules.find((m) => m.id === 'search-single-result-auto-nav');
    assert.equal(mod.match(hooks.getRouteContext()), false);
  });

  await t.test('navigates directly to the only result', () => {
    const { elements, elementLists } = resultElements(1, [el({ attrs: { href: '/net/39743' } })]);
    const { hooks, window } = loadFp({ pathname: '/search', search: '?q=150506', elements, elementLists });
    const calls = [];
    window.location.replace = (url) => calls.push(url);
    const mod = hooks.modules.find((m) => m.id === 'search-single-result-auto-nav');
    mod.run(hooks.getRouteContext());
    assert.deepEqual(calls, ['https://www.peeringdb.com/net/39743']);
  });

  await t.test('does not navigate when there are zero results', () => {
    const { elements, elementLists } = resultElements(0, []);
    const { hooks, window } = loadFp({ pathname: '/search', search: '?q=AS141743', elements, elementLists });
    const calls = [];
    window.location.replace = (url) => calls.push(url);
    const mod = hooks.modules.find((m) => m.id === 'search-single-result-auto-nav');
    mod.run(hooks.getRouteContext());
    assert.deepEqual(calls, []);
  });

  await t.test('does not navigate when there is more than one result', () => {
    const { elements, elementLists } = resultElements(2, [
      el({ attrs: { href: '/net/1' } }),
      el({ attrs: { href: '/net/2' } }),
    ]);
    const { hooks, window } = loadFp({ pathname: '/search', search: '?q=Equinix', elements, elementLists });
    const calls = [];
    window.location.replace = (url) => calls.push(url);
    const mod = hooks.modules.find((m) => m.id === 'search-single-result-auto-nav');
    mod.run(hooks.getRouteContext());
    assert.deepEqual(calls, []);
  });
});
