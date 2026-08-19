'use strict';

// Tests for scripts/build_userscripts.py's @version parity check.
//
// Tampermonkey polls the .meta.js to decide whether an update exists, but
// installs the .user.js generated from the .src.js. When those two headers
// disagree, the update check and the shipped code describe different versions:
// admins either never see an update that exists, or install one whose reported
// version is wrong. AGENTS.md asked a human to bump both; nothing enforced it,
// and all three scripts had drifted.
//
// See tests/helpers/build-script-runner.js for why these spawn a process.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PYTHON, makeFixture, runBuild } = require('./helpers/build-script-runner');

test('build_userscripts.py @version parity', { skip: PYTHON ? false : 'no python on PATH' }, async (t) => {
  await t.test('matching versions build cleanly', () => {
    const dir = makeFixture({ srcVersion: '1.2.3', metaVersion: '1.2.3' });
    const result = runBuild(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(dir, 'user.js', 'demo.user.js')), true);
  });

  await t.test('differing versions fail, naming both files and both values', () => {
    const dir = makeFixture({ srcVersion: '1.2.3', metaVersion: '1.2.4' });
    const result = runBuild(dir);
    assert.notEqual(result.status, 0, 'a drifted pair must not build clean');
    assert.match(result.stderr, /@version mismatch/);
    assert.match(result.stderr, /demo\.src\.js says 1\.2\.3/);
    assert.match(result.stderr, /demo\.meta\.js says 1\.2\.4/);
  });

  await t.test('the check runs without --check too, not only in CI mode', () => {
    // A mismatch is worth surfacing while regenerating locally; catching it
    // only under --check means the person who caused it never sees it.
    const dir = makeFixture({ srcVersion: '2.0.0', metaVersion: '2.0.1' });
    assert.notEqual(runBuild(dir, ['--check']).status, 0);
    assert.notEqual(runBuild(dir).status, 0);
  });

  await t.test('every bad pair is reported, not just the first', () => {
    const dir = makeFixture({
      srcVersion: '1.0.0',
      metaVersion: '1.0.1',
      extraScripts: [{ name: 'second', srcVersion: '3.0.0', metaVersion: '3.9.9' }],
    });
    const result = runBuild(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /demo\.src\.js says 1\.0\.0/);
    assert.match(result.stderr, /second\.src\.js says 3\.0\.0/, 'the run must not stop at the first bad pair');
  });

  await t.test('a missing .meta.js is an error, not a silent skip', () => {
    // Hard-failing is the deliberate choice: a script without a manifest never
    // auto-updates, and skipping would make the check quietly cover less than
    // it appears to.
    const dir = makeFixture({ withMeta: false });
    const result = runBuild(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no sibling demo\.meta\.js/);
    assert.match(result.stderr, /never auto-update/);
  });

  await t.test('a header with no @version at all is reported distinctly', () => {
    // Different from a mismatch: nothing to compare, rather than two things
    // disagreeing. A shared message would send the reader looking for a value
    // that is not there.
    const missingInMeta = runBuild(makeFixture({ metaVersion: null }));
    assert.notEqual(missingInMeta.status, 0);
    assert.match(missingInMeta.stderr, /demo\.meta\.js: no `\/\/ @version <value>` line/);
    assert.doesNotMatch(missingInMeta.stderr, /@version mismatch/);

    const missingInSrc = runBuild(makeFixture({ srcVersion: null }));
    assert.notEqual(missingInSrc.status, 0);
    assert.match(missingInSrc.stderr, /demo\.src\.js: no `\/\/ @version <value>` line/);
  });

  await t.test('a stray @version below the metadata block is not read as the header', () => {
    // A .src.js is ~11,600 lines of JavaScript, and scanning all of it would
    // let a comment further down masquerade as the directive. The header has
    // to be *missing* for that to show: with a header present the first match
    // wins either way, so a fixture that keeps one proves nothing.
    //
    // Whole-file scanning would find 9.9.9 here and report a confident
    // mismatch against the manifest -- a wrong diagnosis, sending the reader
    // to reconcile two values, neither of which is the header's. Reading only
    // the ==UserScript== block reports the real problem: there is no header
    // version at all.
    const dir = makeFixture({ srcVersion: null, metaVersion: '1.0.0' });
    fs.appendFileSync(path.join(dir, 'user.js', 'demo.src.js'), '\n// @version 9.9.9\n', 'utf-8');
    const result = runBuild(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /demo\.src\.js: no `\/\/ @version <value>` line/);
    assert.doesNotMatch(result.stderr, /9\.9\.9/, 'a stray line must not be reported as the version');
  });
});
