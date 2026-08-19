'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadScript, el } = require('./helpers/browser-shim');

const SCRIPT_PATH = path.join(__dirname, '..', 'peeringdb-fp-consolidated-tools.user.js');

/**
 * Loads the FP script for one route/DOM fixture, runs the set-window-title
 * module exactly like production dispatch does (match() gate, then run()),
 * and returns the resulting document.title.
 */
function titleFor(routeOpts, domOpts = {}) {
  const { document, hooks } = loadScript(SCRIPT_PATH, { hooksKey: '__pdbFpTestHooks__', ...routeOpts, ...domOpts });
  const ctx = hooks.getRouteContext();
  const mod = hooks.modules.find((m) => m.id === 'set-window-title');
  assert.ok(mod, 'set-window-title module not found');
  assert.ok(mod.match(ctx), `expected set-window-title to match pathname ${routeOpts.pathname}`);
  mod.run(ctx);
  return document.title;
}

test('FP entity pages keep their existing detailed title format', async (t) => {
  await t.test('network entity page', () => {
    const title = titleFor(
      { pathname: '/net/1234' },
      {
        elements: {
          'div[data-edit-name="name"]': el({ attrs: { 'data-edit-value': 'Example Net' } }),
          'div[data-edit-name="name_long"]': el({ innerText: 'Example Network Inc' }),
          'div[data-edit-name="asn"]': el({ innerText: '15169' }),
          'div[data-edit-name="aka"]': el({ innerText: '' }),
        },
      },
    );
    assert.equal(title, 'PDB | AS15169 | Example Network Inc | net.peeringdb.com');
  });

  await t.test('org entity page', () => {
    const title = titleFor(
      { pathname: '/org/42' },
      {
        elements: {
          'div[data-edit-name="name"]': el({ attrs: { 'data-edit-value': 'Example Org' } }),
          'div[data-edit-name="name_long"]': el({ innerText: '' }),
        },
      },
    );
    assert.equal(title, 'PDB | ORG | Example Org');
  });

  await t.test('ix entity page uses IXP label', () => {
    const title = titleFor(
      { pathname: '/ix/7' },
      {
        elements: {
          'div[data-edit-name="name"]': el({ attrs: { 'data-edit-value': 'Example IX' } }),
          'div[data-edit-name="name_long"]': el({ innerText: '' }),
        },
      },
    );
    assert.equal(title, 'PDB | IXP | Example IX');
  });
});

test('FP CP-entity-change branch (legacy, kept for parity)', () => {
  const title = titleFor(
    { pathname: '/cp/peeringdb_server/user/9/change/' },
    {
      elements: {
        'div[data-edit-name="name"]': el(),
        '#id_username': el({ value: 'jdoe' }),
        '#id_email': el({ value: 'jdoe@example.com' }),
      },
    },
  );
  assert.equal(title, 'PDB CP | USER | jdoe | jdoe@example.com');
});

test('FP static pages get bespoke titles', async (t) => {
  const cases = [
    ['/', 'PDB | Home'],
    ['/advanced_search', 'PDB | Advanced Search'],
    ['/sponsors', 'PDB | Sponsors'],
    ['/about', 'PDB | About'],
    ['/aup', 'PDB | Acceptable Use Policy (AUP)'],
    ['/maintenance', 'PDB | Maintenance'],
    ['/suggest/fac', 'PDB | Suggest Facility'],
    ['/_search', 'PDB | ES Search'],
    ['/register', 'PDB | Register'],
    ['/verify', 'PDB | My Profile'],
    ['/profile', 'PDB | My Profile'],
    ['/account/passkey', 'PDB | Account Security - Passkeys'],
    ['/reset-password', 'PDB | Account Recovery - Reset Password'],
    ['/username-retrieve', 'PDB | Account Recovery - Retrieve Username'],
    ['/username-retrieve/complete', 'PDB | Account Recovery - Retrieve Username'],
    ['/request-ownership', 'PDB | Request Ownership'],
    ['/remove-affiliation/', 'PDB | Remove Affiliation'],
    ['/verified-update/', 'PDB | Verified Update'],
    ['/verified-update/accept/', 'PDB | Verified Update'],
  ];

  for (const [pathname, expected] of cases) {
    await t.test(`${pathname} -> "${expected}"`, () => {
      assert.equal(titleFor({ pathname }), expected);
    });
  }
});

test('FP search page reflects the q query params', async (t) => {
  await t.test('single q param', () => {
    assert.equal(titleFor({ pathname: '/search', search: '?q=as15169' }), 'PDB | Search: "as15169"');
  });

  await t.test('/search/v2 alias behaves the same', () => {
    assert.equal(titleFor({ pathname: '/search/v2', search: '?q=as15169' }), 'PDB | Search: "as15169"');
  });

  await t.test('multiple q params are space-joined, matching extract_query()', () => {
    assert.equal(
      titleFor({ pathname: '/search', search: '?q=near&q=Amsterdam' }),
      'PDB | Search: "near Amsterdam"',
    );
  });

  await t.test('missing q falls back to a plain title', () => {
    assert.equal(titleFor({ pathname: '/search', search: '' }), 'PDB | Search');
  });

  await t.test('long query is truncated with an ellipsis', () => {
    const longQuery = 'a'.repeat(80);
    const title = titleFor({ pathname: '/search', search: `?q=${longQuery}` });
    assert.equal(title, `PDB | Search: "${'a'.repeat(59)}…"`);
    assert.ok(title.length < 80, 'title should be capped, not grow unbounded with the query');
  });
});

test('FP generic fallback normalizes titles on every other page', async (t) => {
  await t.test('2FA login page keeps its own title, PDB-prefixed', () => {
    assert.equal(
      titleFor({ pathname: '/account/login/' }, { title: 'Login' }),
      'PDB | Login',
    );
  });

  await t.test('allauth page keeps its own title, PDB-prefixed', () => {
    assert.equal(
      titleFor({ pathname: '/accounts/password/reset/' }, { title: 'Password Reset' }),
      'PDB | Password Reset',
    );
  });

  await t.test('unknown/future route falls back to the native title', () => {
    assert.equal(
      titleFor({ pathname: '/some-new-route-nobody-mapped-yet' }, { title: 'Whatever Django Rendered' }),
      'PDB | Whatever Django Rendered',
    );
  });

  await t.test('already-PDB-prefixed native title is left alone', () => {
    assert.equal(
      titleFor({ pathname: '/some-new-route-nobody-mapped-yet' }, { title: 'PDB | Already Set' }),
      'PDB | Already Set',
    );
  });

  await t.test('empty native title stays empty rather than producing "PDB | "', () => {
    assert.equal(titleFor({ pathname: '/some-new-route-nobody-mapped-yet' }, { title: '' }), '');
  });
});

test('FP SCRIPT_VERSION comes from GM_info, not a hard-coded literal', () => {
  // See the matching CP case: the version is read from the @version header at
  // install time so it can't drift. FP reports it in its self-check warning and
  // init debug line. '0.0.0-test' is what the browser-shim sandbox stubs.
  const { hooks } = loadScript(SCRIPT_PATH, { hooksKey: '__pdbFpTestHooks__', pathname: '/' });
  assert.equal(hooks.SCRIPT_VERSION, '0.0.0-test');
});
