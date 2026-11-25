'use strict';

// Tests for CP's Network Name Pattern Diagnostics scan and the Recent IP
// Changes audit-reconciliation helpers. classifyNetworkNamePattern is a
// dense multi-signal regex scoring function -- easy to silently regress a
// single weight or regex and never notice since it only affects triage
// ranking, not a hard failure. mergeAuditSources/formatRecentChangeLines
// reconcile API rows with local audit-log entries into the operator-facing
// diff lines used by the Recent IP Changes report. All expected values
// below were captured empirically from the real functions before being
// hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js');

function loadCp() {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbCpTestHooks__', pathname: '/cp/' }).hooks;
}

// Array-of-primitives comparison, not assert.deepEqual: arrays returned from
// the vm-loaded script come from a separate realm, so deepStrictEqual's
// prototype check fails against a host-realm array literal despite
// identical contents.
function arrEqual(actual, expected) {
  assert.equal(actual.length, expected.length, `expected length ${expected.length}, got ${actual.length}: ${JSON.stringify(actual)}`);
  expected.forEach((value, i) => assert.equal(actual[i], value));
}

test('classifyNetworkNamePattern', async (t) => {
  const hooks = loadCp();

  await t.test('a clean human-readable name scores 0 with no reasons', () => {
    const r = hooks.classifyNetworkNamePattern('Acme Networks');
    assert.equal(r.score, 0);
    arrEqual(r.reasons, []);
  });

  await t.test('empty/null input scores 0 with no reasons', () => {
    assert.equal(hooks.classifyNetworkNamePattern('').score, 0);
    assert.equal(hooks.classifyNetworkNamePattern(null).score, 0);
  });

  await t.test('a numeric-only name flags numeric-only and digit-heavy', () => {
    const r = hooks.classifyNetworkNamePattern('123456');
    assert.equal(r.score, 21);
    arrEqual(r.reasons, ['numeric-only', 'digit-heavy']);
  });

  await t.test('a placeholder keyword flags placeholder-keyword', () => {
    const r = hooks.classifyNetworkNamePattern('test network');
    assert.equal(r.score, 17);
    arrEqual(r.reasons, ['placeholder-keyword']);
  });

  await t.test('loud punctuation flags invalid-chars', () => {
    const r = hooks.classifyNetworkNamePattern('Acme!@#Net');
    assert.equal(r.score, 13);
    arrEqual(r.reasons, ['invalid-chars']);
  });

  await t.test('an AS<digits> handle flags asn-token, token-like, digit-heavy, low-alpha-signal', () => {
    const r = hooks.classifyNetworkNamePattern('AS211750');
    assert.equal(r.score, 25);
    arrEqual(r.reasons, ['asn-token', 'token-like', 'digit-heavy', 'low-alpha-signal']);
  });

  await t.test('an ORG-XXXX handle flags org-token, token-like', () => {
    const r = hooks.classifyNetworkNamePattern('ORG-ABCD-1234');
    assert.equal(r.score, 16);
    arrEqual(r.reasons, ['org-token', 'token-like']);
  });

  await t.test('a NIR-prefixed name flags nir-prefix', () => {
    const r = hooks.classifyNetworkNamePattern('RIPE-NETWORK-FOO');
    assert.equal(r.score, 12);
    arrEqual(r.reasons, ['nir-prefix']);
  });

  await t.test('a generic-prefix+number handle stacks compact-dashed-token/all-caps/generic-prefix/digit-heavy', () => {
    const r = hooks.classifyNetworkNamePattern('NET-12345');
    assert.equal(r.score, 24);
    arrEqual(r.reasons, ['compact-dashed-token', 'all-caps-compact-dashed', 'generic-prefix+number', 'digit-heavy']);
  });

  await t.test('an all-caps compact dashed name flags compact-dashed-token/all-caps/multi-segment', () => {
    const r = hooks.classifyNetworkNamePattern('FOO-BAR-BAZ');
    assert.equal(r.score, 14);
    arrEqual(r.reasons, ['compact-dashed-token', 'all-caps-compact-dashed', 'multi-segment-compact-dashed']);
  });

  await t.test('a mixed-case compact dashed name flags mixed-case instead of all-caps', () => {
    const r = hooks.classifyNetworkNamePattern('Foo-Bar-Baz');
    assert.equal(r.score, 13);
    arrEqual(r.reasons, ['compact-dashed-token', 'mixed-case-compact-dashed', 'multi-segment-compact-dashed']);
  });

  await t.test('a trailing "-AS" boundary affix flags boundary-as-affix alongside dashed-token signals', () => {
    const r = hooks.classifyNetworkNamePattern('FOO-AS');
    assert.equal(r.score, 20);
    arrEqual(r.reasons, ['nir-country-suffix-weak', 'compact-dashed-token', 'boundary-as-affix', 'all-caps-compact-dashed']);
  });

  await t.test('a short mostly-digit name flags digit-heavy and low-alpha-signal', () => {
    const r = hooks.classifyNetworkNamePattern('AB123456');
    assert.equal(r.score, 8);
    arrEqual(r.reasons, ['digit-heavy', 'low-alpha-signal']);
  });

  await t.test('trailing "!" flags invalid-chars and trailing-loud-punctuation together', () => {
    const r = hooks.classifyNetworkNamePattern('Weird Name!');
    assert.equal(r.score, 16);
    arrEqual(r.reasons, ['invalid-chars', 'trailing-loud-punctuation']);
  });

  await t.test('a longer ASN-shaped token scores higher than a shorter one', () => {
    const shorter = hooks.classifyNetworkNamePattern('AS211750');
    const longer = hooks.classifyNetworkNamePattern('AS21175099');
    assert.equal(longer.score > shorter.score, true);
    arrEqual(longer.reasons, ['asn-token', 'token-like', 'digit-heavy', 'low-alpha-signal']);
  });
});

test('buildNetworkNamePatternSummary', async (t) => {
  const hooks = loadCp();

  await t.test('formats counts, transport, and source for a multi-request fresh REST scan', () => {
    const summary = hooks.buildNetworkNamePatternSummary({
      analysis: { total: 100, highConfidenceCount: 3, reviewCount: 5, suspiciousCount: 8 },
      requestCount: 4, transport: 'rest', source: 'fresh',
    });
    assert.equal(
      summary,
      'Scanned 100 network names in 4 requests (REST, fresh fetch); flagged 8 names (3 high-confidence, 5 review).',
    );
  });

  await t.test('uses singular "request" and reports a cached GraphQL scan', () => {
    const summary = hooks.buildNetworkNamePatternSummary({
      analysis: { total: 10, highConfidenceCount: 0, reviewCount: 0, suspiciousCount: 0 },
      requestCount: 1, transport: 'graphql', source: 'cache',
    });
    assert.equal(summary, 'Scanned 10 network names in 1 request (GRAPHQL, cache); flagged 0 names (0 high-confidence, 0 review).');
  });

  await t.test('defaults missing fields to 0/REST/fresh fetch', () => {
    assert.equal(
      hooks.buildNetworkNamePatternSummary({}),
      'Scanned 0 network names in 0 requests (REST, fresh fetch); flagged 0 names (0 high-confidence, 0 review).',
    );
  });
});

test('buildSuspiciousNetworkNameTsv', async (t) => {
  const hooks = loadCp();

  await t.test('emits a header row plus one tab-separated row per suspicious entry', () => {
    const tsv = hooks.buildSuspiciousNetworkNameTsv({
      suspicious: [
        { id: '5', name: 'AS211750', tier: 'high-confidence', score: 20, reasons: ['asn-token', 'digit-heavy'], changeUrl: 'https://x/5/change/' },
        { id: '6', name: 'Weird  Name', tier: 'review', score: 8, reasons: ['trailing-loud-punctuation'], changeUrl: 'https://x/6/change/' },
      ],
    });
    const lines = tsv.split('\n');
    assert.equal(lines[0], 'id\tname\ttier\tscore\treasons\tchange_url');
    assert.equal(lines[1], '5\tAS211750\thigh-confidence\t20\tasn-token,digit-heavy\thttps://x/5/change/');
    assert.equal(lines[2], '6\tWeird Name\treview\t8\ttrailing-loud-punctuation\thttps://x/6/change/');
  });

  await t.test('an empty suspicious list still emits the header only', () => {
    assert.equal(hooks.buildSuspiciousNetworkNameTsv({ suspicious: [] }), 'id\tname\ttier\tscore\treasons\tchange_url');
  });

  await t.test('a missing analysis object still emits the header only', () => {
    assert.equal(hooks.buildSuspiciousNetworkNameTsv({}), 'id\tname\ttier\tscore\treasons\tchange_url');
  });

  await t.test('collapses internal whitespace runs (including tabs) in the name field', () => {
    const tsv = hooks.buildSuspiciousNetworkNameTsv({
      suspicious: [{ id: '1', name: 'Foo   Bar\tBaz', tier: 'review', score: 1, reasons: [], changeUrl: '' }],
    });
    assert.equal(tsv.split('\n')[1], '1\tFoo Bar Baz\treview\t1\t\t');
  });
});

test('mergeAuditSources', async (t) => {
  const hooks = loadCp();

  await t.test('an API-only row carries source "api" and no old IP', () => {
    const [merged] = hooks.mergeAuditSources(
      [{ id: '100', asn: '65000', name: 'Net A', ipaddr4: '1.2.3.4', ipaddr6: '', updated: '2024-01-01T00:00:00Z' }],
      [],
    );
    assert.equal(merged.netixlanId, '100');
    assert.equal(merged.newIp4, '1.2.3.4');
    assert.equal(merged.oldIp4, '');
    arrEqual(merged.sources, ['api']);
  });

  await t.test('a log-only DELETE outcome (row no longer in the API window) still surfaces', () => {
    const [merged] = hooks.mergeAuditSources(
      [],
      [{ netixlanId: '200', asn: '65001', oldIp4: '9.9.9.9', deleted: true, keeperId: '201', source: 'conflict-resolve', ts: '2024-02-01T00:00:00Z' }],
    );
    assert.equal(merged.deleted, true);
    assert.equal(merged.keeperId, '201');
    assert.equal(merged.oldIp4, '9.9.9.9');
    arrEqual(merged.sources, ['conflict-resolve']);
  });

  await t.test('merges an API row with a matching log outcome by netixlan id, filling in the old IP', () => {
    const [merged] = hooks.mergeAuditSources(
      [{ id: '100', asn: '65000', name: 'Net A', ipaddr4: '5.6.7.8', ipaddr6: '', updated: '2024-01-02T00:00:00Z' }],
      [{ netixlanId: '100', asn: '65000', oldIp4: '1.2.3.4', newIp4: '5.6.7.8', source: 'renumber', ts: '2024-01-01T00:00:00Z' }],
    );
    assert.equal(merged.oldIp4, '1.2.3.4');
    assert.equal(merged.newIp4, '5.6.7.8');
    arrEqual(merged.sources, ['api', 'renumber']);
  });

  await t.test('sorts results by timestamp descending', () => {
    const ids = hooks.mergeAuditSources(
      [
        { id: '1', asn: '1', name: 'A', updated: '2024-01-01T00:00:00Z' },
        { id: '2', asn: '2', name: 'B', updated: '2024-03-01T00:00:00Z' },
      ],
      [],
    ).map((m) => m.netixlanId);
    arrEqual(ids, ['2', '1']);
  });

  await t.test('accumulates multiple log sources onto the same entry without duplicating "api"', () => {
    const [merged] = hooks.mergeAuditSources(
      [{ id: '5', asn: '5', name: 'N', updated: '2024-01-01T00:00:00Z' }],
      [
        { netixlanId: '5', asn: '5', source: 'renumber', ts: '2024-01-02T00:00:00Z', newIp4: '1.1.1.1' },
        { netixlanId: '5', asn: '5', source: 'ixf-merge', ts: '2024-01-03T00:00:00Z' },
      ],
    );
    arrEqual(merged.sources, ['api', 'renumber', 'ixf-merge']);
  });
});

test('formatRecentChangeLines', async (t) => {
  const hooks = loadCp();

  await t.test('a deleted row with a keeper gets a "superseded by" suffix', () => {
    const lines = hooks.formatRecentChangeLines([
      { name: 'Net A', asn: '65000', netixlanId: '10', deleted: true, oldIp4: '1.2.3.4', oldIp6: '', keeperId: '11', sources: ['conflict-resolve'] },
    ]);
    arrEqual(lines, ['Net A (AS65000); netixlan #10; 1.2.3.4 → (deleted; superseded by #11)']);
  });

  await t.test('a deleted row with no known old IP and no keeper falls back to "? → (deleted)"', () => {
    const lines = hooks.formatRecentChangeLines([
      { name: '', asn: '', netixlanId: '', deleted: true, oldIp4: '', oldIp6: '', keeperId: '', sources: [] },
    ]);
    arrEqual(lines, ['(unknown network) (AS?); netixlan #?; ? → (deleted)']);
  });

  await t.test('a v4-only change emits one line', () => {
    const lines = hooks.formatRecentChangeLines([
      { name: 'Net B', asn: '65001', netixlanId: '20', deleted: false, oldIp4: '1.1.1.1', newIp4: '2.2.2.2', oldIp6: '', newIp6: '', absorbedFromId: '', sources: ['renumber'] },
    ]);
    arrEqual(lines, ['Net B (AS65001); netixlan #20; 1.1.1.1 → 2.2.2.2']);
  });

  await t.test('a dual-stack change emits one line per changed family', () => {
    const lines = hooks.formatRecentChangeLines([
      { name: 'Net C', asn: '65002', netixlanId: '30', deleted: false, oldIp4: '1.1.1.1', newIp4: '2.2.2.2', oldIp6: '::1', newIp6: '::2', absorbedFromId: '', sources: ['renumber'] },
    ]);
    arrEqual(lines, [
      'Net C (AS65002); netixlan #30; 1.1.1.1 → 2.2.2.2',
      'Net C (AS65002); netixlan #30; ::1 → ::2',
    ]);
  });

  await t.test('an absorbed-into-keeper row gets an "(absorbed from #id)" suffix', () => {
    const lines = hooks.formatRecentChangeLines([
      { name: 'Net D', asn: '65003', netixlanId: '40', deleted: false, oldIp4: '', newIp4: '3.3.3.3', oldIp6: '', newIp6: '', absorbedFromId: '41', sources: ['conflict-resolve-absorbed'] },
    ]);
    arrEqual(lines, ['Net D (AS65003); netixlan #40; ? → 3.3.3.3 (absorbed from #41)']);
  });

  await t.test('an API-only row with no address in either family falls back to the "no historical IP recorded" line', () => {
    const lines = hooks.formatRecentChangeLines([
      { name: 'Net E', asn: '65004', netixlanId: '50', deleted: false, oldIp4: '', newIp4: '', oldIp6: '', newIp6: '', absorbedFromId: '', sources: ['api'] },
    ]);
    arrEqual(lines, ['Net E (AS65004); netixlan #50; current: (no v4) / (no v6) (no historical IP recorded)']);
  });

  await t.test('missing name/asn/netixlanId fall back to "(unknown network)"/"AS?"/"netixlan #?"', () => {
    const lines = hooks.formatRecentChangeLines([
      { name: '', asn: '', netixlanId: '', deleted: false, oldIp4: '1.1.1.1', newIp4: '2.2.2.2', oldIp6: '', newIp6: '', absorbedFromId: '', sources: [] },
    ]);
    arrEqual(lines, ['(unknown network) (AS?); netixlan #?; 1.1.1.1 → 2.2.2.2']);
  });
});
