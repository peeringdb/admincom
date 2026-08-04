'use strict';

// Tests for FP's admin-ops CP URL builders (behind the admin-console-link
// and admin-workflow-buttons modules -- load-bearing for every admin-ops
// action a user takes on an entity page) and the report-string builders
// (formatEntityIdsBundle/formatAdminTriageSummary) that summarize the
// current page for copy/paste into a ticket or chat. All expected values
// below were captured empirically from the real functions before being
// hardcoded.
//
// fix-double-slashes' redirect-trigger regex and asn-404-cp-search-redirect's
// URL-builder core are deliberately NOT covered here: both are inline
// closures inside modules[].run() (not standalone exposed functions), and
// exercising them would require mocking window.location.href reassignment
// and window.location.replace() rather than asserting a pure return value --
// a different, heavier kind of test than the rest of this file. The
// URL-builder half (buildCpNetworkSearchUrlByAsn) is already covered above.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, el } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-fp-consolidated-tools.user.js');

function loadFp(opts = {}) {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbFpTestHooks__', hostname: 'www.peeringdb.com', ...opts }).hooks;
}

test('buildCpNetworkSearchUrlByAsn', async (t) => {
  const hooks = loadFp({ pathname: '/net/123' });

  await t.test('builds a CP network search URL from plain digits', () => {
    assert.equal(hooks.buildCpNetworkSearchUrlByAsn('64500'), 'https://www.peeringdb.com/cp/peeringdb_server/network/?q=64500');
  });

  await t.test('strips non-digit characters (e.g. "AS " prefix, commas)', () => {
    assert.equal(hooks.buildCpNetworkSearchUrlByAsn('AS 64,500'), 'https://www.peeringdb.com/cp/peeringdb_server/network/?q=64500');
  });

  await t.test('returns empty string for empty input or a value with no digits', () => {
    assert.equal(hooks.buildCpNetworkSearchUrlByAsn(''), '');
    assert.equal(hooks.buildCpNetworkSearchUrlByAsn('abc'), '');
  });
});

test('buildCpOrgChangeUrl', async (t) => {
  const hooks = loadFp({ pathname: '/net/123' });

  await t.test('builds the CP organization change URL for a valid numeric id', () => {
    assert.equal(hooks.buildCpOrgChangeUrl('55'), 'https://www.peeringdb.com/cp/peeringdb_server/organization/55/change/');
    assert.equal(hooks.buildCpOrgChangeUrl(55), 'https://www.peeringdb.com/cp/peeringdb_server/organization/55/change/');
  });

  await t.test('returns empty string for a non-numeric or empty id', () => {
    assert.equal(hooks.buildCpOrgChangeUrl('abc'), '');
    assert.equal(hooks.buildCpOrgChangeUrl(''), '');
  });
});

test('buildCpUserManagerUrl', async (t) => {
  const hooks = loadFp({ pathname: '/net/123' });

  await t.test('appends the #org-user-manager anchor to a valid org change URL', () => {
    assert.equal(
      hooks.buildCpUserManagerUrl('55'),
      'https://www.peeringdb.com/cp/peeringdb_server/organization/55/change/#org-user-manager',
    );
  });

  await t.test('returns empty string when the underlying org change URL is invalid', () => {
    assert.equal(hooks.buildCpUserManagerUrl('abc'), '');
  });
});

test('buildCpEntitySearchUrl', async (t) => {
  const hooks = loadFp({ pathname: '/net/123' });

  await t.test('maps each supported entity type to its CP model search URL', () => {
    assert.equal(hooks.buildCpEntitySearchUrl('net', '64500'), 'https://www.peeringdb.com/cp/peeringdb_server/network/?q=64500');
    assert.equal(hooks.buildCpEntitySearchUrl('org', '55'), 'https://www.peeringdb.com/cp/peeringdb_server/organization/?q=55');
    assert.equal(hooks.buildCpEntitySearchUrl('fac', '10'), 'https://www.peeringdb.com/cp/peeringdb_server/facility/?q=10');
    assert.equal(hooks.buildCpEntitySearchUrl('ix', '10'), 'https://www.peeringdb.com/cp/peeringdb_server/internetexchange/?q=10');
    assert.equal(hooks.buildCpEntitySearchUrl('carrier', '10'), 'https://www.peeringdb.com/cp/peeringdb_server/carrier/?q=10');
  });

  await t.test('returns empty string for an unmapped type or a missing id', () => {
    assert.equal(hooks.buildCpEntitySearchUrl('bogus', '10'), '');
    assert.equal(hooks.buildCpEntitySearchUrl('net', ''), '');
  });

  await t.test('URL-encodes the id', () => {
    assert.equal(hooks.buildCpEntitySearchUrl('net', 'A B'), 'https://www.peeringdb.com/cp/peeringdb_server/network/?q=A%20B');
  });
});

test('buildCpAccountSearchUrl', async (t) => {
  const hooks = loadFp({ pathname: '/net/123' });

  await t.test('builds the CP account email-search URL', () => {
    assert.equal(hooks.buildCpAccountSearchUrl('foo@example.com'), 'https://www.peeringdb.com/cp/account/emailaddress/?q=foo%40example.com');
  });

  await t.test('trims surrounding whitespace before encoding', () => {
    assert.equal(hooks.buildCpAccountSearchUrl('  foo@example.com  '), 'https://www.peeringdb.com/cp/account/emailaddress/?q=foo%40example.com');
  });

  await t.test('returns empty string for empty input', () => {
    assert.equal(hooks.buildCpAccountSearchUrl(''), '');
  });
});

test('formatEntityIdsBundle', async (t) => {
  await t.test('summarizes a fully-populated net entity page', () => {
    const hooks = loadFp({
      pathname: '/net/1234',
      elements: {
        '[data-edit-name="org_id"]': el({ attrs: { 'data-edit-value': '55' } }),
        '[data-edit-name="asn"]': el({ attrs: { 'data-edit-value': '64500' } }),
      },
      elementLists: {
        '#api-listing-netixlan .item[data-edit-id], #api-listing-netixlan .row.item[data-edit-id]': [
          el({ attrs: { 'data-edit-id': '10' } }),
          el({ attrs: { 'data-edit-id': '11' } }),
        ],
        '#api-listing-netfac .item[data-edit-id], #api-listing-netfac .row.item[data-edit-id]': [
          el({ attrs: { 'data-edit-id': '20' } }),
        ],
        '#api-listing-poc .item[data-edit-id], #api-listing-poc .row[data-edit-id]': [],
      },
    });
    assert.equal(
      hooks.formatEntityIdsBundle(),
      'type=net; id=1234; org_id=55; asn=64500; netixlan_count=2; netfac_count=1; poc_count=0; url=https://www.peeringdb.com/net/1234',
    );
  });

  await t.test('falls back to "n/a" for every field on a non-entity page with no data', () => {
    const hooks = loadFp({ pathname: '/' });
    assert.equal(
      hooks.formatEntityIdsBundle(),
      'type=n/a; id=n/a; org_id=n/a; asn=n/a; netixlan_count=0; netfac_count=0; poc_count=0; url=https://www.peeringdb.com/',
    );
  });
});

test('formatAdminTriageSummary', async (t) => {
  await t.test('summarizes a fully-populated net entity page as multiline text', () => {
    const hooks = loadFp({
      pathname: '/net/1234',
      elements: {
        '[data-edit-name="name"]': el({ attrs: { 'data-edit-value': 'Example Net' } }),
        '[data-edit-name="org_id"]': el({ attrs: { 'data-edit-value': '55' } }),
        '[data-edit-name="asn"]': el({ attrs: { 'data-edit-value': '64500' } }),
        '[data-edit-name="website"]': el({ attrs: { 'data-edit-value': 'https://example.com' } }),
        '[data-edit-name="irr_as_set"]': el({ attrs: { 'data-edit-value': 'AS-EXAMPLE' } }),
        '[data-edit-name="info_traffic"]': el({ attrs: { 'data-edit-value': '10-20Gbps' } }),
      },
    });
    assert.equal(
      hooks.formatAdminTriageSummary(),
      [
        'Entity: NET #1234',
        'Name: Example Net',
        'Org ID: 55',
        'ASN: 64500',
        'Website: https://example.com',
        'IRR AS-SET: AS-EXAMPLE',
        'Traffic: 10-20Gbps',
        'Source: https://www.peeringdb.com/net/1234',
      ].join('\n'),
    );
  });

  await t.test('falls back to "n/a" for every field on a non-entity page with no data', () => {
    const hooks = loadFp({ pathname: '/' });
    assert.equal(
      hooks.formatAdminTriageSummary(),
      [
        'Entity: N/A #n/a',
        'Name: n/a',
        'Org ID: n/a',
        'ASN: n/a',
        'Website: n/a',
        'IRR AS-SET: n/a',
        'Traffic: n/a',
        'Source: https://www.peeringdb.com/',
      ].join('\n'),
    );
  });

  await t.test('falls back to plain input values when data-edit attributes are absent', () => {
    const hooks = loadFp({
      pathname: '/net/1234',
      elements: {
        '#id_name': el({ value: 'Fallback Net' }),
        '#id_org': el({ value: '77' }),
        '#id_asn': el({ value: '64501' }),
        '#id_website': el({ value: 'https://fallback.example.com' }),
        '#id_irr_as_set': el({ value: 'AS-FALLBACK' }),
      },
    });
    assert.equal(
      hooks.formatAdminTriageSummary(),
      [
        'Entity: NET #1234',
        'Name: Fallback Net',
        'Org ID: 77',
        'ASN: 64501',
        'Website: https://fallback.example.com',
        'IRR AS-SET: AS-FALLBACK',
        'Traffic: n/a',
        'Source: https://www.peeringdb.com/net/1234',
      ].join('\n'),
    );
  });
});
