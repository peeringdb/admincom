'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, el } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js');

/**
 * Loads the CP script for one route/DOM fixture, runs the set-window-title
 * module exactly like production dispatch does (match() gate, then run()),
 * and returns the resulting document.title.
 */
function titleFor(routeOpts, domOpts = {}) {
  const { document, hooks } = loadScript(SCRIPT_PATH, { hooksKey: '__pdbCpTestHooks__', ...routeOpts, ...domOpts });
  const ctx = hooks.getRouteContext();
  const mod = hooks.modules.find((m) => m.id === 'set-window-title');
  assert.ok(mod, 'set-window-title module not found');
  assert.ok(mod.match(ctx), `expected set-window-title to match pathname ${routeOpts.pathname}`);
  mod.run(ctx);
  return document.title;
}

test('CP entity change pages keep their existing title format', async (t) => {
  await t.test('network change page', () => {
    const title = titleFor(
      { pathname: '/cp/peeringdb_server/network/123/change/' },
      {
        elements: {
          '#id_name': el({ value: 'Example Net' }),
          '#id_country > option[selected]': el({ innerText: 'US' }),
        },
      },
    );
    assert.equal(title, 'PDB CP | NETWORK | Example Net | US');
  });

  await t.test('user change page uses username/email, not name/country', () => {
    const title = titleFor(
      { pathname: '/cp/peeringdb_server/user/9/change/' },
      {
        elements: {
          '#id_username': el({ value: 'jdoe' }),
          '#id_email': el({ value: 'jdoe@example.com' }),
        },
      },
    );
    assert.equal(title, 'PDB CP | USER | jdoe | jdoe@example.com');
  });
});

test('CP history pages are generalized beyond network', async (t) => {
  await t.test('network history (breadcrumb name)', () => {
    const title = titleFor(
      { pathname: '/cp/peeringdb_server/network/123/history/' },
      { elementLists: { '#grp-breadcrumbs a': [el({ innerText: 'Home' }), el({ innerText: 'Example Net' })] } },
    );
    assert.equal(title, 'PDB CP | NETWORK | Example Net | History');
  });

  await t.test('organization history (previously uncovered — was hardcoded to network only)', () => {
    const title = titleFor(
      { pathname: '/cp/peeringdb_server/organization/42/history/' },
      { elementLists: { '#grp-breadcrumbs a': [el({ innerText: 'Home' }), el({ innerText: 'Example Org' })] } },
    );
    assert.equal(title, 'PDB CP | ORGANIZATION | Example Org | History');
  });

  await t.test('falls back to h1 text (with trailing "history" token stripped) when no usable breadcrumb', () => {
    const title = titleFor(
      { pathname: '/cp/peeringdb_server/facility/7/history/' },
      { elements: { '#grp-content-title h1, h1': el({ innerText: 'Example Facility history' }) } },
    );
    assert.equal(title, 'PDB CP | FACILITY | Example Facility | History');
  });

  await t.test('falls back to entity#id when nothing else is available', () => {
    const title = titleFor({ pathname: '/cp/peeringdb_server/carrier/5/history/' });
    assert.equal(title, 'PDB CP | CARRIER | carrier#5 | History');
  });
});

test('CP list/add/delete pages, previously uncovered, get titled for any of the 35 registered models', async (t) => {
  await t.test('list page', () => {
    assert.equal(titleFor({ pathname: '/cp/peeringdb_server/network/' }), 'PDB CP | NETWORK | List');
  });

  await t.test('add page', () => {
    assert.equal(titleFor({ pathname: '/cp/peeringdb_server/network/add/' }), 'PDB CP | NETWORK | Add');
  });

  await t.test('delete confirm page', () => {
    assert.equal(
      titleFor({ pathname: '/cp/peeringdb_server/network/123/delete/' }),
      'PDB CP | NETWORK | Delete #123',
    );
  });

  await t.test('a model with no bespoke label still works via the raw entity slug', () => {
    assert.equal(
      titleFor({ pathname: '/cp/peeringdb_server/userorgaffiliationrequest/' }),
      'PDB CP | USERORGAFFILIATIONREQUEST | List',
    );
  });
});

test('CP org-merge-tool superuser page', () => {
  assert.equal(
    titleFor({ pathname: '/cp/peeringdb_server/organization/org-merge-tool/' }),
    'PDB CP | Org Merge Tool',
  );
});

test('CP generic fallback normalizes titles outside peeringdb_server', async (t) => {
  await t.test('bare admin dashboard', () => {
    assert.equal(titleFor({ pathname: '/cp/' }, { title: 'Site administration' }), 'PDB CP | Site administration');
  });

  await t.test('another registered app (e.g. auth) admin page', () => {
    assert.equal(titleFor({ pathname: '/cp/auth/group/' }, { title: 'Select group to change' }), 'PDB CP | Select group to change');
  });

  await t.test('already-PDB-prefixed native title is left alone', () => {
    assert.equal(titleFor({ pathname: '/cp/auth/group/' }, { title: 'PDB CP | Already Set' }), 'PDB CP | Already Set');
  });

  await t.test('empty native title stays empty rather than producing "PDB CP | "', () => {
    assert.equal(titleFor({ pathname: '/cp/' }, { title: '' }), '');
  });
});
