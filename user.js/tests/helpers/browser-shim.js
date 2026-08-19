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
 * A minimal but real element node -- enough of the DOM to test code that
 * *creates and inserts* elements (document.createElement, insertAdjacentElement,
 * append, nextElementSibling), which the selector-keyed `el()` above can't
 * support since it isn't connected to anything. Deliberately narrow: only the
 * operations DP's anchor-decoration code actually uses (afterend insertion,
 * attribute get/set, simple text content).
 */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.isConnected = true;
    this.parentNode = null;
    this.nextElementSibling = null;
    this.previousElementSibling = null;
    this.children = [];
    this._attrs = new Map();
    this._textContent = '';
    this.style = {};
    this.href = '';
    this.target = '';
    this.rel = '';
    this.title = '';
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  removeAttribute(name) {
    this._attrs.delete(name);
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
  }

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertAdjacentElement(position, node) {
    if (position !== 'afterend') return; // only mode DP's code uses
    node.parentNode = this.parentNode;
    node.previousElementSibling = this;
    node.nextElementSibling = this.nextElementSibling;
    if (this.nextElementSibling) this.nextElementSibling.previousElementSibling = node;
    this.nextElementSibling = node;
  }

  remove() {
    if (this.previousElementSibling) this.previousElementSibling.nextElementSibling = this.nextElementSibling;
    if (this.nextElementSibling) this.nextElementSibling.previousElementSibling = this.previousElementSibling;
    this.parentNode = null;
  }

  closest() {
    return null; // not exercised by any function called directly via test hooks
  }

  matches() {
    return false;
  }
}

/**
 * A minimal text node -- just enough for code that builds a fragment of
 * mixed text/element children (e.g. DP's linkifyText) and for tests that
 * read the result back via .textContent. nodeType 3 matches the real DOM's
 * Node.TEXT_NODE, in case code branches on it.
 */
class FakeTextNode {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text ?? '');
  }
}

/**
 * A minimal DocumentFragment -- reuses FakeElement's append/appendChild
 * (already supports mixed text/element children) under a non-tag name.
 */
class FakeDocumentFragment extends FakeElement {
  constructor() {
    super('#document-fragment');
  }
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
 * @param {object} [opts.fetchMap] - exact request URL -> JSON body. Powers a fake `fetch()` so
 *   API-calling functions (e.g. DP's fetchNetById/fetchOrgWithUsers) can be tested without any
 *   real network access; a URL not present in the map resolves as a 404. Omit entirely for
 *   scripts/tests that never call fetch().
 * @param {Storage} [opts.localStorage] - Externally-supplied fake localStorage (see
 *   makeFakeStorage()), for simulating two same-origin scripts (e.g. CP + FP) sharing real
 *   browser storage across separate loadScript() calls. Omit for a fresh, isolated instance
 *   (the default -- most tests want this).
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
    fetchMap = {},
    localStorage = makeFakeStorage(),
  } = opts;

  // Every fake-fetch request lands here in order. Returned from loadScript so a
  // test can assert request count and method -- the only observable difference
  // between one request and a retried one.
  const fetchCalls = [];

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
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createTextNode(text) {
      return new FakeTextNode(text);
    },
    createDocumentFragment() {
      return new FakeDocumentFragment();
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
    localStorage,
    sessionStorage: makeFakeStorage(),
    navigator: { userAgent: 'node-test', platform: 'node', language: 'en-US', hardwareConcurrency: 4 },
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    AbortController,
    fetch: makeFakeFetch(fetchMap, fetchCalls),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    addEventListener() {},
    removeEventListener() {},
    // Tampermonkey always injects GM_info regardless of @grant; the scripts read
    // GM_info.script.version rather than hard-coding their own version string, so
    // the sandbox must provide it or the IIFE throws before exporting its hooks.
    GM_info: { script: { version: '0.0.0-test' } },
    __PDB_TEST__: true,
  };
  sandbox.window = sandbox; // scripts read both bare `document`/`location` and `window.*`

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: scriptPath });

  const hooks = sandbox[hooksKey];
  if (!hooks) {
    throw new Error(`${path.basename(scriptPath)} did not expose window.${hooksKey} -- was window.__PDB_TEST__ wired up?`);
  }

  return { window: sandbox, document: fakeDocument, hooks, fetchCalls };
}

/**
 * Builds a fake response object with headers real enough for production code
 * to read. The previous version exposed only forEach(), so any code calling
 * response.headers.get() -- which lib/admincom-common.js's fetchWithRetry does
 * for Retry-After -- threw TypeError before its logic could be reached. That
 * is why the retry/backoff path had no coverage: not oversight, but a harness
 * that could not express the case.
 */
function makeFakeResponse(status, body, headers = {}) {
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (lowered.has(String(name).toLowerCase()) ? lowered.get(String(name).toLowerCase()) : null),
      has: (name) => lowered.has(String(name).toLowerCase()),
      forEach: (cb) => lowered.forEach((v, k) => cb(v, k)),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Builds a fake global fetch() keyed by exact request URL (query params and
 * all), returning a canned JSON body or a 404 when the URL isn't mapped.
 * Purpose: Let API-calling functions run for real (no manual mocking of the
 * function itself) while keeping tests fully offline/deterministic -- no
 * accidental live traffic, no network flakiness.
 *
 * A fetchMap value is normally the JSON body to return with a 200. To model a
 * failure or a header-bearing response, use the descriptor form instead:
 *
 *   { __response: true, status: 503, body: {}, headers: { 'Retry-After': '1' } }
 *
 * Every call is appended to `calls` as { url, method, body, headers }, so a
 * test can assert *how many* requests a function issued and with which method
 * -- the only way to observe retry behavior, since a retried request is
 * indistinguishable from a single one by its return value alone.
 *
 * @param {object} fetchMap - URL -> JSON body, or URL -> response descriptor.
 * @param {object[]} calls - Array the fake appends each request to, in order.
 */
function makeFakeFetch(fetchMap, calls) {
  return async (url, init = {}) => {
    const key = String(url);
    calls.push({
      url: key,
      method: String(init.method || 'GET').toUpperCase(),
      body: init.body,
      headers: init.headers,
    });

    if (!Object.prototype.hasOwnProperty.call(fetchMap, key)) {
      return makeFakeResponse(404, {});
    }

    let entry = fetchMap[key];

    // A { __sequence: [...] } entry serves its elements in order, repeating
    // the last one once exhausted. Read-modify-verify flows need this: CP's
    // IX-F merge GETs the keeper, PUTs it, then GETs it again to confirm the
    // write landed before deleting the only other copy -- and a single static
    // response per URL cannot express "different after the write". Each
    // element is itself a bare body or a __response descriptor.
    if (entry && typeof entry === 'object' && Array.isArray(entry.__sequence)) {
      const seq = entry.__sequence;
      if (seq.length === 0) return makeFakeResponse(404, {});
      const index = Math.min(entry.__served || 0, seq.length - 1);
      entry.__served = (entry.__served || 0) + 1;
      entry = seq[index];
    }

    if (entry && typeof entry === 'object' && entry.__response === true) {
      return makeFakeResponse(
        typeof entry.status === 'number' ? entry.status : 200,
        'body' in entry ? entry.body : {},
        entry.headers || {},
      );
    }
    return makeFakeResponse(200, entry);
  };
}

/**
 * Builds a fake Storage (localStorage/sessionStorage) instance -- full enough
 * to support both plain get/set/remove and the key-enumeration sweeps used
 * by the legacy-cache-migration functions (storage.length + storage.key(i)),
 * not just a Map wrapper.
 */
function makeFakeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
  };
}

module.exports = { loadScript, el, FakeElement, FakeTextNode, FakeDocumentFragment, makeFakeStorage, makeFakeResponse };
