// Minimal, hand-rolled browser shim for testing the CP/FP userscripts under
// Node's built-in test runner -- no jsdom/package manager, consistent with
// this repo's zero-dependency policy (see user.js/AGENTS.md).
//
// Elements are looked up by exact selector string rather than parsed as real
// CSS, since the scripts only ever call qs()/qsa() with a small, known set of
// literal selector strings. This is deliberately narrow: it is not a general
// DOM, only enough of one to run getRouteContext() and a single module's
// match()/run() in isolation.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Builds a fake element supporting the handful of properties/methods the
 * scripts read: .value, .innerText, .getAttribute(name).
 */
function el({ value, innerText, attrs = {} } = {}) {
  return {
    value,
    innerText,
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
  };
}

/**
 * Loads a generated .user.js script into a fresh vm context with a minimal
 * fake window/document, using the window.__PDB_TEST__ escape hatch (see the
 * end of each .src.js) to skip the real browser bootstrap and instead expose
 * { getRouteContext, modules } on window[hooksKey].
 *
 * @param {string} scriptPath - Absolute path to the .user.js file to load.
 * @param {object} opts
 * @param {string} opts.hooksKey - '__pdbFpTestHooks__' or '__pdbCpTestHooks__'.
 * @param {string} opts.pathname - window.location.pathname for this case.
 * @param {string} [opts.search] - window.location.search (query string, including leading "?").
 * @param {string} [opts.hostname] - window.location.hostname.
 * @param {string} [opts.title] - initial document.title (simulates the server-rendered title).
 * @param {object} [opts.elements] - selector string -> fake element, for qs()/getInputValue()/getText().
 * @param {object} [opts.elementLists] - selector string -> array of fake elements, for qsa().
 * @returns {{ window: object, document: object, hooks: { getRouteContext: Function, modules: Array } }}
 */
function loadScript(scriptPath, opts) {
  const {
    hooksKey,
    pathname,
    search = '',
    hostname = 'www.peeringdb.com',
    title = '',
    elements = {},
    elementLists = {},
  } = opts;

  const source = fs.readFileSync(scriptPath, 'utf-8');

  const fakeDocument = {
    title,
    readyState: 'complete',
    querySelector(selector) {
      return Object.prototype.hasOwnProperty.call(elements, selector) ? elements[selector] : null;
    },
    querySelectorAll(selector) {
      return Object.prototype.hasOwnProperty.call(elementLists, selector) ? elementLists[selector] : [];
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    document: fakeDocument,
    location: {
      pathname,
      search,
      hostname,
      origin: `https://${hostname}`,
      href: `https://${hostname}${pathname}${search}`,
    },
    localStorage: makeFakeStorage(),
    sessionStorage: makeFakeStorage(),
    navigator: { userAgent: 'node-test', platform: 'node', language: 'en-US', hardwareConcurrency: 4 },
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    addEventListener() {},
    removeEventListener() {},
    __PDB_TEST__: true,
  };
  sandbox.window = sandbox; // scripts read both bare `document`/`location` and `window.*`

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: scriptPath });

  const hooks = sandbox[hooksKey];
  if (!hooks) {
    throw new Error(`${path.basename(scriptPath)} did not expose window.${hooksKey} -- was window.__PDB_TEST__ wired up?`);
  }

  return { window: sandbox, document: fakeDocument, hooks };
}

function makeFakeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

module.exports = { loadScript, el };
