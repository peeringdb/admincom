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

const DIAGNOSTICS_STORAGE_KEY = "pdbAdmincom.debug";
// Abort a stalled request instead of letting it hang the UI indefinitely.
const REQUEST_TIMEOUT_MS = 15000;
// Transient statuses worth retrying with backoff (rate limit / gateway).
const RETRYABLE_STATUS = [429, 502, 503, 504];
const MAX_RETRIES = 3;

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
 * @param {object} params
 * @param {?number} params.status - HTTP status, or null/undefined for a network-level failure.
 * @param {number} params.attempt - 1-based current attempt number.
 * @param {?string} [params.retryAfterHeader] - Raw Retry-After header value, if any.
 * @returns {{retryable: boolean, backoffMs: number}}
 */
function classifyRetry({ status, attempt, retryAfterHeader }) {
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
 * 429/5xx responses are retried for any method. A transport-level failure
 * (network error/timeout, as opposed to an HTTP error response) is only
 * retried for idempotent GETs by default -- pass retryTransportErrors: true
 * to opt in for a non-GET call known to be safe to replay. Pass retry:
 * false to disable retries entirely for a call.
 * @param {object} opts - GM_xmlhttpRequest options, plus onload/onerror/
 *   ontimeout callbacks, an optional `retry: false` full opt-out, and an
 *   optional `retryTransportErrors: true`.
 * @param {number} [attempt] - 1-based current attempt number (internal,
 *   used for backoff calculation on recursive retries).
 */
function gmRequestWithRetry(opts, attempt = 1) {
  const { onload, onerror, ontimeout, retry, retryTransportErrors = false, ...rest } = opts;
  const transportRetryable = (rest.method || 'GET').toUpperCase() === 'GET' || retryTransportErrors;

  const scheduleRetry = (status, retryAfterHeader) => {
    if (retry === false || attempt >= MAX_RETRIES) return false;
    const decision = classifyRetry({ status, attempt, retryAfterHeader });
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
 *   full opt-out, an optional `retryTransportErrors: true` (see
 *   gmRequestWithRetry for semantics), and an optional `timeout` override
 *   (default REQUEST_TIMEOUT_MS).
 * @param {number} [attempt] - 1-based current attempt number (internal,
 *   used for backoff calculation on recursive retries).
 * @returns {Promise<Response>} Resolves with the Response, including a
 *   non-retried error status (e.g. 404); rejects on a network failure or
 *   timeout once retries are exhausted.
 */
async function fetchWithRetry(url, opts = {}, attempt = 1) {
  const { retry, retryTransportErrors = false, timeout = REQUEST_TIMEOUT_MS, ...rest } = opts;
  const transportRetryable = (rest.method || 'GET').toUpperCase() === 'GET' || retryTransportErrors;

  const attemptRetry = async (status, retryAfterHeader) => {
    if (retry === false || attempt >= MAX_RETRIES) return null;
    const decision = classifyRetry({ status, attempt, retryAfterHeader });
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
