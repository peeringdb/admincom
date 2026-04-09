// ==UserScript==
// @name            PeeringDB DP - Consolidated Tools
// @namespace       https://www.peeringdb.com/
// @version         1.4.0.20260409
// @description     Consolidated DeskPro tools: linkifies/enriches PeeringDB links (ASN/IP/IX/NET), copies mailto addresses, normalizes PeeringDB CP double-slash links
// @author          <chriztoffer@peeringdb.com>
// @match           https://peeringdb.deskpro.com/app*
// @icon            https://icons.duckduckgo.com/ip2/deskpro.com.ico
// @grant           GM_xmlhttpRequest
// @connect         www.peeringdb.com
// @connect         peeringdb.com
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-deskpro-tools.meta.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-deskpro-tools.user.js
// @supportURL      https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function () {
  "use strict";

  /**
   * Global constants and feature toggles for DeskPro linkification behavior.
   * Purpose: Keep selectors, labels, API timing, and URL normalization values centralized.
   * Necessity: Reused across link builders, fetch helpers, and mutation processing.
   */
  // Attribute stamped on generated <a> elements to prevent reprocessing.
  const LINKIFIED_ATTR = "data-pdb-asn-link";
  const MAILTO_DECORATED_ATTR = "data-pdb-mailto-decorated";
  const MAILTO_ICON_ATTR = "data-pdb-mailto-icon";
  const ACTION_EMOJI_LINK = "🔗";
  const ACTION_EMOJI_COPY = "📋";
  const ACTION_EMOJI_IX = "🏢";
  const ACTION_LINK_ICON_ATTR = "data-pdb-action-link-icon";
  const ACTION_LINK_TEXT_ATTR = "data-pdb-action-link-text";
  const IX_SHORTCUT_ATTR = "data-pdb-ix-shortcut";
  const EXISTING_PDB_LINK_DECORATED_ATTR = "data-pdb-existing-link-decorated";
  const EXISTING_PDB_LINK_ICON_ATTR = "data-pdb-existing-link-icon";
  const EXISTING_PDB_LINK_TEXT_ATTR = "data-pdb-existing-link-text";
  const TARGET_ACTION_LINK_LABELS = new Set([
    "review affiliation/ownership request",
    "approve ownership request and notify user",
  ]);
  const PDB_CP_DOUBLE_SLASH_PREFIX = "https://www.peeringdb.com//cp/peeringdb_server";
  const PDB_CP_SINGLE_SLASH_PREFIX = "https://www.peeringdb.com/cp/peeringdb_server";
  const DEFAULT_REQUEST_USER_AGENT = "PeeringDB-Admincom-DP-Consolidated";
  // Shared cache namespace (used by DP, FP, CP) for API data deduplication
  const SHARED_CACHE_PREFIX = "pdbAdmincom.cache.";
  const CACHE_SCHEMA_VERSION = 1;
  const ASN_API_TIMEOUT_MS = 12000;
  const ASN_API_RETRIES = 2;
  const ASN_NAME_CACHE_MISS_TTL_MS = 15 * 60 * 1000;
  const ASN_NAME_CACHE_TTL_MS = 7.5 * 60 * 60 * 1000;
  const NETIXLAN_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
  const ENABLE_IP_TOOLTIP_POC_ENRICHMENT = true;
  const ORG_CACHE_TTL_MS = 7.5 * 60 * 60 * 1000;
  const USER_CACHE_TTL_MS = 7.5 * 60 * 60 * 1000;
  const FACILITY_CACHE_TTL_MS = 7.5 * 60 * 60 * 1000;
  const BATCH_FETCH_MAX_ASNS = 100; // Per-request limit for asn__in queries
  const RATE_LIMIT_MIN_REMAINING = 10; // Backoff threshold

  const asnNameCache = new Map();
  const asnNameInFlight = new Map();
  const dataCacheInFlight = new Map(); // In-flight dedup for all API requests
  const rateLimitState = { limit: null, remaining: null, resetTime: null }; // Track rate-limit quotas
  const IPV4_TOKEN_REGEX = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
  const IPV4_TEST_REGEX = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/;
  const IPV6_TOKEN_REGEX = /\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g;
  const IPV6_TEST_REGEX = /\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/;

  /**
   * Returns localStorage when available for domain-scoped cache persistence.
   * Purpose: Share ASN name cache entries across tabs and page reloads.
   * @returns {Storage|null} localStorage instance, or null when unavailable.
   */
  function getDomainCacheStorage() {
    try {
      if (window.localStorage) return window.localStorage;
    } catch (_error) {
      // Ignore; persistence may be unavailable due to browser policy.
    }
    return null;
  }

  /**
   * Normalizes ASN value into a stable cache key suffix.
   * @param {string|number} asn - Raw ASN value.
   * @returns {string} Trimmed ASN string.
   */
  function normalizeAsnForCache(asn) {
    return String(asn || "").trim();
  }

  /**
   * Builds localStorage key for cached API data (shared namespace).
   * @param {string} type - Entity type (asn, org, user, facility).
   * @param {string|number} id - Entity identifier.
   * @returns {string} Namespaced cache key, or empty string when invalid.
   */
  function getSharedCacheStorageKey(type, id) {
    const normalizedType = String(type || "").trim().toLowerCase();
    const normalizedId = String(id || "").trim();
    if (!normalizedType || !normalizedId || !/^[a-z_]+$/.test(normalizedType)) return "";
    return `${SHARED_CACHE_PREFIX}${normalizedType}.${normalizedId}`;
  }

  /**
   * Builds localStorage key for ASN-name cache entries (backward compat wrapper).
   * @param {string|number} asn - ASN value.
   * @returns {string} Namespaced cache key, or empty string when invalid.
   */
  function getAsnNameCacheStorageKey(asn) {
    const normalizedAsn = normalizeAsnForCache(asn);
    if (!normalizedAsn || !/^\d+$/.test(normalizedAsn)) return "";
    return getSharedCacheStorageKey("asn", normalizedAsn);
  }

  /**
   * Reads cached API data object from localStorage when valid.
   * @param {string} type - Entity type (asn, org, user, facility).
   * @param {string|number} id - Entity identifier.
   * @returns {object|null} Cached data object, or null when absent/expired/invalid.
   */
  function getCachedDataFromStorage(type, id) {
    const storageKey = getSharedCacheStorageKey(type, id);
    if (!storageKey) return null;

    try {
      const storage = getDomainCacheStorage();
      const raw = storage?.getItem(storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const expiresAt = Number(parsed?.expiresAt || 0);
      const schemaVersion = Number(parsed?.schema ?? -1);
      const now = Date.now();
      if (
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        schemaVersion !== CACHE_SCHEMA_VERSION
      ) {
        storage?.removeItem(storageKey);
        return null;
      }

      return parsed?.data || null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Reads ASN name from localStorage cache when valid (backward compat).
   * @param {string|number} asn - ASN value.
   * @returns {string|null} Cached ASN name, or null when absent/expired/invalid.
   */
  function getCachedAsnNameFromStorage(asn) {
    const data = getCachedDataFromStorage("asn", asn);
    return data ? String(data.name || "").trim() || null : null;
  }

  /**
   * Stores API data object into localStorage cache with TTL/schema metadata.
   * @param {string} type - Entity type (asn, org, user, facility).
   * @param {string|number} id - Entity identifier.
   * @param {object} data - Data object to cache.
   * @param {number} [ttlMs=ASN_NAME_CACHE_TTL_MS] - Cache time-to-live (milliseconds).
   */
  function setCachedDataInStorage(type, id, data, ttlMs = ASN_NAME_CACHE_TTL_MS) {
    const storageKey = getSharedCacheStorageKey(type, id);
    if (!storageKey || !data || typeof data !== "object") return;

    try {
      const storage = getDomainCacheStorage();
      storage?.setItem(
        storageKey,
        JSON.stringify({
          schema: CACHE_SCHEMA_VERSION,
          data,
          expiresAt: Date.now() + ttlMs,
        }),
      );
    } catch (_error) {
      // Ignore storage failures; in-memory cache still provides benefit.
    }
  }

  /**
   * Stores ASN name into localStorage cache with TTL/schema metadata (backward compat).
   * @param {string|number} asn - ASN value.
   * @param {string} name - Resolved network name.
   */
  function setCachedAsnNameInStorage(asn, name) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) return;
    setCachedDataInStorage("asn", asn, { name: normalizedName }, ASN_NAME_CACHE_TTL_MS);
  }

  /**
   * Constructs request headers for script-driven HTTP requests.
   * Purpose: Keep User-Agent and internal tracing header values consistent.
   * Necessity: Centralizes request identity formatting for all PeeringDB API calls.
   * @param {object} [baseHeaders={}] - Optional caller-provided headers.
   * @returns {object} Final request headers including UA metadata.
   */
  function buildTampermonkeyRequestHeaders(baseHeaders = {}) {
    const headers = { ...baseHeaders };
    const userAgent = `${DEFAULT_REQUEST_USER_AGENT} (${navigator.userAgent.split(" ").slice(-1)[0] || "browser"})`;
    headers["User-Agent"] = userAgent;
    if (!headers["X-PDB-Request-UA"] && !headers["x-pdb-request-ua"]) {
      headers["X-PDB-Request-UA"] = userAgent;
    }
    return headers;
  }

  /**
   * Removes headers that cannot be used with browser fetch.
   * Purpose: Avoid forbidden-header runtime failures for same-origin fetch mode.
   * @param {object} headers - Source headers object.
   * @returns {object} Fetch-safe header copy.
   */
  function getFetchSafeHeaders(headers) {
    const source = headers && typeof headers === "object" ? headers : {};
    const sanitized = { ...source };
    delete sanitized["User-Agent"];
    delete sanitized["user-agent"];
    return sanitized;
  }

  /**
   * Updates rate-limit state from response headers.
   * @param {object} headers - Response headers object.
   */
  function updateRateLimitState(headers) {
    const limit = headers["x-ratelimit-limit"];
    const remaining = headers["x-ratelimit-remaining"];
    const reset = headers["x-ratelimit-reset"];
    
    if (limit) rateLimitState.limit = parseInt(limit);
    if (remaining) rateLimitState.remaining = parseInt(remaining);
    if (reset) rateLimitState.resetTime = new Date(reset);
  }

  /**
   * Checks if current rate-limit quota is low enough to trigger backoff.
   * @returns {boolean} True if should backoff (remaining quota < threshold).
   */
  function shouldBackoffRateLimit() {
    return rateLimitState.remaining !== null && rateLimitState.remaining < RATE_LIMIT_MIN_REMAINING;
  }

  /**
   * Unified JSON fetch helper with retry and timeout support.
   * Purpose: Mirror CP script network behavior for stable PeeringDB API access.
   * Necessity: Prevents divergent network logic between Tampermonkey transport modes.
   * @param {string} url - Absolute URL to request.
   * @param {{ headers?: object, timeout?: number, retries?: number }} [options] - Request tuning options.
   * @returns {Promise<object|null>} Parsed JSON payload, or null on failure.
   */
  async function pdbFetch(url, { headers = {}, timeout = ASN_API_TIMEOUT_MS, retries = ASN_API_RETRIES } = {}) {
    const fullHeaders = buildTampermonkeyRequestHeaders(headers);

    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve) => {
        let attempts = 0;

        function attempt() {
          attempts += 1;
          GM_xmlhttpRequest({
            method: "GET",
            url,
            headers: fullHeaders,
            withCredentials: true,
            anonymous: false,
            timeout,
            onload: (response) => {
              if (response.status >= 200 && response.status < 300) {
                try {
                  // Extract rate-limit headers from response
                  const responseHeaders = {};
                  if (response.responseHeaders) {
                    response.responseHeaders.split(/\r?\n/).forEach((line) => {
                      const [key, value] = line.split(":", 2);
                      if (key) responseHeaders[key.toLowerCase().trim()] = (value || "").trim();
                    });
                  }
                  updateRateLimitState(responseHeaders);
                  resolve(JSON.parse(response.responseText));
                } catch (_err) {
                  resolve(null);
                }
                return;
              }

              if (attempts < retries) {
                attempt();
              } else {
                resolve(null);
              }
            },
            onerror: () => {
              if (attempts < retries) {
                attempt();
              } else {
                resolve(null);
              }
            },
            ontimeout: () => {
              if (attempts < retries) {
                attempt();
              } else {
                resolve(null);
              }
            },
          });
        }

        attempt();
      });
    }

    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(url, {
          method: "GET",
          headers: getFetchSafeHeaders(fullHeaders),
          credentials: "include",
          referrerPolicy: "strict-origin-when-cross-origin",
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
          if (attempt + 1 >= retries) return null;
          continue;
        }

        try {
          // Extract rate-limit headers from response
          const responseHeaders = {};
          response.headers.forEach((value, key) => {
            responseHeaders[key.toLowerCase()] = value;
          });
          updateRateLimitState(responseHeaders);
          return await response.json();
        } catch (_parseError) {
          if (attempt + 1 >= retries) return null;
        }
      } catch (_error) {
        if (attempt + 1 >= retries) return null;
      }
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
   * Resolves network name for an ASN via PeeringDB API with cache and in-flight dedupe.
   * Purpose: Enrich ASN link labels with authoritative network names.
   * Necessity: Limits duplicate API calls when the same ASN appears repeatedly in one ticket.
   * @param {string|number} asn - ASN number to resolve.
   * @returns {Promise<string>} Resolved network name, or empty string when unavailable.
   */
  async function fetchAsnNetworkName(asn) {
    const normalizedAsn = normalizeAsnForCache(asn);
    if (!/^\d+$/.test(normalizedAsn)) return "";

    const cached = asnNameCache.get(normalizedAsn);
    if (cached && cached.expiresAt > Date.now()) {
      return String(cached.name || "");
    }

    if (cached && cached.expiresAt <= Date.now()) {
      asnNameCache.delete(normalizedAsn);
    }

    const persistedName = getCachedAsnNameFromStorage(normalizedAsn);
    if (persistedName) {
      asnNameCache.set(normalizedAsn, {
        name: persistedName,
        expiresAt: Date.now() + ASN_NAME_CACHE_TTL_MS,
      });
      return persistedName;
    }

    if (asnNameInFlight.has(normalizedAsn)) {
      return asnNameInFlight.get(normalizedAsn);
    }

    const requestPromise = (async () => {
      const params = new URLSearchParams({
        asn: normalizedAsn,
        depth: "0",
        status: "ok",
        limit: "1",
      });
      const url = `https://www.peeringdb.com/api/net?${params.toString()}`;
      const payload = await pdbFetch(url);
      const net = getBestApiNetDataItem(payload, normalizedAsn);
      const resolved = String(net?.name || net?.name_long || "").trim();
      const ttl = resolved ? ASN_NAME_CACHE_TTL_MS : ASN_NAME_CACHE_MISS_TTL_MS;

      asnNameCache.set(normalizedAsn, {
        name: resolved,
        expiresAt: Date.now() + ttl,
      });
      if (resolved) setCachedAsnNameInStorage(normalizedAsn, resolved);

      return resolved;
    })();

    asnNameInFlight.set(normalizedAsn, requestPromise);

    try {
      return await requestPromise;
    } finally {
      asnNameInFlight.delete(normalizedAsn);
    }
  }

  /**
   * Fetches organization details including nested user/POC information.
   * Purpose: Resolve org name and contact details (email, org_role) from org_id.
   * @param {string|number} orgId - Organization ID to fetch.
   * @returns {Promise<object|null>} Organization object with user_set, or null.
   */
  async function fetchOrgWithUsers(orgId) {
    const normalizedOrgId = String(orgId || "").trim();
    if (!normalizedOrgId || !/^\d+$/.test(normalizedOrgId)) return null;

    const cacheKey = `fetchOrgWithUsers.${normalizedOrgId}`;
    if (dataCacheInFlight.has(cacheKey)) {
      return dataCacheInFlight.get(cacheKey);
    }

    const requestPromise = (async () => {
      // Check localStorage cache first
      const cached = getCachedDataFromStorage("org", normalizedOrgId);
      if (cached) {
        // Return null if this is a cached negative lookup
        if (isNegativeCacheEntry(cached)) return null;
        return cached;
      }

      const params = new URLSearchParams({
        id: normalizedOrgId,
        depth: "1",
        limit: "1",
      });
      const url = `https://www.peeringdb.com/api/org?${params.toString()}`;
      const payload = await pdbFetch(url);
      
      if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
        // Negative-cache failed lookup to avoid repeated requests
        cacheNegativeLookup("org", normalizedOrgId, 1.5 * 3600 * 1000);
        return null;
      }
      
      const org = payload.data[0];
      if (!org) {
        cacheNegativeLookup("org", normalizedOrgId, 1.5 * 3600 * 1000);
        return null;
      }

      // Cache the org data
      setCachedDataInStorage("org", normalizedOrgId, org, ORG_CACHE_TTL_MS);
      
      return org;
    })();

    dataCacheInFlight.set(cacheKey, requestPromise);

    try {
      return await requestPromise;
    } finally {
      dataCacheInFlight.delete(cacheKey);
    }
  }

  /**
   * Fetches network record for an ASN.
   * Purpose: Resolve org relation for optional IP-tooltip POC enrichment.
   * @param {string|number} asn - ASN to resolve.
   * @returns {Promise<object|null>} Network row, or null when unavailable.
   */
  async function fetchNetByAsn(asn) {
    const normalizedAsn = String(asn || "").trim();
    if (!/^\d+$/.test(normalizedAsn)) return null;

    const cacheKey = `fetchNetByAsn.${normalizedAsn}`;
    if (dataCacheInFlight.has(cacheKey)) {
      return dataCacheInFlight.get(cacheKey);
    }

    const requestPromise = (async () => {
      const cached = getCachedDataFromStorage("net", normalizedAsn);
      if (cached) {
        if (isNegativeCacheEntry(cached)) return null;
        return cached;
      }

      const params = new URLSearchParams({
        asn: normalizedAsn,
        status: "ok",
        depth: "0",
        limit: "1",
      });
      const url = `https://www.peeringdb.com/api/net?${params.toString()}`;
      const payload = await pdbFetch(url);
      const net = getBestApiNetDataItem(payload, normalizedAsn);
      if (!net) {
        cacheNegativeLookup("net", normalizedAsn, ASN_NAME_CACHE_MISS_TTL_MS);
        return null;
      }

      setCachedDataInStorage("net", normalizedAsn, net, ASN_NAME_CACHE_TTL_MS);
      return net;
    })();

    dataCacheInFlight.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      dataCacheInFlight.delete(cacheKey);
    }
  }

  /**
   * Fetches network record by network id.
   * Purpose: Richly hydrate existing /net/{id} anchors found in rendered DeskPro HTML.
   * @param {string|number} netId - Network id.
   * @returns {Promise<object|null>} Network row, or null when unavailable.
   */
  async function fetchNetById(netId) {
    const normalizedNetId = String(netId || "").trim();
    if (!/^\d+$/.test(normalizedNetId)) return null;

    const cacheKey = `fetchNetById.${normalizedNetId}`;
    if (dataCacheInFlight.has(cacheKey)) {
      return dataCacheInFlight.get(cacheKey);
    }

    const requestPromise = (async () => {
      const cached = getCachedDataFromStorage("net_id", normalizedNetId);
      if (cached) {
        if (isNegativeCacheEntry(cached)) return null;
        return cached;
      }

      const params = new URLSearchParams({
        id: normalizedNetId,
        status: "ok",
        depth: "0",
        limit: "1",
      });
      const url = `https://www.peeringdb.com/api/net?${params.toString()}`;
      const payload = await pdbFetch(url);
      const net = Array.isArray(payload?.data) ? payload.data[0] || null : null;
      if (!net) {
        cacheNegativeLookup("net_id", normalizedNetId, ASN_NAME_CACHE_MISS_TTL_MS);
        return null;
      }

      setCachedDataInStorage("net_id", normalizedNetId, net, ASN_NAME_CACHE_TTL_MS);
      return net;
    })();

    dataCacheInFlight.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      dataCacheInFlight.delete(cacheKey);
    }
  }

  /**
   * Splits an array into chunks of specified maximum size.
   * @param {array} arr - Array to chunk.
   * @param {number} chunkSize - Maximum size per chunk.
   * @returns {array} Array of chunks.
   */
  function chunkArray(arr, chunkSize) {
    if (!Array.isArray(arr) || chunkSize < 1) return [];
    const chunks = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
      chunks.push(arr.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Batch-fetches network data for multiple ASNs with automatic chunking.
   * Purpose: Fetch up to 100 ASNs in parallel chunks (API limit per request).
   * Reduces latency vs. serial requests: 5 ASNs typically <2s vs. ~5s serial.
   * @param {array} asnList - Array of ASN numbers to fetch.
   * @returns {Promise<array>} Flattened array of network objects form all chunks.
   */
  async function batchFetchNetworks(asnList) {
    if (!Array.isArray(asnList) || asnList.length === 0) return [];

    // Split into chunks respecting API batch size limit
    const chunks = chunkArray(asnList, BATCH_FETCH_MAX_ASNS);
    
    const chunkPromises = chunks.map(async (asnChunk) => {
      const queryString = asnChunk.join(",");
      const params = new URLSearchParams({
        asn__in: queryString,
        depth: "1",
        limit: "250",
      });
      const url = `https://www.peeringdb.com/api/net?${params.toString()}`;
      const payload = await pdbFetch(url);
      
      if (!payload || !Array.isArray(payload.data)) return [];
      
      // Cache each network individually for later lookups
      payload.data.forEach((net) => {
        if (net && net.asn) {
          setCachedDataInStorage("net", net.asn, net, ASN_NAME_CACHE_TTL_MS);
        }
      });
      
      return payload.data;
    });

    try {
      const results = await Promise.all(chunkPromises);
      return results.flat();
    } catch (_error) {
      return [];
    }
  }

  /**
   * Formats a list of user objects as contact string: "Role (email), Role2 (email2)".
   * Purpose: Create readable POC display for tickets.
   * Priority: email > org_role > name (as specified).
   * @param {array} users - Array of user objects from org.user_set.
   * @returns {string} Formatted contact list, or empty string when no users.
   */
  function formatPocList(users) {
    if (!Array.isArray(users) || users.length === 0) return "";

    const pocParts = users
      .map((user) => {
        const email = String(user?.email || "").trim();
        const orgRole = String(user?.user_class || "").trim();
        const name = String(user?.name || "").trim();

        // Priority: email > org_role > name
        const primary = email || orgRole || name || null;
        const secondary = (email && orgRole) ? orgRole : (email && name) ? name : null;

        if (!primary) return null;
        if (secondary) return `${secondary} (${primary})`;
        return primary;
      })
      .filter((part) => part !== null);

    return pocParts.join(", ");
  }

  /**
   * Hydrates an existing ASN link label with resolved API network name and POC info.
   * Purpose: Preserve fast initial rendering, then progressively enhance link text with org details.
   * Necessity: API requests are asynchronous and should not block DOM linkification.
   * @param {HTMLAnchorElement} anchor - ASN anchor element to update.
   * @param {HTMLSpanElement} labelNode - Text span containing ASN label.
   * @param {string|number} asn - ASN identifier used for API resolution.
   * @param {string} originalDisplayText - Original text shown before enrichment.
   * @returns {Promise<void>}
   */
  async function hydrateAsnLinkLabel(anchor, labelNode, asn, originalDisplayText) {
    const resolvedName = await fetchAsnNetworkName(asn);
    if (!resolvedName || !anchor?.isConnected || !labelNode?.isConnected) return;

    labelNode.textContent = `${originalDisplayText} (${resolvedName})`;
    let titleText = `Open ASN${asn} (${resolvedName}) in PeeringDB`;

    // Optionally fetch org/POC info for enriched tooltip (non-blocking)
    (async () => {
      try {
        const params = new URLSearchParams({
          asn: asn,
          depth: "1",
          limit: "1",
        });
        const url = `https://www.peeringdb.com/api/net?${params.toString()}`;
        const payload = await pdbFetch(url);
        const net = getBestApiNetDataItem(payload, asn);
        
        if (!net || !net.org_id) return;
        
        const org = await fetchOrgWithUsers(net.org_id);
        if (!org) return;

        const pocList = formatPocList(org.user_set);
        if (pocList && anchor?.isConnected) {
          titleText = `${resolvedName}\nOrg: ${org.name}\nPOCs: ${pocList}`;
          anchor.title = titleText;
        }
      } catch (_error) {
        // Silently ignore POC resolution errors; base info still available
      }
    })();

    anchor.title = titleText;
  }

  /**
   * Migrates old DP-specific cache keys to shared cache namespace.
   * Purpose: Eliminate cache fragmentation when upgrading from v1.1.x to v1.2.0+.
   * Run once on script load to consolidate legacy cache entries.
   */
  function migrateOldCacheKeys() {
    try {
      const storage = getDomainCacheStorage();
      if (!storage) return;

      const oldPrefixes = ["pdbDpConsolidated.asnNameCache."];
      const keysToRemove = [];

      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key) continue;

        for (const oldPrefix of oldPrefixes) {
          if (key.startsWith(oldPrefix)) {
            try {
              const raw = storage.getItem(key);
              if (!raw) continue;

              const parsed = JSON.parse(raw);
              const asn = key.substring(oldPrefix.length);

              // Only migrate if newer cached format doesn't already exist
              const newCacheKey = getSharedCacheStorageKey("asn", asn);
              if (!storage.getItem(newCacheKey)) {
                setCachedDataInStorage("asn", asn, { name: parsed.name }, ASN_NAME_CACHE_TTL_MS);
              }

              keysToRemove.push(key);
            } catch (_error) {
              // Skip entries that can't be parsed
            }
          }
        }
      }

      // Clean up old keys after migrating
      keysToRemove.forEach((key) => storage.removeItem(key));
    } catch (_error) {
      // Silently ignore migration errors; system continues to work
    }
  }

  /**
   * Classifies an API error into categories for retry/abort decisions.
   * Purpose: Distinguish transient (retry-able) from fatal (abort) errors.
   * @param {number} [status] - HTTP status code, or null/undefined for network error.
   * @param {Error} [error] - Optional error object.
   * @returns {object} Classification with type, retryable flag, and guidance.
   */
  function classifyError(status, error) {
    if (status === 429 || status === 503) {
      return {
        type: "transient",
        retryable: true,
        backoffMs: 5000,
        label: "Rate-limited or temporarily unavailable",
      };
    }
    if (status === 404) {
      return {
        type: "not_found",
        retryable: false,
        ttl: 1.5 * 3600 * 1000, // Cache negative result for 1.5 hours
        label: "Resource not found (404)",
      };
    }
    if (status === 401 || status === 403) {
      return {
        type: "auth",
        retryable: false,
        label: "Authentication failed or access denied",
      };
    }
    if (status >= 500) {
      return {
        type: "server",
        retryable: true,
        backoffMs: 10000,
        label: "Server error (5xx)",
      };
    }
    if (!status) {
      return {
        type: "network",
        retryable: true,
        backoffMs: 3000,
        label: "Network error or timeout",
      };
    }
    return {
      type: "unknown",
      retryable: false,
      label: `Unknown error (HTTP ${status})`,
    };
  }

  /**
   * Negative-cache a missing entity to avoid repeated failed lookups.
   * @param {string} type - Entity type (asn, org, user, facility).
   * @param {string|number} id - Entity identifier.
   * @param {number} [ttlMs=1.5 hours] - Cache time-to-live.
   */
  function cacheNegativeLookup(type, id, ttlMs = 1.5 * 3600 * 1000) {
    setCachedDataInStorage(type, id, { error: "not_found", timestamp: Date.now() }, ttlMs);
  }

  /**
   * Checks if a cache entry represents a negative lookup (not found).
   * @param {object} cached - Cached data object.
   * @returns {boolean} True if this is a cached "not found" result.
   */
  function isNegativeCacheEntry(cached) {
    return cached && cached.error === "not_found";
  }

  /**
   * Tags whose text content must never be linkified.
   * Purpose: Protect editable/source-like regions and existing links.
   */
  const SKIP_TAGS = new Set([
    "A", "SCRIPT", "STYLE", "NOSCRIPT",
    "TEXTAREA", "INPUT", "SELECT", "BUTTON",
    "CODE", "PRE",
  ]);

  /**
   * Builds ASN anchor element with link emoji and delayed name hydration.
   * Purpose: Standardize visual/behavioral construction of all ASN links.
   * @param {string|number} asn - ASN identifier.
   * @param {string} displayText - Visible initial label (e.g. AS12345).
   * @returns {HTMLAnchorElement} Fully configured ASN anchor.
   */
  // Builds an <a> element linking to PeeringDB for the given ASN.
  function makeAsnLink(asn, displayText) {
    const a = document.createElement("a");
    a.href = `https://www.peeringdb.com/asn/${asn}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `Open ASN${asn} in PeeringDB`;
    a.style.textDecoration = "none";
    a.style.textDecorationLine = "none";

    const text = document.createElement("span");
    text.textContent = displayText;
    text.style.textDecoration = "underline";
    text.style.textDecorationLine = "underline";

    const icon = document.createElement("span");
    icon.textContent = ` ${ACTION_EMOJI_LINK}`;
    icon.setAttribute("aria-hidden", "true");
    icon.style.textDecoration = "none";

    a.append(text, icon);
    a.setAttribute(LINKIFIED_ATTR, "true");
    void hydrateAsnLinkLabel(a, text, asn, displayText);
    return a;
  }

  /**
   * Picks the best netixlan item from API payload.
   * @param {*} payload - Parsed API response.
   * @param {string} [expectedIp=""] - Queried IP address.
   * @returns {object|null} Selected netixlan row.
   */
  function getBestNetixlanDataItem(payload, expectedIp = "") {
    if (!payload || typeof payload !== "object") return null;
    const data = payload.data;
    if (!Array.isArray(data) || data.length === 0) return null;

    const expected = String(expectedIp || "").trim();
    const exact = data.find((item) => {
      const ip4 = String(item?.ipaddr4 || "").trim();
      const ip6 = String(item?.ipaddr6 || "").trim();
      return expected && (ip4 === expected || ip6 === expected);
    });
    if (exact) return exact;

    const operational = data.find(
      (item) => Boolean(item?.operational) && String(item?.status || "").toLowerCase() === "ok",
    );
    if (operational) return operational;

    return data[0] || null;
  }

  /**
   * Fetches a netixlan row by IPv4 or IPv6 address.
   * @param {string} ip - IPv4 or IPv6 address.
   * @returns {Promise<object|null>} Best matching netixlan row.
   */
  async function fetchNetixlanByIp(ip) {
    const normalizedIp = String(ip || "").trim();
    if (!normalizedIp) return null;

    const cacheKey = `fetchNetixlanByIp.${normalizedIp}`;
    if (dataCacheInFlight.has(cacheKey)) {
      return dataCacheInFlight.get(cacheKey);
    }

    const requestPromise = (async () => {
      const cached = getCachedDataFromStorage("netixlan_ip", normalizedIp);
      if (cached) {
        if (isNegativeCacheEntry(cached)) return null;
        return cached;
      }

      const params = new URLSearchParams({
        status: "ok",
        depth: "0",
        limit: "1",
      });
      if (IPV4_TEST_REGEX.test(normalizedIp)) {
        params.set("ipaddr4", normalizedIp);
      } else if (IPV6_TEST_REGEX.test(normalizedIp)) {
        params.set("ipaddr6", normalizedIp);
      } else {
        return null;
      }

      const url = `https://www.peeringdb.com/api/netixlan?${params.toString()}`;
      const payload = await pdbFetch(url);
      const netixlan = getBestNetixlanDataItem(payload, normalizedIp);
      if (!netixlan) {
        cacheNegativeLookup("netixlan_ip", normalizedIp, ASN_NAME_CACHE_MISS_TTL_MS);
        return null;
      }

      setCachedDataInStorage("netixlan_ip", normalizedIp, netixlan, NETIXLAN_CACHE_TTL_MS);
      return netixlan;
    })();

    dataCacheInFlight.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      dataCacheInFlight.delete(cacheKey);
    }
  }

  /**
   * Fetches exchange object by IX id.
   * @param {string|number} ixId - Exchange id.
   * @returns {Promise<object|null>} Exchange object.
   */
  async function fetchIxById(ixId) {
    const normalizedIxId = String(ixId || "").trim();
    if (!/^\d+$/.test(normalizedIxId)) return null;

    const cacheKey = `fetchIxById.${normalizedIxId}`;
    if (dataCacheInFlight.has(cacheKey)) {
      return dataCacheInFlight.get(cacheKey);
    }

    const requestPromise = (async () => {
      const cached = getCachedDataFromStorage("ix", normalizedIxId);
      if (cached) {
        if (isNegativeCacheEntry(cached)) return null;
        return cached;
      }

      const params = new URLSearchParams({
        id: normalizedIxId,
        status: "ok",
        depth: "0",
        limit: "1",
      });
      const url = `https://www.peeringdb.com/api/ix?${params.toString()}`;
      const payload = await pdbFetch(url);
      const ix = Array.isArray(payload?.data) ? payload.data[0] || null : null;
      if (!ix) {
        cacheNegativeLookup("ix", normalizedIxId, ASN_NAME_CACHE_MISS_TTL_MS);
        return null;
      }

      setCachedDataInStorage("ix", normalizedIxId, ix, FACILITY_CACHE_TTL_MS);
      return ix;
    })();

    dataCacheInFlight.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      dataCacheInFlight.delete(cacheKey);
    }
  }

  /**
   * Adds a compact IX shortcut icon next to an enriched link.
   * @param {HTMLAnchorElement} anchor - Primary anchor.
   * @param {string|number} ixId - Exchange id.
   * @param {string} [ixName=""] - Optional exchange name for tooltip.
   */
  function ensureIxShortcut(anchor, ixId, ixName = "") {
    if (!anchor?.isConnected) return;
    if (!/^\d+$/.test(String(ixId || "").trim())) return;
    if (anchor.nextElementSibling?.getAttribute?.(IX_SHORTCUT_ATTR) === "true") return;

    const ixLink = document.createElement("a");
    ixLink.href = `https://www.peeringdb.com/ix/${ixId}`;
    ixLink.target = "_blank";
    ixLink.rel = "noopener noreferrer";
    ixLink.setAttribute(IX_SHORTCUT_ATTR, "true");
    ixLink.style.marginLeft = "3px";
    ixLink.style.textDecoration = "none";
    ixLink.title = ixName ? `Open IX ${ixName} in PeeringDB` : `Open IX ${ixId} in PeeringDB`;
    ixLink.textContent = ACTION_EMOJI_IX;
    ixLink.setAttribute("aria-label", ixLink.title);

    anchor.insertAdjacentElement("afterend", ixLink);
  }

  /**
   * Formats a speed integer into a compact human-readable label.
   * @param {string|number} speed - Speed value from API.
   * @returns {string} Speed label.
   */
  function formatSpeedLabel(speed) {
    const numericSpeed = Number(speed);
    if (!Number.isFinite(numericSpeed) || numericSpeed <= 0) return "speed n/a";
    if (numericSpeed >= 1000000) return `${Math.round(numericSpeed / 1000000)}T`;
    if (numericSpeed >= 1000) return `${Math.round(numericSpeed / 1000)}G`;
    return `${numericSpeed}M`;
  }

  /**
   * Builds an anchor for an IP address and enriches it from netixlan async.
   * @param {string} ip - IPv4 or IPv6 token.
   * @returns {HTMLAnchorElement} Configured IP anchor.
   */
  function makeIpLink(ip) {
    const normalizedIp = String(ip || "").trim();
    const a = document.createElement("a");
    a.href = `https://www.peeringdb.com/search/v2?q=${encodeURIComponent(normalizedIp)}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `Resolve ${normalizedIp} in PeeringDB`;
    a.style.textDecoration = "none";
    a.style.textDecorationLine = "none";

    const text = document.createElement("span");
    text.textContent = normalizedIp;
    text.style.textDecoration = "underline";
    text.style.textDecorationLine = "underline";

    const icon = document.createElement("span");
    icon.textContent = ` ${ACTION_EMOJI_LINK}`;
    icon.setAttribute("aria-hidden", "true");
    icon.style.textDecoration = "none";

    a.append(text, icon);
    a.setAttribute(LINKIFIED_ATTR, "true");
    void hydrateIpLinkLabel(a, normalizedIp);
    return a;
  }

  /**
   * Hydrates an IP link using /api/netixlan and related data.
   * @param {HTMLAnchorElement} anchor - Link element created by makeIpLink.
   * @param {string} ip - IPv4 or IPv6 value.
   * @returns {Promise<void>}
   */
  async function hydrateIpLinkLabel(anchor, ip) {
    const netixlan = await fetchNetixlanByIp(ip);
    if (!netixlan || !anchor?.isConnected) return;

    const asn = String(netixlan.asn || "").trim();
    const netId = String(netixlan.net_id || "").trim();
    const ixId = String(netixlan.ix_id || "").trim();
    const operational = netixlan.operational ? "operational" : "non-operational";
    const speed = formatSpeedLabel(netixlan.speed);

    let netName = String(netixlan.name || "").trim();
    if (asn) {
      const resolvedName = await fetchAsnNetworkName(asn);
      if (resolvedName) netName = resolvedName;
    }

    let ixName = "";
    if (ixId) {
      const ix = await fetchIxById(ixId);
      ixName = String(ix?.name || "").trim();
    }

    if (netId) {
      anchor.href = `https://www.peeringdb.com/net/${netId}`;
    } else if (asn) {
      anchor.href = `https://www.peeringdb.com/asn/${asn}`;
    }

    const tooltipParts = [];
    if (asn) tooltipParts.push(`AS${asn}`);
    if (netName) tooltipParts.push(netName);
    if (ixName) tooltipParts.push(ixName);
    else if (ixId) tooltipParts.push(`IX ${ixId}`);
    tooltipParts.push(speed);
    tooltipParts.push(operational);

    if (ENABLE_IP_TOOLTIP_POC_ENRICHMENT && asn) {
      try {
        const net = await fetchNetByAsn(asn);
        if (net?.org_id) {
          const org = await fetchOrgWithUsers(net.org_id);
          const orgName = String(org?.name || "").trim();
          const pocList = formatPocList(org?.user_set);
          if (orgName) tooltipParts.push(`Org ${orgName}`);
          if (pocList) tooltipParts.push(`POCs ${pocList}`);
        }
      } catch (_error) {
        // Ignore optional POC enrichment failures; base tooltip remains available.
      }
    }

    anchor.title = tooltipParts.join(" | ");

    if (ixId) {
      ensureIxShortcut(anchor, ixId, ixName);
    }
  }

  /**
   * Builds organization search anchor with link emoji styling.
   * Purpose: Link affiliation organization names to PeeringDB search results.
   * @param {string} orgName - Organization search query value.
   * @param {string} [displayText=orgName] - Visible label for the anchor text span.
   * @returns {HTMLAnchorElement} Configured organization-search anchor.
   */
  function makeOrganizationSearchLink(orgName, displayText = orgName) {
    const query = String(orgName || "").trim();
    const a = document.createElement("a");
    a.href = `https://www.peeringdb.com/search/v2?q=${encodeURIComponent(query)}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `Search organization \"${query}\" in PeeringDB`;
    a.style.textDecoration = "none";
    a.style.textDecorationLine = "none";

    const text = document.createElement("span");
    text.textContent = displayText;
    text.style.textDecoration = "underline";
    text.style.textDecorationLine = "underline";

    const icon = document.createElement("span");
    icon.textContent = ` ${ACTION_EMOJI_LINK}`;
    icon.setAttribute("aria-hidden", "true");
    icon.style.textDecoration = "none";

    a.append(text, icon);
    a.setAttribute(LINKIFIED_ATTR, "true");
    return a;
  }

  /**
   * Parses PeeringDB entity info from a URL for decoration/hydration.
   * @param {string} href - Anchor href.
   * @returns {{ kind: string, id?: string, entity?: string, url: URL }|null} Parsed descriptor.
   */
  function parsePeeringDbEntityFromHref(href) {
    try {
      const url = new URL(String(href || ""), window.location.origin);
      const host = String(url.hostname || "").toLowerCase();
      if (!(host === "peeringdb.com" || host === "www.peeringdb.com")) return null;

      const entityMatch = url.pathname.match(/^\/(asn|net|ix)\/(\d+)(?:\/|$)/i);
      if (entityMatch) {
        return {
          kind: String(entityMatch[1] || "").toLowerCase(),
          id: String(entityMatch[2] || ""),
          url,
        };
      }

      const cpMatch = url.pathname.match(/^\/cp\/peeringdb_server\/([a-z_]+)\/(\d+)\/change\/?/i);
      if (cpMatch) {
        return {
          kind: "cp",
          entity: String(cpMatch[1] || "").toLowerCase(),
          id: String(cpMatch[2] || ""),
          url,
        };
      }

      return { kind: "pdb", url };
    } catch (_error) {
      return null;
    }
  }

  /**
   * Returns true when anchor visible text is a bare URL matching href.
   * @param {HTMLAnchorElement} anchor - Anchor node.
   * @returns {boolean} True when text is URL-like and safe to relabel.
   */
  function isBareUrlAnchorText(anchor) {
    if (!anchor) return false;
    const rawText = String(anchor.textContent || "").trim();
    const rawHref = String(anchor.href || "").trim();
    if (!rawText || !rawHref) return false;

    const normalize = (value) =>
      String(value || "")
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/\/$/, "")
        .toLowerCase();

    return normalize(rawText) === normalize(rawHref);
  }

  /**
   * Ensures anchor has a text span + link icon while preserving existing complex content.
   * @param {HTMLAnchorElement} anchor - Anchor to decorate.
   * @param {string} [initialLabel=""] - Optional initial label when text is URL-like.
   */
  function ensureExistingPdbAnchorVisual(anchor, initialLabel = "") {
    if (!anchor) return;

    anchor.style.textDecoration = "none";
    anchor.style.textDecorationLine = "none";

    const hasComplexChildren = Array.from(anchor.childNodes).some((node) => node.nodeType === Node.ELEMENT_NODE);
    if (!hasComplexChildren) {
      let textNode = anchor.querySelector(`span[${EXISTING_PDB_LINK_TEXT_ATTR}]`);
      if (!textNode) {
        const rawText = String(anchor.textContent || "").trim();
        const label = String(initialLabel || "").trim() || rawText || String(anchor.href || "").trim();

        anchor.textContent = "";

        textNode = document.createElement("span");
        textNode.setAttribute(EXISTING_PDB_LINK_TEXT_ATTR, "true");
        textNode.style.textDecoration = "underline";
        textNode.style.textDecorationLine = "underline";
        textNode.textContent = label;
        anchor.appendChild(textNode);
      }
    }

    if (!anchor.querySelector(`span[${EXISTING_PDB_LINK_ICON_ATTR}]`)) {
      const icon = document.createElement("span");
      icon.textContent = ` ${ACTION_EMOJI_LINK}`;
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute(EXISTING_PDB_LINK_ICON_ATTR, "true");
      icon.style.textDecoration = "none";
      anchor.appendChild(icon);
    }
  }

  /**
   * Updates decorated anchor label when a dedicated text span exists.
   * @param {HTMLAnchorElement} anchor - Decorated anchor.
   * @param {string} label - New text label.
   */
  function setExistingPdbAnchorLabel(anchor, label) {
    const textNode = anchor?.querySelector?.(`span[${EXISTING_PDB_LINK_TEXT_ATTR}]`);
    const normalized = String(label || "").trim();
    if (!textNode || !normalized) return;
    textNode.textContent = normalized;
  }

  /**
   * Hydrates existing PeeringDB anchors with contextual titles and compact labels.
   * @param {HTMLAnchorElement} anchor - Anchor to enrich.
   * @param {{ kind: string, id?: string, entity?: string }} info - Parsed anchor descriptor.
   * @returns {Promise<void>}
   */
  async function hydrateExistingPeeringDbAnchor(anchor, info) {
    if (!anchor?.isConnected || !info) return;

    try {
      if (info.kind === "asn" && info.id) {
        const name = await fetchAsnNetworkName(info.id);
        if (!anchor?.isConnected) return;
        const label = name ? `AS${info.id} (${name})` : `AS${info.id}`;
        setExistingPdbAnchorLabel(anchor, label);
        anchor.title = name ? `AS${info.id} | ${name}` : `AS${info.id}`;
        return;
      }

      if (info.kind === "ix" && info.id) {
        const ix = await fetchIxById(info.id);
        if (!anchor?.isConnected) return;
        const ixName = String(ix?.name || "").trim();
        const label = ixName ? `IX ${info.id} (${ixName})` : `IX ${info.id}`;
        setExistingPdbAnchorLabel(anchor, label);
        anchor.title = ixName ? `IX ${info.id} | ${ixName}` : `IX ${info.id}`;
        return;
      }

      if (info.kind === "net" && info.id) {
        const net = await fetchNetById(info.id);
        if (!anchor?.isConnected) return;

        const netName = String(net?.name || net?.name_long || "").trim();
        const asn = String(net?.asn || "").trim();
        const orgId = String(net?.org_id || "").trim();

        const tooltipParts = [];
        tooltipParts.push(`NET ${info.id}`);
        if (netName) tooltipParts.push(netName);
        if (asn) tooltipParts.push(`AS${asn}`);

        const label = netName ? `NET ${info.id} (${netName})` : `NET ${info.id}`;
        setExistingPdbAnchorLabel(anchor, label);

        if (orgId && ENABLE_IP_TOOLTIP_POC_ENRICHMENT) {
          const org = await fetchOrgWithUsers(orgId);
          if (anchor?.isConnected && org) {
            const orgName = String(org.name || "").trim();
            const pocList = formatPocList(org.user_set);
            if (orgName) tooltipParts.push(`Org ${orgName}`);
            if (pocList) tooltipParts.push(`POCs ${pocList}`);
          }
        }

        if (anchor?.isConnected) {
          anchor.title = tooltipParts.join(" | ");
        }
        return;
      }

      if (info.kind === "cp" && info.id) {
        const entity = String(info.entity || "record").replace(/_/g, " ");
        anchor.title = `Open CP ${entity} ${info.id}`;
      }
    } catch (_error) {
      // Ignore enrichment failures for existing anchors; base navigation remains intact.
    }
  }

  /**
   * Decorates pre-existing PeeringDB anchors rendered in ticket HTML.
   * Purpose: Provide consistent iconography and rich contextual tooltips without text-node relinkification.
   * @param {Element} root - Root element to scan.
   */
  function decorateExistingPeeringDbLinks(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

    const anchors = [];
    if (root.matches?.("a[href]")) anchors.push(root);
    root.querySelectorAll?.("a[href]").forEach((anchor) => anchors.push(anchor));

    anchors.forEach((anchor) => {
      if (!anchor || anchor.getAttribute(LINKIFIED_ATTR) === "true") return;
      if (anchor.getAttribute(MAILTO_DECORATED_ATTR) === "true") return;

      const info = parsePeeringDbEntityFromHref(anchor.getAttribute("href") || "");
      if (!info) return;

      const shouldRelabel = isBareUrlAnchorText(anchor);
      let initialLabel = "";
      if (shouldRelabel && info.kind === "asn" && info.id) initialLabel = `AS${info.id}`;
      if (shouldRelabel && info.kind === "net" && info.id) initialLabel = `NET ${info.id}`;
      if (shouldRelabel && info.kind === "ix" && info.id) initialLabel = `IX ${info.id}`;
      if (shouldRelabel && info.kind === "cp" && info.id) initialLabel = `CP ${info.id}`;

      ensureExistingPdbAnchorVisual(anchor, initialLabel);
      if (!anchor.getAttribute("title")) {
        if (info.kind === "cp" && info.id) {
          anchor.title = `Open CP ${String(info.entity || "record").replace(/_/g, " ")} ${info.id}`;
        } else if (info.kind === "pdb") {
          anchor.title = "Open in PeeringDB";
        }
      }

      if (anchor.getAttribute(EXISTING_PDB_LINK_DECORATED_ATTR) !== "true") {
        anchor.setAttribute(EXISTING_PDB_LINK_DECORATED_ATTR, "true");
        void hydrateExistingPeeringDbAnchor(anchor, info);
      }
    });
  }

  /**
   * Decorates a mailto anchor for copy-to-clipboard UX.
   * Purpose: Add copy emoji indicator and remove underline decoration.
   * Necessity: Ticket operators need clear click affordance for mail addresses.
   * @param {HTMLAnchorElement} anchor - Mailto anchor to decorate.
   */
  function decorateMailtoAnchor(anchor) {
    if (!anchor) return;

    anchor.querySelectorAll(`span[${MAILTO_ICON_ATTR}]`).forEach((node) => node.remove());
    anchor.style.textDecoration = "none";
    anchor.style.textDecorationLine = "none";

    const icon = document.createElement("span");
    icon.textContent = ` ${ACTION_EMOJI_COPY}`;
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute(MAILTO_ICON_ATTR, "true");
    anchor.append(icon);

    if (!anchor.getAttribute("title")) {
      anchor.setAttribute("title", "Click to copy email address");
    }
    anchor.setAttribute(MAILTO_DECORATED_ATTR, "true");
  }

  /**
   * Decorates all mailto anchors in a subtree.
   * Purpose: Ensure initial render and dynamic content share identical mailto UX.
   * @param {Element} root - Root element to scan.
   */
  function decorateMailtoLinks(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches?.('a[href^="mailto:"]')) {
      decorateMailtoAnchor(root);
    }
    root.querySelectorAll?.('a[href^="mailto:"]').forEach(decorateMailtoAnchor);
  }

  /**
   * Normalizes known malformed PeeringDB CP double-slash URLs in plain text.
   * @param {string} value - Raw text containing URL content.
   * @returns {string} Text with normalized CP URL prefix.
   */
  function normalizePeeringDbCpDoubleSlashText(value) {
    return String(value || "").replaceAll(PDB_CP_DOUBLE_SLASH_PREFIX, PDB_CP_SINGLE_SLASH_PREFIX);
  }

  /**
   * Normalizes malformed PeeringDB CP URL prefix in anchor href and text nodes.
   * Purpose: Keep both clickable destination and displayed text consistent.
   * @param {HTMLAnchorElement} anchor - Anchor node to normalize.
   */
  function normalizeAnchorHrefAndText(anchor) {
    if (!anchor) return;

    const rawHref = anchor.getAttribute("href") || "";
    if (rawHref.includes(PDB_CP_DOUBLE_SLASH_PREFIX)) {
      const normalizedHref = normalizePeeringDbCpDoubleSlashText(rawHref);
      anchor.setAttribute("href", normalizedHref);
      anchor.href = normalizedHref;
    }

    const textNodes = [];
    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const textNode of textNodes) {
      const original = textNode.nodeValue || "";
      if (!original.includes(PDB_CP_DOUBLE_SLASH_PREFIX)) continue;
      textNode.nodeValue = normalizePeeringDbCpDoubleSlashText(original);
    }
  }

  /**
   * Applies CP URL double-slash normalization to all anchors under root.
   * @param {Element} root - Root element to scan.
   */
  function normalizePeeringDbCpDoubleSlashLinks(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches?.("a")) {
      normalizeAnchorHrefAndText(root);
    }
    root.querySelectorAll?.("a").forEach(normalizeAnchorHrefAndText);
  }

  /**
   * Appends a link emoji to specific DeskPro action links.
   * Purpose: Align action-link affordance with other linkified actions.
   * @param {HTMLAnchorElement} anchor - Anchor to decorate when label matches target list.
   */
  function decorateTargetActionLink(anchor) {
    if (!anchor) return;

    const label = String(anchor.textContent || "")
      .replace(new RegExp(`\\s*${ACTION_EMOJI_LINK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!TARGET_ACTION_LINK_LABELS.has(label)) return;

    anchor.style.textDecoration = "none";
    anchor.style.textDecorationLine = "none";

    let textSpan = anchor.querySelector(`span[${ACTION_LINK_TEXT_ATTR}]`);
    if (!textSpan) {
      textSpan = document.createElement("span");
      textSpan.setAttribute(ACTION_LINK_TEXT_ATTR, "true");
      textSpan.style.textDecoration = "underline";
      textSpan.style.textDecorationLine = "underline";

      const fragment = document.createDocumentFragment();
      for (const node of Array.from(anchor.childNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE && node.getAttribute?.(ACTION_LINK_ICON_ATTR) === "true") {
          continue;
        }
        fragment.appendChild(node);
      }
      textSpan.appendChild(fragment);
      anchor.appendChild(textSpan);
    }

    // Prevent duplicate icon insertion during mutation reprocessing.
    if (anchor.querySelector(`span[${ACTION_LINK_ICON_ATTR}]`)) return;

    const icon = document.createElement("span");
    icon.textContent = ` ${ACTION_EMOJI_LINK}`;
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute(ACTION_LINK_ICON_ATTR, "true");
    icon.style.textDecoration = "none";
    anchor.append(icon);
  }

  /**
   * Decorates all target DeskPro action links in a subtree.
   * @param {Element} root - Root element to scan.
   */
  function decorateTargetActionLinks(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches?.("a")) {
      decorateTargetActionLink(root);
    }
    root.querySelectorAll?.("a").forEach(decorateTargetActionLink);
  }

  // Replacement rules — each has a regex and a factory that builds DOM nodes
  // for the matched span. All rules run in a single combined pass (sorted by
  // match position) so patterns never conflict on overlapping ranges.
  const REPLACEMENT_RULES = [
    {
      // AS123 / ASN123 — the full token becomes the link text.
      regex: /\bASN?(\d+)\b/gi,
      buildNodes([fullMatch, asn]) {
        return [makeAsnLink(asn, fullMatch)];
      },
    },
    {
      // Label-led ASN value — link only the numeric token (e.g. "member ASN: 12345").
      regex: /\b((?:member\s+asn|network\s+asn|asn|as)\s*[:=#-]?\s*)(\d{3,6})\b/gi,
      buildNodes([, prefix, asn]) {
        return [document.createTextNode(prefix), makeAsnLink(asn, asn)];
      },
    },
    {
      // "provided this ASN in their request: 123" — only the bare number links.
      regex: /\bprovided this ASN in their request:\s*(\d+)/gi,
      buildNodes([fullMatch, asn]) {
        const prefix = fullMatch.slice(0, fullMatch.length - asn.length);
        return [document.createTextNode(prefix), makeAsnLink(asn, asn)];
      },
    },
    {
      // "wishes to be affiliated to Organization 'Org Name'" — link only the org name.
      regex: /(\bwishes to be affiliated to Organization\s+['"\u201c\u201d\u2018\u2019])([^'"\u201c\u201d\u2018\u2019\n]+)(['"\u201c\u201d\u2018\u2019])/gi,
      buildNodes([, prefix, orgName, suffix]) {
        return [
          document.createTextNode(prefix),
          makeOrganizationSearchLink(orgName, orgName),
          document.createTextNode(suffix),
        ];
      },
    },
    {
      // IPv4 tokens should resolve via netixlan enrichment.
      regex: /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g,
      buildNodes([ip]) {
        return [makeIpLink(ip)];
      },
    },
    {
      // IPv6 tokens should resolve via netixlan enrichment.
      regex: /\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g,
      buildNodes([ip]) {
        if (!isLikelyIpv6Address(ip)) return [document.createTextNode(ip)];
        return [makeIpLink(ip)];
      },
    },
  ];

  // Quick pre-test — text nodes matching none of the rules are rejected early.
  const QUICK_TEST_REGEX = /\bASN?\d+\b|\b(?:member\s+asn|network\s+asn|asn|as)\s*[:=#-]?\s*\d{3,6}\b|provided this ASN in their request:\s*\d+|wishes to be affiliated to Organization\s+['"\u201c\u201d\u2018\u2019][^'"\u201c\u201d\u2018\u2019\n]+['"\u201c\u201d\u2018\u2019]|\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b|\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b|(?:^|\n)\s*\d{3,6}\s*(?:\n|$)/i;

  /**
   * Finds standalone 3-6 digit ASN candidates only in high-confidence contexts.
   * Heuristics:
   * - standalone ASN-like line adjacent to both IPv4 and IPv6 mentions
   * - sequence context containing member-removal style fields (speed/policy + IP labels)
   * - line preceded by explicit ASN label
   * @param {string} text - Text-node content.
   * @returns {Array<{start:number,end:number,asn:string}>} Candidate ranges.
   */
  function findProbableStandaloneAsnHits(text) {
    const lines = String(text || "").split("\n");
    const hits = [];
    let offset = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const rawLine = lines[i] || "";
      const line = rawLine.replace(/\r$/, "");
      const trimmed = line.trim();

      if (!/^\d{3,6}$/.test(trimmed)) {
        offset += rawLine.length + 1;
        continue;
      }

      const windowStart = Math.max(0, i - 3);
      const windowEnd = Math.min(lines.length, i + 4);
      const windowText = lines.slice(windowStart, windowEnd).join("\n");
      const prevLine = String(lines[i - 1] || "").toLowerCase();

      const hasIpPair = IPV4_TEST_REGEX.test(windowText) && IPV6_TEST_REGEX.test(windowText);
      const hasMemberBlock =
        /\b(speed|policy)\b/i.test(windowText) && /\b(ipv4|ipaddr4)\b/i.test(windowText) && /\b(ipv6|ipaddr6)\b/i.test(windowText);
      const precededByLabel = /\b(member\s+asn|network\s+asn|asn|as)\b/.test(prevLine);

      if (hasIpPair || hasMemberBlock || precededByLabel) {
        const start = offset + line.indexOf(trimmed);
        hits.push({ start, end: start + trimmed.length, asn: trimmed });
      }

      offset += rawLine.length + 1;
    }

    return hits;
  }

  /**
   * Validates whether a matched token is a likely IPv6 address.
   * Purpose: Reduce false-positive linking for colon-delimited non-IP text.
   * @param {string} token - Candidate token.
   * @returns {boolean} True when token resembles a valid IPv6 literal.
   */
  function isLikelyIpv6Address(token) {
    const value = String(token || "").trim();
    if (!value || !value.includes(":")) return false;
    if ((value.match(/:/g) || []).length < 2) return false;
    if (/:::.+|:::/.test(value)) return false;
    if (/[^0-9a-fA-F:]/.test(value)) return false;
    if (value.startsWith(":") && !value.startsWith("::")) return false;
    if (value.endsWith(":") && !value.endsWith("::")) return false;

    const doubleColonMatches = value.match(/::/g) || [];
    if (doubleColonMatches.length > 1) return false;

    const collapsedParts = value.split("::");
    const leftSegments = collapsedParts[0] ? collapsedParts[0].split(":").filter(Boolean) : [];
    const rightSegments = collapsedParts[1] ? collapsedParts[1].split(":").filter(Boolean) : [];
    const allSegments = [...leftSegments, ...rightSegments];

    if (allSegments.length === 0 || allSegments.length > 8) return false;
    if (collapsedParts.length === 1 && allSegments.length !== 8) return false;
    if (collapsedParts.length === 2 && allSegments.length >= 8) return false;

    return allSegments.every((segment) => /^[0-9a-fA-F]{1,4}$/.test(segment));
  }

  /**
   * Extracts plain email address from a mailto href.
   * @param {string} href - Anchor href value.
   * @returns {string} Decoded email address, or empty string.
   */
  function extractMailtoAddress(href) {
    if (!href || !href.toLowerCase().startsWith("mailto:")) return "";
    const mailtoPart = href.slice("mailto:".length).split("?")[0].trim();
    if (!mailtoPart) return "";
    try {
      return decodeURIComponent(mailtoPart);
    } catch {
      return mailtoPart;
    }
  }

  /**
   * Copies text to clipboard using modern API with legacy fallback.
   * @param {string} text - Text to copy.
   * @returns {Promise<boolean>} True when copy succeeded.
   */
  async function copyTextToClipboard(text) {
    if (!text) return false;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      textarea.remove();
    }

    return copied;
  }

  /**
   * Intercepts mailto clicks and converts them to copy-to-clipboard actions.
   * Purpose: Prevent default mail client opening inside DeskPro workflows.
   * @param {MouseEvent} event - Captured click event.
   */
  function interceptMailtoClick(event) {
    const anchor = event.target?.closest?.('a[href^="mailto:"]');
    if (!anchor) return;

    const emailAddress = extractMailtoAddress(anchor.getAttribute("href") || "");
    if (!emailAddress) return;

    event.preventDefault();
    event.stopPropagation();

    void copyTextToClipboard(emailAddress)
      .then((copied) => {
        if (!copied) return;
        const previousTitle = anchor.getAttribute("title");
        anchor.setAttribute("title", `Copied: ${emailAddress}`);
        setTimeout(() => {
          if (previousTitle === null) {
            anchor.removeAttribute("title");
            return;
          }
          anchor.setAttribute("title", previousTitle);
        }, 1200);
      })
      .catch(() => {
        // Ignore clipboard errors silently.
      });
  }

  /**
   * Build a DocumentFragment from `text` by replacing all pattern matches with
   * link nodes according to REPLACEMENT_RULES. Returns null if nothing matches.
   */
  function linkifyText(text) {
    const hits = [];
    for (const rule of REPLACEMENT_RULES) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(text)) !== null) {
        hits.push({ start: match.index, end: match.index + match[0].length, rule, match, priority: 1 });
      }
    }

    for (const hit of findProbableStandaloneAsnHits(text)) {
      hits.push({
        start: hit.start,
        end: hit.end,
        priority: 2,
        rule: {
          buildNodes([asn]) {
            return [makeAsnLink(asn, asn)];
          },
        },
        match: [hit.asn],
      });
    }

    if (hits.length === 0) return null;

    hits.sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const { start, end, rule, match } of hits) {
      if (start < cursor) continue; // Overlapping — skip.
      if (start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
      for (const node of rule.buildNodes(match)) fragment.appendChild(node);
      cursor = end;
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    return fragment;
  }

  /**
   * Replace all matched tokens inside a single text node with linked nodes.
   * Skips nodes already inside an <a> or a skipped-tag element.
   */
  function linkifyTextNode(textNode) {
    const parent = textNode.parentNode;
    if (!parent) return;
    if (SKIP_TAGS.has(parent.tagName)) return;
    if (parent.closest("a")) return;

    const fragment = linkifyText(textNode.nodeValue);
    if (fragment) parent.replaceChild(fragment, textNode);
  }

  /**
   * Walk all text nodes under `root` and linkify each one.
   * Collects nodes into an array first so the TreeWalker isn't
   * invalidated by DOM mutations during replacement.
   */
  function linkifySubtree(root) {
    if (root.nodeType !== Node.ELEMENT_NODE) return;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentNode;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          // Already inside a generated link — skip.
          if (p.closest(`a[${LINKIFIED_ATTR}]`)) return NodeFilter.FILTER_REJECT;
          // Already inside any <a> (external links etc.) — skip.
          if (p.closest("a")) return NodeFilter.FILTER_REJECT;
          // Quick pre-test to avoid collecting non-matching nodes.
          if (!QUICK_TEST_REGEX.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(linkifyTextNode);
  }

  // ── MutationObserver ──────────────────────────────────────────────────────

  let observer;

  /**
   * Handles MutationObserver events for dynamically loaded DeskPro content.
   * Purpose: Re-apply all normalizers/decorators/linkification to added nodes.
   * @param {MutationRecord[]} mutations - Mutation records from observer callback.
   */
  function onMutations(mutations) {
    // Pause observation while we mutate the DOM ourselves to avoid
    // re-triggering on our own insertions.
    observer.disconnect();

    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          normalizePeeringDbCpDoubleSlashLinks(node);
          decorateTargetActionLinks(node);
          decorateMailtoLinks(node);
          decorateExistingPeeringDbLinks(node);
          linkifySubtree(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          linkifyTextNode(node);
        }
      }
    }

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  /**
   * Initializes DeskPro consolidated tools on page load.
   * Purpose: Run cache migration, initial normalization/decorators and attach listeners/observer.
   */
  function init() {
    // Migrate old cache keys to shared namespace (one-time on first run after upgrade)
    migrateOldCacheKeys();

    // Initial pass over whatever is already rendered.
    normalizePeeringDbCpDoubleSlashLinks(document.body);
    decorateTargetActionLinks(document.body);
    decorateMailtoLinks(document.body);
    decorateExistingPeeringDbLinks(document.body);
    linkifySubtree(document.body);

    // Convert all mailto clicks into copy-to-clipboard behavior.
    document.addEventListener("click", interceptMailtoClick, true);

    // Watch for ticket content loaded dynamically by the DeskPro SPA.
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
