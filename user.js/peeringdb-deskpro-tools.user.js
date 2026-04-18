// ==UserScript==
// @name            PeeringDB DP - Consolidated Tools
// @namespace       https://www.peeringdb.com/
// @version         1.5.9.20260414
// @description     Consolidated DeskPro tools: linkifies/enriches PeeringDB links (ASN/IP/IX/NET), copies mailto addresses, normalizes PeeringDB CP double-slash links
// @author          <chriztoffer@peeringdb.com>
// @match           https://peeringdb.deskpro.com/app*
// @icon            https://icons.duckduckgo.com/ip2/deskpro.com.ico
// @grant           GM_xmlhttpRequest
// @grant           GM_registerMenuCommand
// @grant           GM_unregisterMenuCommand
// @connect         www.peeringdb.com
// @connect         peeringdb.com
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-deskpro-tools.meta.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-deskpro-tools.user.js
// @supportURL      https://github.com/peeringdb/admincom/issues
// ==/UserScript==

// AI Maintenance Notes (Copilot/Claude):
// - Preserve existing route matching and module boundaries.
// - Prefer minimal, localized edits; avoid broad refactors.
// - Keep grants/connect metadata aligned with actual usage.
// - Preserve shared storage key names and cache namespace compatibility.
// - Validate with syntax checks after edits.
// DP scope:
// - This script owns DeskPro linkification and enrichment workflows.
// - Do not add RDAP client logic here; RDAP fallback is CP-only.

(function () {
  "use strict";

  const MODULE_PREFIX = "pdbDp";
  const SCRIPT_VERSION = "1.5.7.20260413";
  // RDAP fallback client is intentionally CP-only; DP does not implement RDAP lookups.

  // Shared cross-script storage keys — must stay identical across DP, FP, and CP.
  const SHARED_USER_AGENT_STORAGE_KEY = "pdbAdmincom.userAgent";
  const SESSION_UUID_STORAGE_KEY = "pdbAdmincom.sessionUuid";
  const DIAGNOSTICS_STORAGE_KEY = "pdbAdmincom.debug";
  const TRUSTED_DOMAINS_FOR_UA = [
    "peeringdb.com",
    "*.peeringdb.com",
    "api.peeringdb.com",
    "127.0.0.1",
    "::1",
    "localhost",
  ];
  const DUMMY_ORG_ID = 20525;
  const FEATURE_FLAGS_STORAGE_KEY = `${MODULE_PREFIX}.featureFlags`;
  /**
   * Runtime feature flags for DP consolidated behavior.
   *
   * `debugMode`:  Enables debug logging when diagnostics localStorage is enabled.
   */
  const FEATURE_FLAGS = Object.freeze({
    debugMode: false,
    ipLinkification: true,
  });

  /**
   * Global constants and feature toggles for DeskPro linkification behavior.
   * Purpose: Keep selectors, labels, API timing, and URL normalization values centralized.
   * Necessity: Reused across link builders, fetch helpers, and mutation processing.
   */
  // Attribute stamped on generated <a> elements to prevent reprocessing.
  const LINKIFIED_ATTR = "data-pdb-asn-link";
  const MAILTO_DECORATED_ATTR = "data-pdb-mailto-decorated";
  const MAILTO_ICON_ATTR = "data-pdb-mailto-icon";
  const MAILTO_OWNER_ATTR = "data-pdb-mailto-owner";
  const MAILTO_HELPER_WRAP_ATTR = "data-pdb-mailto-helper-wrap";
  const MAILTO_SEARCH_LINK_ATTR = "data-pdb-mailto-search-link";
  const MAILTO_COPY_LINK_ATTR = "data-pdb-mailto-copy-link";
  const ACTION_EMOJI_LINK = "🔗";
  const ACTION_EMOJI_COPY = "📋";
  const ACTION_EMOJI_IX = "🏢";
  const ACTION_LINK_ICON_ATTR = "data-pdb-action-link-icon";
  const ACTION_LINK_TEXT_ATTR = "data-pdb-action-link-text";
  const IX_SHORTCUT_ATTR = "data-pdb-ix-shortcut";
  const EXISTING_PDB_LINK_DECORATED_ATTR = "data-pdb-existing-link-decorated";
  const EXISTING_PDB_LINK_ICON_ATTR = "data-pdb-existing-link-icon";
  const EXISTING_PDB_LINK_TEXT_ATTR = "data-pdb-existing-link-text";
  const PDB_LINK_CANDIDATE_SELECTOR = 'a[href*="peeringdb.com"]';
  const EDITABLE_CONTAINER_SELECTOR = '[contenteditable="true"]';
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
  const PDB_API_TIMEOUT_MS = 12000;
  const PDB_API_RETRIES = 2;
  const CACHE_TTL_MS = 7.5 * 60 * 60 * 1000;
  const ASN_NAME_CACHE_MISS_TTL_MS = 15 * 60 * 1000;
  const ASN_NAME_CACHE_TTL_MS = CACHE_TTL_MS;
  const ORG_CACHE_TTL_MS = CACHE_TTL_MS;
  const USER_CACHE_TTL_MS = CACHE_TTL_MS;
  const FACILITY_CACHE_TTL_MS = CACHE_TTL_MS;
  const NETIXLAN_CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours — separate from general TTL

  // IPv4: matches a.b.c.d, requires word boundary, rejects CIDR suffix /N and additional octet.
  const IPV4_TOKEN_REGEX = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?!\/\d)(?!\.\d)\b/g;
  const IPV4_TEST_REGEX = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?!\/\d)(?!\.\d)\b/;
  // IPv6: colon-hex compressed notation, rejects CIDR suffix /N.
  const IPV6_TOKEN_REGEX = /\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?!:)(?!\/\d)\b/g;
  const IPV6_TEST_REGEX = /\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?!:)(?!\/\d)\b/;

  const ENTITY_EXISTENCE_CACHE_TTL_MS = 60 * 60 * 1000;
  const BATCH_FETCH_MAX_ASNS = 100; // Per-request limit for asn__in queries
  const RATE_LIMIT_MIN_REMAINING = 10; // Backoff threshold

  const asnNameCache = new Map();
  const asnNameInFlight = new Map();
  const dataCacheInFlight = new Map(); // In-flight dedup for all API requests
  const rateLimitState = { limit: null, remaining: null, resetTime: null }; // Track rate-limit quotas

  /**
   * Returns localStorage when available for domain-scoped cache persistence.
   * Purpose: Share ASN name cache entries across tabs and page reloads.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * Returns storage for tab-scoped transient values.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @returns {Storage|null} sessionStorage instance, or null when unavailable.
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
   * Generates or retrieves a persistent session UUID for the browser session.
   * Purpose: Provides a unique identifier for correlating requests within a session.
   * Necessity: Enables server-side analytics and request tracking without exposing device fingerprint.
   * UUID persists across page reloads and tabs on the same origin.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @returns {string} Session UUID string (generated once per browser session).
   */
  function getSessionUuid() {
    const sessionKey = SESSION_UUID_STORAGE_KEY;
    const storage = getDomainCacheStorage();
    let uuid = storage?.getItem(sessionKey);
    if (!uuid) {
      uuid = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      if (storage) {
        storage.setItem(sessionKey, uuid);
      }
    }
    return uuid;
  }

  /**
   * Computes a stable client fingerprint from browser/device attributes.
   * Purpose: Creates a privacy-preserving identifier for requests from untrusted domains.
   * Necessity: Balances analytics tracking with user privacy for non-trusted networks.
   * Returns a 16-character hex string derived from UA, platform, language, CPU count, memory.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {string} 16-character lowercase hex fingerprint string.
   */
  function computeClientFingerprint() {
    const parts = [
      navigator.userAgent,
      navigator.platform,
      navigator.language,
      navigator.hardwareConcurrency || "unknown",
      navigator.deviceMemory || "unknown",
    ].join("|");

    let hash = 0;
    for (let i = 0; i < parts.length; i++) {
      const char = parts.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(16, "0").substr(0, 16);
  }

  /**
   * Determines if a domain is in the trusted domain list.
   * Purpose: Implement domain-based trust policy for User-Agent header generation.
   * Necessity: Distinguishes between trusted (localhost, peeringdb.com) and untrusted domains
   * to decide whether to use full browser info or privacy-preserving fingerprint.
   * Also normalizes IPv6 URIs with bracket notation ([::1]) for transparent matching.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {string} domain - Hostname to test (e.g., "www.peeringdb.com", "localhost").
   * @returns {boolean} True when the domain matches a TRUSTED_DOMAINS_FOR_UA entry.
   */
  function isDomainTrusted(domain) {
    if (!domain) return false;
    // Normalize: trim, lowercase, and strip IPv6 URI brackets (e.g., [::1] → ::1)
    let domainText = String(domain).trim().toLowerCase();
    if (domainText.startsWith("[") && domainText.endsWith("]")) {
      domainText = domainText.slice(1, -1); // Strip IPv6 URI brackets
    }
    if (!domainText) return false;

    for (const pattern of TRUSTED_DOMAINS_FOR_UA) {
      const patternLower = pattern.toLowerCase();
      if (patternLower === domainText) return true;

      // Handle wildcard patterns like *.peeringdb.com
      if (patternLower.startsWith("*.")) {
        const baseDomain = patternLower.slice(2);
        if (domainText === baseDomain || domainText.endsWith("." + baseDomain)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Constructs a User-Agent string based on domain trust level.
   * Purpose: Provide contextual information to backend while respecting user privacy.
   * Necessity: For trusted domains (development, peeringdb.com), includes browser/platform for debugging;
   * for untrusted domains, uses fingerprint only to minimize data exposure.
   * Includes session UUID in both cases for request correlation.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} domain - Hostname of the page making the request.
   * @returns {string} Constructed User-Agent header value.
   */
  function buildTrustBasedUserAgent(domain) {
    const isTrusted = isDomainTrusted(domain);
    const sessionUuid = getSessionUuid();

    if (isTrusted) {
      // Full-detail UA for trusted domains (server-side context, logging, analytics)
      const browserInfo = `${navigator.userAgent.split(" ").slice(-1)[0]} ${navigator.platform}`;
      return `${DEFAULT_REQUEST_USER_AGENT} (${browserInfo} uuid/${sessionUuid})`;
    }

    // Privacy-preserving UA with fingerprint only for untrusted domains
    const fingerprint = computeClientFingerprint();
    return `${DEFAULT_REQUEST_USER_AGENT} (fingerprint/${fingerprint} uuid/${sessionUuid})`;
  }

  /**
   * Retrieves explicit or auto-computed User-Agent for this session.
   * Purpose: Provide flexible UA configuration with fallback to trust-based generation.
   * Necessity: Allows manual override via localStorage while auto-computing from domain trust.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @returns {string} User-Agent string to use for outgoing requests.
   */
  function getCustomRequestUserAgent() {
    const sharedConfigured = String(window.localStorage?.getItem(SHARED_USER_AGENT_STORAGE_KEY) || "").trim();
    if (sharedConfigured) return sharedConfigured;
    // Auto-compute trust-based UA if not explicitly configured
    return buildTrustBasedUserAgent(window.location.hostname);
  }

  /**
   * Reads JSON feature-flag overrides from localStorage.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {object} Parsed override map, or empty object when unavailable/invalid.
   */
  function getFeatureFlagOverrides() {
    try {
      const raw = String(window.localStorage?.getItem(FEATURE_FLAGS_STORAGE_KEY) || "").trim();
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  /**
   * Returns resolved feature-flag value using defaults plus localStorage overrides.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} flagName - Flag key inside FEATURE_FLAGS.
   * @returns {boolean} Resolved boolean state.
   */
  function isFeatureEnabled(flagName) {
    const defaultValue = FEATURE_FLAGS[flagName];
    if (typeof defaultValue !== "boolean") return false;

    const overrides = getFeatureFlagOverrides();
    const overrideValue = overrides[flagName];
    if (typeof overrideValue === "boolean") return overrideValue;

    return defaultValue;
  }

  /**
   * Returns feature-flag default/override/resolved state.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} flagName - Flag key inside FEATURE_FLAGS.
   * @returns {{ defaultValue: boolean, overrideValue: boolean|null, enabled: boolean }|null} Flag state.
   */
  function getFeatureFlagState(flagName) {
    const defaultValue = FEATURE_FLAGS[flagName];
    if (typeof defaultValue !== "boolean") return null;

    const overrides = getFeatureFlagOverrides();
    const overrideValue = typeof overrides[flagName] === "boolean" ? overrides[flagName] : null;
    const enabled = overrideValue === null ? defaultValue : overrideValue;
    return { defaultValue, overrideValue, enabled };
  }

  /**
   * Sets a feature-flag override and cleans up redundant values.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} flagName - Flag key inside FEATURE_FLAGS.
   * @param {boolean} enabled - Resolved target state.
   */
  function setFeatureFlagEnabled(flagName, enabled) {
    const state = getFeatureFlagState(flagName);
    if (!state) return;

    const overrides = getFeatureFlagOverrides();
    if (enabled === state.defaultValue) {
      delete overrides[flagName];
    } else {
      overrides[flagName] = Boolean(enabled);
    }

    try {
      if (Object.keys(overrides).length === 0) {
        window.localStorage?.removeItem(FEATURE_FLAGS_STORAGE_KEY);
      } else {
        window.localStorage?.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(overrides));
      }
    } catch (_error) {
      // Ignore localStorage write failures.
    }
  }

  /**
   * Removes all feature-flag overrides and restores defaults.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function resetFeatureFlagOverrides() {
    try {
      window.localStorage?.removeItem(FEATURE_FLAGS_STORAGE_KEY);
    } catch (_error) {
      // Ignore localStorage write failures.
    }
  }

  /**
   * Returns true when diagnostics/debug mode is enabled via localStorage.
   * Purpose: Gate verbose console output behind an opt-in flag so normal
   * production use is silent.
   * Toggle with: localStorage.setItem('pdbAdmincom.debug', '1')
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {boolean} True when debug mode is active.
   */
  function isDebugEnabled() {
    return isFeatureEnabled("debugMode") && window.localStorage?.getItem(DIAGNOSTICS_STORAGE_KEY) === "1";
  }

  /**
   * Structured debug logger — no-ops unless debug mode is active.
   * Purpose: Provide consistent prefixed console output for diagnostics
   * without polluting normal page console output.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} tag  - Short subsystem label shown in brackets.
   * @param {string} msg  - Human-readable message.
   * @param {...*}   rest - Optional extra values forwarded to console.debug.
   */
  function dbg(tag, msg, ...rest) {
    if (!isDebugEnabled()) return;
    console.debug(`[${MODULE_PREFIX}:${tag}]`, msg, ...rest);
  }

  /**
   * Normalizes ASN value into a stable cache key suffix.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} asn - Raw ASN value.
   * @returns {string} Trimmed ASN string.
   */
  function normalizeAsnForCache(asn) {
    return String(asn || "").trim();
  }

  /**
   * Builds localStorage key for cached API data (shared namespace).
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} asn - ASN value.
   * @returns {string|null} Cached ASN name, or null when absent/expired/invalid.
   */
  function getCachedAsnNameFromStorage(asn) {
    const data = getCachedDataFromStorage("asn", asn);
    return data ? String(data.name || "").trim() || null : null;
  }

  /**
   * Stores API data object into localStorage cache with TTL/schema metadata.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} [baseHeaders={}] - Optional caller-provided headers.
   * @returns {object} Final request headers including UA metadata.
   */
  function buildTampermonkeyRequestHeaders(baseHeaders = {}) {
    const headers = { ...baseHeaders };
    const userAgent = getCustomRequestUserAgent();

    if (userAgent) {
      headers["User-Agent"] = userAgent;
      if (!headers["X-PDB-Request-UA"] && !headers["x-pdb-request-ua"]) {
        headers["X-PDB-Request-UA"] = userAgent;
      }
    }
    return headers;
  }

  /**
   * Removes headers that cannot be used with browser fetch.
   * Purpose: Avoid forbidden-header runtime failures for same-origin fetch mode.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
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
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {boolean} True if should backoff (remaining quota < threshold).
   */
  function shouldBackoffRateLimit() {
    return rateLimitState.remaining !== null && rateLimitState.remaining < RATE_LIMIT_MIN_REMAINING;
  }

  /**
   * Unified JSON fetch helper with retry and timeout support.
   * Purpose: Mirror CP script network behavior for stable PeeringDB API access.
   * Necessity: Prevents divergent network logic between Tampermonkey transport modes.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} url - Absolute URL to request.
   * @param {{ headers?: object, timeout?: number, retries?: number }} [options] - Request tuning options.
   * @returns {Promise<object|null>} Parsed JSON payload, or null on failure.
   */
  async function pdbFetch(url, { headers = {}, timeout = PDB_API_TIMEOUT_MS, retries = PDB_API_RETRIES } = {}) {
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
   * Performs an API GET and returns HTTP status information.
   * Purpose: Distinguish true 404 missing objects from transient/auth failures.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} url - Request URL.
   * @param {object} [options={}] - Request options.
   * @returns {Promise<{ok:boolean,status:number|null}>} Fetch result with status.
   */
  async function pdbFetchStatus(url, { headers = {}, timeout = PDB_API_TIMEOUT_MS, retries = PDB_API_RETRIES } = {}) {
    const fullHeaders = buildTampermonkeyRequestHeaders(headers);

    if (shouldBackoffRateLimit()) {
      const resetAt = Number(rateLimitState.resetTime) || Date.now();
      const waitMs = Math.max(500, resetAt - Date.now());
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(waitMs, 5000));
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

        const responseHeaders = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });
        updateRateLimitState(responseHeaders);

        if (response.ok) return { ok: true, status: response.status };
        if (response.status === 404) return { ok: false, status: 404 };

        if (attempt + 1 >= retries) {
          return { ok: false, status: response.status };
        }
      } catch (_error) {
        if (attempt + 1 >= retries) {
          return { ok: false, status: null };
        }
      }
    }

    return { ok: false, status: null };
  }

  /**
   * Maps frontend entity kinds to CP backend model names.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} kind - Frontend entity kind.
   * @returns {string} CP model segment, or empty string when unsupported.
   */
  function getCpModelForFrontendKind(kind) {
    const normalizedKind = String(kind || "").trim().toLowerCase();
    const mapping = {
      asn: "network",
      net: "network",
      ix: "internetexchange",
      fac: "facility",
      org: "organization",
      user: "user",
    };
    return mapping[normalizedKind] || "";
  }

  /**
   * Builds canonical CP change URL for a model/id pair.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} model - CP backend model name.
   * @param {string|number} id - Object identifier.
   * @returns {string} Absolute CP change URL, or empty string when invalid.
   */
  function buildCpChangeUrl(model, id) {
    const normalizedModel = String(model || "").trim().toLowerCase();
    const normalizedId = String(id || "").trim();
    if (!normalizedModel || !/^\d+$/.test(normalizedId)) return "";
    return `https://www.peeringdb.com/cp/peeringdb_server/${normalizedModel}/${normalizedId}/change/`;
  }

  /**
   * Resolves API probe URL for frontend entity existence checks.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} kind - Frontend entity kind.
   * @param {string|number} id - Entity identifier.
   * @returns {string} API URL, or empty string when unsupported.
   */
  function getFrontendExistenceProbeUrl(kind, id) {
    const normalizedKind = String(kind || "").trim().toLowerCase();
    const normalizedId = String(id || "").trim();
    if (!/^\d+$/.test(normalizedId)) return "";

    const mapping = {
      net: "net",
      ix: "ix",
      fac: "fac",
      org: "org",
      user: "user",
    };

    const apiResource = mapping[normalizedKind] || "";
    if (!apiResource) return "";
    return `https://www.peeringdb.com/api/${apiResource}/${normalizedId}`;
  }

  /**
   * Returns true when a frontend entity is confirmed missing (404).
   * Policy: fallback triggers only for confirmed HTTP 404 responses.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} kind - Frontend entity kind.
   * @param {string|number} id - Entity identifier.
   * @returns {Promise<boolean>} True when entity is missing.
   */
  async function isFrontendEntityMissing(kind, id) {
    const normalizedKind = String(kind || "").trim().toLowerCase();
    const normalizedId = String(id || "").trim();
    if (!normalizedKind || !/^\d+$/.test(normalizedId)) return false;

    const probeUrl = getFrontendExistenceProbeUrl(normalizedKind, normalizedId);
    if (!probeUrl) return false;

    const cacheType = "entity_existence";
    const cacheId = `${normalizedKind}.${normalizedId}`;
    const cached = getCachedDataFromStorage(cacheType, cacheId);
    if (cached && typeof cached.missing === "boolean") {
      return cached.missing;
    }

    const inFlightKey = `frontendExistence.${cacheId}`;
    if (dataCacheInFlight.has(inFlightKey)) {
      return dataCacheInFlight.get(inFlightKey);
    }

    const requestPromise = (async () => {
      const result = await pdbFetchStatus(probeUrl);
      if (result.ok) {
        setCachedDataInStorage(cacheType, cacheId, { missing: false }, ENTITY_EXISTENCE_CACHE_TTL_MS);
        return false;
      }
      if (result.status === 404) {
        setCachedDataInStorage(cacheType, cacheId, { missing: true }, ASN_NAME_CACHE_MISS_TTL_MS);
        return true;
      }
      return false;
    })();

    dataCacheInFlight.set(inFlightKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      dataCacheInFlight.delete(inFlightKey);
    }
  }

  /**
   * Resolves CP fallback URL for missing frontend entities.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ kind: string, id?: string }} info - Parsed frontend entity descriptor.
   * @returns {Promise<string>} CP fallback URL, or empty string when no fallback needed.
   */
  async function getCpFallbackUrlForMissingFrontendEntity(info) {
    const kind = String(info?.kind || "").trim().toLowerCase();
    const id = String(info?.id || "").trim();
    if (!kind || !/^\d+$/.test(id)) return "";

    const cpModel = getCpModelForFrontendKind(kind);
    if (!cpModel) return "";

    const missing = await isFrontendEntityMissing(kind, id);
    if (!missing) return "";
    return buildCpChangeUrl(cpModel, id);
  }

  /**
   * Selects the best network item for ASN lookups from list-style API payloads.
   * Purpose: Prefer exact ASN and active status from `/api/net` responses.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
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
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
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
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
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
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
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
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
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
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
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
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
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
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
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
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string} type - Entity type (asn, org, user, facility).
   * @param {string|number} id - Entity identifier.
   * @param {number} [ttlMs=1.5 hours] - Cache time-to-live.
   */
  function cacheNegativeLookup(type, id, ttlMs = 1.5 * 3600 * 1000) {
    setCachedDataInStorage(type, id, { error: "not_found", timestamp: Date.now() }, ttlMs);
  }

  /**
   * Checks if a cache entry represents a negative lookup (not found).
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {string|number} asn - ASN identifier.
   * @param {string} displayText - Visible initial label (e.g. AS12345).
   * @returns {HTMLAnchorElement} Fully configured ASN anchor.
   */
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
   * Fetches exchange object by IX id.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
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
   * Returns the best netixlan record from an API result set.
   * Prefers records that include an ix.name for label enrichment.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {Array} items - Netixlan data array from API.
   * @returns {object|null} Best record, or null when none available.
   */
  function getBestNetixlanDataItem(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    return items.find((item) => item?.ix?.name) ?? items[0] ?? null;
  }

  /**
   * Fetches the best netixlan record for an IPv4 address.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} ip - IPv4 address.
   * @returns {Promise<object|null>} Netixlan record, or null when not found.
   */
  async function fetchNetixlanByIp(ip) {
    const normalizedIp = String(ip || "").trim();
    if (!normalizedIp) return null;
    const cacheKey = `netixlan_ip_${normalizedIp}`;
    const cached = getCachedDataFromStorage(cacheKey);
    if (cached !== undefined) return cached;
    const url = `${PEERINGDB_API_BASE_URL}/netixlan?ipaddr4=${encodeURIComponent(normalizedIp)}&depth=2`;
    try {
      const data = await pdbFetch(url);
      const items = Array.isArray(data?.data) ? data.data : [];
      const best = getBestNetixlanDataItem(items);
      setCachedDataInStorage(cacheKey, best, NETIXLAN_CACHE_TTL_MS);
      return best;
    } catch {
      setCachedDataInStorage(cacheKey, null, NETIXLAN_CACHE_TTL_MS);
      return null;
    }
  }

  /**
   * Adds a compact IX shortcut icon next to an enriched link.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
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
   * Builds organization search anchor with link emoji styling.
   * Purpose: Link affiliation organization names to PeeringDB search results.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} orgName - Organization search query value.
   * @param {string} [displayText=orgName] - Visible label for the anchor text span.
   * @returns {HTMLAnchorElement} Configured organization-search anchor.
   */
  /**
   * Returns true when text is a plausible compressed IPv6 address (colon-hex notation).
   * Used as a secondary gate after the IPv6 regex to reject false positives.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} text - Candidate string.
   * @returns {boolean}
   */
  function isLikelyIpv6Address(text) {
    if (!text.includes(":")) return false;
    // Compressed form — exactly one "::" present.
    if (text.includes("::")) {
      const parts = text.split("::");
      if (parts.length !== 2) return false; // more than one "::" → malformed
      return /^[0-9a-fA-F:]*$/.test(text); // each side is pure hex/colon
    }
    // Full uncompressed form — exactly 8 groups of 1–4 hex digits.
    const groups = text.split(":");
    return groups.length === 8 && groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
  }

  /**
   * Builds an IP address search anchor with link emoji styling.
   * Purpose: Link bare IP addresses to PeeringDB search results.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} ip - IP address to linkify.
   * @returns {HTMLAnchorElement} Configured IP-search anchor.
   */
  function makeIpLink(ip) {
    const query = String(ip || "").trim();
    const a = document.createElement("a");
    a.href = `https://www.peeringdb.com/search/v2?q=${encodeURIComponent(query)}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `Search ${query} in PeeringDB`;
    a.style.textDecoration = "none";

    const text = document.createElement("span");
    text.textContent = query;
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
   * Async-enriches an IP link anchor with IX name from netixlan API data.
   * Purpose: Replace bare IP label with contextual IX name once data is available.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLAnchorElement} anchor - Anchor to update.
   * @param {string} ip - IPv4 address used for lookup.
   * @returns {Promise<void>}
   */
  async function hydrateIpLinkLabel(anchor, ip) {
    try {
      const netixlan = await fetchNetixlanByIp(ip);
      if (!anchor?.isConnected || !netixlan) return;
      const ixName = String(netixlan?.ix?.name || "").trim();
      if (!ixName) return;
      const textSpan = anchor.querySelector("span");
      if (textSpan) textSpan.textContent = `${ip} (${ixName})`;
      anchor.title = `${ip} | ${ixName}`;
    } catch {
      // Enrichment errors are non-fatal.
    }
  }

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
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} href - Anchor href.
   * @returns {{ kind: string, id?: string, entity?: string, url: URL }|null} Parsed descriptor.
   */
  function parsePeeringDbEntityFromHref(href) {
    try {
      const url = new URL(String(href || ""), window.location.origin);
      const host = String(url.hostname || "").toLowerCase();
      if (!(host === "peeringdb.com" || host === "www.peeringdb.com")) return null;

      const entityMatch = url.pathname.match(/^\/(asn|net|ix|fac|org|user)\/(\d+)(?:\/|$)/i);
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
   * Resolves CP entity model names to compact type tokens and relation semantics.
   * Purpose: Ensure decorated CP links always include explicit target type.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} entity - CP model/entity segment from URL.
   * @returns {{ token: string, label: string, isRelationship: boolean }} Normalized CP type descriptor.
   */
  function getCpEntityTypeInfo(entity) {
    const normalized = String(entity || "").trim().toLowerCase();
    const mapping = {
      org: { token: "org", label: "organization", isRelationship: false },
      organization: { token: "org", label: "organization", isRelationship: false },
      user: { token: "user", label: "user", isRelationship: false },
      fac: { token: "fac", label: "facility", isRelationship: false },
      facility: { token: "fac", label: "facility", isRelationship: false },
      net: { token: "net", label: "network", isRelationship: false },
      network: { token: "net", label: "network", isRelationship: false },
      asn: { token: "asn", label: "ASN", isRelationship: false },
      ix: { token: "ix", label: "internet exchange", isRelationship: false },
      internetexchange: { token: "ix", label: "internet exchange", isRelationship: false },
      ixlan: { token: "ixlan", label: "IX LAN", isRelationship: true },
      ixfac: { token: "ixfac", label: "IX-facility", isRelationship: true },
      internetexchangefacility: { token: "ixfac", label: "IX-facility", isRelationship: true },
      netfac: { token: "netfac", label: "network-facility", isRelationship: true },
      networkfacility: { token: "netfac", label: "network-facility", isRelationship: true },
      netixlan: { token: "netixlan", label: "network-IX LAN", isRelationship: true },
      networkixlan: { token: "netixlan", label: "network-IX LAN", isRelationship: true },
      network_contact: { token: "poc", label: "point of contact", isRelationship: true },
      networkcontact: { token: "poc", label: "point of contact", isRelationship: true },
      poc: { token: "poc", label: "point of contact", isRelationship: false },
      ixfmemberdata: { token: "ixfmemberdata", label: "IX-F member", isRelationship: true },
      verificationqueueitem: {
        token: "verificationqueueitem",
        label: "verification queue item",
        isRelationship: false,
      },
    };

    if (mapping[normalized]) return mapping[normalized];

    const fallbackToken = normalized || "record";
    const fallbackLabel = fallbackToken.replace(/_/g, " ");
    return {
      token: fallbackToken,
      label: fallbackLabel,
      isRelationship: fallbackToken.includes("ixlan") || fallbackToken.includes("fac"),
    };
  }

  /**
   * Returns true when anchor visible text is a bare URL matching href.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
   * Strips trailing link-emoji tokens from visible anchor text.
   * Purpose: Prevent re-decoration cycles from treating prior emoji icons as label content.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} value - Raw anchor text.
   * @returns {string} Text without trailing link-emoji tokens.
   */
  function stripTrailingLinkEmojiTokens(value) {
    return String(value || "")
      .replace(/\s*(?:🔗\s*)+$/g, "")
      .trim();
  }

  /**
   * Returns true when anchor text is composed only of link-emoji tokens.
   * Purpose: Detect stray duplicate anchors created from repeated visual decoration.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLAnchorElement} anchor - Anchor to inspect.
   * @returns {boolean} True when text has no content beyond link emoji characters.
   */
  function isLinkEmojiOnlyAnchorText(anchor) {
    const compact = String(anchor?.textContent || "").replace(/\s+/g, "").trim();
    if (!compact) return false;
    return compact.replace(/🔗/g, "") === "";
  }

  /**
   * Resolves previous sibling anchor, including wrappers that contain an anchor.
   * Purpose: Support duplicate cleanup in editor markup where anchors may be wrapped in spans.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {HTMLAnchorElement} anchor - Current anchor.
   * @returns {HTMLAnchorElement|null} Previous sibling anchor candidate.
   */
  function getPreviousSiblingAnchor(anchor) {
    const previous = anchor?.previousElementSibling;
    if (!previous) return null;
    if (previous.matches?.("a[href]")) return previous;
    return previous.querySelector?.("a[href]") || null;
  }

  /**
   * Determines whether an anchor is inside an editable composer region.
   * Purpose: Avoid modifying DeskPro editor content while snippets are inserted/managed.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLAnchorElement} anchor - Anchor to evaluate.
   * @returns {boolean} True when inside a contenteditable ancestor.
   */
  function isAnchorInsideEditableRegion(anchor) {
    return Boolean(anchor?.closest?.(EDITABLE_CONTAINER_SELECTOR));
  }

  /**
   * Ensures anchor has a text span + link icon while preserving existing complex content.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
        const rawText = stripTrailingLinkEmojiTokens(String(anchor.textContent || ""));
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
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLAnchorElement} anchor - Anchor to enrich.
   * @param {{ kind: string, id?: string, entity?: string }} info - Parsed anchor descriptor.
   * @returns {Promise<void>}
   */
  async function hydrateExistingPeeringDbAnchor(anchor, info) {
    if (!anchor?.isConnected || !info) return;

    try {
      if (info.kind !== "cp" && info.kind !== "pdb" && info.id) {
        const fallbackUrl = await getCpFallbackUrlForMissingFrontendEntity(info);
        if (fallbackUrl && anchor?.isConnected) {
          anchor.href = fallbackUrl;
          if (!anchor.getAttribute("title")) {
            anchor.title = `Frontend ${info.kind} ${info.id} not found; opening CP change page`;
          }
        }
      }

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
        const label = ixName ? `ix/${info.id} (${ixName})` : `ix/${info.id}`;
        setExistingPdbAnchorLabel(anchor, label);
        anchor.title = ixName ? `ix/${info.id} | ${ixName}` : `ix/${info.id}`;
        return;
      }

      if (info.kind === "net" && info.id) {
        const net = await fetchNetById(info.id);
        if (!anchor?.isConnected) return;

        const netName = String(net?.name || net?.name_long || "").trim();
        const asn = String(net?.asn || "").trim();
        const orgId = String(net?.org_id || "").trim();

        const tooltipParts = [];
        tooltipParts.push(`net/${info.id}`);
        if (netName) tooltipParts.push(netName);
        if (asn) tooltipParts.push(`AS${asn}`);

        const label = netName ? `net/${info.id} (${netName})` : `net/${info.id}`;
        setExistingPdbAnchorLabel(anchor, label);

        if (orgId) {
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
        const cpType = getCpEntityTypeInfo(info.entity);
        const kindLabel = cpType.isRelationship ? "relationship" : "object";
        const label = `cp/${cpType.token}/${info.id}`;
        setExistingPdbAnchorLabel(anchor, label);
        anchor.title = `Open CP ${cpType.label} ${kindLabel} ${info.id}`;
      }
    } catch (_error) {
      // Ignore enrichment failures for existing anchors; base navigation remains intact.
    }
  }

  /**
   * Decorates pre-existing PeeringDB anchors rendered in ticket HTML.
   * Purpose: Provide consistent iconography and rich contextual tooltips without text-node relinkification.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {Element} root - Root element to scan.
   */
  function decorateExistingPeeringDbLinks(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    // Always decorate, including in editable regions
    if (!root.matches?.(PDB_LINK_CANDIDATE_SELECTOR) && !root.querySelector?.(PDB_LINK_CANDIDATE_SELECTOR)) {
      return;
    }

    const anchors = [];
    if (root.matches?.("a[href]")) anchors.push(root);
    root.querySelectorAll?.("a[href]").forEach((anchor) => anchors.push(anchor));

    anchors.forEach((anchor) => {
      if (!anchor || anchor.getAttribute(LINKIFIED_ATTR) === "true") return;
      if (anchor.getAttribute(MAILTO_DECORATED_ATTR) === "true") return;
      if (anchor.getAttribute(MAILTO_SEARCH_LINK_ATTR) === "true") return;
      // Always decorate, including in editable regions

      const info = parsePeeringDbEntityFromHref(anchor.getAttribute("href") || "");
      if (!info) return;

      if (isLinkEmojiOnlyAnchorText(anchor)) {
        const previousAnchor = getPreviousSiblingAnchor(anchor);
        const currentHref = String(anchor.getAttribute("href") || "").trim();
        const previousHref = String(previousAnchor?.getAttribute?.("href") || "").trim();
        if (currentHref && previousHref && currentHref === previousHref) {
          anchor.remove();
          return;
        }
      }

      // Detect DeskPro-generated PeeringDB IP search links (/search/v2?q=<ip>).
      if (info.kind === "pdb" && isFeatureEnabled("ipLinkification")) {
        const qParam = String(info.url?.searchParams?.get("q") || "").trim();
        const hasCidr = /\/\d+$/.test(qParam);
        const isIpv4Query = !hasCidr && IPV4_TEST_REGEX.test(qParam) && /^[0-9.]+$/.test(qParam);
        const isIpv6Query = !hasCidr && IPV6_TEST_REGEX.test(qParam) && isLikelyIpv6Address(qParam);

        if (hasCidr && qParam) {
          // CIDR prefix anchor (e.g. 192.168.0.0/24) — replace with plain text so
          // it is not linkified and does not produce a broken IP search result.
          anchor.replaceWith(document.createTextNode(qParam));
          return;
        }

        // IPv6-like qParam that is NOT a complete address (DeskPro split a subnet prefix,
        // e.g. "2001:df5:ebc0" from "2001:df5:ebc0::/48"). Replace with the anchor's text
        // content — the remaining "::/48" is already plain text in the DOM.
        const isFragmentedIpv6 =
          !hasCidr && qParam.includes(":") && IPV6_TEST_REGEX.test(qParam) && !isLikelyIpv6Address(qParam);
        if (isFragmentedIpv6) {
          anchor.replaceWith(document.createTextNode(anchor.textContent || qParam));
          return;
        }

        if (isIpv4Query || isIpv6Query) {
          // Plain IP already linked by DeskPro — decorate in-place, skip text-node re-linkification.
          ensureExistingPdbAnchorVisual(anchor, qParam);
          anchor.title = `Search ${qParam} in PeeringDB`;
          if (anchor.getAttribute(EXISTING_PDB_LINK_DECORATED_ATTR) !== "true") {
            anchor.setAttribute(EXISTING_PDB_LINK_DECORATED_ATTR, "true");
            void hydrateIpLinkLabel(anchor, qParam);
          }
          return;
        }
      }

      const shouldRelabel = isBareUrlAnchorText(anchor);
      let initialLabel = "";
      if (shouldRelabel && info.kind === "asn" && info.id) initialLabel = `AS${info.id}`;
      if (shouldRelabel && info.kind === "net" && info.id) initialLabel = `net/${info.id}`;
      if (shouldRelabel && info.kind === "ix" && info.id) initialLabel = `ix/${info.id}`;
      if (shouldRelabel && info.kind === "fac" && info.id) initialLabel = `fac/${info.id}`;
      if (shouldRelabel && info.kind === "org" && info.id) initialLabel = `org/${info.id}`;
      if (shouldRelabel && info.kind === "user" && info.id) initialLabel = `user/${info.id}`;
      if (shouldRelabel && info.kind === "cp" && info.id) {
        const cpType = getCpEntityTypeInfo(info.entity);
        initialLabel = `cp/${cpType.token}/${info.id}`;
      }

      ensureExistingPdbAnchorVisual(anchor, initialLabel);
      if (!anchor.getAttribute("title")) {
        if (info.kind === "cp" && info.id) {
          const cpType = getCpEntityTypeInfo(info.entity);
          const kindLabel = cpType.isRelationship ? "relationship" : "object";
          anchor.title = `Open CP ${cpType.label} ${kindLabel} ${info.id}`;
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
   * One-time cleanup pass for stale duplicate PeeringDB anchors from older render cycles.
   * Purpose: Remove emoji-only duplicate anchors already present in ticket DOM before
   * normal decoration runs.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {Element} root - Root element to scan.
   * @returns {number} Number of removed duplicate anchors.
   */
  function cleanupLegacyDuplicatePeeringDbAnchors(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return 0;

    const anchors = [];
    if (root.matches?.("a[href]")) anchors.push(root);
    root.querySelectorAll?.("a[href]").forEach((anchor) => anchors.push(anchor));

    let removed = 0;

    anchors.forEach((anchor) => {
      if (!anchor?.isConnected) return;

      const info = parsePeeringDbEntityFromHref(anchor.getAttribute("href") || "");
      if (!info) return;
      if (!isLinkEmojiOnlyAnchorText(anchor)) return;

      const previousAnchor = getPreviousSiblingAnchor(anchor);
      const currentHref = String(anchor.getAttribute("href") || "").trim();
      const previousHref = String(previousAnchor?.getAttribute?.("href") || "").trim();

      if (currentHref && previousHref && currentHref === previousHref) {
        anchor.remove();
        removed += 1;
      }
    });

    return removed;
  }

  /**
   * Decorates a mailto anchor for copy-to-clipboard UX.
   * Purpose: Add copy emoji indicator and remove underline decoration.
   * Necessity: Ticket operators need clear click affordance for mail addresses.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {HTMLAnchorElement} anchor - Mailto anchor to decorate.
   */
  function decorateMailtoAnchor(anchor) {
    if (!anchor) return;

    const emailAddress = extractMailtoAddress(anchor.getAttribute("href") || "");
    const ownerId = getOrCreateMailtoOwnerId(anchor);

    anchor.querySelectorAll(`span[${MAILTO_ICON_ATTR}]`).forEach((node) => node.remove());
    const parent = anchor.parentElement;
    if (parent) {
      parent.querySelectorAll(`span[${MAILTO_HELPER_WRAP_ATTR}]`).forEach((node) => {
        if (node.previousElementSibling === anchor || node.nextElementSibling === anchor) {
          node.remove();
        }
      });
    }
    document
      .querySelectorAll(`span[${MAILTO_HELPER_WRAP_ATTR}="${ownerId}"]`)
      .forEach((node) => node.remove());

    anchor.style.textDecoration = "none";
    anchor.style.textDecorationLine = "none";

    if (emailAddress) {
      const helperWrap = document.createElement("span");
      helperWrap.setAttribute(MAILTO_HELPER_WRAP_ATTR, ownerId);
      helperWrap.style.display = "inline-flex";
      helperWrap.style.alignItems = "center";
      helperWrap.style.whiteSpace = "nowrap";

      const cpSearchLink = document.createElement("a");
      cpSearchLink.href = buildCpEmailSearchUrl(emailAddress);
      cpSearchLink.target = "_blank";
      cpSearchLink.rel = "noopener noreferrer";
      cpSearchLink.textContent = ` ${ACTION_EMOJI_LINK}`;
      cpSearchLink.setAttribute(MAILTO_SEARCH_LINK_ATTR, "true");
      cpSearchLink.setAttribute("aria-label", `Search ${emailAddress} in CP`);
      cpSearchLink.title = `Search ${emailAddress} in CP`;
      cpSearchLink.style.textDecoration = "none";

      const copyLink = document.createElement("a");
      copyLink.href = "#";
      copyLink.textContent = ` ${ACTION_EMOJI_COPY}`;
      copyLink.setAttribute(MAILTO_COPY_LINK_ATTR, "true");
      copyLink.setAttribute(MAILTO_ICON_ATTR, "true");
      copyLink.setAttribute("aria-label", `Copy ${emailAddress}`);
      copyLink.title = `Copy ${emailAddress}`;
      copyLink.style.textDecoration = "none";
      copyLink.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyTextToClipboard(emailAddress);
      });

      helperWrap.append(copyLink, cpSearchLink);
      anchor.insertAdjacentElement("afterend", helperWrap);
    }

    if (!anchor.getAttribute("title")) {
      anchor.setAttribute("title", "Click to copy email address");
    }
    anchor.setAttribute(MAILTO_DECORATED_ATTR, "true");
  }

  /**
   * Decorates all mailto anchors in a subtree.
   * Purpose: Ensure initial render and dynamic content share identical mailto UX.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
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
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} value - Raw text containing URL content.
   * @returns {string} Text with normalized CP URL prefix.
   */
  function normalizePeeringDbCpDoubleSlashText(value) {
    return String(value || "").replaceAll(PDB_CP_DOUBLE_SLASH_PREFIX, PDB_CP_SINGLE_SLASH_PREFIX);
  }

  /**
   * Normalizes malformed PeeringDB CP URL prefix in anchor href and text nodes.
   * Purpose: Keep both clickable destination and displayed text consistent.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
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
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
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
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
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
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
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
      regex: /\b((?:member\s+asn|network\s+asn|asn)\s*[:=#-]?\s*)(\d{3,6})\b/gi,
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
      featureFlag: "ipLinkification",
      // IPv4 host address — not a CIDR prefix, not inside an existing link.
      regex: IPV4_TOKEN_REGEX,
      buildNodes([fullMatch]) {
        const anchor = makeIpLink(fullMatch);
        void hydrateIpLinkLabel(anchor, fullMatch);
        return [anchor];
      },
    },
    {
      featureFlag: "ipLinkification",
      // IPv6 address — colon-hex notation, not a CIDR prefix.
      regex: IPV6_TOKEN_REGEX,
      buildNodes([fullMatch]) {
        if (!isLikelyIpv6Address(fullMatch)) return [document.createTextNode(fullMatch)];
        const anchor = makeIpLink(fullMatch);
        void hydrateIpLinkLabel(anchor, fullMatch);
        return [anchor];
      },
    },
  ];

  // Quick pre-test — text nodes matching none of the rules are rejected early.
  const QUICK_TEST_REGEX = /\bASN?\d+\b|\b(?:member\s+asn|network\s+asn|asn)\s*[:=#-]?\s*\d{3,6}\b|provided this ASN in their request:\s*\d+|wishes to be affiliated to Organization\s+['"\u201c\u201d\u2018\u2019][^'"\u201c\u201d\u2018\u2019\n]+['"\u201c\u201d\u2018\u2019]|(?:^|\n)\s*\d{3,6}\s*(?:\n|$)|\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?!\/\d)(?!\.\d)\b|\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?!:)(?!\/\d)\b/i;

  /**
   * Finds standalone 3-6 digit ASN candidates only in high-confidence contexts.
   * Heuristics:
   * - standalone ASN-like line adjacent to both IPv4 and IPv6 mentions
   * - sequence context containing member-removal style fields (speed/policy + IP labels)
   * - line preceded by explicit ASN label
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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

      const ipv4Re = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/;
      const ipv6Re = /\b(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/;
      const hasIpPair = ipv4Re.test(windowText) && ipv6Re.test(windowText);
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
   * Extracts plain email address from a mailto href.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
   * Returns the CP account-email search URL for a specific email value.
   * Purpose: Build stable deep links from DeskPro mailto addresses into CP lookup.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} emailAddress - Email address extracted from mailto href.
   * @returns {string} CP email search URL, or empty string when input is invalid.
   */
  function buildCpEmailSearchUrl(emailAddress) {
    const normalizedEmail = String(emailAddress || "").trim();
    if (!normalizedEmail) return "";
    return `https://www.peeringdb.com/cp/account/emailaddress/?q=${encodeURIComponent(normalizedEmail)}`;
  }

  /**
   * Returns a stable owner id for mailto helper decorations on an anchor.
   * Purpose: Tie sibling helper links to a specific mailto anchor across re-decoration passes.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {HTMLAnchorElement} anchor - Decorated mailto anchor.
   * @returns {string} Stable owner id value.
   */
  function getOrCreateMailtoOwnerId(anchor) {
    const existing = String(anchor?.getAttribute(MAILTO_OWNER_ATTR) || "").trim();
    if (existing) return existing;
    mailtoDecorationCounter += 1;
    const ownerId = `${MODULE_PREFIX}Mailto${mailtoDecorationCounter}`;
    anchor.setAttribute(MAILTO_OWNER_ATTR, ownerId);
    return ownerId;
  }

  /**
   * Copies text to clipboard using modern API with legacy fallback.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
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
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
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
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function linkifyText(text) {
    const hits = [];
    for (const rule of REPLACEMENT_RULES) {
      if (rule.featureFlag && !isFeatureEnabled(rule.featureFlag)) {
        continue;
      }
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
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
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
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
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
  let dpMenuCommandsRegistered = false;
  let mailtoDecorationCounter = 0;

  /**
   * Registers DP Tampermonkey runtime toggles for feature flags.
   * Purpose: Enable rapid runtime experimentation without redeploying.
   * AI Maintenance: Preserve menu command registration behavior.
   */
  function registerDpMenuCommands() {
    if (dpMenuCommandsRegistered) return;
    if (typeof GM_registerMenuCommand !== "function") return;
    dpMenuCommandsRegistered = true;

    let flagShowId = null;
    let flagResetId = null;
    let flagToggleIds = [];

    const registerCommands = () => {
      // Unregister existing commands
      if (typeof GM_unregisterMenuCommand === "function") {
        if (flagShowId != null) GM_unregisterMenuCommand(flagShowId);
        if (flagResetId != null) GM_unregisterMenuCommand(flagResetId);
        flagToggleIds.forEach((id) => id != null && GM_unregisterMenuCommand(id));
      }

      // Show current state
      flagShowId = GM_registerMenuCommand("DP: Feature Flags (show)", () => {
        const snapshot = Object.keys(FEATURE_FLAGS)
          .sort()
          .map((name) => {
            const state = getFeatureFlagState(name);
            return {
              flag: name,
              enabled: state?.enabled,
              default: state?.defaultValue,
              override: state?.overrideValue,
            };
          });
        console.table(snapshot);
      });

      // Reset overrides
      flagResetId = GM_registerMenuCommand("DP: Feature Flags (reset)", () => {
        resetFeatureFlagOverrides();
        console.info("[DP] Feature flags reset.");
        registerCommands();
      });

      // Per-flag toggles
      flagToggleIds = Object.keys(FEATURE_FLAGS)
        .sort()
        .map((name) => {
          const state = getFeatureFlagState(name);
          const label = `DP: ${name} [${state?.enabled ? "ON" : "OFF"}]`;
          return GM_registerMenuCommand(label, () => {
            setFeatureFlagEnabled(name, !state?.enabled);
            console.info(`[DP] ${name} toggled.`);
            registerCommands();
          });
        });
    };

    registerCommands();
  }

  /**
   * Handles MutationObserver events for dynamically loaded DeskPro content.
   * Purpose: Re-apply all normalizers/decorators/linkification to added nodes.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
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
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function init() {
    registerDpMenuCommands();

    // Migrate old cache keys to shared namespace (one-time on first run after upgrade)
    migrateOldCacheKeys();

    // One-time cleanup before any decoration passes so stale duplicate anchors do not
    // participate in re-decoration.
    cleanupLegacyDuplicatePeeringDbAnchors(document.body);

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
