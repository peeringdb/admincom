'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, FakeElement } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

const NET_URL = 'https://www.peeringdb.com/api/net?id=2906&status=ok&depth=0&limit=1';
const NET_BY_ASN_URL = 'https://www.peeringdb.com/api/net?asn=2906&status=ok&depth=0&limit=1';
const IX_URL = 'https://www.peeringdb.com/api/ix?id=26&status=ok&depth=0&limit=1';
const FAC_URL = 'https://www.peeringdb.com/api/fac?id=207&status=ok&depth=0&limit=1';
const CARRIER_URL = 'https://www.peeringdb.com/api/carrier?id=45&status=ok&depth=0&limit=1';
const ORG_URL = (id) => `https://www.peeringdb.com/api/org?id=${id}&depth=1&limit=1`;

const NET_ROW = { id: '2906', name: 'Netflix, Inc.', name_long: '', asn: 2906, org_id: '111' };
const IX_ROW = { id: '26', name: 'DE-CIX Frankfurt', name_long: '', org_id: '222' };
const FAC_ROW = { id: '207', name: 'Equinix DC2', name_long: '', org_id: '333' };
const CARRIER_ROW = { id: '45', name: 'Zayo', name_long: '', org_id: '444' };
const ORG_ROW = (id, name, users = []) => ({ id, name, user_set: users });

/** Loads the DP script with a given fetchMap and returns its test hooks. */
function loadDp(fetchMap = {}) {
  const { hooks } = loadScript(SCRIPT_PATH, {
    hooksKey: '__pdbDpTestHooks__',
    pathname: '/app/ticket',
    fetchMap,
  });
  return hooks;
}

/** Builds a fake existing-anchor as it would appear pasted into a ticket message. */
function makeEntityAnchor(href) {
  const anchor = new FakeElement('a');
  anchor.href = href;
  return anchor;
}

test('parsePeeringDbEntityFromHref recognizes carrier links (previously unrecognized)', () => {
  const hooks = loadDp();
  const info = hooks.parsePeeringDbEntityFromHref('https://www.peeringdb.com/carrier/45');
  assert.equal(info?.kind, 'carrier');
  assert.equal(info?.id, '45');
});

test('net link gets an org shortcut inserted after it', async () => {
  const hooks = loadDp({
    [NET_URL]: { data: [NET_ROW] },
    [ORG_URL('111')]: { data: [ORG_ROW('111', 'Netflix, Inc.', [{ email: 'poc@netflix.com', user_class: 'Technical', name: 'Jane Doe' }])] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/net/2906');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'net', id: '2906' });

  assert.match(anchor.title, /^net\/2906 \| Netflix, Inc\. \| AS2906 \| Org Netflix, Inc\. \| POCs/);
  assert.equal(anchor.nextElementSibling?.tagName, 'A');
  assert.equal(anchor.nextElementSibling?.href, 'https://www.peeringdb.com/org/111');
  assert.equal(anchor.nextElementSibling?.textContent, '🏛');
  assert.equal(anchor.nextElementSibling?.title, 'Open org "Netflix, Inc." in PeeringDB');
});

test('fac link gets name hydration AND an org shortcut (previously zero hydration at all)', async () => {
  const hooks = loadDp({
    [FAC_URL]: { data: [FAC_ROW] },
    [ORG_URL('333')]: { data: [ORG_ROW('333', 'Equinix, Inc.')] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/fac/207');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'fac', id: '207' });

  assert.equal(anchor.title, 'fac/207 | Equinix DC2 | Org Equinix, Inc.');
  assert.equal(anchor.nextElementSibling?.href, 'https://www.peeringdb.com/org/333');
});

test('ix link gains org resolution (previously name-only, no org)', async () => {
  const hooks = loadDp({
    [IX_URL]: { data: [IX_ROW] },
    [ORG_URL('222')]: { data: [ORG_ROW('222', 'DE-CIX Management GmbH')] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/ix/26');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'ix', id: '26' });

  assert.equal(anchor.title, 'ix/26 | DE-CIX Frankfurt | Org DE-CIX Management GmbH');
  assert.equal(anchor.nextElementSibling?.href, 'https://www.peeringdb.com/org/222');
});

test('carrier link is now recognized, hydrated, and gets an org shortcut', async () => {
  const hooks = loadDp({
    [CARRIER_URL]: { data: [CARRIER_ROW] },
    [ORG_URL('444')]: { data: [ORG_ROW('444', 'Zayo Group')] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/carrier/45');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'carrier', id: '45' });

  assert.equal(anchor.title, 'carrier/45 | Zayo | Org Zayo Group');
  assert.equal(anchor.nextElementSibling?.href, 'https://www.peeringdb.com/org/444');
});

test('pasted /asn/{asn} link gets an org shortcut too', async () => {
  const hooks = loadDp({
    [NET_BY_ASN_URL]: { data: [NET_ROW] },
    [ORG_URL('111')]: { data: [ORG_ROW('111', 'Netflix, Inc.')] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/asn/2906');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'asn', id: '2906' });

  assert.equal(anchor.title, 'AS2906 | Netflix, Inc. | Org Netflix, Inc.');
  assert.equal(anchor.nextElementSibling?.href, 'https://www.peeringdb.com/org/111');
});

test('auto-linkified "AS2906" text mention also gets an org shortcut', async () => {
  const hooks = loadDp({
    [NET_BY_ASN_URL]: { data: [NET_ROW] },
    [ORG_URL('111')]: { data: [ORG_ROW('111', 'Netflix, Inc.')] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/asn/2906');
  const label = new FakeElement('span');
  anchor.appendChild(label);

  await hooks.hydrateAsnLinkLabel(anchor, label, '2906', 'AS2906');

  assert.equal(label.textContent, 'AS2906 (Netflix, Inc.)');
  assert.equal(anchor.title, 'ASN2906 | Netflix, Inc. | Org Netflix, Inc.');
  assert.equal(anchor.nextElementSibling?.href, 'https://www.peeringdb.com/org/111');
});

test('org links themselves never get a shortcut appended', async () => {
  const hooks = loadDp({
    [ORG_URL('111')]: { data: [ORG_ROW('111', 'Netflix, Inc.')] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/org/111');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'org', id: '111' });

  assert.equal(anchor.nextElementSibling, null);
});

test('entity with no org_id gets no shortcut, no crash', async () => {
  const hooks = loadDp({
    [FAC_URL]: { data: [{ id: '207', name: 'Equinix DC2', name_long: '', org_id: '' }] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/fac/207');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'fac', id: '207' });

  assert.equal(anchor.title, 'fac/207 | Equinix DC2');
  assert.equal(anchor.nextElementSibling, null);
});

test('entity fetch 404s: no crash, bare tooltip, no shortcut', async () => {
  const hooks = loadDp({}); // fac/999 intentionally not in the fetch map
  const anchor = makeEntityAnchor('https://www.peeringdb.com/fac/999');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'fac', id: '999' });

  assert.equal(anchor.title, 'fac/999');
  assert.equal(anchor.nextElementSibling, null);
});

test('org fetch fails (404): entity tooltip still set, no shortcut inserted', async () => {
  const hooks = loadDp({
    [CARRIER_URL]: { data: [CARRIER_ROW] },
    // ORG_URL('444') intentionally omitted
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/carrier/45');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'carrier', id: '45' });

  assert.equal(anchor.title, 'carrier/45 | Zayo');
  assert.equal(anchor.nextElementSibling, null);
});

test('re-hydrating the same anchor does not insert a second org shortcut', async () => {
  const hooks = loadDp({
    [NET_URL]: { data: [NET_ROW] },
    [ORG_URL('111')]: { data: [ORG_ROW('111', 'Netflix, Inc.')] },
  });
  const anchor = makeEntityAnchor('https://www.peeringdb.com/net/2906');

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'net', id: '2906' });
  const firstShortcut = anchor.nextElementSibling;
  assert.ok(firstShortcut);

  await hooks.hydrateExistingPeeringDbAnchor(anchor, { kind: 'net', id: '2906' });

  assert.equal(anchor.nextElementSibling, firstShortcut, 'shortcut identity should be unchanged');
  assert.equal(firstShortcut.nextElementSibling, null, 'no second shortcut chained after the first');
});
