// Loader for lib/*.js fragments that are pure (no window/document/fetch/GM_*
// references) -- e.g. lib/cp-name-normalization.js. These don't need the
// vm-based browser-shim.js sandbox at all: they're plain string/regex
// transforms, so a bare `new Function(...)` executing the fragment's source
// and returning the requested names is enough to get real, unmodified
// function references to test directly. No jsdom, no vm context, nothing to
// simulate. If a fragment ever grows a window/document dependency, it no
// longer belongs in this loader -- use browser-shim.js's loadScript instead.
'use strict';

const fs = require('node:fs');

/**
 * Loads a pure lib/*.js fragment and returns the requested top-level
 * function/const names as a plain object.
 * @param {string} fragmentPath - Absolute path to the lib fragment.
 * @param {string[]} exportNames - Top-level names declared in the fragment to return.
 * @returns {object} Map of name -> value for each requested export.
 */
function loadPureLib(fragmentPath, exportNames) {
  const source = fs.readFileSync(fragmentPath, 'utf-8');
  const body = `${source}\nreturn { ${exportNames.join(', ')} };`;
  // eslint-disable-next-line no-new-func -- deliberate: evaluating a local source fragment, not user input.
  const factory = new Function(body);
  return factory();
}

module.exports = { loadPureLib };
