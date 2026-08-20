// Shared cross-script helpers for the admincom Tampermonkey userscripts:
// formatting, DOM-safety and IP-token predicates, plus an ASN ->
// network-name resolver built on the shared cache and retry wrapper from
// admincom-common.js (which every script inlines ahead of this
// fragment's marker). For now only the DeskPro script includes this fragment;
// whether CP and FP adopt it is a decision deferred until a concrete
// caller lands there.
//
// This is a source fragment, not a standalone script: it is inlined into
// a *.user.js by scripts/build_userscripts.py at the `/* @include
// admincom-shared-helpers.js */` marker in that script's *.src.js. Edit
// this file, then re-run the build script -- do not hand-edit the
// generated block inside the .user.js files, your changes will be
// overwritten.
//
// Symbols below that no script references yet carry the frozen @staged
// grammar; drop a symbol's marker in the commit that wires its first
// caller.

// Selector for DeskPro-style rich-text editor containers. Mutating text
// nodes/anchors under an active editor's selection can desync the editor
// and hang the tab, so decoration code checks ancestry against this first.
const EDITABLE_CONTAINER_SELECTOR = '[contenteditable="true"]';

/**
 * Determines whether a node sits inside an editable composer region.
 * Purpose: Avoid modifying editor content (message composer, or a message
 * opened for in-place editing) while snippets are inserted/managed.
 * @param {Node} node - Element or text node to evaluate.
 * @returns {boolean} True when inside a contenteditable ancestor.
 */
function isNodeInsideEditableRegion(node) {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(el?.closest?.(EDITABLE_CONTAINER_SELECTOR));
}

/**
 * Determines whether an anchor is inside an editable composer region.
 * Anchor-flavored alias of isNodeInsideEditableRegion() for call sites
 * that deal in anchors specifically.
 * @staged wip — no caller yet in any script; adopt where anchor decoration needs the editable-region check by name.
 * @param {HTMLAnchorElement} anchor - Anchor to evaluate.
 * @returns {boolean} True when inside a contenteditable ancestor.
 */
function isAnchorInsideEditableRegion(anchor) {
  return isNodeInsideEditableRegion(anchor);
}

// Strict single-token IP predicates: reject CIDR-suffixed and extra-octet
// tokens. These are test-regexes (no /g flag) safe for repeated .test()
// calls; DP's linkify pipeline is the live consumer, and this fragment
// is the canonical home should CP or FP grow an IP-token need.
const IPV4_TEST_REGEX = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?!\/\d)(?!\.\d)\b/;
const IPV6_TEST_REGEX = /\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?!:)(?!\/\d)\b/;

/**
 * Formats a speed integer (Mbit/s, as the PeeringDB API reports it) into a
 * compact human-readable label.
 * @staged wip — no caller yet in any script; netixlan/ixlan speed labels in CP and FP are the intended adopters.
 * @param {string|number} speed - Speed value from API.
 * @returns {string} Speed label ("750M", "10G", "1T", or "speed n/a").
 */
function formatSpeedLabel(speed) {
  const numericSpeed = Number(speed);
  if (!Number.isFinite(numericSpeed) || numericSpeed <= 0) return "speed n/a";
  if (numericSpeed >= 1000000) return `${Math.round(numericSpeed / 1000000)}T`;
  if (numericSpeed >= 1000) return `${Math.round(numericSpeed / 1000)}G`;
  return `${numericSpeed}M`;
}

/**
 * Returns storage for tab-scoped transient values.
 * @staged wip — no caller yet in any script; CP's legacy org-name-tab-cache sweep keeps a local twin and is the intended adopter once this fragment is included beyond DP.
 * @returns {Storage|null} sessionStorage instance, or null when unavailable
 *   (e.g. blocked by browser privacy settings, which makes the property
 *   getter itself throw).
 */
function getTabSessionStorage() {
  try {
    if (window.sessionStorage) return window.sessionStorage;
  } catch (_error) {
    // Ignore; session storage may be unavailable.
  }
  return null;
}

/**
 * Selects the best network item for ASN lookups from list-style API payloads.
 * Purpose: Prefer exact ASN and active status from `/api/net` responses.
 * @param {*} payload - Parsed API response.
 * @param {string} expectedAsn - ASN value used in the query.
 * @returns {object|null} Matching network entry, or null when unavailable.
 */
function getBestApiNetDataItem(payload, expectedAsn) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const expectedAsnNumber = Number(expectedAsn);
  const exactOk = data.find(
    (item) => Number(item?.asn) === expectedAsnNumber && String(item?.status || "").toLowerCase() === "ok",
  );
  if (exactOk) return exactOk;

  const exact = data.find((item) => Number(item?.asn) === expectedAsnNumber);
  if (exact) return exact;

  return data[0] || null;
}

/**
 * Resolves the authoritative legal display name for an entity payload.
 * Prefers long legal name when available, then falls back to short name.
 * @param {object|null|undefined} entity - API entity payload.
 * @returns {string} Resolved legal-preferred name.
 */
function resolveEntityLegalName(entity) {
  return String(entity?.name_long || entity?.name || "").trim();
}

// ASN -> network-name resolver state. One instance per host script (the
// fragment is inlined, not shared at runtime). TTLs mirror DeskPro's
// general/miss cache policy.
// @staged wip — resolver cluster has no caller yet in any script; DP's linkify enrichment and CP/FP ASN labels are the intended adopters.
const ASN_NETWORK_NAME_CACHE_TTL_MS = 7.5 * 60 * 60 * 1000;
// @staged wip — resolver cluster has no caller yet in any script; DP's linkify enrichment and CP/FP ASN labels are the intended adopters.
const ASN_NETWORK_NAME_MISS_TTL_MS = 15 * 60 * 1000;
// @staged wip — resolver cluster has no caller yet in any script; DP's linkify enrichment and CP/FP ASN labels are the intended adopters.
const asnNetworkNameCache = new Map();
// @staged wip — resolver cluster has no caller yet in any script; DP's linkify enrichment and CP/FP ASN labels are the intended adopters.
const asnNetworkNameInFlight = new Map();

/**
 * Default JSON transport for fetchAsnNetworkName: same-origin
 * fetchWithRetry. Correct for CP and FP, which run on the peeringdb.com
 * origin; DeskPro runs cross-origin and must inject its
 * GM_xmlhttpRequest-backed transport instead (see fetchAsnNetworkName).
 * @staged wip — resolver cluster has no caller yet in any script; DP's linkify enrichment and CP/FP ASN labels are the intended adopters.
 * @param {string} url - API URL to fetch.
 * @returns {Promise<object|null>} Parsed JSON payload, or null on a non-2xx
 *   response or unparseable body.
 */
async function fetchAsnNameJsonSameOrigin(url) {
  const response = await fetchWithRetry(url, { credentials: "same-origin" });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

/**
 * Resolves the network name for an ASN via the PeeringDB API, with
 * in-memory and shared-storage caching plus in-flight dedupe.
 * Restored from DeskPro's retired resolver and reworked for cross-script
 * use: the transport is injectable because the hosts differ -- CP/FP are
 * same-origin and default to fetchAsnNameJsonSameOrigin, while DeskPro
 * must pass its own cross-origin transport (pdbFetch). Persisted names
 * share the "asn" cache type with DeskPro's existing writers, so a name
 * resolved by one script is a cache hit for its siblings on the same
 * origin.
 * @staged wip — resolver cluster has no caller yet in any script; DP's linkify enrichment and CP/FP ASN labels are the intended adopters.
 * @param {string|number} asn - ASN number to resolve.
 * @param {{ fetchJson?: (url: string) => Promise<object|null> }} [opts] -
 *   Optional transport override returning the parsed payload or null.
 * @returns {Promise<string>} Resolved network name, or "" when unavailable
 *   (invalid ASN, no match, or transport failure -- failures are not
 *   cached, so the next call retries).
 */
async function fetchAsnNetworkName(asn, { fetchJson } = {}) {
  const normalizedAsn = String(asn || "").trim();
  if (!/^\d+$/.test(normalizedAsn)) return "";

  const cached = asnNetworkNameCache.get(normalizedAsn);
  if (cached && cached.expiresAt > Date.now()) {
    return String(cached.name || "");
  }
  if (cached) asnNetworkNameCache.delete(normalizedAsn);

  const persisted = getCachedDataFromStorage("asn", normalizedAsn);
  const persistedName =
    persisted && !isNegativeCacheEntry(persisted) ? String(persisted.name || "").trim() : "";
  if (persistedName) {
    asnNetworkNameCache.set(normalizedAsn, {
      name: persistedName,
      expiresAt: Date.now() + ASN_NETWORK_NAME_CACHE_TTL_MS,
    });
    return persistedName;
  }

  if (asnNetworkNameInFlight.has(normalizedAsn)) {
    return asnNetworkNameInFlight.get(normalizedAsn);
  }

  const requestPromise = (async () => {
    const params = new URLSearchParams({
      asn: normalizedAsn,
      depth: "0",
      status: "ok",
      limit: "1",
    });
    const url = `https://www.peeringdb.com/api/net?${params.toString()}`;

    let payload = null;
    try {
      payload = await (fetchJson || fetchAsnNameJsonSameOrigin)(url);
    } catch (_error) {
      // Transport failure: report unavailable without caching, so the next
      // call retries instead of pinning a transient outage for hours.
      return "";
    }

    const net = getBestApiNetDataItem(payload, normalizedAsn);
    const resolved = resolveEntityLegalName(net);
    const ttl = resolved ? ASN_NETWORK_NAME_CACHE_TTL_MS : ASN_NETWORK_NAME_MISS_TTL_MS;

    asnNetworkNameCache.set(normalizedAsn, {
      name: resolved,
      expiresAt: Date.now() + ttl,
    });
    if (resolved) {
      setCachedDataInStorage("asn", normalizedAsn, { name: resolved }, ASN_NETWORK_NAME_CACHE_TTL_MS);
    }

    return resolved;
  })();

  asnNetworkNameInFlight.set(normalizedAsn, requestPromise);
  try {
    return await requestPromise;
  } finally {
    asnNetworkNameInFlight.delete(normalizedAsn);
  }
}
