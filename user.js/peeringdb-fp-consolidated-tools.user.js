// ==UserScript==
// @name         PeeringDB FP - Consolidated Tools
// @namespace    https://www.peeringdb.com/
// @version      1.1.20.20260418
// @description  Consolidated FP userscript for PeeringDB frontend (Net/Org/Fac/IX/Carrier)
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/*
// @exclude      https://www.peeringdb.com/cp/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_notification
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-consolidated-tools.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-consolidated-tools.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==

// AI Maintenance Notes (Copilot/Claude):
// - Preserve existing route matching and module boundaries.
// - Prefer minimal, localized edits; avoid broad refactors.
// - Keep grants/connect metadata aligned with actual usage.
// - Preserve shared storage key names and cache namespace compatibility.
// - Validate with syntax checks after edits.
// FP scope:
// - This script owns frontend toolbar and safe read/triage helpers.
// - Do not add RDAP client logic here; RDAP fallback is CP-only.

(function () {
  "use strict";

  const MODULE_PREFIX = "pdbFpConsolidated";
  const SCRIPT_VERSION = "1.1.20.20260418";
  // RDAP fallback client is intentionally CP-only; FP does not implement RDAP lookups.

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
   * Runtime feature flags for FP consolidated behavior.
   *
   * `debugMode`:
   * Enables debug logging gates (`dbg`) when diagnostics localStorage is also enabled.
   *
   * `moduleDispatch`:
   * Master switch for running FP modules in `dispatchModules`.
   * Disable to prevent module execution while keeping the script loaded.
   *
   * `adminOpsMode`:
   * Enables Admin Ops mode pathways guarded by `isAdminOpsModeEnabled()`.
   * Disable to force Admin Ops features off even if storage toggle is set.
   */
  const FEATURE_FLAGS = Object.freeze({
    debugMode: false,
    moduleDispatch: true,
    adminOpsMode: true,
  });

  const DISABLED_MODULES_STORAGE_KEY = `${MODULE_PREFIX}.disabledModules`;
  const ADMIN_OPS_MODE_STORAGE_KEY = `${MODULE_PREFIX}.adminOpsMode`;
  const DEFAULT_REQUEST_USER_AGENT = "PeeringDB-Admincom-FP-Consolidated";
  const OBSERVER_IDLE_DISCONNECT_MS = 2000;
  // How long to wait after the last DOM mutation before re-running init.
  // Gives PeeringDB's framework time to settle before we inject our buttons.
  const INIT_OBSERVER_DEBOUNCE_MS = 500;
  const UI_NEXT_ACTION_ROW_GAP_PX = 8;
  const UI_NEXT_ACTION_COLUMN_GAP_PX = 8;
  const UI_NEXT_ACTION_MARGIN_TOP_PX = 8;

  /**
   * Hard-excluded entity IDs for Example Organization records.
   * Extend by appending IDs to the relevant Set.
   */
  const HARD_EXCLUDED_ENTITY_IDS = {
    net: new Set(["32281", "666", "31754", "29032", "14185", "2858", "24084", "10664"]),
    ix: new Set(["4095"]),
    org: new Set(["25554", "34028", String(DUMMY_ORG_ID), "31503"]),
    fac: new Set(["13346", "13399"]),
    carrier: new Set(["66"]),
    campus: new Set(["25"]),
  };
  const HARD_EXCLUDED_ENTITY_ALIASES = {
    net: "net",
    asn: "net",
    ix: "ix",
    org: "org",
    fac: "fac",
    carrier: "carrier",
    campus: "campus",
  };
  const activeActionLocks = new Set();
  const pendingDomUpdates = new Map();
  const lastFetchFailureByUrl = new Map();
  const openDropdownActionItems = new Set();
  // Registry for document-level delegated click handlers on FP action buttons.
  // Keyed by actionId; values are { onClick, href, target }.
  // Using delegation instead of direct element listeners means handlers survive when
  // PeeringDB's framework replaces the DOM nodes that contain our buttons.
  const fpActionDelegateRegistry = new Map();
  let dropdownGlobalCloseListenerBound = false;
  let isDomUpdateScheduled = false;
  let fetchInstrumentationInstalled = false;
  let selfCheckHasRun = false;

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
   * Sets a feature-flag override and removes redundant entries.
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
  // Mirrored request/session helper block:
  // Keep this section structurally aligned with the CP consolidated script
  // where practical, while preserving FP's tab-scoped session UUID behavior.

  /**
   * Retrieves the set of disabled module IDs from localStorage.
   * Purpose: Allows individual modules to be toggled on/off without code changes.
   * Necessity: Provides user-level module control for the modular architecture.
   * Supports both JSON array and comma-separated formats for backward compatibility.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function getDisabledModules() {
    const raw = String(window.localStorage?.getItem(DISABLED_MODULES_STORAGE_KEY) || "").trim();
    if (!raw) return new Set();

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.map((item) => String(item || "").trim()).filter(Boolean));
      }
    } catch (_error) {
      // fallback to comma-separated format
    }

    return new Set(
      raw
        .split(",")
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    );
  }

  /**
   * Checks if a module is enabled (not in the disabled set).
   * Purpose: Gate-keeper for module execution in dispatchModules().
   * Necessity: Implements selective module control without removing code.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function isModuleEnabled(moduleId, disabledModules) {
    if (!moduleId) return false;
    if (!isFeatureEnabled("moduleDispatch")) return false;
    return !disabledModules.has(moduleId);
  }

  /**
   * Returns true when diagnostics/debug mode is enabled via localStorage.
   * Purpose: Gate verbose console output behind an opt-in flag.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function isDebugEnabled() {
    return isFeatureEnabled("debugMode") && window.localStorage?.getItem(DIAGNOSTICS_STORAGE_KEY) === "1";
  }

  /**
   * Returns true when Admin Ops mode is enabled via localStorage.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function isAdminOpsModeEnabled() {
    if (!isFeatureEnabled("adminOpsMode")) return false;
    return window.localStorage?.getItem(ADMIN_OPS_MODE_STORAGE_KEY) === "1";
  }

  /**
   * Structured debug logger — no-ops unless debug mode is active.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function dbg(tag, msg, ...rest) {
    if (!isDebugEnabled()) return;
    console.debug(`[${MODULE_PREFIX}:${tag}]`, msg, ...rest);
  }

  /**
   * Shows a user-facing notification with a console fallback.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function notifyUser({ title, text, timeout = 2500 }) {
    if (typeof GM_notification === "function") {
      GM_notification({
        title: String(title || "PeeringDB FP"),
        text: String(text || ""),
        timeout,
      });
      return;
    }

    console.info(`[${MODULE_PREFIX}:notify]`, String(title || "PeeringDB FP"), String(text || ""));
  }

  /**
   * Returns storage for domain-scoped persistent values.
   * Purpose: Centralize guarded access to localStorage for shared helper logic.
   * Necessity: Keeps FP storage access patterns aligned with CP helper structure.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   */
  function getDomainCacheStorage() {
    try {
      if (window.localStorage) return window.localStorage;
    } catch (_error) {
      // Ignore; persistent storage may be unavailable.
    }

    return null;
  }

  /**
   * Returns storage for tab-scoped transient values.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * UUID persists across reloads and tabs via shared domain storage.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
      hash = hash & hash;
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
   */
  function isDomainTrusted(domain) {
    if (!domain) return false;
    // Normalize: trim, lowercase, and strip IPv6 URI brackets (e.g., [::1] → ::1)
    let domainText = String(domain).trim().toLowerCase();
    if (domainText.startsWith("[") && domainText.endsWith("]")) {
      domainText = domainText.slice(1, -1);
    }
    if (!domainText) return false;

    for (const pattern of TRUSTED_DOMAINS_FOR_UA) {
      const patternLower = pattern.toLowerCase();
      if (patternLower === domainText) return true;

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
   */
  function buildTrustBasedUserAgent(domain) {
    const isTrusted = isDomainTrusted(domain);
    const sessionUuid = getSessionUuid();

    if (isTrusted) {
      const browserInfo = `${navigator.userAgent.split(" ").slice(-1)[0]} ${navigator.platform}`;
      return `${DEFAULT_REQUEST_USER_AGENT} (${browserInfo} uuid/${sessionUuid})`;
    }

    const fingerprint = computeClientFingerprint();
    return `${DEFAULT_REQUEST_USER_AGENT} (fingerprint/${fingerprint} uuid/${sessionUuid})`;
  }

  /**
   * Retrieves explicit or auto-computed User-Agent for this session.
   * Purpose: Provide flexible UA configuration with fallback to trust-based generation.
   * Necessity: Allows manual override via localStorage while auto-computing from domain trust.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function getCustomRequestUserAgent() {
    const sharedConfigured = String(window.localStorage?.getItem(SHARED_USER_AGENT_STORAGE_KEY) || "").trim();
    if (sharedConfigured) return sharedConfigured;
    return buildTrustBasedUserAgent(window.location.hostname);
  }

  /**
   * Emits current User-Agent details when diagnostics are enabled.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {boolean} True when emitted.
   */
  function logCurrentUserAgentDebug() {
    if (!isDebugEnabled()) return false;

    const sharedConfigured = String(window.localStorage?.getItem(SHARED_USER_AGENT_STORAGE_KEY) || "").trim();
    const host = String(window.location?.hostname || "").trim().toLowerCase();
    const source = sharedConfigured ? "shared" : "auto";
    const payload = {
      source,
      trustedDomain: isDomainTrusted(host),
      host,
      userAgent: getCustomRequestUserAgent(),
    };

    console.info(`[${MODULE_PREFIX}:ua] effective User-Agent`, payload);
    dbg("ua", "effective User-Agent", payload);
    return true;
  }

  /**
   * Emits debug diagnostics for outbound requests.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function logExternalRequestUserAgent(meta) {
    if (!isDebugEnabled()) return;

    const url = String(meta?.url || "").trim();
    if (!url) return;

    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch (_error) {
      return;
    }

    const method = String(meta?.method || "GET").toUpperCase();
    const attempt = Number(meta?.attempt || 1);
    const retries = Number(meta?.retries || 1);
    const mode = String(meta?.mode || "external");
    const userAgent = String(meta?.headers?.["User-Agent"] || "").trim() || "<none>";

    console.info(`[${MODULE_PREFIX}:ua] request`, {
      method,
      url,
      host: hostname,
      mode,
      attempt,
      retries,
      userAgent,
    });
  }

  /**
   * Stores the latest fetch failure details by URL for diagnostics.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function recordFetchFailure(url, details) {
    const key = String(url || "").trim();
    if (!key) return;
    lastFetchFailureByUrl.set(key, {
      ...(details || {}),
      at: new Date().toISOString(),
    });
    dbg("fetch", "failure", key, lastFetchFailureByUrl.get(key));
  }

  /**
   * Clears any stored fetch failure details for URL.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function clearFetchFailure(url) {
    const key = String(url || "").trim();
    if (!key) return;
    lastFetchFailureByUrl.delete(key);
  }

  /**
   * Constructs HTTP headers for Tampermonkey requests with User-Agent.
   * Purpose: Centralize header building for all script-initiated requests.
   * Necessity: Ensures consistent User-Agent and other important headers across all API calls.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
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
   * Installs lightweight fetch instrumentation for debug diagnostics.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function installFetchDiagnostics() {
    if (fetchInstrumentationInstalled || typeof window.fetch !== "function") return;
    fetchInstrumentationInstalled = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] || {};
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      const url = String(input?.url || input || "");

      const normalizedHeaders = {};
      try {
        const sourceHeaders = new Headers(init?.headers || input?.headers || undefined);
        sourceHeaders.forEach((value, key) => {
          normalizedHeaders[key] = value;
        });
      } catch (_error) {
        // Ignore headers extraction failures.
      }

      logExternalRequestUserAgent({
        url,
        method,
        headers: normalizedHeaders,
        mode: "fetch",
      });

      try {
        const response = await originalFetch(...args);
        if (!response.ok) {
          recordFetchFailure(url, {
            reason: "http",
            status: response.status,
            statusText: response.statusText,
            method,
          });
        } else {
          clearFetchFailure(url);
        }
        return response;
      } catch (error) {
        const reason =
          error?.name === "AbortError"
            ? "timeout"
            : error instanceof SyntaxError
              ? "parse"
            : error instanceof TypeError
              ? "error"
              : "exception";

        recordFetchFailure(url, {
          reason,
          message: String(error?.message || "fetch failed"),
          method,
        });
        throw error;
      }
    };
  }

  /**
   * Attempts to acquire a named action lock.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function tryBeginActionLock(lockKey) {
    const normalizedKey = String(lockKey || "").trim();
    if (!normalizedKey || activeActionLocks.has(normalizedKey)) {
      return false;
    }

    activeActionLocks.add(normalizedKey);
    return true;
  }

  /**
   * Releases a previously acquired action lock.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function endActionLock(lockKey) {
    const normalizedKey = String(lockKey || "").trim();
    if (!normalizedKey) return;
    activeActionLocks.delete(normalizedKey);
  }

  /**
   * Runs async action while holding an action lock.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  async function withActionLock(lockKey, fn) {
    if (!tryBeginActionLock(lockKey)) {
      dbg("lock", `action already running: ${lockKey}`);
      return false;
    }

    try {
      await fn();
      return true;
    } finally {
      endActionLock(lockKey);
    }
  }

  /**
   * Schedules keyed DOM updates and coalesces multiple writes into one frame.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function scheduleDomUpdate(key, fn) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || typeof fn !== "function") return;

    pendingDomUpdates.set(normalizedKey, fn);
    if (isDomUpdateScheduled) return;

    isDomUpdateScheduled = true;
    requestAnimationFrame(() => {
      isDomUpdateScheduled = false;
      const updates = Array.from(pendingDomUpdates.values());
      pendingDomUpdates.clear();

      updates.forEach((updateFn) => {
        try {
          updateFn();
        } catch (error) {
          console.warn(`[${MODULE_PREFIX}] scheduled DOM update failed`, error);
        }
      });
    });
  }

  /**
   * Parses the current URL to extract route context (entity type, ID, page kind).
   * Purpose: Provide route info to modules for conditional execution.
   * Necessity: Enables modules to match specific pages (e.g., /net/1234) and determine
   * whether to run. Used by all modules' match() function.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function getRouteContext() {
    const path = window.location.pathname;
    // Split and filter empty strings to handle leading/trailing slashes robustly
    const parts = path.split("/").filter((p) => p.length > 0);
    const type = parts[0] || "";
    const id = parts[1] || "";
    const isCpEntityChangePage =
      parts[0] === "cp" &&
      parts[1] === "peeringdb_server" &&
      /^\d+$/.test(parts[3] || "") &&
      parts[4] === "change";

    return {
      path,
      parts,
      type, // e.g., 'net', 'org', 'fac'
      id, // e.g., '1234'
      isEntityPage: parts.length >= 2 && /^\d+$/.test(id),
      isCpEntityChangePage,
      cpEntity: isCpEntityChangePage ? parts[2] || "" : "",
      cpEntityId: isCpEntityChangePage ? parts[3] || "" : "",
    };
  }

  /**
   * Convenience wrapper for querySelector.
   * Purpose: Reduce boilerplate for DOM querying throughout the script.
   * Necessity: Used extensively for finding form fields and toolbar elements.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function qs(selector, root = document) {
    if (!root || typeof root.querySelector !== "function") {
      return null;
    }

    return root.querySelector(selector);
  }

  /**
   * Convenience wrapper for querySelectorAll returning an array.
   * Purpose: Reduce repeated Array.from(querySelectorAll(...)) patterns in FP modules.
   * Necessity: Keeps small DOM iteration helpers aligned with CP utility parity.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function qsa(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  /**
   * Retrieves trimmed innerText from a selected element.
   * Purpose: Safe extraction of display text for form fields and data fields.
   * Necessity: Provides consistent empty-string fallback vs. throwing on missing elements.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getText(selector, root = document) {
    const el = qs(selector, root);
    return el ? el.innerText.trim() : "";
  }

  /**
   * Retrieves trimmed value from form input elements (input, select, textarea).
   * Purpose: Unified value extraction that handles both .value property and data attributes.
   * Necessity: Normalizes form field reading across different input types.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getInputValue(selector, root = document) {
    const el = qs(selector, root);
    if (!el) return "";

    if ("value" in el) {
      return String(el.value || "").trim();
    }

    return String(el.getAttribute("value") || "").trim();
  }

  /**
   * Reads a normalized value from a data-edit field in the current page.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getDataEditValue(name, root = document) {
    const el = qs(`[data-edit-name="${name}"]`, root);
    if (!el) return "";
    return String(el.getAttribute("data-edit-value") || el.textContent || "").trim();
  }

  /**
   * Parses a value into a finite number, returning null when invalid.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function toNumeric(value) {
    const n = Number(String(value || "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Resolves current entity type/id from route context, with ASN->network fallback.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getCurrentEntityTypeAndId(ctx = null) {
    const route = ctx || getRouteContext();
    if (!route?.isEntityPage) return { type: "", id: "" };

    let type = String(route.type || "").trim().toLowerCase();
    let id = String(route.id || "").trim();

    if (type === "asn") {
      type = "net";
      id = String(getDataEditValue("net_id") || id).trim();
    }

    return { type, id };
  }

  /**
   * Normalizes frontend route entity aliases to canonical hard-exclude keys.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   */
  function normalizeEntityTypeForHardExclude(type) {
    const normalized = String(type || "").trim().toLowerCase();
    return HARD_EXCLUDED_ENTITY_ALIASES[normalized] || "";
  }

  /**
   * Returns hard-exclusion metadata for the current entity, or null.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getHardExcludedEntityInfo(ctx = null) {
    const { type, id } = getCurrentEntityTypeAndId(ctx);
    if (!type || !id) return null;

    const canonicalType = normalizeEntityTypeForHardExclude(type);
    if (!canonicalType) return null;

    const excludedIds = HARD_EXCLUDED_ENTITY_IDS[canonicalType];
    if (!excludedIds || !excludedIds.has(String(id).trim())) return null;

    return { type: canonicalType, id: String(id).trim() };
  }

  /**
   * Attempts to resolve the parent organization ID from route, fields, or links.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getParentOrgId(ctx = null) {
    const route = ctx || getRouteContext();
    const { type, id } = getCurrentEntityTypeAndId(route);

    if (type === "org" && id) return id;

    const direct =
      getDataEditValue("org_id") ||
      getDataEditValue("org") ||
      getInputValue("#id_org") ||
      getInputValue("#id_org_id");
    if (/^\d+$/.test(String(direct || "").trim())) {
      return String(direct).trim();
    }

    const orgLink = qs('a[href*="/org/"]');
    const linkMatch = String(orgLink?.getAttribute("href") || "").match(/\/org\/(\d+)/);
    if (linkMatch?.[1]) return linkMatch[1];

    const canonical = qs('link[rel="canonical"]')?.getAttribute("href") || "";
    const canonicalMatch = String(canonical).match(/\/org\/(\d+)/);
    return canonicalMatch?.[1] || "";
  }

  /**
   * Builds the API URL for the current entity context.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function getCurrentEntityApiUrl(ctx = null) {
    const { type, id } = getCurrentEntityTypeAndId(ctx);
    if (!type || !id) return "";
    return `${window.location.origin}/api/${type}/${id}`;
  }

  /**
   * Maps frontend entity slugs to CP model names.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getCpEntityNameByType(type) {
    const map = {
      org: "organization",
      net: "network",
      fac: "facility",
      ix: "internetexchange",
      carrier: "carrier",
    };
    return map[String(type || "").trim().toLowerCase()] || "";
  }

  /**
   * Builds a CP organization change-page URL from org ID.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function buildCpOrgChangeUrl(orgId) {
    if (!/^\d+$/.test(String(orgId || "").trim())) return "";
    return `https://www.peeringdb.com/cp/peeringdb_server/organization/${String(orgId).trim()}/change/`;
  }

  /**
   * Builds a CP organization user-manager anchor URL from org ID.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function buildCpUserManagerUrl(orgId) {
    const base = buildCpOrgChangeUrl(orgId);
    if (!base) return "";
    return `${base}#org-user-manager`;
  }

  /**
   * Builds a CP list-search URL for an entity type and identifier.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function buildCpEntitySearchUrl(type, id) {
    const cpName = getCpEntityNameByType(type);
    const normalizedId = String(id || "").trim();
    if (!cpName || !normalizedId) return "";
    return `https://www.peeringdb.com/cp/peeringdb_server/${cpName}/?q=${encodeURIComponent(normalizedId)}`;
  }

  /**
   * Builds a CP network search URL from an ASN value.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function buildCpNetworkSearchUrlByAsn(asn) {
    const normalizedAsn = String(asn || "").replace(/\D/g, "");
    if (!normalizedAsn) return "";
    return `https://www.peeringdb.com/cp/peeringdb_server/network/?q=${encodeURIComponent(normalizedAsn)}`;
  }

  /**
   * Returns true when current page appears to be a frontend 404 document.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function isFrontendNotFoundPage() {
    const title = String(document.title || "").toLowerCase();
    if (title.includes("404") || title.includes("not found")) return true;

    const headingTexts = qsa("h1, h2").map((el) => String(el.textContent || "").trim().toLowerCase());
    if (headingTexts.some((text) => text.includes("404") && text.includes("not found"))) return true;

    const bodyText = String(document.body?.innerText || "").toLowerCase();
    return bodyText.includes("404 - not found") || bodyText.includes("page you requested does not exist");
  }

  /**
   * Builds a CP account email-address search URL.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function buildCpAccountSearchUrl(query) {
    const q = String(query || "").trim();
    if (!q) return "";
    return `https://www.peeringdb.com/cp/account/emailaddress/?q=${encodeURIComponent(q)}`;
  }

  /**
   * Returns the best-effort current entity name from rendered/editable fields.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getCurrentEntityName() {
    return (
      getDataEditValue("name") ||
      getText('.view_title > div[data-edit-name="name"]') ||
      getInputValue("#id_name")
    );
  }

  /**
   * Extracts the current ASN as digits only.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getCurrentAsn() {
    const raw = getDataEditValue("asn") || getText('div[data-edit-name="asn"]') || getInputValue("#id_asn");
    const digits = String(raw || "").replace(/\D/g, "");
    return digits || "";
  }

  /**
   * Collects visible usernames, emails, and email domains from org user manager rows.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getVisibleUserIdentityData() {
    const rows = qsa('#org-user-manager > div[data-edit-template="user-item"] > .editable');
    const usernames = [];
    const emails = [];

    rows.forEach((item) => {
      const usernameRow = item.querySelector(".item > div:nth-child(1) > div:nth-child(2)");
      const username = Array.from(usernameRow?.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => String(node.textContent || ""))
        .join(" ")
        .trim();
      if (username) usernames.push(username);

      const emailCell = item.querySelector(".item > div:nth-child(2)");
      const emailText = String(emailCell?.textContent || "");
      const match = emailText.match(/[A-Z0-9._+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (match?.[0]) emails.push(match[0].trim());
    });

    const domains = emails
      .map((email) => String(email.split("@")[1] || "").toLowerCase())
      .filter(Boolean);

    return { usernames, emails, domains };
  }

  /**
   * Collects related object IDs from visible API listing sections on the page.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function getRelatedObjectIds() {
    const result = {
      netixlanIds: [],
      netfacIds: [],
      pocIds: [],
    };

    qsa('#api-listing-netixlan .item[data-edit-id], #api-listing-netixlan .row.item[data-edit-id]')
      .forEach((el) => {
        const id = String(el.getAttribute("data-edit-id") || "").trim();
        if (/^\d+$/.test(id)) result.netixlanIds.push(id);
      });

    qsa('#api-listing-netfac .item[data-edit-id], #api-listing-netfac .row.item[data-edit-id]')
      .forEach((el) => {
        const id = String(el.getAttribute("data-edit-id") || "").trim();
        if (/^\d+$/.test(id)) result.netfacIds.push(id);
      });

    qsa('#api-listing-poc .item[data-edit-id], #api-listing-poc .row[data-edit-id]')
      .forEach((el) => {
        const id = String(el.getAttribute("data-edit-id") || "").trim();
        if (/^\d+$/.test(id)) result.pocIds.push(id);
      });

    return result;
  }

  /**
   * Formats a compact semicolon-separated summary of key entity identifiers.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   */
  function formatEntityIdsBundle(ctx = null) {
    const route = ctx || getRouteContext();
    const { type, id } = getCurrentEntityTypeAndId(route);
    const orgId = getParentOrgId(route);
    const asn = getCurrentAsn();
    const related = getRelatedObjectIds();

    return [
      `type=${type || "n/a"}`,
      `id=${id || "n/a"}`,
      `org_id=${orgId || "n/a"}`,
      `asn=${asn || "n/a"}`,
      `netixlan_count=${related.netixlanIds.length}`,
      `netfac_count=${related.netfacIds.length}`,
      `poc_count=${related.pocIds.length}`,
      `url=${window.location.href}`,
    ].join("; ");
  }

  /**
   * Formats a multiline triage summary for quick admin review/copy workflows.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   */
  function formatAdminTriageSummary(ctx = null) {
    const route = ctx || getRouteContext();
    const { type, id } = getCurrentEntityTypeAndId(route);
    const name = getCurrentEntityName() || "n/a";
    const orgId = getParentOrgId(route) || "n/a";
    const asn = getCurrentAsn() || "n/a";
    const website = getDataEditValue("website") || getInputValue("#id_website") || "n/a";
    const irrAsSet = getDataEditValue("irr_as_set") || getInputValue("#id_irr_as_set") || "n/a";
    const traffic = getDataEditValue("info_traffic") || "n/a";

    return [
      `Entity: ${String(type || "n/a").toUpperCase()} #${id || "n/a"}`,
      `Name: ${name}`,
      `Org ID: ${orgId}`,
      `ASN: ${asn}`,
      `Website: ${website}`,
      `IRR AS-SET: ${irrAsSet}`,
      `Traffic: ${traffic}`,
      `Source: ${window.location.href}`,
    ].join("\n");
  }

  /**
   * Collects unique external links from known fields and visible anchor tags.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function collectExternalLinks() {
    const links = new Set();
    const candidateFields = ["website", "url"];

    candidateFields.forEach((name) => {
      const v = getDataEditValue(name) || getInputValue(`#id_${name}`);
      if (/^https?:\/\//i.test(v)) links.add(v);
    });

    qsa('a[href^="http://"], a[href^="https://"]').forEach((a) => {
      const href = String(a.getAttribute("href") || "").trim();
      if (/^https?:\/\//i.test(href)) links.add(href);
    });

    return Array.from(links).slice(0, 12);
  }

  /**
   * Opens validated URLs in new tabs, prompting confirmation for large batches.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function openUrlsWithConfirm(urls, threshold = 3) {
    const valid = Array.from(new Set((urls || []).map((u) => String(u || "").trim()).filter(Boolean)));
    if (!valid.length) return 0;

    if (valid.length > threshold) {
      const ok = window.confirm(`Open ${valid.length} tabs?`);
      if (!ok) return 0;
    }

    valid.forEach((url) => {
      window.open(url, "_blank", "noopener");
    });
    return valid.length;
  }

  /**
   * Copies text to clipboard with modern and fallback implementations.
   * Purpose: Enable "Copy URL" and similar copy actions for user convenience.
   * Necessity: Handles browsers with and without Clipboard API support.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  async function copyToClipboard(text) {
    const normalizedText = String(text ?? "");

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(normalizedText);
        return true;
      } catch (err) {
        console.error("Async: Could not copy text:", err);
      }
    }

    const textArea = document.createElement("textarea");
    textArea.value = normalizedText;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const copied = document.execCommand("copy");
      if (!copied) {
        console.error("Fallback: Copy command returned false");
      }
      return copied;
    } catch (err) {
      console.error("Fallback: Oops, unable to copy", err);
      return false;
    } finally {
      document.body.removeChild(textArea);
    }
  }

  /**
   * Retrieves the container element for top-right toolbar buttons.
   * Purpose: Centralize toolbar element selection with fallback selectors.
   * Necessity: Top-right button area varies in PeeringDB pages; needs fallback chain.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function getTopRightToolbarContainer(parentSelector = "div.right.button-bar > div:first-child") {
    return qs(parentSelector);
  }

  /**
   * Installs a single capture-phase click delegation listener on document for FP action buttons.
   * Purpose: Ensure action handlers work even when PeeringDB's framework replaces button DOM nodes.
   * Necessity: Direct addEventListener on <a> elements is lost when a framework reconciler
   * replaces vnode. Capture-phase delegation on document runs before framework bubble handlers,
   * so stopPropagation can prevent PeeringDB from intercepting our button clicks.
   * Guard: installed at most once per page lifetime via _pdbFpDelegationInstalled.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function ensureFpClickDelegation() {
    if (document._pdbFpDelegationInstalled) return;
    document._pdbFpDelegationInstalled = true;

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pdb-fp-action]");
      if (!btn) return;

      const actionId = btn.getAttribute("data-pdb-fp-action");
      if (!actionId) return;

      const action = fpActionDelegateRegistry.get(actionId);
      if (!action) return; // Not one of our registered actions; let it propagate normally.

      e.preventDefault();
      e.stopPropagation();

      if (typeof action.onClick === "function") {
        action.onClick(e);
      } else if (action.href && action.href !== "#") {
        const tgt = action.target || "_blank";
        if (tgt === "_self") {
          window.location.href = action.href;
        } else {
          window.open(action.href, tgt, "noopener");
        }
      }
    }, true /* capture phase */);
  }

  /**
   * Creates and appends an action button to the top-right toolbar.
   * Purpose: Standardized way to add custom links (Admin Console, BGP tools, etc.) to FP pages.
   * Necessity: Ensures consistent styling, idempotency (prevents duplicates), and event handling.
   * Marks buttons with data-pdb-fp-action attribute for later reordering and identification.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function createTopRightAction({
    actionId,
    label,
    href = "#",
    onClick,
    target = null,
    parentSelector = "div.right.button-bar > div:first-child",
  }) {
    if (!actionId) return null;

    const parent = getTopRightToolbarContainer(parentSelector);
    if (!parent) return null;

    const existing = qs(`a[data-pdb-fp-action="${actionId}"]`, parent);
    if (existing) {
      return existing;
    }

    const btn = document.createElement("a");
    btn.className = isUiNextPage() ? "btn btn-default" : "btn btn-primary";
    btn.style.cursor = "pointer";
    btn.style.display = "inline-block";
    btn.style.width = "auto";
    btn.style.maxWidth = "none";
    btn.style.whiteSpace = "nowrap";
    btn.style.flex = "0 0 auto";
    btn.innerText = label;
    btn.href = href;
    btn.setAttribute("data-pdb-fp-action", actionId);

    if (target) {
      btn.target = target;
    }

    if (typeof onClick === "function") {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        onClick(e);
      });
    } else if (target && href && href !== "#") {
      // UI-next may attach handlers to toolbar anchors; force explicit navigation for reliability.
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (target === "_self") {
          window.location.href = href;
          return;
        }
        window.open(href, target, "noopener");
      });
    }

    // Also register in the delegation registry so the handler survives DOM replacement.
    // ensureFpClickDelegation() installs a capture-phase listener on document that dispatches
    // based on data-pdb-fp-action, providing a resilient fallback independent of element lifetime.
    fpActionDelegateRegistry.set(actionId, { onClick, href, target });
    ensureFpClickDelegation();

    parent.appendChild(btn);
    return btn;
  }

  /**
   * Closes a single FP dropdown wrapper and resets toggle accessibility state.
   * Purpose: Centralize close behavior for toolbar overflow menus.
   * Necessity: Shared close logic prevents duplicated per-menu dismissal handling.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function closeDropdownActionItem(wrapper) {
    if (!wrapper) return;

    const toggle = qs(':scope > a.btn', wrapper);
    const menu = qs(':scope > div', wrapper);

    if (menu) {
      menu.style.display = "none";
    }

    if (toggle) {
      toggle.setAttribute("aria-expanded", "false");
    }

    wrapper.removeAttribute("data-open");
    wrapper.style.zIndex = "";
    openDropdownActionItems.delete(wrapper);
  }

  /**
   * Closes all open FP dropdown wrappers except an optional exempt wrapper.
   * Purpose: Enforce single-open-dropdown behavior for FP toolbar overflow menus.
   * Necessity: Keeps UI state predictable when multiple dropdown-capable actions exist.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function closeAllDropdownActionItems(exemptWrapper = null) {
    Array.from(openDropdownActionItems).forEach((wrapper) => {
      if (exemptWrapper && wrapper === exemptWrapper) return;
      closeDropdownActionItem(wrapper);
    });
  }

  /**
   * Registers one shared listener pair for FP dropdown close behavior.
   * Purpose: Replace per-menu document listeners with one shared close mechanism.
   * Necessity: Reduces global listener duplication and supports Escape-to-close.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function ensureDropdownGlobalCloseListener() {
    if (dropdownGlobalCloseListenerBound) return;
    dropdownGlobalCloseListenerBound = true;

    document.addEventListener("click", (event) => {
      const target = event?.target;
      const activeItems = Array.from(openDropdownActionItems);
      if (!activeItems.length) return;

      const clickedInsideAnyOpenItem = activeItems.some((wrapper) => wrapper.contains(target));
      if (!clickedInsideAnyOpenItem) {
        closeAllDropdownActionItems();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeAllDropdownActionItems();
    });
  }

  /**
   * Creates an overflow dropdown menu in the top-right toolbar.
   * Purpose: Provide a compact menu for multiple related tools (RIPEstat, BGPView, CIDR Report, etc.).
   * Necessity: Prevents toolbar overcrowding by grouping secondary network analysis tools.
   * Manages menu open/close state and click-outside dismissal.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function createTopRightOverflowMenu({
    actionId,
    label,
    items,
    parentSelector = "div.right.button-bar > div:first-child",
  }) {
    if (!actionId || !Array.isArray(items) || items.length === 0) return null;
    ensureDropdownGlobalCloseListener();

    const parent = getTopRightToolbarContainer(parentSelector);
    if (!parent) return null;

    const existing = qs(`span[data-pdb-fp-action="${actionId}"]`, parent);
    if (existing) {
      return existing;
    }

    const wrapper = document.createElement("span");
    wrapper.setAttribute("data-pdb-fp-action", actionId);
    wrapper.style.display = "inline-block";
    wrapper.style.position = "relative";
    wrapper.style.flex = "0 0 auto";

    const toggle = document.createElement("a");
    toggle.className = isUiNextPage() ? "btn btn-default" : "btn btn-primary";
    toggle.href = "#";
    toggle.textContent = label;
    toggle.style.cursor = "pointer";
    toggle.style.display = "inline-block";
    toggle.style.width = "auto";
    toggle.style.maxWidth = "none";
    toggle.style.whiteSpace = "nowrap";
    toggle.style.flex = "0 0 auto";
    toggle.style.userSelect = "none";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-haspopup", "true");

    const menu = document.createElement("div");
    menu.style.position = "absolute";
    menu.style.right = "0";
    menu.style.top = "calc(100% + 6px)";
    menu.style.display = "grid";
    menu.style.gap = "4px";
    menu.style.padding = "6px";
    menu.style.background = "rgba(255, 255, 255, 0.98)";
    menu.style.border = "1px solid rgba(0, 0, 0, 0.12)";
    menu.style.borderRadius = "6px";
    menu.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.15)";
    menu.style.zIndex = "1000";
    menu.style.display = "none";

    items.forEach((item) => {
      const link = document.createElement("a");
      link.className = isUiNextPage() ? "btn btn-default" : "btn btn-primary";
      const isCallbackItem = typeof item?.onClick === "function";
      const itemUrl = String(item?.url || "").trim();
      const itemTarget = String(item?.target || "_blank");

      link.href = isCallbackItem ? "#" : (itemUrl || "#");
      if (!isCallbackItem && itemUrl) {
        link.target = itemTarget;
      }
      link.rel = "noopener noreferrer";
      link.textContent = String(item?.label || "Action");
      if (item?.title) {
        link.title = String(item.title);
        link.setAttribute("aria-label", String(item.title));
      }
      link.style.whiteSpace = "nowrap";
      link.style.display = "block";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        closeDropdownActionItem(wrapper);

        if (isCallbackItem) {
          try {
            item.onClick(event);
          } catch (error) {
            console.warn(`[${MODULE_PREFIX}] overflow action failed`, { actionId, label: item?.label, error });
          }
          return;
        }

        if (itemUrl) {
          if (itemTarget === "_self") {
            window.location.href = itemUrl;
            return;
          }
          window.open(itemUrl, itemTarget, "noopener");
        }
      });
      menu.appendChild(link);
    });

    wrapper.appendChild(toggle);
    wrapper.appendChild(menu);
    parent.appendChild(wrapper);

    /**
     * Closes the currently open overflow menu wrapper.
     * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
     */
    const closeMenu = () => {
      closeDropdownActionItem(wrapper);
    };

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = wrapper.getAttribute("data-open") === "1";
      if (isOpen) {
        closeMenu();
      } else {
        closeAllDropdownActionItems(wrapper);
        menu.style.display = "grid";
        toggle.setAttribute("aria-expanded", "true");
        wrapper.setAttribute("data-open", "1");
        wrapper.style.zIndex = "1001";
        openDropdownActionItems.add(wrapper);
      }
    });

    menu.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    return wrapper;
  }

  /**
   * Tests if a DOM element matches a given priority (CSS selector or function).
   * Purpose: Support flexible matching in reorderChildrenByPriority (handles strings and predicates).
   * Necessity: Enables both CSS-based matching and custom function-based matching in one API.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function isPriorityMatch(child, priority) {
    if (!child || !priority) return false;

    if (typeof priority === "function") {
      return Boolean(priority(child));
    }

    if (typeof priority !== "string") {
      return false;
    }

    try {
      return child.matches(priority);
    } catch (_error) {
      return false;
    }
  }

  /**
   * Reorders children of a container according to priority list.
   * Purpose: Establish deterministic button order (Admin Console before BGP tools, etc.).
   * Necessity: Ensures consistent UI layout across page variations and module load orders.
   * Unmatched children stay in original order at the end.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function reorderChildrenByPriority(container, priorities) {
    if (!container || !Array.isArray(priorities) || priorities.length === 0) return;

    const currentChildren = Array.from(container.children);
    if (!currentChildren.length) return;

    const used = new Set();
    const ordered = [];

    for (const priority of priorities) {
      const match = currentChildren.find((child) => !used.has(child) && isPriorityMatch(child, priority));
      if (!match) continue;
      ordered.push(match);
      used.add(match);
    }

    currentChildren.forEach((child) => {
      if (!used.has(child)) ordered.push(child);
    });

    ordered.forEach((child) => container.appendChild(child));
  }

  /**
   * Identifies if a child element is PeeringDB's native Edit toggle button.
   * Purpose: Distinguish PeeringDB native structure from custom FP buttons.
   * Necessity: Route native Edit button to separate row position per PeeringDB layout conventions.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function isNativeEditToolbarButton(child) {
    if (!child) return false;

    // Never treat FP helper layout containers as the native Edit button target.
    if (
      child.matches?.('div[data-pdb-fp-action-rows], div[data-pdb-fp-action-row], div[data-pdb-fp-row]')
    ) {
      return false;
    }

    if (child.querySelector?.(':scope > div[data-pdb-fp-action-row], :scope > div[data-pdb-fp-row]')) {
      return false;
    }

    if (child.matches?.('a[data-edit-action="toggle-edit"]')) {
      return true;
    }

    return Boolean(qs('a[data-edit-action="toggle-edit"]', child));
  }

  /**
   * Applies flex layout to toolbar container for two-row button arrangement.
   * Purpose: Enable column-based layout with right alignment and gap spacing.
   * Necessity: Foundation for enforceTopRightButtonOrder two-row structure.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function applyTopRightToolbarFlexLayout(parent) {
    if (!parent) return;

    // Two-row layout host: rows are right-aligned and vertically spaced.
    parent.style.display = "flex";
    parent.style.flexDirection = "column";
    parent.style.alignItems = "flex-end";
    parent.style.rowGap = "6px";
  }

  /**
   * Ensures a named row container exists in the toolbar.
   * Purpose: Create or reuse row div with data-pdb-fp-row attribute for button grouping.
   * Necessity: Routes buttons to two distinct visual rows (Edit/Admin/Copy-URL, then BGP tools).
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function ensureTopRightRowContainer(parent, rowName) {
    if (!parent || !rowName) return null;

    let row = qs(`:scope > div[data-pdb-fp-row="${rowName}"]`, parent);
    if (row) return row;

    row = document.createElement("div");
    row.setAttribute("data-pdb-fp-row", rowName);
    row.style.display = "flex";
    row.style.flexWrap = "nowrap";
    row.style.justifyContent = "flex-end";
    row.style.alignItems = "flex-start";
    row.style.columnGap = "6px";
    row.style.maxWidth = "100%";

    parent.appendChild(row);
    return row;
  }

  /**
   * Routes all toolbar buttons to two predetermined rows.
   * Purpose: Implement the two-row layout convention (primary actions row 1, analysis tools row 2).
   * Necessity: Creates visual hierarchy and improves mobile UX by grouping related actions.
   * Hides empty rows to maintain clean toolbar appearance.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function routeTopRightButtonsToTwoRows(parent) {
    if (!parent) return;

    const row1 = ensureTopRightRowContainer(parent, "1");
    const row2 = ensureTopRightRowContainer(parent, "2");
    if (!row1 || !row2) return;

    const editButton = Array.from(parent.children).find((child) => isNativeEditToolbarButton(child));
    const adminButton = qs('a[data-pdb-fp-action="admin-console"]', parent);
    const openApiButton = qs('a[data-pdb-fp-action="open-api-json"]', parent);
    const copyUrlButton = qs('a[data-pdb-fp-action="copy-url"]', parent);
    const copyAsnButton = qs('a[data-pdb-fp-action="copy-asn"]', parent);
    const copyNetSummaryButton = qs('a[data-pdb-fp-action="copy-net-summary"]', parent);
    const adminWorkflowButton = qs('[data-pdb-fp-action="admin-workflow-overflow"]', parent);
    const moreToolsButton = qs('[data-pdb-fp-action="network-tools-overflow"]', parent);

    // Route deterministic first-row actions.
    [editButton, adminButton, openApiButton, copyUrlButton].forEach((item) => {
      if (item) row1.appendChild(item);
    });

    // Route deterministic second-row actions.
    [copyAsnButton, copyNetSummaryButton, adminWorkflowButton, moreToolsButton].forEach((item) => {
      if (item) row2.appendChild(item);
    });

    // Keep row visibility clean when optional buttons are absent.
    row1.style.display = row1.children.length > 0 ? "flex" : "none";
    row2.style.display = row2.children.length > 0 ? "flex" : "none";
  }

  /**
   * Ensures helper row containers exist for FP action buttons on UI-next pages.
   * Purpose: Keep FP-injected actions visually spaced/aligned without mutating native controls.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function ensureUiNextActionRows(parent) {
    if (!parent) return { host: null, row1: null, row2: null };

    let host = qs(':scope > div[data-pdb-fp-action-rows="1"]', parent);
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-pdb-fp-action-rows", "1");
      host.style.display = "flex";
      host.style.flexDirection = "column";
      host.style.alignItems = "flex-end";
      host.style.rowGap = `${UI_NEXT_ACTION_ROW_GAP_PX}px`;
      host.style.width = "auto";
      host.style.maxWidth = "100%";
      host.style.marginTop = `${UI_NEXT_ACTION_MARGIN_TOP_PX}px`;
      parent.appendChild(host);
    }

    /**
     * Ensures a named UI-next helper row exists under the FP action host.
     * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
     */
    const ensureRow = (rowName) => {
      let row = qs(`:scope > div[data-pdb-fp-action-row="${rowName}"]`, host);
      if (row) return row;

      row = document.createElement("div");
      row.setAttribute("data-pdb-fp-action-row", rowName);
      row.style.display = "flex";
      row.style.flexWrap = "nowrap";
      row.style.justifyContent = "flex-end";
      row.style.alignItems = "flex-start";
      row.style.columnGap = `${UI_NEXT_ACTION_COLUMN_GAP_PX}px`;
      row.style.maxWidth = "100%";
      host.appendChild(row);
      return row;
    };

    return {
      host,
      row1: ensureRow("1"),
      row2: ensureRow("2"),
    };
  }

  /**
   * Routes only FP action buttons into two helper rows on UI-next pages.
   * Purpose: Restore visual spacing while leaving native Edit/theme controls untouched.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function routeUiNextFpActionsToTwoRows(parent) {
    if (!parent) return;

    const { host, row1, row2 } = ensureUiNextActionRows(parent);
    if (!host || !row1 || !row2) return;

    /**
     * Resolves the native edit control while tolerating host DOM reordering.
     * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
     */
    const findNativeEditButton = () => {
      const directChildren = Array.from(parent.children);
      const directMatch = directChildren.find((child) => isNativeEditToolbarButton(child));
      if (directMatch) return directMatch;

      const rowChildren = Array.from(host.querySelectorAll(':scope > div[data-pdb-fp-action-row] > *'));
      return rowChildren.find((child) => isNativeEditToolbarButton(child)) || null;
    };

    const editButton = findNativeEditButton();
    const adminButton = qs('a[data-pdb-fp-action="admin-console"]', parent);
    const openApiButton = qs('a[data-pdb-fp-action="open-api-json"]', parent);
    const copyUrlButton = qs('a[data-pdb-fp-action="copy-url"]', parent);
    const copyAsnButton = qs('a[data-pdb-fp-action="copy-asn"]', parent);
    const copyNetSummaryButton = qs('a[data-pdb-fp-action="copy-net-summary"]', parent);
    const adminWorkflowButton = qs('[data-pdb-fp-action="admin-workflow-overflow"]', parent);
    const moreToolsButton = qs('[data-pdb-fp-action="network-tools-overflow"]', parent);

    [editButton, adminButton, openApiButton, copyUrlButton].forEach((item) => {
      if (item) row1.appendChild(item);
    });

    [copyAsnButton, copyNetSummaryButton, adminWorkflowButton, moreToolsButton].forEach((item) => {
      if (item) row2.appendChild(item);
    });

    row1.style.display = row1.children.length > 0 ? "flex" : "none";
    row2.style.display = row2.children.length > 0 ? "flex" : "none";
    host.style.display = row1.children.length || row2.children.length ? "flex" : "none";
  }

  /**
   * Groups custom toolbar items by vertical pixel position (visual rows).
   * Purpose: Detect which buttons wrap to new lines due to narrow viewports.
   * Necessity: Understand natural wrapping behavior for spacing adjustments.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function groupCustomItemsByVisualRow(customItems, topTolerance = 3) {
    const rows = [];

    customItems.forEach((item) => {
      const top = item.offsetTop;
      let row = rows.find((entry) => Math.abs(entry.top - top) <= topTolerance);

      if (!row) {
        row = { top, items: [] };
        rows.push(row);
      }

      row.items.push(item);
      row.top = Math.min(row.top, top);
    });

    rows.sort((a, b) => a.top - b.top);
    rows.forEach((row) => {
      row.items.sort((a, b) => a.offsetLeft - b.offsetLeft);
    });

    return rows;
  }

  /**
   * Removes individual button margins to rely on container gap for spacing.
   * Purpose: Standardize spacing through flexbox gap instead of element margins.
   * Necessity: Prevents double-spacing and inconsistent gaps from mixed margin/gap sources.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function applyTopRightCustomSpacing(parent) {
    if (!parent) return;

    const customItems = Array.from(
      parent.querySelectorAll('a[data-pdb-fp-action], details[data-pdb-fp-action], span[data-pdb-fp-action]')
    );
    if (customItems.length === 0) return;

    // Reset per-item margins so container gap is the only spacing source.
    customItems.forEach((item) => {
      item.style.marginLeft = "0";
      item.style.marginTop = "0";
    });
  }

  /**
   * Clears top margins on wrapped toolbar items.
   * Purpose: Clean spacing when buttons wrap to multiple rows.
   * Necessity: Prevents excessive vertical gaps when items wrap at narrow viewports.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function applyTopRightWrappedRowOffset(parent) {
    if (!parent) return;

    const customItems = Array.from(
      parent.querySelectorAll('a[data-pdb-fp-action], details[data-pdb-fp-action], span[data-pdb-fp-action]')
    );
    if (customItems.length === 0) return;

    // Vertical spacing is now handled by parent rowGap.
    customItems.forEach((item) => {
      item.style.marginTop = "0";
    });
  }

  /**
   * Returns true when PeeringDB UI-next markup is active.
   * Purpose: Keep FP layout code from fighting native UI-next button logic.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function isUiNextPage() {
    const theme = String(document.documentElement?.getAttribute("data-theme") || "").toLowerCase();
    if (theme.includes("ui-next")) return true;

    const header = qs("#header");
    return String(header?.getAttribute("data-ui-next") || "").toLowerCase() === "true";
  }

  /**
   * Adds a minimal fallback .wrapper node on net pages when UI-next markup omits it.
   * Purpose: Prevent host inline reAdjust() from crashing on $('.wrapper')[0].scrollWidth.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function ensureNetPageWrapperFallback() {
    if (!/^\/net\/\d+/.test(window.location.pathname)) return;
    if (document.querySelector(".wrapper")) return;

    const fallback = document.createElement("div");
    fallback.className = "wrapper";
    fallback.setAttribute("data-pdb-fp-wrapper-fallback", "1");
    fallback.style.display = "none";
    fallback.style.width = "0";
    fallback.style.height = "0";
    fallback.style.overflow = "hidden";

    const host = document.body || document.documentElement;
    if (!host) return;
    host.appendChild(fallback);

    dbg("ui-next", "inserted net page wrapper fallback for host reAdjust");
  }

  /**
   * Enforces deterministic button order and layout in top-right toolbar.
   * Purpose: Coordinate layout detection, reordering, and two-row routing for consistent UX.
   * Necessity: Main orchestrator for toolbar DOM changes; detects when PeeringDB has already
   * laid out buttons and skips processing to avoid interfering with native layout.
   * Version 1.0.20 adds detection for pre-existing data-pdb-fp-row containers.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function enforceTopRightButtonOrder() {
    const parent = getTopRightToolbarContainer();
    if (!parent) return;

    // UI-next has its own active-button lifecycle; avoid DOM reparenting/reordering here.
    if (isUiNextPage()) {
      routeUiNextFpActionsToTwoRows(parent);
      applyTopRightCustomSpacing(parent);
      applyTopRightWrappedRowOffset(parent);
      dbg("toolbar", "applied helper two-row action layout on ui-next page");
      return;
    }

    // Skip re-layout if PeeringDB has already structured buttons into rows (data-pdb-fp-row).
    // New PeeringDB versions handle button layout automatically; don't interfere.
    const hasPreExistingRows = qs('div[data-pdb-fp-row]', parent);
    if (hasPreExistingRows) {
      // Buttons already placed by PeeringDB's native two-row layout.
      return;
    }

    applyTopRightToolbarFlexLayout(parent);

    // FP top-right ordering policy:
    // 1) keep native Edit first (when present)
    // 2) order custom actions deterministically for consistency with CP conventions
    // 3) keep More Tools and related actions at end of the custom sequence
    reorderChildrenByPriority(parent, [
      isNativeEditToolbarButton,
      'a[data-pdb-fp-action="admin-console"]',
      'a[data-pdb-fp-action="open-api-json"]',
      'a[data-pdb-fp-action="copy-url"]',
      'a[data-pdb-fp-action="copy-asn"]',
      'a[data-pdb-fp-action="copy-net-summary"]',
      '[data-pdb-fp-action="admin-workflow-overflow"]',
      '[data-pdb-fp-action="network-tools-overflow"]',
    ]);

    routeTopRightButtonsToTwoRows(parent);

    applyTopRightCustomSpacing(parent);
    applyTopRightWrappedRowOffset(parent);
  }

  /**
   * Convenience wrapper for createTopRightAction with minimal arguments.
   * Purpose: Simplify button creation for module code.
   * Necessity: Reduces boilerplate in module run functions.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function addButton(label, onClick, parentSelector = "div.right.button-bar > div:first-child", actionId = "") {
    return createTopRightAction({
      actionId,
      label,
      onClick,
      parentSelector,
    });
  }

  const modules = [
    {
      id: "fix-double-slashes",
      match: () => true, // Run on all pages
      run: () => {
        const url = window.location;
        // Check if pathname starts with double slash (browser dependent, but checking split length is robust)
        const rawPath = url.pathname;
        if (rawPath.includes("//")) {
          const cleanPath = rawPath.replace(/\/+/g, "/");
          if (rawPath !== cleanPath) {
            window.location.href = url.protocol + "//" + url.hostname + cleanPath + url.search + url.hash;
          }
        }
      },
    },
    {
      id: "asn-404-cp-search-redirect",
      match: (ctx) => ctx.type === "asn" && ctx.isEntityPage,
      run: (ctx) => {
        if (!isFrontendNotFoundPage()) return;

        const asn = String(ctx.id || "").replace(/\D/g, "");
        if (!asn) return;

        const cpSearchUrl = buildCpNetworkSearchUrlByAsn(asn);
        if (!cpSearchUrl) return;

        dbg("asn-redirect", "frontend ASN 404 detected; redirecting to CP search", {
          from: window.location.href,
          to: cpSearchUrl,
          asn,
        });

        window.location.replace(cpSearchUrl);
      },
    },
    {
      id: "set-window-title",
      match: (ctx) => ctx.isEntityPage || ctx.isCpEntityChangePage,
      run: (ctx) => {
        const sep = " | ";

        if (ctx.isCpEntityChangePage) {
          const cpType = ctx.cpEntity;
          if (!cpType) return;

          let cpTitle = "";

          if (cpType === "user") {
            const username = getInputValue("#id_username");
            const email = getInputValue("#id_email");
            cpTitle = `${username}${sep}${email}`;
          } else {
            const name = getInputValue("#id_name");
            const country =
              qs("#id_country > option:checked")?.innerText?.trim() ||
              qs("#id_country > option[selected]")?.innerText?.trim() ||
              "";
            cpTitle = `${name}${sep}${country}`;
          }

          if (cpTitle.trim()) {
            document.title = `PDB CP${sep}${cpType.toUpperCase()}${sep}${cpTitle}`;
          }
          return;
        }

        let pdbType = ctx.type;
        let title = qs('div[data-edit-name="name"]')?.getAttribute("data-edit-value") || "";
        let extra = "";

        if (ctx.type === "asn" || ctx.type === "net") {
          const asn = getText('div[data-edit-name="asn"]');
          if (asn) {
            pdbType = `as${asn.replace(/\D/g, "")}`;
          }
          const aka = getText('div[data-edit-name="aka"]');
          if (aka && aka !== title) {
            title += ` (a.k.a. ${aka})`;
          }
          extra = sep + "net.peeringdb.com";
        } else if (ctx.type === "ix") {
          pdbType = "ixp";
          const longName = getText('div[data-edit-name="name_long"]');
          if (longName) title = longName;
        }

        if (title) {
          document.title = `PDB${sep}${pdbType.toUpperCase()}${sep}${title}${extra}`;
        }
      },
    },
    {
      id: "admin-console-link",
      match: (ctx) => ctx.isEntityPage,
      run: (ctx) => {
        const typeMap = {
          fac: "facility",
          net: "network",
          asn: "network",
          org: "organization",
          carrier: "carrier",
          ix: "internetexchange",
        };

        const cpType = typeMap[ctx.type];
        if (!cpType) return;

        // Determine ID (handle ASN vs Net ID nuances)
        let cpId = ctx.id;
        if (ctx.type === "asn") {
          cpId = getText('div[data-edit-name="net_id"]');
        }

        if (!cpId) return;

        const cpUrl = `https://www.peeringdb.com/cp/peeringdb_server/${cpType}/${cpId}/change/`;
        const parent = getTopRightToolbarContainer();
        if (!parent) return;

        createTopRightAction({
          actionId: "admin-console",
          label: "Admin Console",
          href: cpUrl,
          target: "_blank",
        });

        // Network specific external tools
        if (ctx.type === "net" || ctx.type === "asn") {
          const asnText = getText('div[data-edit-name="asn"]');
          const asn = asnText.replace(/\D/g, "");

          if (asn) {
            createTopRightAction({
              actionId: "copy-asn",
              label: `Copy AS${asn}`,
              onClick: (e) => {
                void withActionLock(`copy-asn-${asn}`, async () => {
                  const copied = await copyToClipboard(`AS${asn}`);
                  if (!copied) return;

                  const btn = e?.target;
                  if (!btn || typeof btn.innerText !== "string") return;
                  const orig = btn.innerText;
                  btn.innerText = "Copied!";
                  setTimeout(() => { btn.innerText = orig; }, 1000);
                });
              },
            });

            createTopRightAction({
              actionId: "copy-net-summary",
              label: "Copy Net Summary",
              onClick: (e) => {
                void withActionLock(`copy-net-summary-${cpId}`, async () => {
                  const name =
                    qs('div[data-edit-name="name"]')?.getAttribute("data-edit-value") ||
                    getText('div[data-edit-name="name"]') ||
                    "<unknown>";
                  const summary = `AS${asn} | ${name} | net_id ${cpId} | ${window.location.href}`;
                  const copied = await copyToClipboard(summary);
                  if (!copied) return;

                  const btn = e?.target;
                  if (!btn || typeof btn.innerText !== "string") return;
                  const orig = btn.innerText;
                  btn.innerText = "Copied!";
                  setTimeout(() => { btn.innerText = orig; }, 1000);
                });
              },
            });

            createTopRightOverflowMenu({
              actionId: "network-tools-overflow",
              label: "More Tools",
              items: [
                { label: "BGP.TOOLS", url: `https://bgp.tools/as${asn}` },
                { label: "BGP.HE", url: `https://bgp.he.net/as${asn}` },
                { label: "RIPEstat", url: `https://stat.ripe.net/AS${asn}` },
                { label: "BGPView", url: `https://bgpview.io/asn/${asn}` },
                { label: "CIDR Report", url: `https://www.cidr-report.org/cgi-bin/as-report?as=${asn}` },
                { label: "IPinfo", url: `https://ipinfo.io/AS${asn}` },
                { label: "CF Radar", url: `https://radar.cloudflare.com/as${asn}` },
                { label: "RouteViews", url: "https://routeviews.org/" },
                { label: "PDB API", url: `https://www.peeringdb.com/api/net/${cpId}` },
              ],
            });
          }

          // Keep native edit button intact; host UI scripts may rely on its presence.
        }
      },
    },
    {
      id: "copy-record-data",
      match: (ctx) => ctx.isEntityPage,
      run: () => {
        addButton("Copy URL", async (event) => {
          await withActionLock("copy-url", async () => {
            const name = getText('.view_title > div[data-edit-name="name"]');
            const uri = window.location.href;
            const copied = await copyToClipboard(`${name} (${uri})`);
            if (!copied) return;

            const btn = event?.target;
            if (!btn) return;
            const orig = btn.innerText;
            btn.innerText = "Copied!";
            setTimeout(() => { btn.innerText = orig; }, 1000);
          });
        }, "div.right.button-bar > div:first-child", "copy-url");
      },
    },
    {
      id: "admin-workflow-buttons",
      match: (ctx) => ctx.isEntityPage,
      run: (ctx) => {
        const parent = getTopRightToolbarContainer();
        const existingAdminOps = parent ? qs('[data-pdb-fp-action="admin-workflow-overflow"]', parent) : null;
        if (!isAdminOpsModeEnabled()) {
          existingAdminOps?.remove();
          return;
        }

        const { type, id } = getCurrentEntityTypeAndId(ctx);
        if (!type || !id) return;

        const apiUrl = getCurrentEntityApiUrl(ctx);
        if (apiUrl) {
          createTopRightAction({
            actionId: "open-api-json",
            label: "Open API",
            href: apiUrl,
            target: "_blank",
          });
        }

        const compareUiVsApi = async () => {
          const currentApiUrl = getCurrentEntityApiUrl(ctx);
          if (!currentApiUrl) {
            notifyUser({ title: "PeeringDB FP", text: "No API URL available for this page." });
            return;
          }

          let payload;
          try {
            const response = await fetch(currentApiUrl, { credentials: "same-origin" });
            const raw = await response.json();
            payload = raw?.data?.[0] || raw || {};
          } catch (_error) {
            notifyUser({ title: "PeeringDB FP", text: "Failed to fetch API payload." });
            return;
          }

          const uiMap = {
            name: getCurrentEntityName(),
            asn: getCurrentAsn(),
            website: getDataEditValue("website") || getInputValue("#id_website"),
            irr_as_set: getDataEditValue("irr_as_set") || getInputValue("#id_irr_as_set"),
            info_traffic: getDataEditValue("info_traffic"),
          };

          const fields = Object.keys(uiMap);
          const diffs = fields
            .map((field) => {
              const uiValue = String(uiMap[field] || "").trim();
              const apiValue = String(payload?.[field] ?? "").trim();
              if (!uiValue && !apiValue) return "";
              if (uiValue === apiValue) return "";
              return `${field}: UI='${uiValue || "n/a"}' API='${apiValue || "n/a"}'`;
            })
            .filter(Boolean);

          const report = [
            `Compare UI vs API :: ${String(type).toUpperCase()} #${id}`,
            diffs.length ? "Differences:" : "No differences detected for mapped fields.",
            ...diffs,
            `API: ${currentApiUrl}`,
            `Page: ${window.location.href}`,
          ].join("\n");

          await copyToClipboard(report);
          notifyUser({
            title: "PeeringDB FP",
            text: diffs.length ? `Copied diff report (${diffs.length} differences).` : "Copied compare report.",
          });
        };

        const runExternalLinkValidator = async () => {
          const links = collectExternalLinks();
          if (!links.length) {
            notifyUser({ title: "PeeringDB FP", text: "No external links found." });
            return;
          }

          const validateOne = async (url) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
              const res = await fetch(url, {
                method: "GET",
                mode: "cors",
                redirect: "follow",
                signal: controller.signal,
              });
              return `${url} -> HTTP ${res.status || 0}`;
            } catch (error) {
              const msg = String(error?.name || error?.message || "blocked");
              return `${url} -> ${msg}`;
            } finally {
              clearTimeout(timeout);
            }
          };

          const results = [];
          for (const url of links.slice(0, 8)) {
            // Keep link validation intentionally small and sequential to avoid request bursts.
            results.push(await validateOne(url));
          }

          const report = ["External Link Validator", ...results].join("\n");
          await copyToClipboard(report);
          notifyUser({ title: "PeeringDB FP", text: `Copied link validation report (${results.length}).` });
        };

        const runPrefixSanityCheck = async () => {
          const p4 = toNumeric(getDataEditValue("info_prefixes4") || getInputValue("#id_info_prefixes4"));
          const p6 = toNumeric(getDataEditValue("info_prefixes6") || getInputValue("#id_info_prefixes6"));

          const findings = [];
          const check = (label, value) => {
            if (value == null) {
              findings.push(`${label}: n/a`);
              return;
            }
            if (value < 0) findings.push(`${label}: negative value (${value})`);
            if (value > 2500000) findings.push(`${label}: unusually high (${value})`);
            if (value >= 0 && value <= 2500000) findings.push(`${label}: ok (${value})`);
          };

          check("IPv4 prefixes", p4);
          check("IPv6 prefixes", p6);

          const report = [
            `Prefix sanity check :: ${String(type).toUpperCase()} #${id}`,
            ...findings,
            `Source: ${window.location.href}`,
          ].join("\n");

          await copyToClipboard(report);
          notifyUser({ title: "PeeringDB FP", text: "Copied prefix sanity report." });
        };

        const runSuspiciousSignals = async () => {
          const signals = [];
          const name = getCurrentEntityName();
          const website = getDataEditValue("website") || getInputValue("#id_website");
          const asn = getCurrentAsn();
          const irrAsSet = getDataEditValue("irr_as_set") || getInputValue("#id_irr_as_set");
          const identities = getVisibleUserIdentityData();

          if (!name || name.length < 3) signals.push("Name is missing or unusually short");
          if (!website) signals.push("Website missing");
          if (type === "net" && !asn) signals.push("ASN missing for network record");
          if (type === "net" && !irrAsSet) signals.push("IRR AS-SET missing");
          if (ctx.type === "org" && identities.emails.length === 0) signals.push("Org has no visible user emails");

          const domainCounts = identities.domains.reduce((acc, domain) => {
            acc[domain] = (acc[domain] || 0) + 1;
            return acc;
          }, {});
          const domainEntries = Object.entries(domainCounts);
          if (domainEntries.length > 2) signals.push("Multiple email domains detected in org users");

          const report = [
            `Suspicious signals :: ${String(type).toUpperCase()} #${id}`,
            ...(signals.length
              ? signals.map((entry, idx) => `${idx + 1}. ${entry}`)
              : ["No obvious quick signals found."]),
            `Source: ${window.location.href}`,
          ].join("\n");

          await copyToClipboard(report);
          notifyUser({ title: "PeeringDB FP", text: "Copied suspicious signals report." });
        };

        const runEmailDomainInspector = async () => {
          const identities = getVisibleUserIdentityData();
          if (!identities.domains.length) {
            notifyUser({ title: "PeeringDB FP", text: "No visible org user emails found." });
            return;
          }

          const counts = identities.domains.reduce((acc, domain) => {
            acc[domain] = (acc[domain] || 0) + 1;
            return acc;
          }, {});

          const report = [
            "Email Domain Inspector",
            ...Object.entries(counts)
              .sort((a, b) => b[1] - a[1])
              .map(([domain, count]) => `${domain}: ${count}`),
            `Total emails: ${identities.emails.length}`,
          ].join("\n");

          await copyToClipboard(report);
          notifyUser({ title: "PeeringDB FP", text: "Copied email domain report." });
        };

        const parentOrgId = getParentOrgId(ctx);
        const relatedSeed = getRelatedObjectIds();
        const hasRelatedTargets =
          relatedSeed.netixlanIds.length > 0 ||
          relatedSeed.netfacIds.length > 0 ||
          relatedSeed.pocIds.length > 0;

        const adminOpsItems = [
          {
            when: type !== "org" && Boolean(parentOrgId),
            label: "Open CP Org",
            title: "Open parent organization in CP",
            onClick: () => {
              const orgId = getParentOrgId(ctx);
              const url = buildCpOrgChangeUrl(orgId);
              if (!url) {
                notifyUser({ title: "PeeringDB FP", text: "Parent org id not found." });
                return;
              }
              window.open(url, "_blank", "noopener");
            },
          },
          {
            when: Boolean(parentOrgId),
            label: "Open CP User Manager",
            title: "Open org user manager in CP",
            onClick: () => {
              const orgId = getParentOrgId(ctx);
              const url = buildCpUserManagerUrl(orgId);
              if (!url) {
                notifyUser({ title: "PeeringDB FP", text: "Parent org id not found." });
                return;
              }
              window.open(url, "_blank", "noopener");
            },
          },
          {
            label: "Copy Entity IDs",
            title: "Copy compact entity id bundle",
            onClick: () => {
              void withActionLock("copy-entity-ids-bundle", async () => {
                await copyToClipboard(formatEntityIdsBundle(ctx));
                notifyUser({ title: "PeeringDB FP", text: "Copied entity ids bundle." });
              });
            },
          },
          {
            label: "Copy Triage Summary",
            title: "Copy moderation triage summary",
            onClick: () => {
              void withActionLock("copy-admin-triage-summary", async () => {
                await copyToClipboard(formatAdminTriageSummary(ctx));
                notifyUser({ title: "PeeringDB FP", text: "Copied triage summary." });
              });
            },
          },
          {
            label: "CP Search Pack",
            title: "Open/copy common CP searches",
            onClick: () => {
              void withActionLock("cp-search-pack", async () => {
                const queries = new Set();
                const name = getCurrentEntityName();
                const asn = getCurrentAsn();
                const identities = getVisibleUserIdentityData();

                if (name) queries.add(name);
                if (asn) queries.add(`AS${asn}`);
                identities.usernames.forEach((q) => queries.add(q));
                identities.emails.forEach((q) => queries.add(q));

                const urls = Array.from(queries)
                  .map((q) => buildCpAccountSearchUrl(q))
                  .filter(Boolean);

                if (!urls.length) {
                  notifyUser({ title: "PeeringDB FP", text: "No search queries available." });
                  return;
                }

                const opened = openUrlsWithConfirm(urls, 3);
                if (opened > 0) {
                  notifyUser({ title: "PeeringDB FP", text: `Opened ${opened} CP search tabs.` });
                  return;
                }

                await copyToClipboard(urls.join("\n"));
                notifyUser({ title: "PeeringDB FP", text: "Copied CP search pack links." });
              });
            },
          },
          {
            when: hasRelatedTargets,
            label: "Open Related Objects",
            title: "Open related object views",
            onClick: () => {
              const urls = [];
              if (type !== "org") {
                const orgId = getParentOrgId(ctx);
                const orgUrl = buildCpOrgChangeUrl(orgId);
                if (orgUrl) urls.push(orgUrl);
              }

              const related = getRelatedObjectIds();
              related.netixlanIds.slice(0, 2).forEach((rid) => {
                urls.push(`${window.location.origin}/netixlan/${rid}`);
              });
              related.netfacIds.slice(0, 2).forEach((rid) => {
                urls.push(`${window.location.origin}/netfac/${rid}`);
              });
              related.pocIds.slice(0, 2).forEach((rid) => {
                urls.push(`${window.location.origin}/poc/${rid}`);
              });

              if (!urls.length) {
                notifyUser({ title: "PeeringDB FP", text: "No related objects found." });
                return;
              }

              const opened = openUrlsWithConfirm(urls, 4);
              notifyUser({ title: "PeeringDB FP", text: `Opened ${opened} related object tab(s).` });
            },
          },
          {
            when: ctx.type === "org",
            label: "Email Domain Inspector",
            title: "Inspect org user email domains",
            onClick: () => {
              void withActionLock("email-domain-inspector", runEmailDomainInspector);
            },
          },
          {
            label: "Validate External Links",
            title: "Validate visible external links",
            onClick: () => {
              void withActionLock("external-link-validator", runExternalLinkValidator);
            },
          },
          {
            label: "Compare UI vs API",
            title: "Compare selected fields between UI and API",
            onClick: () => {
              void withActionLock("compare-ui-vs-api", compareUiVsApi);
            },
          },
          {
            when: type === "net",
            label: "Prefix Sanity Check",
            title: "Run local prefix sanity checks",
            onClick: () => {
              void withActionLock("prefix-sanity-check", runPrefixSanityCheck);
            },
          },
          {
            label: "Suspicious Signals",
            title: "Generate quick suspicious signal report",
            onClick: () => {
              void withActionLock("suspicious-signals", runSuspiciousSignals);
            },
          },
          {
            label: "Audit Trail Jump",
            title: "Open CP search for this entity id",
            onClick: () => {
              const url = buildCpEntitySearchUrl(type, id);
              if (!url) {
                notifyUser({ title: "PeeringDB FP", text: "No CP audit/search URL available." });
                return;
              }
              window.open(url, "_blank", "noopener");
            },
          },
          {
            label: "Soft Reset Form",
            title: "Clear local edit-state artifacts",
            onClick: () => {
              const popins = qsa('.editable.popin.error, .editable.popin.info');
              const shims = qsa('.editable.loading-shim');
              const invalids = qsa('.has-error, .is-invalid');

              popins.forEach((el) => { el.style.display = "none"; });
              shims.forEach((el) => { el.style.display = "none"; });
              invalids.forEach((el) => {
                el.classList.remove("has-error");
                el.classList.remove("is-invalid");
              });

              notifyUser({
                title: "PeeringDB FP",
                text: `Soft reset applied (${popins.length + shims.length + invalids.length} local element updates).`,
              });
            },
          },
        ];

        const filteredAdminOpsItems = adminOpsItems
          .filter((item) => item.when !== false)
          .map(({ when, ...item }) => item);

        const orgPagePriority = {
          "Open CP User Manager": 10,
          "Copy Triage Summary": 20,
          "Copy Entity IDs": 30,
          "CP Search Pack": 40,
          "Email Domain Inspector": 50,
          "Compare UI vs API": 60,
          "Validate External Links": 70,
          "Suspicious Signals": 80,
          "Audit Trail Jump": 90,
          "Soft Reset Form": 100,
        };

        if (ctx.type === "org") {
          filteredAdminOpsItems.sort((a, b) => {
            const pa = orgPagePriority[a.label] ?? 1000;
            const pb = orgPagePriority[b.label] ?? 1000;
            if (pa !== pb) return pa - pb;
            return String(a.label || "").localeCompare(String(b.label || ""));
          });
        }

        if (!filteredAdminOpsItems.length) return;

        createTopRightOverflowMenu({
          actionId: "admin-workflow-overflow",
          label: "Admin Ops",
          items: filteredAdminOpsItems,
        });
      },
    },
    {
      id: "copy-user-roles",
      match: (ctx) => ctx.type === "org" && ctx.isEntityPage,
      run: () => {
        const CP_EMAIL_SEARCH_BASE = "https://www.peeringdb.com/cp/account/emailaddress/?q=";
        const CP_USER_CHANGE_BASE = "https://www.peeringdb.com/cp/peeringdb_server/user";
        const EMAIL_REGEX = /[A-Z0-9._+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

        /**
         * Creates a CP account search anchor for an email/username query.
         */
        function createCpSearchLink(queryText, titleText) {
          const link = document.createElement("a");
          link.href = `${CP_EMAIL_SEARCH_BASE}${encodeURIComponent(queryText)}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "🔍";
          link.title = titleText;
          link.setAttribute("aria-label", titleText);
          link.style.display = "inline-block";
          link.style.marginLeft = "6px";
          link.style.textDecoration = "none";
          return link;
        }

        /**
         * Creates a CP user change-page anchor for a numeric user ID.
         */
        function createCpUserRecordLink(userId) {
          if (!/^\d+$/.test(String(userId || "").trim())) return null;

          const normalizedId = String(userId).trim();
          const link = document.createElement("a");
          link.href = `${CP_USER_CHANGE_BASE}/${normalizedId}/change/`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "🪪";
          link.title = "Open user record in CP";
          link.setAttribute("aria-label", "Open user record in CP");
          link.style.display = "inline-block";
          link.style.marginLeft = "6px";
          link.style.textDecoration = "none";
          return link;
        }

        /**
         * Normalizes inline 2FA badge visuals to a compact icon-only style.
         */
        function normalizeTwoFaBadge(badge) {
          if (!badge || badge.getAttribute("data-pdb-fp-2fa-inline") === "true") return;
          badge.setAttribute("data-pdb-fp-2fa-inline", "true");
          badge.textContent = "🔐";
          badge.title = "2FA enabled";
          badge.setAttribute("aria-label", "2FA enabled");
          badge.setAttribute("role", "img");
          badge.style.display = "inline-block";
          badge.style.marginLeft = "4px";
          badge.style.padding = "0";
          badge.style.border = "0";
          badge.style.borderRadius = "0";
          badge.style.background = "transparent";
          badge.style.color = "inherit";
          badge.style.fontSize = "inherit";
          badge.style.fontWeight = "normal";
          badge.style.lineHeight = "1";
          badge.style.verticalAlign = "middle";
        }

        function decorateUserRows(items, options = {}) {
          const allowDirectLink = Boolean(options.allowDirectLink);

          items.forEach((item) => {
            const rowRoot =
              item?.matches?.(".item")
                ? item
                : item?.querySelector?.(".item");
            if (!rowRoot) return;

          const userId =
            item.getAttribute("data-edit-id") ||
            item.querySelector(".item[data-edit-id]")?.getAttribute("data-edit-id") ||
            "";

            const usernameRow = rowRoot.querySelector(":scope > div:nth-child(1) > div:nth-child(2)");
          if (usernameRow) {
            const badge = usernameRow.querySelector("span.badge-2fa-enabled");
            if (badge) normalizeTwoFaBadge(badge);

            const hasUsernameSearchLink = Boolean(
              usernameRow.querySelector("a[data-pdb-fp-username-search]")
            );
            const hasUsernameDirectLink = !allowDirectLink || Boolean(
              usernameRow.querySelector("a[data-pdb-fp-username-direct]")
            );
            if (!hasUsernameSearchLink || !hasUsernameDirectLink) {
              const username = Array.from(usernameRow.childNodes)
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => String(node.textContent || ""))
                .join(" ")
                .trim();

              if (username) {
                const directLink = hasUsernameDirectLink
                  ? null
                  : createCpUserRecordLink(userId);
                if (directLink) {
                  directLink.setAttribute("data-pdb-fp-username-direct", "true");
                }

                const usernameSearchLink = hasUsernameSearchLink
                  ? null
                  : createCpSearchLink(username, "Search user by username in CP");
                if (usernameSearchLink) {
                  usernameSearchLink.setAttribute("data-pdb-fp-username-search", "true");
                }

                if (directLink || usernameSearchLink) {
                  if (badge) {
                    let anchor = badge;
                    if (directLink) {
                      anchor.insertAdjacentElement("afterend", directLink);
                      anchor = directLink;
                    }
                    if (usernameSearchLink) {
                      anchor.insertAdjacentElement("afterend", usernameSearchLink);
                    }
                  } else {
                    if (directLink) usernameRow.appendChild(directLink);
                    if (usernameSearchLink) usernameRow.appendChild(usernameSearchLink);
                  }
                }
              }
            }
          }

            const emailCell = rowRoot.querySelector(":scope > div:nth-child(2)");
          if (!emailCell) return;

          const emailRows = emailCell.querySelectorAll(":scope > div");
          emailRows.forEach((emailRow) => {
            const emailMatch = String(emailRow.textContent || "").match(EMAIL_REGEX);
            const email = emailMatch ? emailMatch[0].trim() : "";

            // Add quick CP email search link for each email line in the same column.
            if (!email || emailRow.querySelector("a[data-pdb-fp-email-search]")) return;

            const searchLink = createCpSearchLink(email, "Search user by email in CP");
            searchLink.setAttribute("data-pdb-fp-email-search", "true");
            emailRow.appendChild(searchLink);
          });
          });
        }

        const users = qsa(
          '#org-user-manager > div[data-edit-template="user-item"] > .editable'
        );
        decorateUserRows(users, { allowDirectLink: true });

        const usersRequestingAffiliation = qsa(
          '.list[data-edit-module="uoar_listing"] .row.item[data-edit-id]'
        );
        decorateUserRows(usersRequestingAffiliation, { allowDirectLink: false });

        // Insert before the submit button in the user manager
        const parent = qs("#org-user-manager > div:nth-child(5)");
        if (!parent) return;

        const refNode = qs('a[data-edit-action="submit"]', parent);
        if (!refNode) return;

        // Guard: check if button already exists to prevent duplicates on re-init
        const existing = qs('a[data-pdb-fp-copy-user-roles]', parent);
        if (existing) return;

        const btn = document.createElement("a");
        btn.className = "btn btn-default";
        btn.setAttribute("data-pdb-fp-copy-user-roles", "true");
        btn.style.textAlign = "center";
        btn.style.marginRight = "5px";
        btn.style.cursor = "pointer";
        btn.innerText = "Admin 📧";

        btn.addEventListener("click", () => {
          void withActionLock("copy-user-roles", async () => {
            const admins = [];
            const members = [];

            const currentUsers = qsa(
              '#org-user-manager > div[data-edit-template="user-item"] > .editable'
            );

            currentUsers.forEach((item) => {
              const emailCell = item.querySelector(".item > div:nth-child(2)");
              const emailRows = emailCell ? emailCell.querySelectorAll(":scope > div") : [];
              let email = "";

              for (const row of emailRows) {
                const match = String(row.textContent || "").match(EMAIL_REGEX);
                if (match && match[0]) {
                  email = match[0].trim();
                  break;
                }
              }

              const role = item
                .querySelector(".item > div:nth-child(3) > div:first-child")
                ?.getAttribute("data-edit-value");

              if (role === "admin") admins.push(email);
              if (role === "member") members.push(email);
            });

            // Legacy script only returned admins joined by newline
            await copyToClipboard(admins.join("\n"));
          });
        });

        parent.insertBefore(btn, refNode);
      },
    },
    {
      id: "org-pending-fac-cp-edit-links",
      match: (ctx) => ctx.type === "org" && ctx.isEntityPage,
      run: () => {
        const ATTR = "data-pdb-fp-fac-cp-edit";

        qsa("#api-listing-fac .row.item.status-pending[data-edit-id]").forEach((row) => {
          const facId = String(row.getAttribute("data-edit-id") || "").trim();
          if (!/^\d+$/.test(facId)) return;
          if (row.querySelector(`a[${ATTR}]`)) return;

          const cpUrl = `https://www.peeringdb.com/cp/peeringdb_server/facility/${facId}/change/`;

          const link = document.createElement("a");
          link.setAttribute(ATTR, facId);
          link.href = cpUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "⚙️";
          link.title = `Edit facility #${facId} in CP`;
          link.setAttribute("aria-label", `Edit facility #${facId} in CP`);
          link.style.textDecoration = "none";

          const col = document.createElement("div");
          col.className = "col-md-2";
          col.style.textAlign = "right";
          col.style.paddingRight = "8px";
          col.appendChild(link);
          row.appendChild(col);
        });
      },
    },
  ];

  /**
   * Executes all enabled modules that match the current route context.
   * Purpose: Central dispatcher that activates modules for the current page.
   * Necessity: Implements modular architecture; checks both enabled status and page match
   * before running each module. Catches and logs errors to prevent cascade failures.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function dispatchModules(ctx) {
    const disabledModules = getDisabledModules();

    modules.forEach((module) => {
      try {
        if (!isModuleEnabled(module.id, disabledModules)) return;
        if (!module.match(ctx)) return;
        if (typeof module.preconditions === "function" && !module.preconditions(ctx)) return;
        module.run(ctx);
      } catch (error) {
        const latestFetchFailure = Array.from(lastFetchFailureByUrl.entries()).pop();
        console.warn(`[${MODULE_PREFIX}] Module ${module.id} failed`, {
          error,
          latestFetchFailure:
            latestFetchFailure
              ? { url: latestFetchFailure[0], ...latestFetchFailure[1] }
              : null,
        });
      }
    });
  }

  /**
   * Runs the complete initialization sequence for consolidated tools.
   * Purpose: Parse route, dispatch modules, and enforce button order on current page.
   * Necessity: Single entry point for all initialization logic; ensures modules run before layout.
   * Sets isInitRunning flag to prevent duplicate initialization during mutations.
   */
  let isInitRunning = false;
  let fpMenuCommandsRegistered = false;
  let fpCopyUrlMenuCommandId = null;
  let fpCopyAsnMenuCommandId = null;
  let fpAdminConsoleMenuCommandId = null;
  let fpDebugToggleMenuCommandId = null;
  let fpLogUaMenuCommandId = null;
  let fpAdminOpsToggleMenuCommandId = null;
  let fpFeatureFlagsShowMenuCommandId = null;
  let fpFeatureFlagsResetMenuCommandId = null;
  let fpFeatureFlagToggleMenuCommandIds = [];

  /**
   * Registers a menu command and records its ID for future refresh.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function registerFpMenuCommand(label, handler) {
    const commandId = GM_registerMenuCommand(label, handler);
    return commandId;
  }

  /**
   * Registers one-time Tampermonkey menu commands for common FP actions.
   * Purpose: Provide quick action access via extension menu for frequent workflows.
   * Necessity: Supports keyboard-driven usage and declutters reliance on toolbar clicks.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function registerFpMenuCommands() {
    if (fpMenuCommandsRegistered && typeof GM_unregisterMenuCommand !== "function") return;
    if (typeof GM_registerMenuCommand !== "function") return;

    if (typeof GM_unregisterMenuCommand === "function") {
      [
        fpCopyUrlMenuCommandId,
        fpCopyAsnMenuCommandId,
        fpAdminConsoleMenuCommandId,
        fpDebugToggleMenuCommandId,
        fpLogUaMenuCommandId,
        fpAdminOpsToggleMenuCommandId,
        fpFeatureFlagsShowMenuCommandId,
        fpFeatureFlagsResetMenuCommandId,
        ...fpFeatureFlagToggleMenuCommandIds,
      ].forEach((commandId) => {
        if (commandId != null) {
          GM_unregisterMenuCommand(commandId);
        }
      });
      fpFeatureFlagToggleMenuCommandIds = [];
    }

    fpMenuCommandsRegistered = true;

    const getDebugToggleMenuLabel = () => {
      const enabled = isDebugEnabled();
      return `FP: Debug Mode [${enabled ? "ON" : "OFF"}] (toggle to ${enabled ? "OFF" : "ON"})`;
    };

    const getLogUaMenuLabel = () => `FP: Log User-Agent (Debug ${isDebugEnabled() ? "ON" : "OFF"})`;
    const getAdminOpsToggleLabel = () => {
      const enabled = isAdminOpsModeEnabled();
      return `FP: Admin Ops Mode [${enabled ? "ON" : "OFF"}] (toggle to ${enabled ? "OFF" : "ON"})`;
    };
    const getFeatureFlagToggleLabel = (flagName) => {
      const state = getFeatureFlagState(flagName);
      if (!state) return `FP: Feature ${flagName}`;
      return `FP: Feature ${flagName} [${state.enabled ? "ON" : "OFF"}] (toggle to ${state.enabled ? "OFF" : "ON"})`;
    };

    fpCopyUrlMenuCommandId = registerFpMenuCommand("FP: Copy URL", () => {
      qs('a[data-pdb-fp-action="copy-url"]')?.click();
    });

    fpCopyAsnMenuCommandId = registerFpMenuCommand("FP: Copy AS<N>", () => {
      qs('a[data-pdb-fp-action="copy-asn"]')?.click();
    });

    fpAdminConsoleMenuCommandId = registerFpMenuCommand("FP: Open Admin Console", () => {
      const adminLink = qs('a[data-pdb-fp-action="admin-console"]');
      if (!adminLink) return;
      const href = String(adminLink.getAttribute("href") || "").trim();
      if (!href) return;
      window.open(href, "_blank", "noopener");
    });

    fpDebugToggleMenuCommandId = registerFpMenuCommand(getDebugToggleMenuLabel(), () => {
      const next = isDebugEnabled() ? null : "1";
      if (next) {
        window.localStorage?.setItem(DIAGNOSTICS_STORAGE_KEY, next);
      } else {
        window.localStorage?.removeItem(DIAGNOSTICS_STORAGE_KEY);
      }

      notifyUser({
        title: "PeeringDB FP",
        text: `Debug mode ${next ? "enabled" : "disabled"}.`,
      });

      if (next) {
        logCurrentUserAgentDebug();
      }

      if (typeof GM_unregisterMenuCommand === "function") {
        registerFpMenuCommands();
      }
    });

    fpLogUaMenuCommandId = registerFpMenuCommand(getLogUaMenuLabel(), () => {
      const didLog = logCurrentUserAgentDebug();
      if (!didLog) {
        const host = String(window.location?.hostname || "").trim().toLowerCase();
        console.info(`[${MODULE_PREFIX}:ua] requested User-Agent log while debug mode is OFF`, {
          debugEnabled: false,
          host,
          userAgent: getCustomRequestUserAgent(),
        });

        notifyUser({
          title: "PeeringDB FP",
          text: "Enable debug mode first to log User-Agent details.",
        });
        return;
      }

      notifyUser({
        title: "PeeringDB FP",
        text: "User-Agent details logged to browser console.",
      });
    });

    fpAdminOpsToggleMenuCommandId = registerFpMenuCommand(getAdminOpsToggleLabel(), () => {
      const enable = !isAdminOpsModeEnabled();
      if (enable) {
        window.localStorage?.setItem(ADMIN_OPS_MODE_STORAGE_KEY, "1");
      } else {
        window.localStorage?.removeItem(ADMIN_OPS_MODE_STORAGE_KEY);
      }

      notifyUser({
        title: "PeeringDB FP",
        text: `Admin Ops mode ${enable ? "enabled" : "disabled"}.`,
      });

      scheduleConsolidatedInit();

      if (typeof GM_unregisterMenuCommand === "function") {
        registerFpMenuCommands();
      }
    });

    fpFeatureFlagsShowMenuCommandId = registerFpMenuCommand("FP: Feature Flags (show in console)", () => {
      const snapshot = Object.keys(FEATURE_FLAGS)
        .sort()
        .map((flagName) => {
          const state = getFeatureFlagState(flagName);
          return {
            flag: flagName,
            enabled: state?.enabled,
            defaultValue: state?.defaultValue,
            overrideValue: state?.overrideValue,
          };
        });
      console.table(snapshot);

      notifyUser({
        title: "PeeringDB FP",
        text: "Feature-flag snapshot logged to browser console.",
      });
    });

    fpFeatureFlagsResetMenuCommandId = registerFpMenuCommand("FP: Feature Flags (reset overrides)", () => {
      resetFeatureFlagOverrides();
      notifyUser({
        title: "PeeringDB FP",
        text: "Feature-flag overrides reset.",
      });
      if (typeof GM_unregisterMenuCommand === "function") {
        registerFpMenuCommands();
      }
    });

    fpFeatureFlagToggleMenuCommandIds = Object.keys(FEATURE_FLAGS)
      .sort()
      .map((flagName) =>
        registerFpMenuCommand(getFeatureFlagToggleLabel(flagName), () => {
          const state = getFeatureFlagState(flagName);
          if (!state) return;
          setFeatureFlagEnabled(flagName, !state.enabled);

          notifyUser({
            title: "PeeringDB FP",
            text: `Feature ${flagName} ${state.enabled ? "disabled" : "enabled"}.`,
          });

          if (typeof GM_unregisterMenuCommand === "function") {
            registerFpMenuCommands();
          }
        }),
      );
  }

  /**
   * Runs lightweight precondition checks for key FP DOM landmarks.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function runSelfCheck(ctx) {
    if (selfCheckHasRun) return;
    selfCheckHasRun = true;

    const checks = [
      { id: "content", selector: "#content", critical: false },
      { id: "view", selector: "#view", critical: false },
      { id: "toolbar", selector: () => Boolean(getTopRightToolbarContainer()), critical: false },
      { id: "title", selector: "title", critical: true },
    ];

    const failures = [];
    checks.forEach(({ id, selector, critical }) => {
      const found = typeof selector === "function" ? selector() : Boolean(qs(selector));
      dbg("self-check", `${found ? "ok" : "missing"} [${id}]`);
      if (!found) {
        failures.push({ id, critical });
      }
    });

    if (!failures.length) {
      dbg("self-check", "all checks passed", { entity: ctx.type, id: ctx.id });
      return;
    }

    const criticalCount = failures.filter((item) => item.critical).length;
    const missingIds = failures.map((item) => item.id).join(", ");
    console.warn(`[${MODULE_PREFIX}] Self-check missing: ${missingIds}`, {
      criticalCount,
      totalFailures: failures.length,
      path: ctx.path,
      scriptVersion: SCRIPT_VERSION,
    });
  }

  let consolidatedObserver = null;
  let observerDisconnectTimer = 0;
  let initDebouncedTimer = 0;
  let missedMutationDuringInit = false;

  /**
   * Determines the best DOM root to observe for FP dynamic updates.
   * Purpose: Use a stable ancestor so the observer survives framework-triggered DOM replacement.
   * Necessity: Rooting at the toolbar container causes the observer to detach silently when
   * PeeringDB's framework replaces that element, making all subsequent mutations invisible.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function getObserverRootNode() {
    return (
      qs("#content") ||
      qs("#view") ||
      document.body
    );
  }

  /**
   * Disconnects the shared MutationObserver and clears pending disconnect timers.
   * Purpose: Stop observation after page stabilizes to reduce long-lived callback overhead.
   * Necessity: Observer is only needed during dynamic render bursts and route transitions.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function disconnectConsolidatedObserver() {
    if (observerDisconnectTimer) {
      window.clearTimeout(observerDisconnectTimer);
      observerDisconnectTimer = 0;
    }

    if (consolidatedObserver) {
      consolidatedObserver.disconnect();
      consolidatedObserver = null;
    }
  }

  /**
   * Schedules observer shutdown after a short idle period.
   * Purpose: Keep observer active during render bursts, then detach automatically.
   * Necessity: Balances responsiveness with lower steady-state CPU usage.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function scheduleObserverDisconnect() {
    if (observerDisconnectTimer) {
      window.clearTimeout(observerDisconnectTimer);
    }

    observerDisconnectTimer = window.setTimeout(() => {
      disconnectConsolidatedObserver();
    }, OBSERVER_IDLE_DISCONNECT_MS);
  }

  /**
   * Ensures a single shared MutationObserver is connected for dynamic page updates.
   * Purpose: Re-attach observer only when needed, using scoped root + filtered callback.
   * Necessity: SPA-like updates on FP pages require temporary observation for toolbar rebuild.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function ensureConsolidatedObserver() {
    if (consolidatedObserver || !document.body) return;

    const rootNode = getObserverRootNode();
    if (!rootNode) return;

    consolidatedObserver = new MutationObserver((mutations) => {
      if (isInitRunning) {
        // Init is already running; flag that the DOM changed underneath us.
        // runConsolidatedInit's finally block will schedule a re-run.
        missedMutationDuringInit = true;
        return;
      }

      const hasStructuralChange = mutations.some(
        (mutation) =>
          mutation.type === "childList" &&
          ((mutation.addedNodes && mutation.addedNodes.length > 0) ||
            (mutation.removedNodes && mutation.removedNodes.length > 0)),
      );

      if (!hasStructuralChange) return;

      // Use debounced scheduler so we wait for PeeringDB's framework to settle
      // before running init, rather than fighting its reconciler mutation-by-mutation.
      scheduleConsolidatedInitDebounced();
      scheduleObserverDisconnect();
    });

    consolidatedObserver.observe(rootNode, { childList: true, subtree: true });
    scheduleObserverDisconnect();
  }

  /**
   * Runs the consolidated initialization sequence for the current route context.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function runConsolidatedInit() {
    const ctx = getRouteContext();
    isInitRunning = true;
    try {
      dbg("init", `v${SCRIPT_VERSION}`, { type: ctx.type, id: ctx.id, path: ctx.path });
      runSelfCheck(ctx);
      dispatchModules(ctx);
      scheduleDomUpdate("fp-toolbar-order", () => {
        enforceTopRightButtonOrder();
      });
      registerFpMenuCommands();
    } finally {
      isInitRunning = false;
      if (missedMutationDuringInit) {
        // DOM changed while init was running (framework reconciler fired concurrently).
        // Schedule a debounced follow-up so we catch the settled final state.
        missedMutationDuringInit = false;
        scheduleConsolidatedInitDebounced();
      }
      scheduleObserverDisconnect();
    }
  }

  /**
   * Schedules initialization to run on next animation frame, preventing duplicates.
   * Purpose: Debounce repeated mutation events into a single initialization.
   * Necessity: DOM mutations can fire many times per millisecond; this batches them into
   * one operation to avoid redundant module calls and button reordering.
   */
  let initScheduled = false;

  /**
   * Schedules one animation-frame initialization run when not already queued/running.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function scheduleConsolidatedInit() {
    // Prevent triggering while modules are actively running (to avoid duplicate DOM insertions)
    if (initScheduled || isInitRunning) return;
    initScheduled = true;

    requestAnimationFrame(() => {
      initScheduled = false;
      runConsolidatedInit();
    });
  }

  /**
   * Debounced version of scheduleConsolidatedInit for MutationObserver callbacks.
   * Purpose: Wait for PeeringDB's framework to settle before injecting our buttons.
   * Necessity: With @run-at document-end, PeeringDB's framework may still mutate the DOM after load,
   * and causes rapid DOM mutations. Firing init on every mutation creates a fight cycle where
   * we inject buttons that PeeringDB's reconciler immediately removes. The debounce ensures
   * we only run after the last mutation in a burst, when the framework is stable.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   */
  function scheduleConsolidatedInitDebounced() {
    if (initDebouncedTimer) window.clearTimeout(initDebouncedTimer);
    initDebouncedTimer = window.setTimeout(() => {
      initDebouncedTimer = 0;
      scheduleConsolidatedInit();
    }, INIT_OBSERVER_DEBOUNCE_MS);
  }

  /**
   * Bootstrap the consolidated init system and attach event listeners.
   * Purpose: Initialize the script on page load or immediately if DOM is ready.
   * Necessity: Entry point that hooks into DOMContentLoaded, popstate (SPA navigation),
   * and DOM mutations to detect when init should run. Sets up MutationObserver for AJAX/PJAX pages.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function bootstrapConsolidatedInit() {
    ensureNetPageWrapperFallback();

    if (isUiNextPage() && document.readyState !== "complete") {
      window.addEventListener("load", () => {
        ensureNetPageWrapperFallback();
        installFetchDiagnostics();
        scheduleConsolidatedInit();
        ensureConsolidatedObserver();
      }, { once: true });
      return;
    }

    installFetchDiagnostics();
    scheduleConsolidatedInit();
    ensureConsolidatedObserver();

    const onRouteChange = () => {
      ensureConsolidatedObserver();
      scheduleConsolidatedInit();
    };

    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("hashchange", onRouteChange);
  }

  bootstrapConsolidatedInit();
})();
