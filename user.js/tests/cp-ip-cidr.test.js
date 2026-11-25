'use strict';

// Tests for CP's low-level IP/CIDR arithmetic (parseIp/formatIp/parseCidr/
// replaceHostInPrefix), the BigInt host-bit math feeding the IXLAN Renumber
// modal. A silent regression here would misconfigure live peering sessions,
// making this the single highest-consequence untested surface in the repo.
// All expected values below were captured empirically from the real
// functions before being hardcoded (see AGENTS.md's note on this lesson).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js');

function loadCp() {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbCpTestHooks__', pathname: '/cp/' }).hooks;
}

test('parseIp', async (t) => {
  const hooks = loadCp();

  await t.test('parses a plain IPv4 address', () => {
    const r = hooks.parseIp('185.0.1.50');
    assert.equal(r.family, 4);
    assert.equal(r.bigint, 3103785266n);
  });

  await t.test('parses a fully-expanded IPv6 address the same as its compressed form', () => {
    const compressed = hooks.parseIp('2001:db8::1');
    const expanded = hooks.parseIp('2001:db8:0:0:0:0:0:1');
    assert.equal(compressed.family, 6);
    assert.equal(compressed.bigint, expanded.bigint);
    assert.equal(compressed.bigint, 42540766411282592856903984951653826561n);
  });

  await t.test('parses the unspecified IPv6 address "::" as zero', () => {
    const r = hooks.parseIp('::');
    assert.equal(r.family, 6);
    assert.equal(r.bigint, 0n);
  });

  await t.test('trims surrounding whitespace', () => {
    const r = hooks.parseIp(' 185.0.1.50 ');
    assert.equal(r.bigint, 3103785266n);
  });

  await t.test('rejects an out-of-range IPv4 octet', () => {
    assert.equal(hooks.parseIp('256.0.0.1'), null);
  });

  await t.test('rejects an IPv4 address with too few octets', () => {
    assert.equal(hooks.parseIp('1.2.3'), null);
  });

  await t.test('rejects unparseable garbage', () => {
    assert.equal(hooks.parseIp('garbage'), null);
  });

  await t.test('rejects empty input', () => {
    assert.equal(hooks.parseIp(''), null);
  });

  await t.test('rejects an IPv6 address with two "::" compressions', () => {
    assert.equal(hooks.parseIp('1::2::3'), null);
  });
});

test('formatIp', async (t) => {
  const hooks = loadCp();

  await t.test('round-trips an IPv4 address', () => {
    const parsed = hooks.parseIp('185.0.1.50');
    assert.equal(hooks.formatIp(4, parsed.bigint), '185.0.1.50');
  });

  await t.test('round-trips an already-compressed IPv6 address', () => {
    const parsed = hooks.parseIp('2001:db8::1');
    assert.equal(hooks.formatIp(6, parsed.bigint), '2001:db8::1');
  });

  await t.test('compresses the longest run of zero groups per RFC 5952', () => {
    const parsed = hooks.parseIp('2001:0db8:0000:0000:0001:0000:0000:0001');
    assert.equal(hooks.formatIp(6, parsed.bigint), '2001:db8::1:0:0:1');
  });

  await t.test('formats an all-zero address as "::"', () => {
    assert.equal(hooks.formatIp(6, 0n), '::');
  });

  await t.test('compresses a single leading run down to "::1"', () => {
    const parsed = hooks.parseIp('0:0:0:0:0:0:0:1');
    assert.equal(hooks.formatIp(6, parsed.bigint), '::1');
  });

  await t.test('picks the first (leftmost) of two equal-length zero runs', () => {
    const parsed = hooks.parseIp('2001:0:0:1:0:0:1:1');
    assert.equal(hooks.formatIp(6, parsed.bigint), '2001::1:0:0:1:1');
  });

  await t.test('returns empty string for an unknown family', () => {
    assert.equal(hooks.formatIp(5, 1n), '');
  });
});

test('parseCidr', async (t) => {
  const hooks = loadCp();

  await t.test('parses an IPv4 CIDR into family/mask/network fields', () => {
    const r = hooks.parseCidr('185.0.1.0/24');
    assert.equal(r.family, 4);
    assert.equal(r.prefixLen, 24);
    assert.equal(r.totalBits, 32);
    assert.equal(r.networkMask, 4294967040n);
    assert.equal(r.hostMask, 255n);
    assert.equal(r.network, 3103785216n);
  });

  await t.test('parses an IPv6 CIDR', () => {
    const r = hooks.parseCidr('2001:db8::/32');
    assert.equal(r.family, 6);
    assert.equal(r.prefixLen, 32);
    assert.equal(hooks.formatIp(6, r.network), '2001:db8::');
  });

  await t.test('masks off host bits present in the address literal', () => {
    const r = hooks.parseCidr('185.0.1.5/24');
    assert.equal(hooks.formatIp(4, r.network), '185.0.1.0');
  });

  await t.test('/0 keeps the full address space as host bits', () => {
    const r = hooks.parseCidr('185.0.1.0/0');
    assert.equal(hooks.formatIp(4, r.network), '0.0.0.0');
    assert.equal(r.hostMask, 4294967295n);
  });

  await t.test('/32 leaves no host bits', () => {
    const r = hooks.parseCidr('185.0.1.0/32');
    assert.equal(r.hostMask, 0n);
    assert.equal(hooks.formatIp(4, r.network), '185.0.1.0');
  });

  await t.test('rejects a prefix length beyond the family width', () => {
    assert.equal(hooks.parseCidr('185.0.1.0/33'), null);
  });

  await t.test('rejects a negative prefix length', () => {
    assert.equal(hooks.parseCidr('185.0.1.0/-1'), null);
  });

  await t.test('rejects missing prefix length', () => {
    assert.equal(hooks.parseCidr('185.0.1.0'), null);
  });

  await t.test('rejects an unparseable address part', () => {
    assert.equal(hooks.parseCidr('bad/24'), null);
  });
});

test('replaceHostInPrefix', async (t) => {
  const hooks = loadCp();

  await t.test('preserves host bits across a prefix change', () => {
    const r = hooks.replaceHostInPrefix('185.0.1.50', '185.0.1.0/24', '185.1.184.0/23');
    assert.equal(r.fits, true);
    assert.equal(r.ip, '185.1.184.50');
  });

  await t.test('renumbering into the same prefix is a no-op', () => {
    const r = hooks.replaceHostInPrefix('185.0.1.50', '185.0.1.0/24', '185.0.1.0/24');
    assert.equal(r.fits, true);
    assert.equal(r.ip, '185.0.1.50');
  });

  await t.test('preserves host bits across an IPv6 prefix change', () => {
    const r = hooks.replaceHostInPrefix('2001:db8::50', '2001:db8::/32', '2001:db9::/32');
    assert.equal(r.fits, true);
    assert.equal(r.ip, '2001:db9::50');
  });

  await t.test('rejects an invalid address', () => {
    const r = hooks.replaceHostInPrefix('garbage', '185.0.1.0/24', '185.1.184.0/23');
    assert.equal(r.fits, false);
    assert.equal(r.reason, 'invalid-ip');
  });

  await t.test('rejects an invalid old CIDR', () => {
    const r = hooks.replaceHostInPrefix('185.0.1.50', 'garbage', '185.1.184.0/23');
    assert.equal(r.fits, false);
    assert.equal(r.reason, 'invalid-old-cidr');
  });

  await t.test('rejects an invalid new CIDR', () => {
    const r = hooks.replaceHostInPrefix('185.0.1.50', '185.0.1.0/24', 'garbage');
    assert.equal(r.fits, false);
    assert.equal(r.reason, 'invalid-new-cidr');
  });

  await t.test('rejects a family mismatch between address and prefixes', () => {
    const r = hooks.replaceHostInPrefix('185.0.1.50', '185.0.1.0/24', '2001:db8::/32');
    assert.equal(r.fits, false);
    assert.equal(r.reason, 'family-mismatch');
  });

  await t.test('rejects an address that is not inside the old prefix', () => {
    const r = hooks.replaceHostInPrefix('10.0.0.5', '185.0.1.0/24', '185.1.184.0/23');
    assert.equal(r.fits, false);
    assert.equal(r.reason, 'ip-not-in-old-prefix');
  });

  await t.test('rejects when the host bits do not fit a narrower new prefix', () => {
    const r = hooks.replaceHostInPrefix('185.0.1.200', '185.0.1.0/24', '185.1.184.0/28');
    assert.equal(r.fits, false);
    assert.equal(r.reason, 'host-out-of-range');
  });
});
