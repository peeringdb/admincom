'use strict';

// Tests for DP's text-linkification engine: linkifyText's REPLACEMENT_RULES
// (4 overlapping ASN/org-name patterns run in a single combined pass, sorted
// by match position) and findProbableStandaloneAsnHits (a heuristic detector
// for bare 3-10 digit ASN lines, gated on surrounding context to avoid
// false-positiving on arbitrary numbers). This is the richest untested
// regex/business logic in either script. All expected values below were
// captured empirically from the real functions before being hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

function loadDp() {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbDpTestHooks__', pathname: '/app/ticket' }).hooks;
}

// Flattens a linkifyText() fragment into plain-object nodes for assertions:
// text nodes -> { type: 'text', text }, anchors -> { type: 'element', ...attrs, label }.
// Not assert.deepEqual against the fragment itself -- FakeElement instances
// come from the vm sandbox realm, so prototype-identity comparison would
// fail even for structurally-identical fragments.
function describeFragment(fragment) {
  if (fragment === null) return null;
  return fragment.children.map((child) => {
    if (child.nodeType === 3) return { type: 'text', text: child.textContent };
    const spanChild = child.children.find((c) => c.tagName === 'SPAN');
    return {
      type: 'element',
      tag: child.tagName,
      href: child.href,
      target: child.target,
      rel: child.rel,
      title: child.title,
      label: spanChild ? spanChild.textContent : undefined,
    };
  });
}

function assertNodesEqual(actual, expected) {
  assert.equal(actual.length, expected.length, `expected ${expected.length} nodes, got ${JSON.stringify(actual)}`);
  expected.forEach((exp, i) => assert.deepEqual({ ...actual[i] }, exp));
}

test('findProbableStandaloneAsnHits', async (t) => {
  const hooks = loadDp();

  await t.test('a standalone ASN-shaped line adjacent to both an IPv4 and IPv6 mention is a hit', () => {
    const hits = hooks.findProbableStandaloneAsnHits('Here are the details:\n64500\n192.0.2.1\n2001:db8::1\n');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].asn, '64500');
    assert.equal(hits[0].start, 22);
    assert.equal(hits[0].end, 27);
  });

  await t.test('a member-removal-style block (speed/policy + ipv4/ipv6 labels) is a hit', () => {
    const hits = hooks.findProbableStandaloneAsnHits('speed: 1000\npolicy: open\nipv4: yes\nipv6: yes\n64500\n');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].asn, '64500');
  });

  await t.test('a line preceded by an explicit ASN label is a hit', () => {
    const hits = hooks.findProbableStandaloneAsnHits('ASN\n64500\n');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].asn, '64500');
  });

  await t.test('a "provided this ASN in their request" phrase in the surrounding window is a hit', () => {
    const hits = hooks.findProbableStandaloneAsnHits('they also provided this ASN in their request\n64500\n');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].asn, '64500');
  });

  await t.test('a standalone number with no qualifying context is not a hit (avoids false positives)', () => {
    const hits = hooks.findProbableStandaloneAsnHits('random text\n64500\nmore text\n');
    assert.equal(hits.length, 0);
  });

  await t.test('an out-of-range ASN is never a hit even with qualifying context', () => {
    const hits = hooks.findProbableStandaloneAsnHits('192.0.2.1\n2001:db8::1\n99999999999\n');
    assert.equal(hits.length, 0);
  });

  await t.test('empty input returns no hits', () => {
    assert.equal(hooks.findProbableStandaloneAsnHits('').length, 0);
  });
});

test('linkifyText', async (t) => {
  const hooks = loadDp();

  await t.test('text with no matching pattern returns null', () => {
    assert.equal(hooks.linkifyText('nothing to see here'), null);
  });

  await t.test('a plain AS<digits> token becomes a full-token ASN link', () => {
    const nodes = describeFragment(hooks.linkifyText('See AS64500 for details'));
    assertNodesEqual(nodes, [
      { type: 'text', text: 'See ' },
      { type: 'element', tag: 'A', href: 'https://www.peeringdb.com/asn/64500', target: '_blank', rel: 'noopener noreferrer', title: 'Open ASN64500 in PeeringDB', label: 'AS64500' },
      { type: 'text', text: ' for details' },
    ]);
  });

  await t.test('an ASN<digits> token (with the N) also links, keeping the "ASN" spelling as the label', () => {
    const nodes = describeFragment(hooks.linkifyText('See ASN64500 for details'));
    assert.equal(nodes[1].label, 'ASN64500');
  });

  await t.test('a label-led ASN value links only the numeric token, keeping the label as plain text', () => {
    const nodes = describeFragment(hooks.linkifyText('member asn: 64500 is affected'));
    assertNodesEqual(nodes, [
      { type: 'text', text: 'member asn: ' },
      { type: 'element', tag: 'A', href: 'https://www.peeringdb.com/asn/64500', target: '_blank', rel: 'noopener noreferrer', title: 'Open ASN64500 in PeeringDB', label: '64500' },
      { type: 'text', text: ' is affected' },
    ]);
  });

  await t.test('the "provided this ASN in their request" phrase links only the bare number', () => {
    const nodes = describeFragment(hooks.linkifyText('they also provided this ASN in their request: 64500 today'));
    assertNodesEqual(nodes, [
      { type: 'text', text: 'they also provided this ASN in their request: ' },
      { type: 'element', tag: 'A', href: 'https://www.peeringdb.com/asn/64500', target: '_blank', rel: 'noopener noreferrer', title: 'Open ASN64500 in PeeringDB', label: '64500' },
      { type: 'text', text: ' today' },
    ]);
  });

  await t.test('the org-name quote phrase links only the quoted organization name', () => {
    const nodes = describeFragment(hooks.linkifyText('wishes to be affiliated to Organization "Acme Corp" today'));
    assert.equal(nodes.length, 4);
    assert.equal(nodes[0].text, 'wishes to be affiliated to Organization "');
    assert.equal(nodes[1].tag, 'A');
    assert.equal(nodes[1].href, 'https://www.peeringdb.com/search/v2?q=Acme%20Corp');
    assert.equal(nodes[1].title, 'Search organization "Acme Corp" in PeeringDB');
    assert.equal(nodes[1].label, 'Acme Corp');
    assert.equal(nodes[2].text, '"');
    assert.equal(nodes[3].text, ' today');
  });

  await t.test('an out-of-range ASN token is left as plain text (no match at all, since the whole text has nothing else to link)', () => {
    assert.equal(hooks.linkifyText('See AS99999999999 please'), null);
  });

  await t.test('two non-overlapping ASN tokens both link independently, in document order', () => {
    const nodes = describeFragment(hooks.linkifyText('AS100 and AS200 are both affected'));
    assertNodesEqual(nodes, [
      { type: 'element', tag: 'A', href: 'https://www.peeringdb.com/asn/100', target: '_blank', rel: 'noopener noreferrer', title: 'Open ASN100 in PeeringDB', label: 'AS100' },
      { type: 'text', text: ' and ' },
      { type: 'element', tag: 'A', href: 'https://www.peeringdb.com/asn/200', target: '_blank', rel: 'noopener noreferrer', title: 'Open ASN200 in PeeringDB', label: 'AS200' },
      { type: 'text', text: ' are both affected' },
    ]);
  });

  await t.test('an explicit AS token and a standalone-heuristic ASN both link in the same pass', () => {
    const nodes = describeFragment(hooks.linkifyText('AS100\n192.0.2.1\n2001:db8::1\n64500\n'));
    assertNodesEqual(nodes, [
      { type: 'element', tag: 'A', href: 'https://www.peeringdb.com/asn/100', target: '_blank', rel: 'noopener noreferrer', title: 'Open ASN100 in PeeringDB', label: 'AS100' },
      { type: 'text', text: '\n192.0.2.1\n2001:db8::1\n' },
      { type: 'element', tag: 'A', href: 'https://www.peeringdb.com/asn/64500', target: '_blank', rel: 'noopener noreferrer', title: 'Open ASN64500 in PeeringDB', label: '64500' },
      { type: 'text', text: '\n' },
    ]);
  });
});
