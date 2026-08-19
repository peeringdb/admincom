'use strict';

// Harness for the tests that exercise scripts/build_userscripts.py.
//
// These are the only tests here that spawn a process. The build script is
// Python and the suite is node:test, but the alternative -- a second test
// runner -- is exactly what AGENTS.md says not to add without discussing it
// first, and the interpreter is one the build already requires. Each test
// builds a throwaway repo layout in a temp directory and runs the real script
// against it, so nothing touches the working tree.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUILD_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'build_userscripts.py');

/**
 * Locates a usable Python interpreter, or null when none is on PATH.
 * @returns {string|null} Executable name.
 */
function findPython() {
  for (const exe of ['python', 'python3']) {
    const probe = spawnSync(exe, ['--version'], { encoding: 'utf-8' });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

const PYTHON = findPython();

/**
 * Builds a userscript metadata block.
 * @param {string} name - Script name for @name.
 * @param {string|null} version - Version value, or null to omit the line.
 * @returns {string} The ==UserScript== block, newline-terminated.
 */
function metadataBlock(name, version) {
  const versionLine = version === null ? '' : `// @version      ${version}\n`;
  return `// ==UserScript==\n// @name         ${name}\n${versionLine}// ==/UserScript==\n`;
}

/**
 * Creates a throwaway repo layout the build script can run against.
 *
 * Defaults produce a well-formed single-script repo; each option turns off one
 * thing so a test can isolate a single failure mode.
 * @param {object} [opts] - Fixture options.
 * @param {boolean} [opts.withMarker] - Emit the /* @include *\/ marker.
 * @param {boolean} [opts.withMeta] - Emit a sibling .meta.js.
 * @param {string|null} [opts.srcVersion] - .src.js @version, null to omit.
 * @param {string|null} [opts.metaVersion] - .meta.js @version, null to omit.
 * @param {object[]} [opts.extraScripts] - Further scripts, same option shape
 *   plus a `name`, for asserting that every bad pair is reported.
 * @returns {string} Path to the temporary working directory.
 */
function makeFixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-build-'));
  const userJs = path.join(dir, 'user.js');
  fs.mkdirSync(path.join(userJs, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(userJs, 'lib', 'admincom-common.js'), 'function dbg() {}\n', 'utf-8');

  const scripts = [{ name: 'demo', ...opts }, ...(opts.extraScripts || [])];
  for (const script of scripts) {
    const {
      name,
      withMarker = true,
      withMeta = true,
      srcVersion = '1.0.0',
      metaVersion = '1.0.0',
    } = script;
    const marker = withMarker ? '  /* @include admincom-common.js */\n' : '';
    fs.writeFileSync(
      path.join(userJs, `${name}.src.js`),
      `${metadataBlock(name, srcVersion)}\n(function () {\n  "use strict";\n${marker}  dbg("x");\n})();\n`,
      'utf-8',
    );
    if (withMeta) {
      fs.writeFileSync(path.join(userJs, `${name}.meta.js`), metadataBlock(name, metaVersion), 'utf-8');
    }
  }
  return dir;
}

/**
 * Runs the real build script with the fixture directory as cwd.
 * @param {string} cwd - Fixture directory.
 * @param {string[]} [args] - Extra arguments (e.g. ['--check']).
 * @returns {object} spawnSync result.
 */
function runBuild(cwd, args = []) {
  return spawnSync(PYTHON, [BUILD_SCRIPT, ...args], { cwd, encoding: 'utf-8' });
}

module.exports = { PYTHON, makeFixture, runBuild, BUILD_SCRIPT };
