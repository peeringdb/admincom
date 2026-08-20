'use strict';

// Tests for DP's IXLAN Peer Renumber launcher (read-only: detects prefix
// pairs in ticket text and hands off to CP via a URL hash payload) and the
// Whitelist CMD Generator's final command-string builder. All expected
// values below were captured empirically from the real functions before
// being hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-deskpro-tools.user.js');

function loadDp() {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbDpTestHooks__', pathname: '/app/ticket' }).hooks;
}

test('buildWhitelistCommand', async (t) => {
  const hooks = loadDp();

  await t.test('builds a quoted pihole allow command with the ticket/type comment', () => {
    const cmd = hooks.buildWhitelistCommand('T-100', 'Internet Exchange', ['example.com']);
    assert.equal(cmd, 'pihole allow "example.com" --comment "PeeringDB DeskPro ticket T-100 - Internet Exchange"');
  });

  await t.test('joins multiple quoted domains with a space', () => {
    const cmd = hooks.buildWhitelistCommand('T-100', 'Network', ['a.com', 'b.com']);
    assert.equal(cmd, 'pihole allow "a.com" "b.com" --comment "PeeringDB DeskPro ticket T-100 - Network"');
  });

  await t.test('returns an empty string for an empty domain list', () => {
    assert.equal(hooks.buildWhitelistCommand('T-100', 'Network', []), '');
  });

  await t.test('returns an empty string for a non-array domains argument', () => {
    assert.equal(hooks.buildWhitelistCommand('T-100', 'Network', null), '');
  });

  await t.test('filters out blank/whitespace-only entries', () => {
    const cmd = hooks.buildWhitelistCommand('T-1', 'Facility', ['', '  ', 'x.com']);
    assert.equal(cmd, 'pihole allow "x.com" --comment "PeeringDB DeskPro ticket T-1 - Facility"');
  });
});

test('collectRenumberCandidates', async (t) => {
  const hooks = loadDp();

  await t.test('detects an ASCII "->" separated v4 pair', () => {
    const r = hooks.collectRenumberCandidates({ ticketSubject: '', ticketBodyText: '185.0.1.0/24 -> 185.1.184.0/23' });
    assert.equal(r.pairs.length, 1);
    assert.equal(r.pairs[0].family, 4);
    assert.equal(r.pairs[0].old, '185.0.1.0/24');
    assert.equal(r.pairs[0].new, '185.1.184.0/23');
  });

  await t.test('accepts the Unicode "→" separator', () => {
    const r = hooks.collectRenumberCandidates({ ticketSubject: '', ticketBodyText: '185.0.1.0/24 → 185.1.184.0/23' });
    assert.equal(r.pairs.length, 1);
    assert.equal(r.pairs[0].old, '185.0.1.0/24');
  });

  await t.test('accepts the word "to" as a separator', () => {
    const r = hooks.collectRenumberCandidates({ ticketSubject: '', ticketBodyText: '185.0.1.0/24 to 185.1.184.0/23' });
    assert.equal(r.pairs.length, 1);
  });

  await t.test('detects a v6 pair and tags it family 6', () => {
    const r = hooks.collectRenumberCandidates({ ticketSubject: '', ticketBodyText: '2001:db8::/32 -> 2001:db9::/32' });
    assert.equal(r.pairs.length, 1);
    assert.equal(r.pairs[0].family, 6);
  });

  await t.test('skips a pair whose old/new prefixes are different address families', () => {
    const r = hooks.collectRenumberCandidates({ ticketSubject: '', ticketBodyText: '185.0.1.0/24 -> 2001:db9::/32' });
    assert.equal(r.pairs.length, 0);
  });

  await t.test('deduplicates an identical pair repeated in the ticket text', () => {
    const r = hooks.collectRenumberCandidates({
      ticketSubject: '',
      ticketBodyText: '185.0.1.0/24 -> 185.1.184.0/23\nsame: 185.0.1.0/24 -> 185.1.184.0/23',
    });
    assert.equal(r.pairs.length, 1);
  });

  await t.test('returns an empty pairs list when nothing matches', () => {
    assert.equal(hooks.collectRenumberCandidates({ ticketSubject: '', ticketBodyText: 'nothing here' }).pairs.length, 0);
  });

  await t.test('tolerates a completely empty context object', () => {
    const r = hooks.collectRenumberCandidates({});
    assert.equal(r.pairs.length, 0);
  });
});

test('extractIxlanIdFromTicket', async (t) => {
  const hooks = loadDp();

  await t.test('extracts the ixlan id from a CP change-URL anchor', () => {
    const id = hooks.extractIxlanIdFromTicket({
      querySelectorAll: (sel) => (sel === 'a[href*="peeringdb_server/ixlan/"]'
        ? [{ getAttribute: (n) => (n === 'href' ? 'https://www.peeringdb.com/cp/peeringdb_server/ixlan/42/change/' : null) }]
        : []),
    });
    assert.equal(id, '42');
  });

  await t.test('tolerates doubled slashes in the href', () => {
    const id = hooks.extractIxlanIdFromTicket({
      querySelectorAll: (sel) => (sel === 'a[href*="peeringdb_server/ixlan/"]'
        ? [{ getAttribute: (n) => (n === 'href' ? 'https://www.peeringdb.com/cp//peeringdb_server//ixlan//42//change//' : null) }]
        : []),
    });
    assert.equal(id, '42');
  });

  await t.test('returns an empty string when no matching anchors exist', () => {
    assert.equal(hooks.extractIxlanIdFromTicket({ querySelectorAll: () => [] }), '');
  });

  await t.test('returns an empty string for a null ticketPageEl', () => {
    assert.equal(hooks.extractIxlanIdFromTicket(null), '');
  });

  await t.test('returns the first matching anchor when multiple are present', () => {
    const id = hooks.extractIxlanIdFromTicket({
      querySelectorAll: (sel) => (sel === 'a[href*="peeringdb_server/ixlan/"]'
        ? [
          { getAttribute: (n) => (n === 'href' ? 'https://www.peeringdb.com/cp/peeringdb_server/ixlan/7/change/' : null) },
          { getAttribute: (n) => (n === 'href' ? 'https://www.peeringdb.com/cp/peeringdb_server/ixlan/8/change/' : null) },
        ]
        : []),
    });
    assert.equal(id, '7');
  });
});

test('buildRenumberCpUrl', async (t) => {
  const hooks = loadDp();

  await t.test('builds a full v4+v6+ixlan+ticket hash payload', () => {
    const url = hooks.buildRenumberCpUrl({
      old4: '185.0.1.0/24', new4: '185.1.184.0/23',
      old6: '2001:db8::/32', new6: '2001:db9::/32',
      ixlan: '42', ticket: 'T-100',
    });
    assert.equal(
      url,
      'https://www.peeringdb.com/cp/peeringdb_server/networkixlan/#pdb-renumber=v1&old4=185.0.1.0%2F24&new4=185.1.184.0%2F23&old6=2001%3Adb8%3A%3A%2F32&new6=2001%3Adb9%3A%3A%2F32&ixlan=42&ticket=T-100',
    );
  });

  await t.test('omits absent fields, keeping only what was supplied', () => {
    const url = hooks.buildRenumberCpUrl({ old4: '185.0.1.0/24', new4: '185.1.184.0/23' });
    assert.equal(
      url,
      'https://www.peeringdb.com/cp/peeringdb_server/networkixlan/#pdb-renumber=v1&old4=185.0.1.0%2F24&new4=185.1.184.0%2F23',
    );
  });

  await t.test('an empty payload still carries the key/version pair', () => {
    assert.equal(hooks.buildRenumberCpUrl({}), 'https://www.peeringdb.com/cp/peeringdb_server/networkixlan/#pdb-renumber=v1');
  });

  await t.test('tolerates an undefined payload', () => {
    assert.equal(hooks.buildRenumberCpUrl(undefined), 'https://www.peeringdb.com/cp/peeringdb_server/networkixlan/#pdb-renumber=v1');
  });

  await t.test('URL-encodes field values', () => {
    const url = hooks.buildRenumberCpUrl({ ticket: 'T 100 & co' });
    assert.equal(url, 'https://www.peeringdb.com/cp/peeringdb_server/networkixlan/#pdb-renumber=v1&ticket=T%20100%20%26%20co');
  });
});
