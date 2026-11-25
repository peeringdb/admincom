'use strict';

// Tests for the per-netixlan-row "Verify IX-F" / "Resolve discrepancy" flow
// on the network page.
//
// Context: admins had no quick way to check whether a network's netixlan
// record (speed, route-server flag, operational status) still matches what
// the exchange's own IX-F member-export feed says, without going to CP's
// exchange-centric IX-F Member Audit tool (a different job -- bulk
// split-row merge detection for one ixlan at a time). This adds a per-row
// button on the network's own page instead.
//
// Only the pure matching/diff/payload functions below are unit tested here,
// same precedent as cp-ixf-merge-gates.test.js (never the GM_xmlhttpRequest
// fetch or the button/panel DOM wiring -- see the header comment in the
// .src.js right above the `netixlan-ixf-verify` module, and
// fp-admin-ops-builders.test.js's header for the same split applied to
// fix-double-slashes/asn-404-cp-search-redirect). All expected values below
// were captured empirically from the real functions before being hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-fp-consolidated-tools.user.js');

function loadFp(opts = {}) {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbFpTestHooks__', hostname: 'www.peeringdb.com', ...opts });
}

function ixfMember({ asnum, state = 'active', ifSpeed = 10000, vlans }) {
  return {
    asnum,
    connection_list: [
      {
        state,
        if_list: [{ if_speed: ifSpeed }],
        vlan_list: vlans,
      },
    ],
  };
}

test('normalizeIpv6ForCompareFp', async (t) => {
  const { hooks } = loadFp({ pathname: '/net/1234' });

  await t.test('mixed-case and compressed vs. fully-expanded compare equal', () => {
    const a = hooks.normalizeIpv6ForCompareFp('2001:DB8::1');
    const b = hooks.normalizeIpv6ForCompareFp('2001:db8:0:0:0:0:0:1');
    assert.equal(a, b);
    assert.equal(a, '2001:0db8:0000:0000:0000:0000:0000:0001');
  });

  await t.test('all-zero compressed form expands to eight zero groups', () => {
    assert.equal(hooks.normalizeIpv6ForCompareFp('::'), '0000:0000:0000:0000:0000:0000:0000:0000');
  });

  await t.test('empty input returns ""', () => {
    assert.equal(hooks.normalizeIpv6ForCompareFp(''), '');
  });
});

test('extractIxfMatchForAsnIp', async (t) => {
  const { hooks } = loadFp({ pathname: '/net/1234' });

  await t.test('matches on an exact IPv4 address', () => {
    const ixfData = {
      member_list: [
        ixfMember({
          asnum: 64500,
          vlans: [{ ipv4: { address: '80.81.194.210' }, ipv6: {} }],
        }),
      ],
    };
    const result = hooks.extractIxfMatchForAsnIp(ixfData, { asn: 64500, ipaddr4: '80.81.194.210', ipaddr6: '' });
    assert.equal(result.matched, 'ip');
    assert.equal(result.vlan.ipv4.address, '80.81.194.210');
  });

  await t.test('matches on a normalized IPv6 address (different spelling)', () => {
    const ixfData = {
      member_list: [
        ixfMember({
          asnum: 64500,
          vlans: [{ ipv4: {}, ipv6: { address: '2001:DB8::1' } }],
        }),
      ],
    };
    const result = hooks.extractIxfMatchForAsnIp(ixfData, {
      asn: 64500, ipaddr4: '', ipaddr6: '2001:db8:0:0:0:0:0:1',
    });
    assert.equal(result.matched, 'ip');
    assert.equal(result.vlan.ipv6.address, '2001:DB8::1');
  });

  await t.test('ASN present but no matching IP -> "asn-only" with the ASN\'s other IX-F entries', () => {
    const ixfData = {
      member_list: [
        ixfMember({
          asnum: 64500,
          vlans: [{ ipv4: { address: '80.81.194.211' }, ipv6: {} }],
        }),
      ],
    };
    const result = hooks.extractIxfMatchForAsnIp(ixfData, { asn: 64500, ipaddr4: '80.81.194.210', ipaddr6: '' });
    assert.equal(result.matched, 'asn-only');
    assert.equal(result.asnEntries.length, 1);
    assert.equal(result.asnEntries[0].v4, '80.81.194.211');
    assert.equal(result.asnEntries[0].v6, '');
  });

  await t.test('ASN absent from the export entirely -> "none"', () => {
    const ixfData = {
      member_list: [
        ixfMember({ asnum: 64501, vlans: [{ ipv4: { address: '80.81.194.210' }, ipv6: {} }] }),
      ],
    };
    const result = hooks.extractIxfMatchForAsnIp(ixfData, { asn: 64500, ipaddr4: '80.81.194.210', ipaddr6: '' });
    assert.equal(result.matched, 'none');
    assert.equal(result.asnEntries.length, 0);
  });

  await t.test('an unreadable export is "unreadable", never "none"', () => {
    // Regression: all of these used to coerce to [] and report "none", which
    // the panel renders as "IX-F has no entry for this ASN at all" next to a
    // "Remove netixlan entry" button. A 200-OK CDN error page, a renamed
    // schema, or a URL pointing at another exchange is silence, not absence,
    // and must never reach the destructive path.
    for (const [label, body] of [
      ['null body', null],
      ['empty object', {}],
      ['non-IX-F JSON', { detail: 'Not Found' }],
      ['member_list is not an array', { member_list: 'nope' }],
      ['member_list present but empty', { member_list: [] }],
    ]) {
      const result = hooks.extractIxfMatchForAsnIp(body, { asn: 64500, ipaddr4: '1.2.3.4' });
      assert.equal(result.matched, 'unreadable', label);
      assert.equal(result.reason, 'no-member-list', label);
      assert.notEqual(result.matched, 'none', label);
    }
  });

  await t.test('missing asn -> "unreadable", not a claim of absence', () => {
    const ixfData = { member_list: [ixfMember({ asnum: 64500, vlans: [{ ipv4: { address: '1.2.3.4' }, ipv6: {} }] })] };
    const result = hooks.extractIxfMatchForAsnIp(ixfData, { asn: '', ipaddr4: '1.2.3.4' });
    assert.equal(result.matched, 'unreadable');
    assert.equal(result.reason, 'no-target-asn');
  });

  await t.test('a readable export that genuinely lacks the ASN is still "none"', () => {
    // The other half of the fix: "none" must keep working where it is true,
    // or the Remove path becomes unreachable and the guard is vacuous.
    const ixfData = {
      member_list: [ixfMember({ asnum: 64999, vlans: [{ ipv4: { address: '9.9.9.9' }, ipv6: {} }] })],
    };
    const result = hooks.extractIxfMatchForAsnIp(ixfData, { asn: 64500, ipaddr4: '1.2.3.4' });
    assert.equal(result.matched, 'none');
    assert.equal(result.asnEntries.length, 0);
  });
});

test('buildIxfDiff', async (t) => {
  const { hooks } = loadFp({ pathname: '/net/1234' });

  const matchedIp = (overrides = {}) => hooks.extractIxfMatchForAsnIp(
    {
      member_list: [
        ixfMember({
          asnum: 64500,
          ifSpeed: overrides.ifSpeed ?? 10000,
          state: overrides.state === undefined ? 'active' : overrides.state,
          vlans: [{
            ipv4: { address: '80.81.194.210', routeserver: overrides.rsV4 ?? true },
            ipv6: { address: '2001:7f8::1:0:0:1', routeserver: overrides.rsV6 ?? false },
          }],
        }),
      ],
    },
    { asn: 64500, ipaddr4: '80.81.194.210', ipaddr6: '' },
  );

  await t.test('no differences when PDB and IX-F fully agree', () => {
    const netixlanRow = {
      asn: 64500, ipaddr4: '80.81.194.210', ipaddr6: '2001:7f8::1:0:0:1',
      speed: 10000, is_rs_peer: true, operational: true,
    };
    const diff = hooks.buildIxfDiff(netixlanRow, matchedIp());
    assert.equal(diff.every((entry) => !entry.differs), true);
  });

  await t.test('speed mismatch is flagged and auto-fixable', () => {
    const netixlanRow = { asn: 64500, ipaddr4: '80.81.194.210', speed: 1000, is_rs_peer: true, operational: true };
    const diff = hooks.buildIxfDiff(netixlanRow, matchedIp());
    const speedEntry = diff.find((entry) => entry.field === 'speed');
    assert.equal(speedEntry.differs, true);
    assert.equal(speedEntry.autoFixable, true);
    assert.equal(speedEntry.pdbValue, 1000);
    assert.equal(speedEntry.ixfValue, 10000);
  });

  await t.test('is_rs_peer mismatch is flagged and auto-fixable', () => {
    const netixlanRow = { asn: 64500, ipaddr4: '80.81.194.210', speed: 10000, is_rs_peer: false, operational: true };
    const diff = hooks.buildIxfDiff(netixlanRow, matchedIp());
    const entry = diff.find((e) => e.field === 'is_rs_peer');
    assert.equal(entry.differs, true);
    assert.equal(entry.ixfValue, true);
  });

  await t.test('operational mismatch is flagged and auto-fixable', () => {
    const netixlanRow = { asn: 64500, ipaddr4: '80.81.194.210', speed: 10000, is_rs_peer: true, operational: false };
    const diff = hooks.buildIxfDiff(netixlanRow, matchedIp({ state: 'active' }));
    const entry = diff.find((e) => e.field === 'operational');
    assert.equal(entry.differs, true);
    assert.equal(entry.ixfValue, true);
  });

  await t.test('operational is omitted entirely when IX-F state is missing', () => {
    const netixlanRow = { asn: 64500, ipaddr4: '80.81.194.210', speed: 10000, is_rs_peer: true, operational: true };
    const diff = hooks.buildIxfDiff(netixlanRow, matchedIp({ state: '' }));
    assert.equal(diff.some((e) => e.field === 'operational'), false);
  });

  await t.test('ipaddr4/ipaddr6 are always autoFixable: false, even when they differ', () => {
    const netixlanRow = { asn: 64500, ipaddr4: '80.81.194.211', ipaddr6: '', speed: 10000, is_rs_peer: true, operational: true };
    const diff = hooks.buildIxfDiff(netixlanRow, matchedIp());
    const ip4Entry = diff.find((e) => e.field === 'ipaddr4');
    assert.equal(ip4Entry.differs, true);
    assert.equal(ip4Entry.autoFixable, false);
    const ip6Entry = diff.find((e) => e.field === 'ipaddr6');
    assert.equal(ip6Entry.autoFixable, false);
  });

  await t.test('returns [] when there is no IP match', () => {
    const noMatch = hooks.extractIxfMatchForAsnIp(
      { member_list: [ixfMember({ asnum: 64999, vlans: [{ ipv4: { address: '9.9.9.9' }, ipv6: {} }] })] },
      { asn: 64500 },
    );
    assert.equal(noMatch.matched, 'none');
    assert.equal(hooks.buildIxfDiff({}, noMatch).length, 0);
  });

  await t.test('returns [] for an unreadable export too', () => {
    const unreadable = hooks.extractIxfMatchForAsnIp({}, { asn: 64500 });
    assert.equal(unreadable.matched, 'unreadable');
    assert.equal(hooks.buildIxfDiff({}, unreadable).length, 0);
  });
});

test('buildNetixlanResolvePayload', async (t) => {
  const { hooks } = loadFp({ pathname: '/net/1234' });

  await t.test('overwrites only fields that are both autoFixable and differing', () => {
    const netixlanRow = {
      id: 555, created: 'x', updated: 'y', _grainy_status: 'ok', status_dashboard_url: 'z',
      asn: 64500, ipaddr4: '80.81.194.210', ipaddr6: '2001:7f8::1', speed: 1000, is_rs_peer: false, operational: false,
    };
    const diffEntries = [
      { field: 'speed', ixfValue: 10000, differs: true, autoFixable: true },
      { field: 'is_rs_peer', ixfValue: true, differs: true, autoFixable: true },
      { field: 'operational', ixfValue: true, differs: false, autoFixable: true },
      { field: 'ipaddr4', ixfValue: '80.81.194.211', differs: true, autoFixable: false },
    ];
    const payload = hooks.buildNetixlanResolvePayload(netixlanRow, diffEntries);

    assert.equal(payload.speed, 10000);
    assert.equal(payload.is_rs_peer, true);
    assert.equal(payload.operational, false); // differs:false -- left alone
    assert.equal(payload.ipaddr4, '80.81.194.210'); // autoFixable:false -- never touched
  });

  await t.test('strips read-only/server-managed fields', () => {
    const netixlanRow = { id: 555, created: 'x', updated: 'y', _grainy_status: 'ok', status_dashboard_url: 'z', asn: 64500 };
    const payload = hooks.buildNetixlanResolvePayload(netixlanRow, []);
    assert.deepEqual(Object.keys(payload).sort(), ['asn', 'ipaddr4', 'ipaddr6']);
  });

  await t.test('normalizes null/undefined ipaddr4/ipaddr6 to ""', () => {
    const netixlanRow = { asn: 64500, ipaddr4: null, ipaddr6: undefined };
    const payload = hooks.buildNetixlanResolvePayload(netixlanRow, []);
    assert.equal(payload.ipaddr4, '');
    assert.equal(payload.ipaddr6, '');
  });
});

test('netixlan-ixf-verify module', async (t) => {
  await t.test('match() is true on a network entity page', () => {
    const { hooks } = loadFp({ pathname: '/net/1234' });
    const mod = hooks.modules.find((m) => m.id === 'netixlan-ixf-verify');
    assert.equal(mod.match(hooks.getRouteContext()), true);
  });

  await t.test('match() is false on a non-network entity page', () => {
    const { hooks } = loadFp({ pathname: '/org/55' });
    const mod = hooks.modules.find((m) => m.id === 'netixlan-ixf-verify');
    assert.equal(mod.match(hooks.getRouteContext()), false);
  });

  await t.test('match() is false on the network changelist (not an entity page)', () => {
    const { hooks } = loadFp({ pathname: '/net' });
    const mod = hooks.modules.find((m) => m.id === 'netixlan-ixf-verify');
    assert.equal(mod.match(hooks.getRouteContext()), false);
  });
});
