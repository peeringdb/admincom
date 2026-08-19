'use strict';

// Structural guards on CP's four destructive/report modals.
//
// These are deliberately *source* assertions, not behavioral ones. The
// modals are pure DOM wiring, which this repo does not unit test (see the
// header of cp-ixf-merge-gates.test.js for the same split), and the test
// shim's FakeElement has no addEventListener at all, so a modal cannot be
// constructed -- let alone clicked -- through loadScript today.
//
// They exist because all three safeguards below were silently absent in
// shipped code and nothing failed:
//
//   * close() removed the backdrop without setting cancelSignal.cancelled,
//     so dismissing a modal mid-apply tore down the progress display while
//     the loop kept issuing PUT/DELETE with no remaining way to abort.
//   * Each opener resolved at its first render, so the caller's action lock
//     was released while the modal was still open and a second click could
//     stack a second modal, with its own cancelSignal, over the same rows.
//   * The conflict resolver pre-filled its type-to-confirm input from first
//     render, making the banner's "type the ixlan id to enable Apply"
//     safeguard inert.
//
// A source assertion cannot prove the wiring works -- that is what the
// manual smoke test in AGENTS.md is for -- but it does prove the safeguard
// has not been deleted again, which is the failure that actually happened.
// Assertions run against the generated .user.js, because that is what ships.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'peeringdb-cp-consolidated-tools.user.js'),
  'utf-8',
);

const MODAL_OPENERS = [
  'openIxlanRenumberModal',
  'openIxfMemberAuditModal',
  'openConflictResolverModal',
  'openRecentIpChangesModal',
];

/**
 * Slices one modal opener's body out of the script source.
 * @param {string} name - Opener function name.
 * @returns {string} Source text from the declaration to its closing brace.
 */
function openerBody(name) {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found -- was it renamed?`);
  const end = SOURCE.indexOf('\n    await closed;\n  }\n', start);
  assert.notEqual(end, -1, `${name} does not end by awaiting its close signal`);
  return SOURCE.slice(start, end);
}

test('every modal opener holds until the modal is dismissed', async (t) => {
  for (const name of MODAL_OPENERS) {
    await t.test(name, () => {
      const body = openerBody(name);
      assert.match(body, /const closed = new Promise\(/, 'declares a close signal');
      assert.match(body, /resolveClosed\(\);/, 'close() resolves it');
      // The lock the caller holds is only as good as this await; openerBody()
      // already fails if the terminating `await closed;` is gone.
    });
  }
});

test('dismissing a modal cancels its in-flight write loop', async (t) => {
  for (const name of MODAL_OPENERS) {
    await t.test(name, () => {
      const body = openerBody(name);
      // Keyed off the declaration, not a bare mention -- prose in a comment
      // must not make a modal look like it has a cancel signal.
      if (!/let cancelSignal = \{ cancelled: false \};/.test(body)) {
        // Read-only report modal -- nothing to cancel. Assert that, rather
        // than skipping, so adding writes to it fails this test.
        assert.equal(name, 'openRecentIpChangesModal');
        return;
      }
      const close = body.match(/function close\(\) \{([\s\S]*?)\n {4}\}/);
      assert.ok(close, `${name} has no close() to inspect`);
      assert.match(
        close[1],
        /cancelSignal\.cancelled = true;/,
        `${name}'s close() must cancel, not just hide`,
      );
    });
  }
});

test('the conflict resolver never pre-fills its type-to-confirm input', () => {
  // The gate is "the admin typed the ixlan id". Any assignment to
  // confirmInput.value satisfies it without the admin doing anything.
  assert.doesNotMatch(SOURCE, /confirmInput\.value\s*=/);
  // ...and the placeholder must not show the expected id either, since that
  // is what made an empty field look filled and prompted the pre-fill.
  assert.doesNotMatch(SOURCE, /confirmInput\.placeholder = normalizedExpectedIxlanId/);
  // The gate itself must still be wired up.
  assert.match(SOURCE, /confirmInput\.addEventListener\("input", recomputeApplyEnabled\)/);
});
