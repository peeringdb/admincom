// Shared helpers for the admincom Tampermonkey userscripts (CP/FP/DeskPro).
//
// This is a source fragment, not a standalone script: it is inlined into
// each *.user.js by scripts/build_userscripts.py at the `/* @include
// admincom-common.js */` marker in that script's *.src.js. Edit this file,
// then re-run the build script -- do not hand-edit the generated functions
// inside the .user.js files, your changes will be overwritten.
//
// Expects the including script to define, above this block: MODULE_PREFIX
// and isFeatureEnabled(flagName) (all three scripts already have their own
// FEATURE_FLAGS/isFeatureEnabled mechanism for disabledModules-style
// toggles -- debug mode piggybacks on that via the "debugMode" flag, same
// as before this file existed). Safe because none of these functions are
// invoked at top-level script evaluation time -- only from later user
// interaction or async work, by which point the including script's own
// top-level statements have run.
//
// dbg()/isDebugEnabled() below are a centralization of logic that already
// existed, identically, independently in all three scripts -- not new
// behavior. DIAGNOSTICS_STORAGE_KEY intentionally stays the literal
// "pdbAdmincom.debug" (not templated per-script like other storage keys)
// because CP and FP already shared this exact key: both run on the
// peeringdb.com origin, so toggling debug mode in one already turned it on
// for the other via shared localStorage. dbgWarn/dbgInfo/dbgGroup/
// dbgGroupEnd are genuinely new severity tiers added on top of the
// existing single-tier dbg(), gated by the same isDebugEnabled() check.
//
// Request retry: split into two thin wrappers sharing one retry decision
// (classifyRetry) instead of one GM_xmlhttpRequest-only wrapper, because
// these scripts mix same-origin fetch (PeeringDB API) with cross-origin
// GM_xmlhttpRequest (RDAP registries, cdnjs).
//
// Cache primitives (getCachedDataFromStorage/setCachedDataInStorage/etc.):
// moved here from DP, where this exact mechanism originated -- previously
// DP, CP, and FP each had their own independent, differently-keyed,
// non-interoperable localStorage cache for API entity data (DP:
// pdbAdmincom.cache.{type}.{id} full objects; CP: pdbCpConsolidated.
// orgNameCache.{id} name strings only; FP: pdbFpConsolidated.apiPayloadCache.
// {url} keyed by exact request URL). This is now the one canonical
// mechanism all three use. localStorage is origin-scoped: CP+FP genuinely
// share a cache (both run on peeringdb.com), but DP (peeringdb.deskpro.com)
// physically cannot -- that's a browser same-origin-policy boundary, not a
// limitation of this code. Each script still owns its own TTL policy
// constants and calls these with an explicit ttlMs; CACHE_DEFAULT_TTL_MS
// below is only a fallback for callers that omit it.

const DIAGNOSTICS_STORAGE_KEY = "pdbAdmincom.debug";
// Abort a stalled request instead of letting it hang the UI indefinitely.
const REQUEST_TIMEOUT_MS = 15000;
// Transient statuses worth retrying with backoff (rate limit / gateway).
const RETRYABLE_STATUS = [429, 502, 503, 504];
const MAX_RETRIES = 3;
// Methods a failed request may be repeated for without the repeat itself being
// a side effect. A 502/503/504 means the response was lost, NOT that the
// request was: a DELETE that committed server-side and then timed out at the
// gateway is indistinguishable here from one that never arrived. Replaying it
// re-issues a write whose outcome is unknown, so writes are excluded and must
// opt in per call via retryWrites: true.
const SAFE_TO_RETRY_METHODS = ['GET', 'HEAD'];

/**
 * Returns true when diagnostics/debug mode is enabled via localStorage.
 * Purpose: Gate verbose console output behind an opt-in flag so normal
 * production use is silent.
 * Toggle with: localStorage.setItem('pdbAdmincom.debug', '1')
 * @ai Preserve shared storage/cache key contracts and TTL behavior.
 * @returns {boolean} True when debug mode is active.
 */
function isDebugEnabled() {
  return isFeatureEnabled("debugMode") && window.localStorage?.getItem(DIAGNOSTICS_STORAGE_KEY) === "1";
}

/**
 * Flip debug mode and persist the new state to localStorage.
 * Purpose: Shared flag-flip used by each script's own "Toggle Debug Mode"
 * GM_registerMenuCommand handler (menu registration/label/notification
 * stays per-script since it wires into script-specific UI).
 * @ai Preserve shared storage/cache key contracts and TTL behavior.
 * @returns {boolean} The new debug-enabled state.
 */
function toggleDebugMode() {
  const next = isDebugEnabled() ? null : "1";
  if (next) {
    window.localStorage?.setItem(DIAGNOSTICS_STORAGE_KEY, next);
  } else {
    window.localStorage?.removeItem(DIAGNOSTICS_STORAGE_KEY);
  }
  return !!next;
}

// A single isDebugEnabled() gate covers all of these; the tier is just
// which console method is used underneath, so the browser's own DevTools
// console log-level filter (Verbose/Info/Warnings/Errors) decides what's
// actually visible -- no second app-level verbosity flag.
/**
 * Structured debug logger — no-ops unless debug mode is active.
 * Purpose: Provide consistent prefixed console output for module and bus
 * diagnostics without polluting normal page console output.
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} tag  - Short subsystem label shown in brackets.
 * @param {string} msg  - Human-readable message.
 * @param {...*}   rest - Optional extra values forwarded to console.debug.
 */
function dbg(tag, msg, ...rest) {
  if (!isDebugEnabled()) return;
  console.debug(`[${MODULE_PREFIX}:${tag}]`, msg, ...rest);
}
/** Same as dbg(), at Info tier: lifecycle/progress messages. */
function dbgInfo(tag, msg, ...rest) {
  if (!isDebugEnabled()) return;
  console.info(`[${MODULE_PREFIX}:${tag}]`, msg, ...rest);
}
/** Same as dbg(), at Warning tier: recoverable/unexpected conditions. */
function dbgWarn(tag, msg, ...rest) {
  if (!isDebugEnabled()) return;
  console.warn(`[${MODULE_PREFIX}:${tag}]`, msg, ...rest);
}
/** Open a console group tagged like dbg(), but only when debug mode is active. */
function dbgGroup(tag, label) {
  if (!isDebugEnabled()) return;
  console.group(`[${MODULE_PREFIX}:${tag}]`, label);
}
/** Close the current console group, but only when debug mode is active. */
function dbgGroupEnd() {
  if (!isDebugEnabled()) return;
  console.groupEnd();
}

/**
 * Parse a Retry-After header value (delay-seconds, or an HTTP-date) into a
 * millisecond delay.
 * @param {?string} value - Raw Retry-After header value.
 * @returns {?number} Milliseconds to wait, or null if absent/unparseable.
 */
function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/**
 * Decide whether a failed request attempt should be retried, and after how
 * long. Shared by both request wrappers below so the retry policy
 * (retryable-status list, Retry-After handling, backoff curve) is defined
 * exactly once.
 * The method is part of the decision, not just the status. Retrying a write
 * that may already have been applied is a correctness problem, not a
 * performance one, so only SAFE_TO_RETRY_METHODS are retried unless the caller
 * explicitly opts in with retryWrites.
 * @param {object} params
 * @param {?number} params.status - HTTP status, or null/undefined for a network-level failure.
 * @param {number} params.attempt - 1-based current attempt number.
 * @param {?string} [params.retryAfterHeader] - Raw Retry-After header value, if any.
 * @param {string} [params.method] - HTTP method of the request. Defaults to GET
 *   so an omitted method is treated as the safe case it almost always is.
 * @param {boolean} [params.retryWrites] - Opt in to retrying a non-safe method.
 *   Only set this where re-applying the write is known to be harmless.
 * @returns {{retryable: boolean, backoffMs: number}}
 */
function classifyRetry({ status, attempt, retryAfterHeader, method = 'GET', retryWrites = false }) {
  const safeMethod = SAFE_TO_RETRY_METHODS.includes(String(method || 'GET').toUpperCase());
  if (!safeMethod && !retryWrites) return { retryable: false, backoffMs: 0 };
  const retryable = status == null || RETRYABLE_STATUS.includes(status);
  if (!retryable) return { retryable: false, backoffMs: 0 };
  const fromHeader = parseRetryAfterMs(retryAfterHeader);
  const backoffMs = fromHeader != null ? fromHeader : Math.min(1000 * 2 ** (attempt - 1), REQUEST_TIMEOUT_MS);
  return { retryable: true, backoffMs };
}

/**
 * Wrapper over GM_xmlhttpRequest (cross-origin requests) that applies a
 * default timeout and retries transient failures with exponential backoff,
 * honoring a Retry-After response header when the server sends one.
 *
 * Only SAFE_TO_RETRY_METHODS (GET/HEAD) are retried, for both 429/5xx
 * responses and transport-level failures. This previously retried 429/5xx for
 * any method, which meant a write that had already been applied server-side
 * could be re-issued when only the response was lost. Pass retryWrites: true
 * to opt a non-safe method back in where re-applying it is known to be
 * harmless, retryTransportErrors: true to opt a non-safe method into
 * transport-failure retries specifically, or retry: false to disable retries
 * entirely for a call.
 * @param {object} opts - GM_xmlhttpRequest options, plus onload/onerror/
 *   ontimeout callbacks, an optional `retry: false` full opt-out, an optional
 *   `retryWrites: true`, and an optional `retryTransportErrors: true`.
 * @param {number} [attempt] - 1-based current attempt number (internal,
 *   used for backoff calculation on recursive retries).
 */
function gmRequestWithRetry(opts, attempt = 1) {
  const { onload, onerror, ontimeout, retry, retryWrites = false, retryTransportErrors = false, ...rest } = opts;
  const method = (rest.method || 'GET').toUpperCase();
  const transportRetryable = SAFE_TO_RETRY_METHODS.includes(method) || retryWrites || retryTransportErrors;

  const scheduleRetry = (status, retryAfterHeader) => {
    if (retry === false || attempt >= MAX_RETRIES) return false;
    const decision = classifyRetry({ status, attempt, retryAfterHeader, method, retryWrites });
    if (!decision.retryable) return false;
    dbg('http', `Retry ${attempt + 1}/${MAX_RETRIES} in ${decision.backoffMs}ms for`, rest.url);
    setTimeout(() => gmRequestWithRetry(opts, attempt + 1), decision.backoffMs);
    return true;
  };

  GM_xmlhttpRequest({
    timeout: REQUEST_TIMEOUT_MS,
    ...rest,
    onload(r) {
      if (RETRYABLE_STATUS.includes(r.status)) {
        const match = (r.responseHeaders || '').match(/retry-after:\s*(.+)/i);
        if (scheduleRetry(r.status, match ? match[1].trim() : null)) return;
      }
      onload(r);
    },
    onerror(e) {
      if (transportRetryable && scheduleRetry(null, null)) return;
      if (onerror) onerror(e);
    },
    ontimeout(e) {
      if (transportRetryable && scheduleRetry(null, null)) return;
      const handler = ontimeout || onerror;
      if (handler) handler(e);
    },
  });
}

/**
 * fetch() with the same timeout/retry/backoff policy as gmRequestWithRetry,
 * for same-origin calls where GM_xmlhttpRequest isn't needed. Aborts via
 * AbortController on timeout.
 * @param {string} url
 * @param {object} [opts] - fetch() init, plus an optional `retry: false`
 *   full opt-out, an optional `retryWrites: true` and `retryTransportErrors:
 *   true` (see gmRequestWithRetry for semantics), and an optional `timeout`
 *   override (default REQUEST_TIMEOUT_MS). Only GET/HEAD are retried by
 *   default; see SAFE_TO_RETRY_METHODS for why.
 * @param {number} [attempt] - 1-based current attempt number (internal,
 *   used for backoff calculation on recursive retries).
 * @returns {Promise<Response>} Resolves with the Response, including a
 *   non-retried error status (e.g. 404); rejects on a network failure or
 *   timeout once retries are exhausted.
 */
async function fetchWithRetry(url, opts = {}, attempt = 1) {
  const { retry, retryWrites = false, retryTransportErrors = false, timeout = REQUEST_TIMEOUT_MS, ...rest } = opts;
  const method = (rest.method || 'GET').toUpperCase();
  const transportRetryable = SAFE_TO_RETRY_METHODS.includes(method) || retryWrites || retryTransportErrors;

  const attemptRetry = async (status, retryAfterHeader) => {
    if (retry === false || attempt >= MAX_RETRIES) return null;
    const decision = classifyRetry({ status, attempt, retryAfterHeader, method, retryWrites });
    if (!decision.retryable) return null;
    dbg('http', `Retry ${attempt + 1}/${MAX_RETRIES} in ${decision.backoffMs}ms for`, url);
    await new Promise((resolve) => setTimeout(resolve, decision.backoffMs));
    return fetchWithRetry(url, opts, attempt + 1);
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    clearTimeout(timer);
    if (RETRYABLE_STATUS.includes(response.status)) {
      const retried = await attemptRetry(response.status, response.headers.get('retry-after'));
      if (retried) return retried;
    }
    return response;
  } catch (err) {
    clearTimeout(timer);
    if (transportRetryable) {
      const retried = await attemptRetry(null, null);
      if (retried) return retried;
    }
    throw err;
  }
}

// Shared cache namespace (used by DP, FP, CP) for API data deduplication.
// See the header comment above for the origin-isolation caveat.
const SHARED_CACHE_PREFIX = "pdbAdmincom.cache.";
const CACHE_SCHEMA_VERSION = 1;
const CACHE_DEFAULT_TTL_MS = 7.5 * 60 * 60 * 1000;

// In-flight request dedup, keyed by caller-chosen string (typically
// `${fnName}.${id}`). Purely in-memory/per-page-load -- not itself shared
// across scripts or tabs; only collapses concurrent duplicate calls within
// one running script instance while a request is outstanding.
const dataCacheInFlight = new Map();

/**
 * Returns localStorage when available for domain-scoped cache persistence.
 * Purpose: Share cache entries across tabs and page reloads on the same origin.
 * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
 * Builds localStorage key for cached API data (shared namespace).
 * @ai Preserve shared storage/cache key contracts and TTL behavior.
 * @param {string} type - Entity type (asn, org, net, ix, fac, carrier, user, ...).
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
 * Reads cached API data object from localStorage when valid.
 * @ai Preserve shared storage/cache key contracts and TTL behavior.
 * @param {string} type - Entity type (asn, org, net, ix, fac, carrier, user, ...).
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
 * Stores API data object into localStorage cache with TTL/schema metadata.
 * @ai Preserve shared storage/cache key contracts and TTL behavior.
 * @param {string} type - Entity type (asn, org, net, ix, fac, carrier, user, ...).
 * @param {string|number} id - Entity identifier.
 * @param {object} data - Data object to cache.
 * @param {number} [ttlMs=CACHE_DEFAULT_TTL_MS] - Cache time-to-live (milliseconds).
 */
function setCachedDataInStorage(type, id, data, ttlMs = CACHE_DEFAULT_TTL_MS) {
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
 * Negative-cache a missing entity to avoid repeated failed lookups.
 * @ai Preserve shared storage/cache key contracts and TTL behavior.
 * @param {string} type - Entity type (asn, org, net, ix, fac, carrier, user, ...).
 * @param {string|number} id - Entity identifier.
 * @param {number} [ttlMs=1.5 hours] - Cache time-to-live.
 */
function cacheNegativeLookup(type, id, ttlMs = 1.5 * 3600 * 1000) {
  setCachedDataInStorage(type, id, { error: "not_found", timestamp: Date.now() }, ttlMs);
}

/**
 * Checks if a cache entry represents a negative lookup (not found).
 * @ai Preserve shared storage/cache key contracts and TTL behavior.
 * @param {object} cached - Cached data object.
 * @returns {boolean} True if this is a cached "not found" result.
 */
function isNegativeCacheEntry(cached) {
  return cached && cached.error === "not_found";
}
