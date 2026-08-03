'use strict';

// Opt-in, network-touching hardening tests for the FP set-window-title
// entity-page branch. These fetch a handful of *real* records from the
// public PeeringDB API and feed the actual field values through the same
// DOM-fixture path the offline unit tests use, so the title format gets
// checked against real-world data shapes (unicode names, absent name_long/
// aka, etc.) rather than only hand-picked synthetic fixtures.
//
// NOT part of the default `node --test` run (see the `skip` guard below) --
// PeeringDB's public API is rate-limited to 20 requests/minute for anonymous
// callers, and a network dependency has no place in the fast/offline suite
// that runs on every edit. This file makes at most 5 requests total, spaced
// out defensively; do not add more calls to this file without re-checking
// that budget, and never run it in a loop or wire it into CI on every push.
//
// Run explicitly with (run from user.js/; a bare directory arg doesn't work
// with node's test runner, use a glob or an explicit file path):
//   PDB_LIVE_TESTS=1 node --test tests/live/*.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, el } = require('../helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'peeringdb-fp-consolidated-tools.user.js');
const API_BASE = 'https://www.peeringdb.com/api';
const REQUEST_SPACING_MS = 1500;
const FETCH_TIMEOUT_MS = 10000;

const RUN_LIVE = process.env.PDB_LIVE_TESTS === '1';
const SKIP_REASON =
  'Live PeeringDB API tests are opt-in (hits a rate-limited public API). ' +
  'Run with PDB_LIVE_TESTS=1 node --test tests/live/*.test.js to enable.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches one row from a PeeringDB list/detail API endpoint, or null on any failure. */
async function fetchRow(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'peeringdb-admincom-tests (+https://github.com/peeringdb/admincom)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body?.data?.[0] || null;
  } finally {
    clearTimeout(timer);
  }
}

function titleFor(routeOpts, domOpts = {}) {
  const { document, hooks } = loadScript(SCRIPT_PATH, { hooksKey: '__pdbFpTestHooks__', ...routeOpts, ...domOpts });
  const ctx = hooks.getRouteContext();
  const mod = hooks.modules.find((m) => m.id === 'set-window-title');
  assert.ok(mod, 'set-window-title module not found');
  assert.ok(mod.match(ctx), `expected set-window-title to match pathname ${routeOpts.pathname}`);
  mod.run(ctx);
  return document.title;
}

test('FP entity titles, hardened against live PeeringDB API records', { skip: RUN_LIVE ? false : SKIP_REASON }, async (t) => {
  let net = null;

  await t.test('network (AS15169 / Google, looked up by ASN so the test survives ID churn)', async () => {
    net = await fetchRow(`${API_BASE}/net?asn=15169&limit=1`);
    if (!net) {
      t.skip('could not reach the live PeeringDB API (offline sandbox / network blocked?)');
      return;
    }

    const title = titleFor(
      { pathname: `/net/${net.id}` },
      {
        elements: {
          'div[data-edit-name="name"]': el({ attrs: { 'data-edit-value': net.name } }),
          'div[data-edit-name="name_long"]': el({ innerText: net.name_long || '' }),
          'div[data-edit-name="asn"]': el({ innerText: String(net.asn) }),
          'div[data-edit-name="aka"]': el({ innerText: net.aka || '' }),
        },
      },
    );

    const expectedName = net.name_long || net.name;
    const expectedAka = net.aka && net.aka !== expectedName ? ` (a.k.a. ${net.aka})` : '';
    assert.equal(title, `PDB | AS${net.asn} | ${expectedName}${expectedAka} | net.peeringdb.com`);
  });

  await sleep(REQUEST_SPACING_MS);

  await t.test('organization (the org that owns the network above -- reuses net, no extra lookup)', async () => {
    if (!net) {
      t.skip('network lookup above did not succeed');
      return;
    }
    const org = await fetchRow(`${API_BASE}/org/${net.org_id}`);
    if (!org) {
      t.skip('could not reach the live PeeringDB API (offline sandbox / network blocked?)');
      return;
    }

    const title = titleFor(
      { pathname: `/org/${org.id}` },
      {
        elements: {
          'div[data-edit-name="name"]': el({ attrs: { 'data-edit-value': org.name } }),
          'div[data-edit-name="name_long"]': el({ innerText: org.name_long || '' }),
        },
      },
    );
    assert.equal(title, `PDB | ORG | ${org.name_long || org.name}`);
  });

  await sleep(REQUEST_SPACING_MS);

  await t.test('internet exchange (arbitrary live record)', async () => {
    const ix = await fetchRow(`${API_BASE}/ix?limit=1`);
    if (!ix) {
      t.skip('could not reach the live PeeringDB API (offline sandbox / network blocked?)');
      return;
    }

    const title = titleFor(
      { pathname: `/ix/${ix.id}` },
      {
        elements: {
          'div[data-edit-name="name"]': el({ attrs: { 'data-edit-value': ix.name } }),
          'div[data-edit-name="name_long"]': el({ innerText: ix.name_long || '' }),
        },
      },
    );
    assert.equal(title, `PDB | IXP | ${ix.name_long || ix.name}`);
  });

  await sleep(REQUEST_SPACING_MS);

  await t.test('facility (arbitrary live record)', async () => {
    const fac = await fetchRow(`${API_BASE}/fac?limit=1`);
    if (!fac) {
      t.skip('could not reach the live PeeringDB API (offline sandbox / network blocked?)');
      return;
    }

    const title = titleFor(
      { pathname: `/fac/${fac.id}` },
      {
        elements: {
          'div[data-edit-name="name"]': el({ attrs: { 'data-edit-value': fac.name } }),
          'div[data-edit-name="name_long"]': el({ innerText: fac.name_long || '' }),
        },
      },
    );
    assert.equal(title, `PDB | FAC | ${fac.name_long || fac.name}`);
  });

  await sleep(REQUEST_SPACING_MS);

  await t.test('carrier (arbitrary live record)', async () => {
    const carrier = await fetchRow(`${API_BASE}/carrier?limit=1`);
    if (!carrier) {
      t.skip('could not reach the live PeeringDB API (offline sandbox / network blocked?)');
      return;
    }

    const title = titleFor(
      { pathname: `/carrier/${carrier.id}` },
      {
        elements: {
          'div[data-edit-name="name"]': el({ attrs: { 'data-edit-value': carrier.name } }),
          'div[data-edit-name="name_long"]': el({ innerText: carrier.name_long || '' }),
        },
      },
    );
    assert.equal(title, `PDB | CARRIER | ${carrier.name_long || carrier.name}`);
  });
});
