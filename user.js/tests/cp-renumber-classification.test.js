'use strict';

// Tests for the IXLAN Renumber modal's non-arithmetic pure logic: the hash
// payload parser (the contract between the DP launcher and this CP module),
// per-row eligibility classification, and the PUT payload/error-detail
// helpers shared with the IX-F merge apply flow. CIDR/host-bit math itself
// is covered separately in cp-ip-cidr.test.js. All expected values below
// were captured empirically from the real functions before being hardcoded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js');

function loadCp() {
  return loadScript(SCRIPT_PATH, { hooksKey: '__pdbCpTestHooks__', pathname: '/cp/' }).hooks;
}

test('parseRenumberHash', async (t) => {
  const hooks = loadCp();

  await t.test('parses a full v4+v6 payload', () => {
    const r = hooks.parseRenumberHash(
      '#pdb-renumber=v1&old4=185.0.1.0/24&new4=185.1.184.0/23&old6=2001:db8::/32&new6=2001:db9::/32&ixlan=42&ticket=T-100',
    );
    assert.equal(r.old4, '185.0.1.0/24');
    assert.equal(r.new4, '185.1.184.0/23');
    assert.equal(r.old6, '2001:db8::/32');
    assert.equal(r.new6, '2001:db9::/32');
    assert.equal(r.ixlanId, '42');
    assert.equal(r.ticketId, 'T-100');
    assert.equal(r.hasV4, true);
    assert.equal(r.hasV6, true);
  });

  await t.test('parses a v4-only payload with hasV6 false and empty v6 fields', () => {
    const r = hooks.parseRenumberHash('#pdb-renumber=v1&old4=185.0.1.0/24&new4=185.1.184.0/23&ixlan=42&ticket=T-100');
    assert.equal(r.hasV4, true);
    assert.equal(r.hasV6, false);
    assert.equal(r.old6, '');
    assert.equal(r.new6, '');
  });

  await t.test('tolerates a missing leading "#"', () => {
    const r = hooks.parseRenumberHash('pdb-renumber=v1&old4=185.0.1.0/24&new4=185.1.184.0/23');
    assert.equal(r.hasV4, true);
  });

  await t.test('rejects a hash version other than v1', () => {
    assert.equal(hooks.parseRenumberHash('#pdb-renumber=v2&old4=185.0.1.0/24&new4=185.1.184.0/23'), null);
  });

  await t.test('rejects an incomplete v4 pair (old4 without new4)', () => {
    assert.equal(hooks.parseRenumberHash('#pdb-renumber=v1&old4=185.0.1.0/24'), null);
  });

  await t.test('rejects a payload with neither v4 nor v6 complete', () => {
    assert.equal(hooks.parseRenumberHash('#pdb-renumber=v1&ixlan=42'), null);
  });

  await t.test('rejects a hash without the pdb-renumber key at all', () => {
    assert.equal(hooks.parseRenumberHash('#foo=bar'), null);
  });

  await t.test('rejects empty and undefined input', () => {
    assert.equal(hooks.parseRenumberHash(''), null);
    assert.equal(hooks.parseRenumberHash(undefined), null);
  });
});

test('buildNetixlanPutPayload', async (t) => {
  const hooks = loadCp();

  await t.test('strips server-managed fields', () => {
    const payload = hooks.buildNetixlanPutPayload({
      id: 1, created: 'x', updated: 'y', _grainy_status: 'z', status_dashboard_url: 'u',
      ipaddr4: '1.2.3.4', ipaddr6: null, asn: 100, speed: 1000,
    });
    assert.equal(payload.id, undefined);
    assert.equal(payload.created, undefined);
    assert.equal(payload.updated, undefined);
    assert.equal(payload._grainy_status, undefined);
    assert.equal(payload.status_dashboard_url, undefined);
    assert.equal(payload.asn, 100);
    assert.equal(payload.speed, 1000);
  });

  await t.test('normalizes null ipaddr6 to empty string', () => {
    const payload = hooks.buildNetixlanPutPayload({ id: 1, ipaddr4: '1.2.3.4', ipaddr6: null });
    assert.equal(payload.ipaddr6, '');
  });

  await t.test('normalizes undefined ipaddr4/ipaddr6 to empty string', () => {
    const payload = hooks.buildNetixlanPutPayload({ id: 2, ipaddr4: undefined, ipaddr6: undefined });
    assert.equal(payload.ipaddr4, '');
    assert.equal(payload.ipaddr6, '');
  });

  await t.test('leaves real address values untouched', () => {
    const payload = hooks.buildNetixlanPutPayload({ id: 3, ipaddr4: '5.6.7.8', ipaddr6: '2001:db8::1' });
    assert.equal(payload.ipaddr4, '5.6.7.8');
    assert.equal(payload.ipaddr6, '2001:db8::1');
  });
});

test('extractRenumberApiErrorDetail', async (t) => {
  const hooks = loadCp();

  await t.test('returns "http-error" for a null result', () => {
    assert.equal(hooks.extractRenumberApiErrorDetail(null), 'http-error');
  });

  await t.test('prefers result.reason over data.detail', () => {
    const detail = hooks.extractRenumberApiErrorDetail({ reason: 'network-error', data: { detail: 'ignored' } });
    assert.equal(detail, 'network-error');
  });

  await t.test('uses data.detail when reason is absent', () => {
    assert.equal(hooks.extractRenumberApiErrorDetail({ data: { detail: 'Not found.' } }), 'Not found.');
  });

  await t.test('joins per-field DRF validation arrays', () => {
    const detail = hooks.extractRenumberApiErrorDetail({
      data: { ipaddr4: ['This IP already exists.'], ipaddr6: ['Bad value.'] },
    });
    assert.equal(detail, 'ipaddr4: This IP already exists. | ipaddr6: Bad value.');
  });

  await t.test('skips the "meta" field', () => {
    const detail = hooks.extractRenumberApiErrorDetail({ data: { meta: { foo: 1 }, ipaddr4: ['dup'] } });
    assert.equal(detail, 'ipaddr4: dup');
  });

  await t.test('stringifies a non-array, non-string field value', () => {
    assert.equal(hooks.extractRenumberApiErrorDetail({ data: { count: 5 } }), 'count: 5');
  });

  await t.test('falls back to rawBody when data has no usable fields', () => {
    assert.equal(hooks.extractRenumberApiErrorDetail({ data: null, rawBody: '<html>500</html>' }), '<html>500</html>');
  });

  await t.test('falls back to "http-<status>" when nothing else is available', () => {
    assert.equal(hooks.extractRenumberApiErrorDetail({ data: null, rawBody: '', status: 500 }), 'http-500');
    assert.equal(hooks.extractRenumberApiErrorDetail({}), 'http-error');
  });

  await t.test('truncates a long field-error message to 240 characters', () => {
    const detail = hooks.extractRenumberApiErrorDetail({ data: { field: 'x'.repeat(300) } });
    assert.equal(detail.length, 240);
    assert.ok(detail.startsWith('field: '));
  });
});

test('classifyRenumberRows', async (t) => {
  const hooks = loadCp();
  const payload4 = { old4: '185.0.1.0/24', new4: '185.1.184.0/23', old6: '', new6: '', hasV4: true, hasV6: false };

  await t.test('marks a row eligible when its renumbered IP is free', () => {
    const entries = hooks.classifyRenumberRows([{ id: 1, ipaddr4: '185.0.1.50', ipaddr6: '' }], payload4);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].v4.status, 'eligible');
    assert.equal(entries[0].v4.newIp, '185.1.184.50');
    assert.equal(entries[0].v6, null);
    assert.equal(entries[0].anyEligible, true);
  });

  await t.test('marks a row no-change when the renumber target equals its current IP', () => {
    const samePrefix = { old4: '185.1.184.0/23', new4: '185.1.184.0/23', hasV4: true, hasV6: false };
    const entries = hooks.classifyRenumberRows([{ id: 1, ipaddr4: '185.1.184.50', ipaddr6: '' }], samePrefix);
    assert.equal(entries[0].v4.status, 'no-change');
    assert.equal(entries[0].anyEligible, false);
  });

  await t.test('marks a row conflict when its target IP is already taken by another fetched row', () => {
    const entries = hooks.classifyRenumberRows(
      [
        { id: 1, ipaddr4: '185.0.1.50', ipaddr6: '' },
        { id: 2, ipaddr4: '185.1.184.50', ipaddr6: '' },
      ],
      payload4,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].row.id, 1);
    assert.equal(entries[0].v4.status, 'conflict');
  });

  await t.test('ignores a row whose address is not inside the old prefix', () => {
    const entries = hooks.classifyRenumberRows([{ id: 1, ipaddr4: '10.0.0.5', ipaddr6: '' }], payload4);
    assert.equal(entries.length, 0);
  });

  await t.test('ignores a row with no ipaddr4 when only a v4 payload is given', () => {
    const entries = hooks.classifyRenumberRows([{ id: 1, ipaddr4: '', ipaddr6: '' }], payload4);
    assert.equal(entries.length, 0);
  });

  await t.test('options.extraConflictIps4 forces a conflict against an IP outside the fetched set', () => {
    const entries = hooks.classifyRenumberRows(
      [{ id: 1, ipaddr4: '185.0.1.50', ipaddr6: '' }],
      payload4,
      { extraConflictIps4: ['185.1.184.50'] },
    );
    assert.equal(entries[0].v4.status, 'conflict');
  });

  await t.test('marks a row skip with a reason when the host bits do not fit the new prefix', () => {
    const narrow = { old4: '185.0.1.0/24', new4: '185.1.184.0/28', hasV4: true, hasV6: false };
    const entries = hooks.classifyRenumberRows([{ id: 1, ipaddr4: '185.0.1.200', ipaddr6: '' }], narrow);
    assert.equal(entries[0].v4.status, 'skip');
    assert.equal(entries[0].v4.reason, 'host-out-of-range');
  });

  await t.test('classifies v4 and v6 independently on a dual-stack row', () => {
    const dualPayload = {
      old4: '185.0.1.0/24', new4: '185.1.184.0/23',
      old6: '2001:db8::/32', new6: '2001:db9::/32',
      hasV4: true, hasV6: true,
    };
    const entries = hooks.classifyRenumberRows(
      [{ id: 1, ipaddr4: '185.0.1.50', ipaddr6: '2001:db8::50' }],
      dualPayload,
    );
    assert.equal(entries[0].v4.status, 'eligible');
    assert.equal(entries[0].v4.newIp, '185.1.184.50');
    assert.equal(entries[0].v6.status, 'eligible');
    assert.equal(entries[0].v6.newIp, '2001:db9::50');
    assert.equal(entries[0].anyEligible, true);
  });
});
