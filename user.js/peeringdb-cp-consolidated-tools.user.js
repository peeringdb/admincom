// ==UserScript==
// @name         PeeringDB CP - Consolidated Tools
// @namespace    https://www.peeringdb.com/cp/
// @version      2.0.173.20260413
// @description  Consolidated CP userscript with strict route-isolated modules for facility/network/user/entity workflows
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/cp/peeringdb_server/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_setClipboard
// @run-at       document-end
// @connect      data.iana.org
// @connect      rdap.arin.net
// @connect      rdap.db.ripe.net
// @connect      rdap.apnic.net
// @connect      rdap.lacnic.net
// @connect      rdap.afrinic.net
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-consolidated-tools.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-consolidated-tools.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==

// AI Maintenance Notes (Copilot/Claude):
// - Preserve existing route matching and module boundaries.
// - Prefer minimal, localized edits; avoid broad refactors.
// - Keep grants/connect metadata aligned with actual usage.
// - Preserve shared storage key names and cache namespace compatibility.
// - Validate with syntax checks after edits.
// CP scope:
// - This script owns admin workflows and RDAP fallback client behavior.
// - RDAP ownership is CP-only; do not assume FP/DP parity.

(function () {
  "use strict";

  const MODULE_PREFIX = "pdbCpConsolidated";
  const SCRIPT_VERSION = "2.0.173.20260413";

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
  const FEATURE_FLAGS = Object.freeze({
    debugMode: true,
    moduleDispatch: true,
    orgUpdateAuditLog: true,
  });
  const DISABLED_MODULES_STORAGE_KEY = `${MODULE_PREFIX}.disabledModules`;
  const ORG_UPDATE_AUDIT_LOG_STORAGE_KEY = `${MODULE_PREFIX}.orgUpdateAuditLog`;
  const ORG_UPDATE_AUDIT_LOG_MAX_ITEMS = 30;
  const DEFAULT_REQUEST_USER_AGENT = "PeeringDB-Admincom-CP-Consolidated";
  const PEERINGDB_API_BASE_URL = window.location.origin + "/api";
  const PDB_API_TIMEOUT_MS = 12000;
  const PDB_API_RETRIES = 1;
  const CACHE_TTL_MS = 7.5 * 60 * 60 * 1000;
  const ORG_NAME_CACHE_STORAGE_PREFIX = `${MODULE_PREFIX}.orgNameCache.`;
  const NETWORK_NAME_CACHE_KEY = `${MODULE_PREFIX}.networkNameCache`;
  const NETWORK_NAME_SCAN_CACHE_KEY = `${MODULE_PREFIX}.networkNameScanCache`;
  const NETWORK_NAME_SCAN_CACHE_TTL_MS = CACHE_TTL_MS;
  const NETWORK_NAME_SCAN_ANALYSIS_VERSION = 3;
  const NETWORK_UPDATE_NAME_RETRY_STORAGE_PREFIX = `${MODULE_PREFIX}.networkUpdateNameRetry.`;
  const NETWORK_UPDATE_NAME_RETRY_TTL_MS = 15 * 60 * 1000;
  const NETWORK_DELETE_CONFIRM_STORAGE_PREFIX = `${MODULE_PREFIX}.networkDeleteConfirm.`;
  const NETWORK_DELETE_CONFIRM_TTL_MS = 5 * 60 * 1000;
  const POST_UPDATE_NAME_HISTORY_REDIRECT_STORAGE_KEY = `${MODULE_PREFIX}.postUpdateNameHistoryRedirect`;
  const POST_UPDATE_NAME_HISTORY_REDIRECT_TTL_MS = 10 * 60 * 1000;
  const ORG_NAME_CACHE_TTL_MS = CACHE_TTL_MS;
  const NETWORK_NAME_CACHE_TTL_MS = CACHE_TTL_MS;
  const NETWORK_NAME_SCAN_PAGE_SIZE = 2000;
  const NETWORK_NAME_SCAN_TARGET_COUNT = 0;
  const NETWORK_NAME_SCAN_MAX_REQUESTS = 40;
  const NETWORK_NAME_SCAN_MIN_SUSPICIOUS_SCORE = 14;
  const NETWORK_NAME_SCAN_HIGH_CONFIDENCE_MIN_SCORE = 20;
  /**
   * Increment this integer whenever the shape of a stored org-name cache entry changes.
   * On first read after a script update, any entry whose stored v field does not match
   * is treated as stale and evicted, preventing silent misreads of old formats.
   */
  const ORG_NAME_CACHE_SCHEMA_VERSION = 1;
  const ENTITY_TYPES = new Set([
    "facility",
    "network",
    "organization",
    "carrier",
    "internetexchange",
    "campus",
  ]);
  const COPY_FIELD_DENY_LABELS = new Set([
    "logo",
    "manual ix-f import request",
    "manual ix-f import status",
    "status",
    "social media",
    "ixf import request user",
    "number of facilities at this exchange",
    "number of networks at this exchange",
    "version",
    "ixf import history",
    "ix-f network count",
    "unicast ipv4",
    "unicast ipv6",
    "multicast",
    "ix-f member export url visibility",
    "id",
    "ixf ixp import enabled",
    "ix-f error",
    "ix-f sent ips for unsupported protocol",
    "ixf import attempt info",
  ]);
  const COPY_FIELD_CONDITIONAL_EMPTY_LABELS = new Set([
    "technical phone",
    "policy phone",
    "sales phone",
    "technical email",
    "policy email",
    "sales email",
  ]);
  const orgNameMemoryCache = new Map();
  let networkNameDataMemoryCache = null;
  let networkNameScanMemoryCache = null;
  const activeActionLocks = new Set();
  const openDropdownActionItems = new Set();
  const moduleDisposers = new Map();
  const pendingDomUpdates = new Map();
  const malformedApiPayloadWarnings = new Set();
  const lastFetchFailureByUrl = new Map();
  const ENTITY_STATE_BACKGROUND_CLASS_NAMES = [
    `${MODULE_PREFIX}StateDummyChild`,
    `${MODULE_PREFIX}StatePending`,
    `${MODULE_PREFIX}StateDeleted`,
  ];

  /**
   * Entity types that derive their Update Name value from the current #id_name field
   * rather than resolving it via the organization API.
   */
  const ENTITY_TYPES_OWN_NAME = new Set(["organization", "facility", "internetexchange"]);

  /**
   * Unified entity slug mapping for frontend URLs and API resource paths.
   * getFrontendSlugByEntity delegates to this map.
   */
  const ENTITY_SLUG_MAP = {
    facility: "fac",
    network: "net",
    organization: "org",
    carrier: "carrier",
    internetexchange: "ix",
    campus: "campus",
  };

  /**
   * Hard-excluded entity IDs for Example Organization records.
   * Extend by appending IDs to the relevant Set.
   */
  const HARD_EXCLUDED_ENTITY_IDS = {
    network: new Set(["32281", "666", "31754", "29032", "14185", "2858", "24084", "10664"]),
    internetexchange: new Set(["4095"]),
    organization: new Set(["25554", "34028", String(DUMMY_ORG_ID), "31503"]),
    facility: new Set(["13346", "13399"]),
    carrier: new Set(["66"]),
    campus: new Set(["25"]),
  };

  /**
   * Normalizes route aliases to canonical CP entity keys.
   */
  const HARD_EXCLUDED_ENTITY_ALIASES = {
    fac: "facility",
    net: "network",
    org: "organization",
    ix: "internetexchange",
    carrier: "carrier",
    campus: "campus",
    facility: "facility",
    network: "network",
    organization: "organization",
    internetexchange: "internetexchange",
  };

  /**
   * API resource mapping by CP entity type.
   * Includes additional CP object types exposed by PeeringDB OpenAPI endpoints.
   */
  const ENTITY_API_RESOURCE_MAP = {
    ...ENTITY_SLUG_MAP,
    networkcontact: "poc",
    networkfacility: "netfac",
    networkixlan: "netixlan",
    internetexchangefacility: "ixfac",
    ixlan: "ixlan",
    ixlanprefix: "ixpfx",
    carrierfacility: "carrierfac",
  };
  const OPENAPI_KNOWN_RESOURCE_SLUGS = new Set([
    "org",
    "fac",
    "net",
    "ix",
    "carrier",
    "campus",
    "poc",
    "netfac",
    "netixlan",
    "ixfac",
    "ixlan",
    "ixpfx",
    "carrierfac",
  ]);

  /**
   * Django admin inline-set DOM ID prefixes for network child relations.
   * Used by markDeletedNetworkInlinesForDeletion to iterate all inline sets.
   */
  const NETWORK_INLINE_SET_PREFIXES = ["poc_set", "netfac_set", "netixlan_set"];

  /**
   * Deterministic left-to-right priority order for the primary CP toolbar.
   * Items not matched by any entry are left in their original relative order.
   */
  const TOOLBAR_PRIMARY_ORDER = [
    `li[data-pdb-cp-action="${MODULE_PREFIX}ObjTypeWebsite"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}ObjOrgWebsite"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}NetworkIxlanNetCp"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}NetworkIxlanIxCp"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}NetworkIxlanOrgCp"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}ApiJson"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}ResetNetworkInformation"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}Frontend"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}OrganizationFrontend"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}OrganizationCp"]`,
    `li[data-pdb-cp-action="${MODULE_PREFIX}InternetExchangeIxlanPrefixCp"]`,
    isHistoryToolbarItem,
  ];

  /**
   * Deterministic left-to-right priority order for the secondary action row.
   * Items not matched by any entry are left in their original relative order.
   */
  const TOOLBAR_SECONDARY_ORDER = [
    `li[data-pdb-cp-secondary-action="${MODULE_PREFIX}UpdateEntityName"]`,
    `li[data-pdb-cp-secondary-action="${MODULE_PREFIX}FacilityAdvancedSearchLink"]`,
    `li[data-pdb-cp-secondary-action="${MODULE_PREFIX}MapsDropdown"]`,
    `li[data-pdb-cp-secondary-action="${MODULE_PREFIX}CopyEntityUrl"]`,
    `li[data-pdb-cp-secondary-action="${MODULE_PREFIX}CopyUserProfileUrl"]`,
    `li[data-pdb-cp-secondary-action="${MODULE_PREFIX}CopyOrganizationUrl"]`,
  ];
  const CP_LIST_PAGE_ACTION_LABELS = {
    ANALYZE_NETWORK_NAMES: "Analyze Network Names",
    COPY_CHANGE_LINKS: "Copy Change Links",
  };
  let dropdownGlobalCloseListenerBound = false;

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

  /**
   * Computes a single EntityVisualState model for the current page context.
   * Purpose: Provide one authoritative source of truth for all state-driven visuals.
   * Necessity: Background, title markers, and future features derive from the same
   * state data. Computing it once prevents drift and redundant DOM/field reads.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {object} ctx - Route context from getRouteContext().
   * @returns {{ state: string, entity: string, status: string,
   *             isDummyChildFacility: boolean }}
   */
  function resolveEntityVisualState(ctx) {
    const entity = String(ctx?.entity || "").trim().toLowerCase();
    const status = String(getSelectedStatus() || "").trim().toLowerCase();
    const orgId = Number.parseInt(getInputValue("#id_org"), 10);
    const isDummyChildFacility =
      entity === "facility" && Number.isFinite(orgId) && orgId === DUMMY_ORG_ID;

    let state = "normal";
    if (isDummyChildFacility) {
      state = "dummy-child";
    } else if (status === "pending") {
      state = "pending";
    } else if (status === "deleted") {
      state = "deleted";
    }

    return { state, entity, status, isDummyChildFacility };
  }

  /**
   * Ensures CSS classes for entity-state background highlighting are available.
   * Purpose: Centralize state background colors in one style block instead of inline colors.
   * Necessity: Keeps state precedence predictable and easy to maintain across modules.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function ensureEntityStateBackgroundStyles() {
    const styleId = `${MODULE_PREFIX}EntityStateBackgroundStyle`;
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #grp-content.${MODULE_PREFIX}StateDummyChild {
        background-color: rgba(255, 235, 59, 0.22);
      }

      #grp-content.${MODULE_PREFIX}StatePending {
        background-color: rgba(255, 152, 0, 0.16);
      }

      #grp-content.${MODULE_PREFIX}StateDeleted {
        background-color: rgba(200, 30, 30, 0.1);
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Applies entity background-state class using explicit priority and entity scope.
   * Priority (first match wins):
   * 1) CHILD OF DUMMY ORGANIZATION (facility only)
   * 2) pending (all entities)
   * 3) deleted (all entities)
   * Purpose: Align visual background behavior with policy-defined ordering.
   * Necessity: Inline per-module background changes can conflict and obscure precedence.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ entity: string, status: string, isDummyChildFacility: boolean }} ctx - Route context.
   */
  function applyEntityStateBackgroundClass(ctx) {
    const bgContainer = qs("#grp-content");
    if (!bgContainer) return;

    ensureEntityStateBackgroundStyles();
    ENTITY_STATE_BACKGROUND_CLASS_NAMES.forEach((className) => {
      bgContainer.classList.remove(className);
    });

    const { state } = resolveEntityVisualState(ctx);

    const classMap = {
      "dummy-child": `${MODULE_PREFIX}StateDummyChild`,
      "pending":     `${MODULE_PREFIX}StatePending`,
      "deleted":     `${MODULE_PREFIX}StateDeleted`,
    };

    const targetClass = classMap[state];
    if (targetClass) {
      bgContainer.classList.add(targetClass);
    }
  }

  /**
   * Synchronizes title markers for dummy-facility and deleted states.
   * Purpose: Keep heading markers accurate as admins edit status/org fields in-place.
   * Necessity: Marker rendering previously relied on module-local one-time insertions.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ entity: string }} ctx - Route context used to resolve the current visual state.
   */
  function syncEntityStateTitleMarkers(ctx) {
    const title = qs("#grp-content-title h1");
    if (!title) return;

    const { state } = resolveEntityVisualState(ctx);

    const dummyMarkerClass = "pdb-dummy-org-child-marker";
    const pendingBadgeClass = "pdb-pending-badge";
    const deletedBadgeClass = "pdb-deleted-badge";

    const existingDummyMarker = qs(`.${dummyMarkerClass}`, title);
    if (state === "dummy-child") {
      if (!existingDummyMarker) {
        const marker = document.createElement("span");
        marker.className = dummyMarkerClass;
        marker.style.cssText =
          "margin-left:10px;color:red;font-weight:bold;font-size:0.8em;letter-spacing:0.02em;vertical-align:middle;";
        marker.textContent = "CHILD OF DUMMY ORGANIZATION";
        title.appendChild(marker);
      }
    } else if (existingDummyMarker) {
      existingDummyMarker.remove();
    }

    const existingPendingBadge = qs(`.${pendingBadgeClass}`, title);
    if (state === "pending") {
      if (!existingPendingBadge) {
        const badge = document.createElement("span");
        badge.className = pendingBadgeClass;
        badge.style.cssText =
          "margin-left:10px;color:#e65c00;font-weight:bold;font-size:0.8em;letter-spacing:0.05em;vertical-align:middle;";
        badge.textContent = "PENDING";
        title.appendChild(badge);
      }
    } else if (existingPendingBadge) {
      existingPendingBadge.remove();
    }

    const existingDeletedBadge = qs(`.${deletedBadgeClass}`, title);
    if (state === "deleted") {
      if (!existingDeletedBadge) {
        const badge = document.createElement("span");
        badge.className = deletedBadgeClass;
        badge.style.cssText =
          "margin-left:10px;color:#c0392b;font-weight:bold;font-size:0.8em;letter-spacing:0.05em;vertical-align:middle;";
        badge.textContent = "DELETED";
        title.appendChild(badge);
      }
    } else if (existingDeletedBadge) {
      existingDeletedBadge.remove();
    }
  }

  /**
   * Subscribes to pdbBus status/org events to keep entity-state visuals in sync.
   * Purpose: Refresh state highlighting when admins change status or org while editing.
   * Necessity: Without listeners, styling only reflects the state at initial page load.
   * Returns a dispose function that unsubscribes from the bus (lifecycle support).
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ entity: string }} ctx - Route context passed through to refresh callbacks.
   * @returns {Function|null} Dispose function that removes bus subscriptions, or null.
   */
  function bindEntityStateBackgroundReactivity(ctx) {
    const statusSelect = qs("#id_status");
    if (!statusSelect || statusSelect.hasAttribute("data-pdb-cp-state-bg-bound")) return null;
    statusSelect.setAttribute("data-pdb-cp-state-bg-bound", "1");

    const refresh = () => {
      scheduleDomUpdate("entity-state-visuals", () => {
        applyEntityStateBackgroundClass(ctx);
        syncEntityStateTitleMarkers(ctx);
      });
    };

    pdbBus.on("statusChanged", refresh);
    pdbBus.on("orgChanged", refresh);

    return () => {
      pdbBus.off("statusChanged", refresh);
      pdbBus.off("orgChanged", refresh);
      qs("#id_status")?.removeAttribute("data-pdb-cp-state-bg-bound");
    };
  }

  /**
   * Closes a single dropdown action item and resets its toggle accessibility state.
   * Purpose: Provide centralized close behavior for toolbar and secondary-row dropdowns.
   * Necessity: Shared close logic prevents duplicated listener code per dropdown instance.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {HTMLLIElement} listItem - The dropdown list item to close.
   */
  function closeDropdownActionItem(listItem) {
    if (!listItem) return;

    const toggle = qs("a[id]", listItem);
    const menu = qs(":scope > div", listItem);
    if (menu) {
      menu.style.display = "none";
    }

    if (toggle) {
      toggle.setAttribute("aria-expanded", "false");
    }

    listItem.removeAttribute("data-open");
    listItem.style.zIndex = "";
    openDropdownActionItems.delete(listItem);
  }

  /**
   * Closes all open dropdowns except an optional exempt item.
   * Purpose: Enforce single-open-dropdown behavior across custom CP action menus.
   * Necessity: Simplifies global click/escape handling and keeps UI predictable.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {HTMLLIElement|null} [exemptItem=null] - Optional item to leave open.
   */
  function closeAllDropdownActionItems(exemptItem = null) {
    Array.from(openDropdownActionItems).forEach((listItem) => {
      if (exemptItem && listItem === exemptItem) return;
      closeDropdownActionItem(listItem);
    });
  }

  /**
   * Registers one global listener pair for dropdown close behavior.
   * Purpose: Replace per-dropdown document listeners with one shared close handler.
   * Necessity: Reduces global event listener count and improves maintainability.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function ensureDropdownGlobalCloseListener() {
    if (dropdownGlobalCloseListenerBound) return;
    dropdownGlobalCloseListenerBound = true;

    document.addEventListener("click", (event) => {
      const target = event?.target;
      const activeItems = Array.from(openDropdownActionItems);
      if (!activeItems.length) return;

      const clickedInsideAnyOpenItem = activeItems.some((listItem) => listItem.contains(target));
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
   * Attempts to acquire a named action lock.
   * Purpose: Prevent duplicate execution for long-running script-driven actions.
   * Necessity: Double clicks or repeated menu triggers can race and produce duplicate saves.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   * @param {string} lockKey - Unique identifier for the action being locked.
   * @returns {boolean} True when the lock was acquired; false if already held.
   */
  function tryBeginActionLock(lockKey) {
    const normalizedKey = String(lockKey || "").trim();
    if (!normalizedKey) return false;
    if (activeActionLocks.has(normalizedKey)) return false;

    activeActionLocks.add(normalizedKey);
    return true;
  }

  /**
   * Releases a previously acquired action lock.
   * Purpose: Re-enable action execution after async work completes.
   * Necessity: Locks must always be released to avoid permanent action blocking.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   * @param {string} lockKey - Unique identifier for the lock to release.
   */
  function endActionLock(lockKey) {
    const normalizedKey = String(lockKey || "").trim();
    if (!normalizedKey) return;
    activeActionLocks.delete(normalizedKey);
  }

  /**
   * Returns true when diagnostics/debug mode is enabled via localStorage.
   * Purpose: Gate verbose console output behind an opt-in flag so normal
   * production use is silent.
  * Toggle with: localStorage.setItem('pdbAdmincom.debug', '1')
   *   or via the Tampermonkey menu command "CP: Toggle Debug Mode".
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {boolean} True when debug mode is active.
   */
  function isDebugEnabled() {
    return isFeatureEnabled("debugMode") && window.localStorage?.getItem(DIAGNOSTICS_STORAGE_KEY) === "1";
  }

  /**
   * Structured debug logger — no-ops unless debug mode is active.
   * Purpose: Provide consistent prefixed console output for module and
   * bus diagnostics without polluting normal page console output.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} tag  - short subsystem label shown in brackets.
   * @param {string} msg  - human-readable message.
   * @param {...*}   rest - optional extra values forwarded to console.debug.
   */
  function dbg(tag, msg, ...rest) {
    if (!isDebugEnabled()) return;
    console.debug(`[${MODULE_PREFIX}:${tag}]`, msg, ...rest);
  }

  /**
   * Persists a lightweight org-update success audit entry.
   * Purpose: Keep a short local history to simplify regression triage.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ orgId: string, name: string, aka?: string }} entry - Successful update entry.
   */
  function appendOrgUpdateSuccessAuditEntry(entry) {
    if (!isFeatureEnabled("orgUpdateAuditLog")) return;

    const storage = getDomainCacheStorage();
    if (!storage) return;

    const item = {
      ts: new Date().toISOString(),
      orgId: String(entry?.orgId || "").trim(),
      name: String(entry?.name || "").trim(),
      aka: String(entry?.aka || "").trim(),
      version: SCRIPT_VERSION,
    };

    if (!item.orgId || !item.name) return;

    try {
      const raw = String(storage.getItem(ORG_UPDATE_AUDIT_LOG_STORAGE_KEY) || "").trim();
      const current = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(current) ? current : [];
      list.unshift(item);
      const compact = list.slice(0, ORG_UPDATE_AUDIT_LOG_MAX_ITEMS);
      storage.setItem(ORG_UPDATE_AUDIT_LOG_STORAGE_KEY, JSON.stringify(compact));

      dbg("org-audit", "org update success recorded", item);
    } catch (_error) {
      // Ignore persistence errors; audit logging should never break update flow.
    }
  }

  /**
   * Returns storage for domain-scoped cache entries.
   * Purpose: Share short-lived cache payloads across tabs on the same origin.
   * Necessity: tab-scoped storage breaks cross-tab consistency; localStorage enables cross-tab reuse.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @returns {Storage|null} localStorage instance, or null when unavailable.
   */
  function getDomainCacheStorage() {
    try {
      if (window.localStorage) return window.localStorage;
    } catch (_error) {
      // Ignore; cache persistence will be unavailable.
    }

    return null;
  }

  /**
  * Returns storage for tab-scoped transient state.
  * Purpose: Provide optional per-tab persistence for ephemeral state when needed.
  * Necessity: Some flows benefit from tab-local fallback storage that does not
  * leak across tabs on the same origin.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @returns {Storage|null} sessionStorage instance, or null when unavailable.
   */
  function getTabSessionStorage() {
    try {
      if (window.sessionStorage) return window.sessionStorage;
    } catch (_error) {
      // Ignore; tab-session persistence will be unavailable.
    }

    return null;
  }

  /**
   * Normalizes organization ID into a stable cache key suffix.
   * Purpose: Ensure cache keys are deterministic across string/number ID inputs.
   * Necessity: Different call sites may pass IDs with whitespace or mixed types.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} orgId - Raw organization ID from form field or API response.
   * @returns {string} Trimmed string representation of the org ID.
   */
  function normalizeOrgIdForCache(orgId) {
    return String(orgId || "").trim();
  }

  /**
   * Builds storage key used for persisted org-name cache entries.
   * Purpose: Keep all org-name cache keys namespaced under module prefix.
   * Necessity: Avoid collisions with other userscripts and local app storage keys.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} orgId - Organization ID to build the key for.
   * @returns {string} Namespaced storage key, or empty string if orgId is invalid.
   */
  function getOrgNameCacheStorageKey(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return "";
    return `${ORG_NAME_CACHE_STORAGE_PREFIX}${normalizedOrgId}`;
  }

  /**
   * Reads a valid organization-name cache entry from in-memory or domain storage.
   * Purpose: Reuse recent org-name lookups to reduce repeated API requests.
   * Necessity: Update Name and Reset Information may request the same org repeatedly.
   * Returns null when cache is absent, malformed, or expired.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} orgId - Organization ID to look up.
   * @returns {string|null} Cached organization name, or null on miss/expiry/malform.
   */
  function getCachedOrganizationName(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return null;

    const now = Date.now();

    const memoryEntry = orgNameMemoryCache.get(normalizedOrgId);
    if (memoryEntry && memoryEntry.expiresAt > now && memoryEntry.name) {
      return memoryEntry.name;
    }

    if (memoryEntry && memoryEntry.expiresAt <= now) {
      orgNameMemoryCache.delete(normalizedOrgId);
    }

    const storageKey = getOrgNameCacheStorageKey(normalizedOrgId);
    if (!storageKey) return null;

    try {
      const storage = getDomainCacheStorage();
      const raw = storage?.getItem(storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const cachedName = String(parsed?.name || "").trim();
      const expiresAt = Number(parsed?.expiresAt || 0);
      const schemaVersion = Number(parsed?.v ?? -1);
      if (
        !cachedName ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        schemaVersion !== ORG_NAME_CACHE_SCHEMA_VERSION
      ) {
        storage?.removeItem(storageKey);
        return null;
      }

      orgNameMemoryCache.set(normalizedOrgId, { name: cachedName, expiresAt });
      return cachedName;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Stores organization-name cache entry in memory and domain storage.
   * Purpose: Persist successful org-name lookups for current tab lifecycle.
   * Necessity: Avoid duplicate network requests for frequently used org IDs.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} orgId - Organization ID to cache the name for.
   * @param {string} name - Resolved organization name to persist.
   */
  function setCachedOrganizationName(orgId, name) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    const normalizedName = String(name || "").trim();
    if (!normalizedOrgId || !normalizedName) return;

    const expiresAt = Date.now() + ORG_NAME_CACHE_TTL_MS;
    orgNameMemoryCache.set(normalizedOrgId, { name: normalizedName, expiresAt });

    const storageKey = getOrgNameCacheStorageKey(normalizedOrgId);
    if (!storageKey) return;

    try {
      const storage = getDomainCacheStorage();
      storage?.setItem(
        storageKey,
        JSON.stringify({ v: ORG_NAME_CACHE_SCHEMA_VERSION, name: normalizedName, expiresAt }),
      );
    } catch (_error) {
      // Storage may be unavailable; memory cache still provides benefit.
    }
  }

  /**
   * Clears all organization-name cache entries from memory and domain storage.
   * Purpose: Provide explicit cache invalidation control for stale org-name lookups.
   * Necessity: Admin workflows occasionally require immediate refresh after org renames.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   */
  function clearOrganizationNameCache() {
    orgNameMemoryCache.clear();

    try {
      const storage = getDomainCacheStorage();
      if (!storage) return;

      const keysToDelete = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && key.startsWith(ORG_NAME_CACHE_STORAGE_PREFIX)) {
          keysToDelete.push(key);
        }
      }

      keysToDelete.forEach((key) => {
        storage.removeItem(key);
      });
    } catch (_error) {
      // Ignore storage failures; in-memory cache is still cleared.
    }
  }

  /**
   * Retrieves the set of disabled module IDs from localStorage.
   * Purpose: Allows individual modules to be toggled on/off without code changes.
   * Necessity: Provides user-level module control for the modular architecture.
   * Supports both JSON array and comma-separated formats for backward compatibility.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   * @returns {Set<string>} Set of module ID strings that are currently disabled.
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
   * @param {string} moduleId - The module identifier to check.
   * @param {Set<string>} disabledModules - Set of currently disabled module IDs.
   * @returns {boolean} True when the module is enabled (not in the disabled set).
   */
  function isModuleEnabled(moduleId, disabledModules) {
    if (!moduleId) return false;
    if (!isFeatureEnabled("moduleDispatch")) return false;
    return !disabledModules.has(moduleId);
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
      domainText = domainText.slice(1, -1);  // Strip IPv6 URI brackets
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
   * Constructs HTTP headers for Tampermonkey requests with User-Agent.
   * Purpose: Centralize header building for all script-initiated requests.
   * Necessity: Ensures consistent User-Agent and other important headers across all API calls.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} [baseHeaders={}] - Optional base headers to merge with generated ones.
   * @returns {object} Header object with User-Agent key populated.
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
   * Returns a copy of headers safe to pass into fetch().
   * Purpose: Remove forbidden header names that browsers block in fetch.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object} headers - Source headers object.
   * @returns {object} Fetch-safe headers object.
   */
  function getFetchSafeHeaders(headers) {
    const source = headers && typeof headers === "object" ? headers : {};
    const sanitized = { ...source };
    delete sanitized["User-Agent"];
    delete sanitized["user-agent"];
    return sanitized;
  }

  /**
   * Reads a cookie value by name from document.cookie.
   * Purpose: Retrieve CSRF token for authenticated state-changing API requests.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string} name - Cookie name to look up.
   * @returns {string} Decoded cookie value or empty string when missing.
   */
  function getCookieValue(name) {
    const key = String(name || "").trim();
    if (!key) return "";

    const cookieText = String(document.cookie || "");
    if (!cookieText) return "";

    const cookies = cookieText.split(";");
    for (const item of cookies) {
      const [rawKey, ...rest] = item.split("=");
      if (String(rawKey || "").trim() !== key) continue;
      return decodeURIComponent(rest.join("=") || "");
    }

    return "";
  }

  /**
   * Resolves CSRF token from common cookie and DOM locations.
   * Purpose: Ensure authenticated mutation requests can pass Django CSRF checks.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {string} CSRF token string, or empty string if unavailable.
   */
  function getCsrfToken() {
    const cookieCandidates = ["csrftoken", "csrf", "CSRF-TOKEN", "XSRF-TOKEN"];
    for (const candidate of cookieCandidates) {
      const value = getCookieValue(candidate);
      if (value) return value;
    }

    const inputToken = String(
      qs("input[name='csrfmiddlewaretoken']")?.value ||
      qs("form input[name='csrfmiddlewaretoken']")?.value ||
      "",
    ).trim();
    if (inputToken) return inputToken;

    const metaToken = String(
      qs("meta[name='csrf-token']")?.getAttribute("content") ||
      qs("meta[name='csrfmiddlewaretoken']")?.getAttribute("content") ||
      "",
    ).trim();
    if (metaToken) return metaToken;

    return "";
  }

  /**
   * Extracts a header value from raw response headers text.
   * Purpose: Retrieve server-provided diagnostics (e.g., x-auth-status) from GM responses.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} rawHeaders - Raw response headers string.
   * @param {string} headerName - Header name to find (case-insensitive).
   * @returns {string} Header value, or empty string when absent.
   */
  function getHeaderValueFromRawHeaders(rawHeaders, headerName) {
    const raw = String(rawHeaders || "");
    const target = String(headerName || "").trim().toLowerCase();
    if (!raw || !target) return "";

    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      if (key !== target) continue;
      return line.slice(idx + 1).trim();
    }

    return "";
  }

  /**
   * Logs outgoing request UA for external URIs when debug mode is enabled.
   * Purpose: Provide per-request UA visibility for RDAP/bootstrap troubleshooting.
   * Necessity: External requests can behave differently based on the effective UA.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ method: string, url: string, headers: object, attempt?: number, retries?: number, mode?: string }} meta
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

    if (hostname === window.location.hostname) return;

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
   * Emits current User-Agent details to debug console when diagnostics are enabled.
   * Purpose: Make it easy to verify which UA is currently active and why.
   * Necessity: Debugging remote API behavior often depends on the effective UA value.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {boolean} True when a log was emitted; false when debug mode is disabled.
   */
  function logCurrentUserAgentDebug() {
    if (!isDebugEnabled()) return false;

    const sharedConfigured = String(window.localStorage?.getItem(SHARED_USER_AGENT_STORAGE_KEY) || "").trim();
    const host = String(window.location?.hostname || "").trim().toLowerCase();
    const trusted = isDomainTrusted(host);
    const source = sharedConfigured ? "shared" : "auto";
    const effectiveUserAgent = getCustomRequestUserAgent();

    const payload = {
      source,
      trustedDomain: trusted,
      host,
      userAgent: effectiveUserAgent,
    };

    // Use info-level output so the message is visible even when DevTools hides debug-level logs.
    console.info(`[${MODULE_PREFIX}:ua] effective User-Agent`, payload);
    dbg("ua", "effective User-Agent", payload);
    return true;
  }

  /**
   * Parses the current window URL into a structured CP route context object.
   * Purpose: Provide a single authoritative source of routing data for all modules.
   * Necessity: Multiple modules need entity type, entity ID, and page kind without
   * re-parsing the URL each time — centralizing parsing prevents divergent path logic.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   * @returns {{ host: string, path: string[], pathName: string, isCp: boolean,
   *             entity: string, entityId: string, pageKind: string,
   *             isEntityChangePage: boolean, isEntityListPage: boolean }}
   */
  function getRouteContext() {
    const path = window.location.pathname.replace(/(^\/|\/$)/g, "").split("/");
    return {
      host: window.location.hostname,
      path,
      pathName: window.location.pathname,
      isCp: path[0] === "cp" && path[1] === "peeringdb_server",
      entity: path[2] || "",
      entityId: path[3] || "",
      pageKind: path[4] || "",
      isEntityChangePage:
        path[0] === "cp" && path[1] === "peeringdb_server" && path[4] === "change",
      isEntityListPage:
        path[0] === "cp" && path[1] === "peeringdb_server" && Boolean(path[2]) && !path[3],
    };
  }

  /**
   * Resolves canonical entity key for hard-exclude checks.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} entity - Route entity segment.
   * @returns {string} Canonical entity key, or empty string if unsupported.
   */
  function normalizeEntityTypeForHardExclude(entity) {
    const normalized = String(entity || "").trim().toLowerCase();
    return HARD_EXCLUDED_ENTITY_ALIASES[normalized] || "";
  }

  /**
   * Returns exclusion metadata when current route is hard-excluded.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ isEntityChangePage: boolean, entity: string, entityId: string }} ctx - Route context.
   * @returns {{ entityType: string, entityId: string }|null} Exclusion info or null.
   */
  function getHardExcludedEntityInfo(ctx) {
    if (!ctx?.isEntityChangePage) return null;

    const entityType = normalizeEntityTypeForHardExclude(ctx.entity);
    const entityId = String(ctx.entityId || "").trim();
    if (!entityType || !entityId) return null;

    const excludedIds = HARD_EXCLUDED_ENTITY_IDS[entityType];
    if (!excludedIds || !excludedIds.has(entityId)) return null;

    return { entityType, entityId };
  }

  /**
   * Returns true when script-driven write/change actions must be blocked.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   * @param {{ isEntityChangePage: boolean, entity: string, entityId: string }} ctx - Route context.
   * @returns {boolean} True when write/change actions are disallowed for this entity.
   */
  function isWriteActionBlockedForHardExcludedEntity(ctx) {
    return Boolean(getHardExcludedEntityInfo(ctx));
  }

  /**
   * Notifies user that write/change action is blocked for hard-excluded entities.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   * @param {string} actionLabel - Human-readable action label.
   * @param {{ isEntityChangePage: boolean, entity: string, entityId: string }} ctx - Route context.
   */
  function notifyWriteActionBlockedForHardExcludedEntity(actionLabel, ctx) {
    const hardExcludedEntity = getHardExcludedEntityInfo(ctx);
    const entityText = hardExcludedEntity
      ? `${hardExcludedEntity.entityType}#${hardExcludedEntity.entityId}`
      : `${String(ctx?.entity || "entity")}#${String(ctx?.entityId || "")}`;
    notifyUser({
      title: "PeeringDB CP",
      text: `${String(actionLabel || "Write action")}: blocked for hard-excluded ${entityText}. Read/view actions remain allowed.`,
    });
  }

  /**
   * Schedules a keyed DOM write callback via requestAnimationFrame with deduplication.
   * Purpose: Coalesce rapid event-driven DOM updates (e.g. typing in status/org) into a
   * single paint frame, preventing redundant reflows per keypress.
   * Necessity: Reactive listeners can fire dozens of times per second; batching keeps
   * visual updates smooth without debounce latency.
   * If a callback is already pending for the same key, the new fn replaces it.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {string} key - Deduplication key; one pending callback allowed per key.
   * @param {Function} fn - DOM write callback to execute in the next animation frame.
   */
  function scheduleDomUpdate(key, fn) {
    if (pendingDomUpdates.has(key)) {
      pendingDomUpdates.set(key, fn);
      return;
    }
    pendingDomUpdates.set(key, fn);
    requestAnimationFrame(() => {
      const pending = pendingDomUpdates.get(key);
      pendingDomUpdates.delete(key);
      if (typeof pending === "function") pending();
    });
  }

  /**
   * Minimal internal publish/subscribe event bus for intra-script communication.
   * Purpose: Decouple DOM event sources (status/org field changes) from feature
   * subscribers so future modules attach to named events rather than raw DOM fields.
   * Necessity: Prevents N-modules × 2-fields listener explosion; one DOM binding
   * per field emits to all interested subscribers through the bus.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  const pdbBus = (() => {
    const listeners = new Map();
    return {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
      },
      off(event, handler) {
        listeners.get(event)?.delete(handler);
      },
      emit(event, data) {
        listeners.get(event)?.forEach((fn) => {
          try { fn(data); } catch (_err) { /* subscriber errors must not break other subscribers */ }
        });
      },
    };
  })();

  /**
   * Attaches one-time DOM listeners on #id_status and #id_org, translating native
   * change/input events into named pdbBus events (statusChanged, orgChanged).
   * Purpose: Centralise the raw DOM fan-out so every subscriber avoids its own
   * addEventListener call on the same elements.
   * Necessity: Single DOM listener per field, many bus subscribers — O(1) DOM cost.
   * Guarded by data-pdb-cp-bus-bound so safe to call from multiple modules.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function bindFormFieldBus() {
    const statusSelect = qs("#id_status");
    if (statusSelect && !statusSelect.hasAttribute("data-pdb-cp-bus-bound")) {
      statusSelect.setAttribute("data-pdb-cp-bus-bound", "1");
      const emitStatus = () => pdbBus.emit("statusChanged", { value: getSelectedStatus() });
      statusSelect.addEventListener("change", emitStatus);
      statusSelect.addEventListener("input", emitStatus);
    }

    const orgInput = qs("#id_org");
    if (orgInput && !orgInput.hasAttribute("data-pdb-cp-bus-bound")) {
      orgInput.setAttribute("data-pdb-cp-bus-bound", "1");
      const emitOrg = () => pdbBus.emit("orgChanged", { value: getInputValue("#id_org") });
      orgInput.addEventListener("change", emitOrg);
      orgInput.addEventListener("input", emitOrg);
    }
  }

  /**
   * Convenience wrapper for querySelector.
   * Purpose: Reduce boilerplate for DOM querying throughout the script.
   * Necessity: Used extensively for finding form fields and toolbar elements.
   * Wraps in try-catch to safely return null on selector errors.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {string} selector - CSS selector string.
   * @param {Document|Element} [root=document] - Optional scoping root element.
   * @returns {Element|null} First matching element, or null.
   */
  function qs(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch (_error) {
      return null;
    }
  }

  /**
   * Convenience wrapper for querySelectorAll returning an array.
   * Purpose: Reduce boilerplate for finding multiple DOM elements.
   * Necessity: Used for inline sets, dynamic forms, and multi-element operations.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {string} selector - CSS selector string.
   * @param {Document|Element} [root=document] - Optional scoping root element.
   * @returns {Element[]} Array of matching elements (may be empty).
   */
  function qsa(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  /**
   * Retrieves trimmed value from form input elements (input, select, textarea).
   * Purpose: Unified value extraction that handles both .value property and data attributes.
   * Necessity: Normalizes form field reading across different input types in Django admin forms.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} selector - CSS selector for the target input element.
   * @returns {string} Trimmed value string, or empty string if element not found.
   */
  function getInputValue(selector) {
    const element = qs(selector);
    if (!element) return "";

    if ("value" in element) {
      return String(element.value || "").trim();
    }

    return String(element.getAttribute("value") || "").trim();
  }

  /**
   * Reads the value attribute of the currently selected option from a `<select>` element.
   * Purpose: Extract the option value rather than display text for form submissions.
   * Necessity: Some dropdowns store codes (country codes) in value vs. full text in display.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} selector - CSS selector for the target `<select>` element.
   * @returns {string} Trimmed value of the selected option, or empty string if absent.
   */
  function getSelectedOptionValue(selector) {
    const select = qs(selector);
    if (!select) return "";

    const selectedOption =
      qs("option:checked", select) ||
      qs("option[selected]", select) ||
      ("selectedIndex" in select && select.options?.[select.selectedIndex]) ||
      null;

    return String(selectedOption?.getAttribute("value") || selectedOption?.value || "").trim();
  }

  /**
   * Reads the visible text of the currently selected option from a `<select>` element.
   * Purpose: Unified selected-option reader that works across choice and render states.
   * Necessity: `option:checked` and `option[selected]` behave differently across browsers
   * and scripted form states; normalizing prevents silent empty reads.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} selector - CSS selector for the target `<select>` element.
   * @returns {string} Trimmed text of the selected option, or empty string if absent.
   */
  function getSelectedOptionText(selector) {
    const select = qs(selector);
    if (!select) return "";

    const selectedOption =
      qs("option:checked", select) ||
      qs("option[selected]", select) ||
      ("selectedIndex" in select && select.options?.[select.selectedIndex]) ||
      null;

    return String(selectedOption?.textContent || "").trim();
  }

  /**
   * Builds a geocoding query string for facility address map links.
   * Purpose: Prefer lat/long coordinates when available for precise map links,
   * falling back to a formatted street address when coordinates are absent.
   * Necessity: Facilities may have coordinates or address-only data; a unified
   * builder covers both cases without branching at the call site.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @returns {string} Comma-separated coordinate pair or formatted address string.
   */
  function buildFacilityMapsQuerySource() {
    const latitude = getInputValue("#id_latitude");
    const longitude = getInputValue("#id_longitude");

    if (latitude && longitude) {
      return `${latitude},${longitude}`;
    }

    const address1 = getInputValue("#id_address1");
    const city = getInputValue("#id_city");
    const state = getInputValue("#id_state");
    const zipcode = getInputValue("#id_zipcode");
    const country = getSelectedOptionText("#id_country");

    const localityLine = [city, [state, zipcode].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", ");

    return [address1, localityLine, country].filter(Boolean).join(", ");
  }

  /**
   * Sets value on form input elements with consistent synchronization.
   * Purpose: Unified value assignment that updates both .value and attributes.
   * Necessity: Ensures form frameworks recognize the change (defaultValue for reset detection).
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} selector - CSS selector for the target input element.
   * @param {string} value - Value to assign to the matched element.
   * @returns {boolean} True when the element was found and updated; false otherwise.
   */
  function setInputValue(selector, value) {
    const element = qs(selector);
    if (!element) return false;

    const normalized = String(value || "");
    if ("value" in element) {
      element.value = normalized;
      if ("defaultValue" in element) {
        element.defaultValue = normalized;
      }
    }

    element.setAttribute("value", normalized);
    return true;
  }

  /**
   * Sets network name field value with proper change event firing.
   * Purpose: Ensure form validation and dependency updates trigger when name changes.
   * Necessity: Django admin forms monitor change events; manual setting requires event dispatch.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} value - New name value to assign to the network name input.
   * @returns {boolean} True when the #id_name element was found and updated.
   */
  function setNetworkNameValue(value) {
    const input = document.getElementById("id_name");
    if (!input) return false;

    const normalized = String(value || "").trim();
    input.value = normalized;
    input.defaultValue = normalized;
    input.setAttribute("value", normalized);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /**
   * Resolves editable long-name input element for network forms.
   * Purpose: Keep Long Name reads/writes resilient to minor template/id changes.
   * Necessity: CP forms may render this field with different IDs depending on
   * model/version, so lookup must support both ID and label-based discovery.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @returns {HTMLInputElement|HTMLTextAreaElement|null} Long Name input element.
   */
  function getNetworkLongNameInputElement() {
    const idCandidates = ["#id_name_long", "#id_long_name", "#id_aka"];
    for (const selector of idCandidates) {
      const element = qs(selector);
      if (element) return element;
    }

    const row = qsa(".form-row").find((item) => {
      const label = normalizeRenderedCopyText(
        (qs(".c-1 label", item) || qs(".c-1", item))?.textContent || "",
      ).toLowerCase();
      return label === "long name";
    });
    if (!row) return null;

    return (
      qs(".c-2 input[type='text']", row) ||
      qs(".c-2 textarea", row) ||
      qs("input[type='text']", row) ||
      qs("textarea", row) ||
      null
    );
  }

  /**
   * Reads current Long Name field value for network change forms.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @returns {string} Trimmed long-name value, or empty string when unavailable.
   */
  function getNetworkLongNameValue() {
    const input = getNetworkLongNameInputElement();
    if (!input) return "";
    return String(input.value || "").trim();
  }

  /**
   * Sets Long Name field value with change/input events.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} value - Value to set in Long Name.
   * @returns {boolean} True when Long Name field was found and updated.
   */
  function setNetworkLongNameValue(value) {
    const input = getNetworkLongNameInputElement();
    if (!input) return false;

    const normalized = String(value || "").trim();
    input.value = normalized;
    if ("defaultValue" in input) {
      input.defaultValue = normalized;
    }
    input.setAttribute("value", normalized);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /**
   * Resolves editable long-name input element for organization forms.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {HTMLInputElement|HTMLTextAreaElement|null} Long Name input element.
   */
  function getOrganizationLongNameInputElement() {
    const idCandidates = ["#id_name_long", "#id_long_name"];
    for (const selector of idCandidates) {
      const element = qs(selector);
      if (element) return element;
    }

    const row = qsa(".form-row").find((item) => {
      const label = normalizeRenderedCopyText(
        (qs(".c-1 label", item) || qs(".c-1", item))?.textContent || "",
      ).toLowerCase();
      return label === "long name";
    });
    if (!row) return null;

    return (
      qs(".c-2 input[type='text']", row) ||
      qs(".c-2 textarea", row) ||
      qs("input[type='text']", row) ||
      qs("textarea", row) ||
      null
    );
  }

  /**
   * Reads current Long Name field value for organization change forms.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {string} Trimmed long-name value, or empty string when unavailable.
   */
  function getOrganizationLongNameValue() {
    const input = getOrganizationLongNameInputElement();
    if (!input) return "";
    return String(input.value || "").trim();
  }

  /**
   * Sets organization Long Name field value with change/input events.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} value - Value to set in Long Name.
   * @returns {boolean} True when Long Name field was found and updated.
   */
  function setOrganizationLongNameValue(value) {
    const input = getOrganizationLongNameInputElement();
    if (!input) return false;

    const normalized = String(value || "").trim();
    input.value = normalized;
    if ("defaultValue" in input) {
      input.defaultValue = normalized;
    }
    input.setAttribute("value", normalized);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /**
   * Strips leading and trailing legal company-type prefixes and suffixes from a name.
   * Purpose: Keep network short Name concise while preserving full legal form
   * in Long Name.
   * Necessity: Organizations frequently include legal prefixes (e.g. PT, CV) and
   * suffixes (e.g. LTDA, SAS) that are better suited for Long Name than short Name.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} name - Full organization name.
   * @returns {string} Name without leading company-type prefix or trailing suffix tokens.
   */
  function stripCompanyTypeSuffix(name) {
    const original = String(name || "").trim().replace(/\s+/g, " ");
    if (!original) return "";

    const legalSuffixPatterns = [
      "S\\.?\\s*A\\.?\\s*S\\.?\\s*U\\.?", // SASU / S.A.S.U.
      "S\\.?\\s*A\\.?\\s*S\\.?", // SAS / S.A.S.
      "S\\.?\\s*N\\.?\\s*C\\.?", // SNC / S.N.C.
      "S\\.?\\s*C\\.?\\s*C\\.?", // SCC / S.C.C.
      "S\\.?\\s*C\\.?", // SC / S.C.
      "L\\.?\\s*T\\.?\\s*D\\.?\\s*A\\.?", // LTDA / L.T.D.A.
      "COMPANY\\s+LIMITED", // Company Limited (full legal form)
      "COMPANY", // Company (bare suffix, e.g. "Private Company")
      "MULTIPURPOSE\\s+COOPERATIVE", // Multipurpose Cooperative
      "COOPERATIVE", // Cooperative legal form
      "CO\\.?\\s*,?\\s*LTD\\.?", // Co., Ltd / Co Ltd
      "LTD\\.?",
      "LIMITED",
      "PRIVATE",
      "P\\.?\\s*V\\.?\\s*T\\.?", // PVT / P.V.T.
      "S\\.?\\s*DE\\s*R\\.?\\s*L\\.?\\s*DE\\s*C\\.?\\s*V\\.?", // S. de R.L. de C.V (Mexico)
      "S\\.?\\s*DE\\s*R\\.?\\s*L\\.?", // S. de R.L.
      "S\\.?\\s*DE\\s*C\\.?\\s*V\\.?", // S. de C.V.
      "S\\.?\\s*A\\.?\\s*DE\\s*C\\.?\\s*V\\.?", // S.A. de C.V.
      "S\\.?\\s*D\\.?\\s*N\\.?", // SDN / S.D.N. (Malaysia)
      "B\\.?\\s*H\\.?\\s*D\\.?", // BHD / B.H.D. (Malaysia)
      "BERHAD", // Berhad (Malaysia)
      "LIMITED\\s+LIABILITY\\s+COMPANY", // Limited Liability Company (full legal form)
      "LIABILITY\\s+CO(?:MPANY)?", // Liability Co / Liability Company (partial legal form)
      "LLC",
      "LLP",
      "PUBLIC\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Public Joint Stock Company (full legal form)
      "OPEN\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Open Joint Stock Company (full legal form)
      "P\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // PJSC / P.J.S.C.
      "O\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // OJSC / O.J.S.C.
      "J\\.?\\s*C\\.?\\s*S\\.?", // JCS / J.C.S.
      "J\\.?\\s*S\\.?\\s*C\\.?", // JSC / J.S.C.
      "CLOSED\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Closed Joint Stock Company (full legal form)
      "C\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // CJSC / C.J.S.C. (Closed Joint-Stock Company)
      "CYFYNGEDIG", // Cyfyngedig (Welsh equivalent of Limited)
      "C\\.?\\s*Y\\.?\\s*F\\.?", // CYF / C.Y.F. (Welsh legal short form)
      "INCORPORATED",
      "INC\\.?",
      "CORP\\.?",
      "S\\.?\\s*A\\.?\\s*U\\.?", // SAU / S.A.U. (Spain)
      "S\\.?\\s*A\\.?", // SA / S.A.
      "C\\.?\\s*A\\.?", // CA / C.A.
      "S\\.?\\s*R\\.?\\s*L\\.?", // SRL / S.R.L.
      "S\\.?\\s*R\\.?\\s*L\\.?\\s*S\\.?", // SRLS / S.R.L.S.
      "S\\.?\\s*R\\.?\\s*O\\.?", // SRO / S.R.O.
      "I\\.?\\s*K\\.?\\s*E\\.?", // IKE / I.K.E. (Greece)
      "S\\.?\\s*L\\.?\\s*U\\.?", // SLU / S.L.U. (Spain)
      "S\\.?\\s*L\\.?", // SL / S.L. (Spain)
      "S\\.?\\s*A\\.?\\s*R\\.?\\s*L\\.?", // SARL / S.A.R.L.
      "S\\.?\\s*P\\.?\\s*A\\.?", // SPA / S.P.A.
      "G\\.?\\s*M\\.?\\s*B\\.?\\s*H\\.?", // GmbH / G.m.b.H.
      "G\\.?\\s*M\\.?\\s*B\\.?\\s*H\\.?\\s*&\\s*CO\\.?\\s*KG\\.?", // GmbH & Co. KG
      "M\\.?\\s*B\\.?\\s*H\\.?", // mbH / m.b.H. (German LLC suffix without leading Gesellschaft)
      "KG", // KG (Germany: Kommanditgesellschaft)
      "[A-Za-z]{2,}gesellschaft", // German compound -gesellschaft entity types (e.g. Kommunikationsgesellschaft)
      "SP\\.?\\s*Z\\.?\\s*O\\.?\\s*O\\.?", // sp. z o.o. (Poland)
      "SPOLKA\\s+JAWNA", // Spolka Jawna (Polish general partnership)
      "SP\\.?\\s*J\\.?", // Sp. J. (Polish general partnership)
      "S\\.?\\s*H\\.?\\s*P\\.?\\s*K\\.?", // sh.p.k / Sh.p.k. (Albania)
      "E\\.?\\s*O\\.?\\s*O\\.?\\s*D\\.?", // EOOD / E.O.O.D. (Bulgaria)
      "O\\.?\\s*O\\.?\\s*D\\.?", // OOD / O.O.D. (Bulgaria)
      "D\\.?\\s*O\\.?\\s*O\\.?", // DOO / D.O.O. (Balkans LLC form)
      "KORLATOLT\\s+FELELOSSEGU\\s+TARSASAG", // Korlátolt Felelősségű Társaság (Hungary)
      "K\\.?\\s*F\\.?\\s*T\\.?", // KFT / K.F.T. (Hungary)
      "K\\.?\\s*K\\.?", // K.K. / KK (Japan: Kabushiki Kaisha)
      "Z\\.?\\s*S\\.?", // z.s. / zs (Czech: zapsany spolek, registered association)
      "AKTSIONERNO\\s+DRUZHESTVO", // Aktsionerno Druzhestvo (Bulgarian joint-stock company)
      "AG",
      "AB", // Aktiebolag (Sweden)
      "BV",
      "B\\.?\\s*V\\.?", // BV / B.V.
      "N\\.?\\s*V\\.?", // NV / N.V.
      "NV",
      "E\\.?\\s*V\\.?", // e.V. / EV (Germany: eingetragener Verein)
      "EINGETRAGENER\\s+VEREIN", // Eingetragener Verein (Germany)
      "PTE\\.?",
      "PTY\\.?",
      "PLC",
      "E\\.?\\s*P\\.?\\s*P\\.?", // EPP / E.P.P. (Brazil)
      "M\\.?\\s*E\\.?", // ME / M.E. (Brazil)
      "EIRELI",
      "MEI",
      "UAB", // UAB (Lithuania: Uzdaroji akcine bendrove, private limited company)
      "M\\.?\\s*B\\.?", // MB (Lithuania: Mažoji bendrija)
      "O\\.?\\s*U\\.?", // OU (Estonia: Osaühing)
      "O\\.?\\s*Y\\.?", // OY (Finland: Osakeyhtiö)
      "L\u0130M\u0130TED\\s+\u015e\u0130RKET\u0130", // Limited Şirketi (Turkey: Limited Company)
      "A\\.?\\s*\u015e\\.?", // A.Ş. (Turkey: Anonim Şirket - Joint Stock Company)
    ];

    const legalPrefixPatterns = [
      "P\\.?\\s*T\\.?", // PT / P.T. (Indonesia)
      "C\\.?\\s*V\\.?", // CV / C.V. (Indonesia)
      "U\\.?\\s*D\\.?", // UD / U.D. (Indonesia)
      "P\\.?\\s*D\\.?", // PD / P.D. (Indonesia)
      "T\\.?\\s*O\\.?\\s*O\\.?", // TOO / T.O.O. (Kazakhstan)
      "O\\.?\\s*O\\.?\\s*O\\.?", // OOO / O.O.O. (Russia)
      "O\\.?\\s*A\\.?\\s*O\\.?", // OAO / O.A.O. (Russia)
      "E\\.?\\s*O\\.?\\s*O\\.?\\s*D\\.?", // EOOD / E.O.O.D. (Bulgaria)
      "O\\.?\\s*O\\.?\\s*D\\.?", // OOD / O.O.D. (Bulgaria)
      "SPOLKA\\s+JAWNA", // Spolka Jawna (Polish general partnership)
      "SP\\.?\\s*J\\.?", // Sp. J. (Polish general partnership)
      "N\\.?\\s*V\\.?", // NV / N.V.
      "E\\.?\\s*V\\.?", // e.V. / EV (Germany: eingetragener Verein)
      "EINGETRAGENER\\s+VEREIN", // Eingetragener Verein (Germany)
      "I\\.?\\s*K\\.?\\s*E\\.?", // IKE / I.K.E. (Greece)
      "PRIVATE\\s+ENTERPRISE", // Private Enterprise (common legal form label)
      "F\\.?\\s*O\\.?\\s*P\\.?", // FOP / F.O.P. (Ukraine: sole proprietor)
      "FIZYCHNA\\s+OSOBA\\s+PIDPRYYEMETS", // Full transliterated FOP legal form (Ukraine)
      "PRIVATELY\\s+OWNED\\s+ENTREPRENEUR", // Privately owned entrepreneur (sole proprietor legal form)
      "AKTSIONERNO\\s+DRUZHESTVO", // Aktsionerno Druzhestvo (Bulgarian joint-stock company)
      "K\\.?\\s*K\\.?", // K.K. / KK (Japan: Kabushiki Kaisha)
      "Z\\.?\\s*S\\.?", // z.s. / zs (Czech: zapsany spolek, registered association)
      "LIMITED\\s+LIABILITY\\s+COMPANY", // Limited Liability Company (full legal form)
      "PUBLIC\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Public Joint Stock Company (full legal form)
      "OPEN\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Open Joint Stock Company (full legal form)
      "P\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // PJSC / P.J.S.C.
      "O\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // OJSC / O.J.S.C.
      "J\\.?\\s*C\\.?\\s*S\\.?", // JCS / J.C.S.
      "J\\.?\\s*S\\.?\\s*C\\.?", // JSC / J.S.C.
      "S\\.?\\s*R\\.?\\s*L\\.?\\s*S\\.?", // SRLS / S.R.L.S.
      "CLOSED\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Closed Joint Stock Company (full legal form)
      "C\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // CJSC / C.J.S.C. (Closed Joint-Stock Company)
      "M\\.?\\s*\\/\\s*S\\.?", // M/S. / M/s. (South Asia, "Messrs.")
      "L\\.?\\s*L\\.?\\s*C\\.?", // LLC / L.L.C. when used as a leading legal designator
      "UAB", // UAB (Lithuania: Uzdaroji akcine bendrove, private limited company)
      "O\\.?\\s*U\\.?", // OU (Estonia: Osaühing)
      "O\\.?\\s*Y\\.?", // OY (Finland: Osakeyhtiö)
      "LİMİTED\\s+ŞİRKETİ", // Limited Şirketi (Turkey: Limited Company)
      "A\\.?\\s*Ş\\.?", // A.Ş. (Turkey: Anonim Şirket - Joint Stock Company)
    ];

    const suffixRegex = new RegExp(
      `(?:[\\s,()._-]+)(?:${legalSuffixPatterns.join("|")})\\.?[\\s,()._-]*$`,
      "i",
    );
    const prefixRegex = new RegExp(
      `^(?:${legalPrefixPatterns.join("|")})\\.?[\\s,._-]+`,
      "i",
    );
    const trailingPrefixRegex = new RegExp(
      `(?:[\\s,()._-]+)(?:${legalPrefixPatterns.join("|")})\\.?[\\s,()._-]*$`,
      "i",
    );

    let candidate = original;
    let previous = "";
    const hadPrivatelyOwnedEntrepreneurPrefix = /^PRIVATELY\s+OWNED\s+ENTREPRENEUR\b/i.test(original);

    // Normalize names that append a location after EOOD/OOD/DOO, so legal stripping can proceed.
    // Example: "DGM EOOD, Sofia, Bulgaria" -> "DGM EOOD".
    const llcWithTrailingLocationRegex = /(.*?)(?:[\s,().-]+)((?:E\.?\s*O\.?\s*O\.?\s*D\.?)|(?:O\.?\s*O\.?\s*D\.?)|(?:D\.?\s*O\.?\s*O\.?))\b(?:[\s,.-]+[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'-]*){1,3}[\s,().-]*$/i;
    const llcWithTrailingLocationMatch = candidate.match(llcWithTrailingLocationRegex);
    if (llcWithTrailingLocationMatch?.[1] && llcWithTrailingLocationMatch?.[2]) {
      candidate = `${llcWithTrailingLocationMatch[1].trim()} ${llcWithTrailingLocationMatch[2].trim()}`.trim();
    }

    // Normalize "<name> <legal suffix> <country token>" ordering so legal stripping can proceed.
    // Example: "Phylaxis, Inc. USA" -> "Phylaxis Inc." -> "Phylaxis".
    const legalWithTrailingCountryCodeRegex = new RegExp(
      `(.*?)(?:[\\s,().-]+)((?:${legalSuffixPatterns.join("|")}))\\b(?:[\\s,.-]+)(?:[A-Z]{2}|[A-Z]{3})[\\s,().-]*$`,
      "i",
    );
    const legalWithTrailingCountryCodeMatch = candidate.match(legalWithTrailingCountryCodeRegex);
    if (legalWithTrailingCountryCodeMatch?.[1] && legalWithTrailingCountryCodeMatch?.[2]) {
      candidate = `${legalWithTrailingCountryCodeMatch[1].trim()} ${legalWithTrailingCountryCodeMatch[2].trim()}`.trim();
    }

    // Strip leading prefix once
    candidate = candidate.replace(prefixRegex, "").trim();

    // Strip trailing suffixes (may be multiple layers)
    while (candidate && candidate !== previous && suffixRegex.test(candidate)) {
      previous = candidate;
      candidate = candidate.replace(suffixRegex, "").trim().replace(/[\s,().-]+$/g, "").trim();
    }

    // Strip trailing prefix-type legal tokens when source ordering is reversed
    // (e.g. "Company PT" instead of "PT Company").
    previous = "";
    while (candidate && candidate !== previous && trailingPrefixRegex.test(candidate)) {
      previous = candidate;
      candidate = candidate.replace(trailingPrefixRegex, "").trim().replace(/[\s,().-]+$/g, "").trim();
    }

    // For "Privately owned entrepreneur ..." names, drop trailing ISO country code tails.
    // Example: "Example Person Name, UA" -> "Example Person Name".
    if (hadPrivatelyOwnedEntrepreneurPrefix) {
      candidate = candidate.replace(/(?:[\s,()._-]+)[A-Z]{2}\.?[\s,()._-]*$/, "").trim();
    }

    // Strip Bulgarian "AD" legal form (Aktsionerno Druzhestvo) in uppercase form only.
    // Case-sensitive intentionally to avoid false positives with ordinary lowercase words.
    const bulgarianAdPrefixRegex = /^A\.?\s*D\.?[\s,._-]+/;
    if (bulgarianAdPrefixRegex.test(candidate)) {
      candidate = candidate
        .replace(bulgarianAdPrefixRegex, "")
        .trim()
        .replace(/[\s,().-]+$/g, "")
        .trim();
    }

    const bulgarianAdSuffixRegex = /(?:[\s,()._-]+)A\.?\s*D\.?[\s,()._-]*$/;
    if (bulgarianAdSuffixRegex.test(candidate)) {
      candidate = candidate
        .replace(bulgarianAdSuffixRegex, "")
        .trim()
        .replace(/[\s,().-]+$/g, "")
        .trim();
    }

    // Strip Scandinavian "AS" suffix (Aksjeselskap/Aktieselskab, NO/DK).
    // Case-sensitive intentionally: avoids false positives with English "as".
    // Must run after the main suffix loop so multi-layer strips have already resolved.
    const scandinavianAsSuffixRegex = /(?:[\s,().-]+)AS\.?[\s,().-]*$/;
    if (scandinavianAsSuffixRegex.test(candidate)) {
      const stripped = candidate
        .replace(scandinavianAsSuffixRegex, "")
        .trim()
        .replace(/[\s,().-]+$/g, "")
        .trim();
      if (stripped) candidate = stripped;
    }

    // Remove wrapping quotes after legal prefix/suffix stripping.
    candidate = candidate.replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, "").trim();

    // Keep quote behavior consistent for short-name normalization.
    // If ASCII double-quotes are unbalanced (odd count), drop all of them.
    const asciiDoubleQuoteCount = (candidate.match(/"/g) || []).length;
    if (asciiDoubleQuoteCount % 2 === 1) {
      candidate = candidate.replace(/"/g, "").replace(/\s+/g, " ").trim();
    }

    return candidate || original;
  }

  /**
   * Trims obvious organizational unit descriptors after a comma.
   * Purpose: Keep short Name concise when source names include department/division text.
   * Necessity: Names like "Company, Data Network Management Division" should keep
   * the unit in Long Name while using company core in Name.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} name - Full organization/network name.
   * @returns {string} Name with trailing unit descriptor removed when confidently detected.
   */
  function stripOrganizationalUnitDescriptor(name) {
    const original = String(name || "").trim().replace(/\s+/g, " ");
    if (!original || !original.includes(",")) return original;

    const parts = original
      .split(",")
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    if (parts.length < 2) return original;

    const rightSide = parts.slice(1).join(" ").toLowerCase();
    const unitDescriptorRegex = /\b(division|department|directorate|bureau|office|branch|section|team|unit|director\s+general|ministry|province|provincial|regional)\b/i;
    const leftSide = parts[0];

    // Handle "Name, legal-form, ISP descriptor" style strings.
    // Example: "NovInvestRezerv, LLC, ISP NIR-Telecom" -> "NovInvestRezerv".
    const standaloneLegalMiddleTokenRegex = /^(?:L\.?\s*L\.?\s*C\.?|L\.?\s*L\.?\s*P\.?|L\.?\s*T\.?\s*D\.?|I\.?\s*N\.?\s*C\.?|G\.?\s*M\.?\s*B\.?\s*H\.?|S\.?\s*R\.?\s*L\.?|S\.?\s*P\.?\s*J\.?)$/i;
    const telecomDescriptorRegex = /\b(isp|telecom|telecommunications|internet\s+provider|provider)\b/i;
    if (
      parts.length >= 3
      && standaloneLegalMiddleTokenRegex.test(parts[1])
      && telecomDescriptorRegex.test(parts.slice(2).join(" "))
      && leftSide.length >= 3
    ) {
      return leftSide;
    }

    if (!unitDescriptorRegex.test(rightSide) || leftSide.length < 3) {
      return original;
    }

    return leftSide;
  }

  /**
   * Resolves canonical short name from comma-separated legal aliases.
   * Purpose: Handle patterns like "FOO SDN BHD, Foo Berhad" and keep one compact short name.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} name - Full organization/network name.
   * @returns {string} Canonical compact alias, or empty string when not confidently resolvable.
   */
  function resolveCompactNameFromCommaLegalAliases(name) {
    const original = String(name || "").trim().replace(/\s+/g, " ");
    if (!original.includes(",")) return "";

    const parts = original
      .split(",")
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    if (parts.length < 2) return "";

    const strippedParts = parts
      .map((part) => stripCompanyTypeSuffix(part))
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    if (strippedParts.length < 2) return "";

    const normalized = strippedParts.map((part) => part.toLowerCase());
    const allMatch = normalized.every((value) => value === normalized[0]);
    if (!allMatch) return "";

    const preferred = strippedParts.find((part) => /[a-z]/.test(part));
    return preferred || strippedParts[0] || "";
  }

  /**
   * Removes trailing registration-number segment when appended after a comma.
   * Example: "Company PTE. LTD., 202208375N" -> "Company PTE. LTD."
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} name - Raw full name.
   * @returns {string} Name without trailing registration segment when confidently detected.
   */
  function stripTrailingRegistrationIdentifier(name) {
    const original = String(name || "").trim().replace(/\s+/g, " ");
    if (!original.includes(",")) return original;

    const parts = original
      .split(",")
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    if (parts.length < 2) return original;

    const registrationCandidate = parts[parts.length - 1];

    // Drop obvious trailing symbol-noise segments.
    // Example: "GLOBALGRID SASU, ************" -> "GLOBALGRID SASU"
    const compactRegistrationCandidate = registrationCandidate.replace(/\s+/g, "");
    const looksLikeTrailingSymbolNoise = /^(?:[*#._~=-]){6,}$/.test(compactRegistrationCandidate);
    if (looksLikeTrailingSymbolNoise) {
      const base = parts.slice(0, -1).join(", ");
      return base || original;
    }

    // Drop trailing opaque token-like blobs and BEGIN/END token banners.
    // Examples:
    // - "Shuma Watanabe, OCITOKEN::201345:97cb..."
    // - "WizardTales GmbH, -----BEGIN TOKEN-----996d...-----END TOKEN-----"
    const looksLikeTokenBanner = /BEGIN\s+[A-Z0-9_-]+/i.test(registrationCandidate)
      || /END\s+[A-Z0-9_-]+/i.test(registrationCandidate)
      || /-+\s*BEGIN\b/i.test(registrationCandidate)
      || /\bEND\s+[A-Z0-9_-]+\s*-+/i.test(registrationCandidate);
    const looksLikeOpaqueTrailingToken =
      !/\s/.test(registrationCandidate)
      && /[A-F0-9]{24,}/i.test(registrationCandidate)
      && /[:_-]/.test(registrationCandidate)
      && registrationCandidate.length >= 32;
    if (looksLikeTokenBanner || looksLikeOpaqueTrailingToken) {
      const base = parts.slice(0, -1).join(", ");
      return base || original;
    }

    const hasWhitespace = /\s/.test(registrationCandidate);
    if (hasWhitespace) return original;

    const looksLikeRegistrationId = /^(?:\d{6,}[a-z]?|[a-z]{1,4}\d{4,}[a-z0-9-]*)$/i.test(registrationCandidate);
    if (!looksLikeRegistrationId) return original;

    const base = parts.slice(0, -1).join(", ");
    if (!base) return original;

    // Only drop the registration segment when base already looks like a legal-form name.
    const baseCompacted = stripCompanyTypeSuffix(base);
    const baseHasLegalForm = String(baseCompacted || "").trim() !== base;
    return baseHasLegalForm ? base : original;
  }

  /**
   * Compacts an entity name for short Name field while preserving legal/full form in Long Name.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} name - Source full name.
   * @returns {{ shortName: string, longName: string }} Compacted short name and optional long name.
   */
  function compactEntityNameWithLongNameFallback(name) {
    const fullName = String(name || "").trim().replace(/\s+/g, " ");
    if (!fullName) return { shortName: "", longName: "" };

    // Strip trailing "AS<digits>" patterns (e.g., "Cogeco Connexion Inc. AS27168" -> "Cogeco Connexion Inc.")
    const withoutAsns = fullName.replace(/\s+AS\s*\d+\s*$/i, "").trim();

    const normalizedFullName = stripTrailingRegistrationIdentifier(withoutAsns);

    const fromLegalAliases = resolveCompactNameFromCommaLegalAliases(normalizedFullName);

    // When the comma-parts are NOT legal aliases of each other (fromLegalAliases empty) but the
    // first part alone has a legal corporate form (e.g. "V D C Net Company Limited, Ultra Net"),
    // use only the first part as the canonical full name so Long Name can be populated correctly.
    let effectiveFullName = normalizedFullName;
    if (!fromLegalAliases && normalizedFullName.includes(",")) {
      const firstPart = normalizedFullName.split(",")[0].trim();
      const firstPartCompacted = stripCompanyTypeSuffix(firstPart);
      if (firstPartCompacted && firstPartCompacted !== firstPart) {
        effectiveFullName = firstPart;
      }
    }

    const withoutUnit = stripOrganizationalUnitDescriptor(fromLegalAliases || effectiveFullName) || (fromLegalAliases || effectiveFullName);
    const withoutLegalType = stripCompanyTypeSuffix(withoutUnit) || withoutUnit;
    let compactBaseShortName = withoutLegalType || effectiveFullName;
    compactBaseShortName = normalizeSimpleSingleDashAlphabeticName(compactBaseShortName);

    // A compact network short name must not end with a dangling ampersand.
    const shortName = String(compactBaseShortName || "")
      .replace(/(?:\s*&\s*)+$/g, "")
      .replace(/[\s,;:.!?-]+$/g, "")
      .trim() || compactBaseShortName;

    const normalizedEffectiveFullName = normalizeSimpleSingleDashAlphabeticName(effectiveFullName);
    const longName = shortName !== normalizedEffectiveFullName ? normalizedEffectiveFullName : "";
    return { shortName, longName };
  }

  /**
   * Normalizes simple single-dash alphabetic forms into spaced words.
   * Example: "Locl-net" -> "Locl Net".
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} value - Source string.
   * @returns {string} Normalized string.
   */
  function normalizeSimpleSingleDashAlphabeticName(value) {
    const raw = String(value || "").trim();
    if (/^[A-Za-z]{3,}-[A-Za-z]{2,}$/.test(raw)) {
      return raw.replace(/-/g, " ");
    }
    return raw;
  }

  /**
   * Collapses exact comma-separated duplicate names.
   * Example: "Name, Name" -> "Name"
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} name - Raw name candidate.
   * @returns {string} Deduplicated name when exact duplication is detected.
   */
  function collapseExactCommaDuplicateName(name) {
    const original = String(name || "").trim().replace(/\s+/g, " ");
    if (!original.includes(",")) return original;

    const parts = original
      .split(",")
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    if (parts.length < 2) return original;

    // 2-part case: direct comparison.
    if (parts.length === 2) {
      const left = parts[0].replace(/^['""\u201c\u201d\u2018\u2019]+|['""\u201c\u201d\u2018\u2019]+$/g, "").trim();
      const right = parts[1].replace(/^['""\u201c\u201d\u2018\u2019]+|['""\u201c\u201d\u2018\u2019]+$/g, "").trim();
      if (!left || !right) return original;
      return left.toLowerCase() === right.toLowerCase() ? left : original;
    }

    // Even-count case: split into two equal halves and compare rejoined halves.
    // Handles e.g. "COMPANY CO., LTD, COMPANY CO., LTD" (4 parts).
    if (parts.length % 2 === 0) {
      const mid = parts.length / 2;
      const left = parts.slice(0, mid).join(", ");
      const right = parts.slice(mid).join(", ");
      if (left.toLowerCase() === right.toLowerCase()) return left;
    }

    return original;
  }

  /**
   * Detects ASN-like token variants inside free-form text.
   * Examples: "AS123456", "ASN 123456", "123456".
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} value - Input text to inspect.
   * @returns {boolean} True when an ASN-like token is present.
   */
  function containsAsnLikeToken(value) {
    const text = String(value || "").trim();
    if (!text) return false;

    // Optional AS/ASN prefix + 4-10 digit ASN-like number.
    return /\b(?:AS|ASN)?\s*[-:]?\s*\d{4,10}\b/i.test(text);
  }

  /**
   * Detects names that look like generated maintainer/registry handles.
   * Purpose: Avoid setting network short Name to opaque handle-like values.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} value - Candidate name.
   * @returns {boolean} True when the value looks autogenerated/handle-like.
   */
  function isLikelyGeneratedHandleName(value) {
    const raw = String(value || "").trim();
    const normalized = raw.toUpperCase();
    if (!normalized) return false;

    // Typical maintainer/registry style handles (e.g. VIPY-MNT, ACME-MAINT).
    if (/^[A-Z0-9]{3,}[-_](?:MNT|MAINT|MNTNER|NIC)$/i.test(normalized)) {
      return true;
    }

    // Compact uppercase token + "-AS" pattern often indicates generated naming.
    if (/^[A-Z0-9]{5,}[-_]AS$/i.test(normalized)) {
      return true;
    }

    // ASN-prefixed handles (e.g. AS-RSSWS, AS_FOO) are often auto-generated.
    if (/^AS[-_][A-Z0-9]{3,}$/i.test(normalized)) {
      return true;
    }

    // Lowercase cc-prefix compact tokens are often machine-style handles
    // (e.g. ru-atss) rather than operator-facing display names.
    if (/^[a-z]{2}[-_][a-z0-9]{3,8}$/.test(raw)) {
      return true;
    }

    return false;
  }

  /**
   * Sanitizes malformed RDAP organization names that contain corruption patterns.
   * Purpose: Clean up org names that include remarks, embedded person entries, or garbage data.
   * Necessity: RDAP data sometimes includes extraneous content like contact remarks mixed into org names.
   * Patterns handled:
  *   - "PERSON trading as COMPANY", "PERSON t/a COMPANY", or "PERSON dba COMPANY" → extracts "COMPANY"
   *   - "Name, remarks: GARBAGE" → extracts "Name"
   *   - Leading/trailing whitespace and punctuation cleanup
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} name - Organization name possibly containing corruption.
   * @returns {string} Cleaned organization name, or original if no corruption detected.
   */
  function sanitizeRdapOrgName(name) {
    const original = String(name || "").trim();
    if (!original || original.length < 2) return original;

    let candidate = original;

    // Split at ", remarks:" and take the first part (removes appended remarks/garbage)
    const remarksMatch = candidate.match(/^(.+?)\s*,\s*remarks\s*:/i);
    if (remarksMatch) {
      candidate = remarksMatch[1].trim();
    }

    // Collapse exact duplicate form "Name, Name".
    candidate = collapseExactCommaDuplicateName(candidate);

    // Collapse legal-alias duplicate form "Name Ltd, Name Pvt Ltd".
    const collapsedLegalAlias = resolveCompactNameFromCommaLegalAliases(candidate);
    if (collapsedLegalAlias) {
      candidate = collapsedLegalAlias;
    }

    // Extract text after trading-as patterns if present.
    const tradingAsMatch = candidate.match(/(?:trading\s+as|t\s*\/\s*a|d\s*\/?\s*b\s*\/?\s*a|dba)\s+(.+)$/i);
    if (tradingAsMatch) {
      const extracted = tradingAsMatch[1].trim();
      // Use the extraction if it's substantially longer than or similar to the person part (avoid picking the person name)
      if (extracted.length >= 5) {
        candidate = extracted;
      }
    }

    // Clean trailing punctuation and comma separators
    candidate = candidate.replace(/[\s,;:.!?-]+$/g, "").trim();

    // Validate the result is still meaningful
    return candidate && candidate.length >= 2 ? candidate : original;
  }

  /**
  * Extracts normalized organization identity from RDAP names containing
  * trading-as patterns (e.g., "trading as", "t/a", "dba").
   * Purpose: Split legal/person prefix into AKA while keeping company name as canonical name.
   * Example: "Remzi Toker trading as VENTURESDC" -> { name: "VENTURESDC", knownAs: "Remzi Toker" }
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} name - Raw organization name.
   * @returns {{ name: string, knownAs: string }} Parsed identity values.
   */
  function parseRdapTradingAsIdentity(name) {
    const original = String(name || "").trim();
    if (!original) return { name: "", knownAs: "" };

    // Remove trailing remarks noise before parsing trading-as pattern.
    const base = original.replace(/^(.+?)\s*,\s*remarks\s*:.*/i, "$1").trim();
    const match = base.match(/^(.+?)\s+(?:trading\s+as|t\s*\/\s*a|d\s*\/?\s*b\s*\/?\s*a|dba)\s+(.+)$/i);
    if (!match) {
      return { name: sanitizeRdapOrgName(original), knownAs: "" };
    }

    const knownAs = String(match[1] || "").trim().replace(/[\s,;:.!?-]+$/g, "").trim();
    const parsedName = String(match[2] || "").trim().replace(/[\s,;:.!?-]+$/g, "").trim();

    return {
      name: sanitizeRdapOrgName(parsedName || original),
      knownAs,
    };
  }

  /**
   * Extracts identity from Polish civil-partnership naming style:
   * "<Company> S.C. <Partner Initial Surname ...>".
   * Purpose: Keep legal form in long/full name while moving partner tail to AKA.
   * Example:
  * "NET-KONT@KT S.C. <PARTNER_1> <PARTNER_2>"
  * -> { name: "NET-KONT@KT S.C.", knownAs: "<PARTNER_1> <PARTNER_2>" }
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} name - Raw organization name.
   * @returns {{ name: string, knownAs: string }} Parsed identity values.
   */
  function parsePolishScPartnerIdentity(name) {
    const original = String(name || "").trim();
    if (!original) return { name: "", knownAs: "" };

    const base = original.replace(/^(.+?)\s*,\s*remarks\s*:.*/i, "$1").trim();
    const match = base.match(/^(.*?\bS\.?\s*C\.?)\s+(.+)$/i);
    if (!match) {
      return { name: sanitizeRdapOrgName(original), knownAs: "" };
    }

    const companyWithLegalForm = String(match[1] || "").trim().replace(/[\s,;:.!?-]+$/g, "").trim();
    const partnerTail = String(match[2] || "").trim().replace(/[\s,;:.!?-]+$/g, "").trim();

    // Require at least two partner-like person tokens to avoid false positives.
    // Accept either:
    // - "Initial + Surname" forms (e.g. "A. Kowalski")
    // - Full "GivenName Surname" forms (e.g. "Dariusz Koper")
    const initialSurnameTokens = partnerTail.match(/[A-Z]\.?\s+[A-Za-z\u00C0-\u024F'’-]+/g) || [];
    const fullNameTokens = partnerTail.match(/[A-Z][A-Za-z\u00C0-\u024F'’-]+\s+[A-Z][A-Za-z\u00C0-\u024F'’-]+/g) || [];
    const looksLikePartnerTail = initialSurnameTokens.length >= 2 || fullNameTokens.length >= 2;
    if (!looksLikePartnerTail) {
      return { name: sanitizeRdapOrgName(original), knownAs: "" };
    }

    return {
      name: sanitizeRdapOrgName(companyWithLegalForm || original),
      knownAs: partnerTail,
    };
  }

  /**
   * Resolves canonical name + AKA identity from known malformed/alias patterns.
   * Purpose: Keep all AKA extraction rules in one place.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} name - Raw organization name.
   * @returns {{ name: string, knownAs: string }} Parsed identity values.
   */
  function parseOrganizationNameIdentity(name) {
    const tradingAsIdentity = parseRdapTradingAsIdentity(name);
    if (String(tradingAsIdentity?.knownAs || "").trim()) {
      return tradingAsIdentity;
    }

    const scIdentity = parsePolishScPartnerIdentity(name);
    if (String(scIdentity?.knownAs || "").trim()) {
      return scIdentity;
    }

    return tradingAsIdentity;
  }

  /**
   * Generates a deterministic non-AS fallback network name with optional suffix.
   * Purpose: Keep required name fields populated when higher-quality sources fail.
   * Necessity: Explicitly avoids AS<id>/AS<asn> placeholder formats.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} _asn - Unused (kept for signature compatibility).
   * @param {string|number} networkId - CP network record ID used as fallback.
   * @param {string} [suffix=""] - Optional suffix to append (e.g., " #42" for deleted records).
   * @returns {string} Generated fallback name string (e.g., "Network 42 #42").
   */
  function getDeterministicNetworkFallbackName(asn, networkId, suffix = "") {
    void asn;
    return `Network ${networkId}${suffix}`;
  }

  /**
   * Selects the first meaningful non-handle network name from candidate strings.
   * Purpose: Prefer human-readable naming before falling back to deterministic placeholders.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string[]} candidates - Raw candidate name strings ordered by preference.
   * @returns {string} Best compacted non-handle name, or empty string when none found.
   */
  function pickPreferredNetworkNameCandidate(candidates) {
    for (const candidate of candidates || []) {
      const compacted = compactEntityNameWithLongNameFallback(String(candidate || "").trim());
      const base = String(compacted?.shortName || candidate || "").trim();
      if (!base) continue;
      if (isLikelyGeneratedHandleName(base)) continue;
      if (/^AS\s*\d+$/i.test(base)) continue;
      return base;
    }
    return "";
  }

  /**
   * Returns the PeeringDB frontend URL slug for a given CP entity type.
   * Purpose: Translate internal CP entity names to their public frontend URL segments.
   * Necessity: Centralizes the entity→slug mapping shared by frontend links and API paths.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} entity - Lowercase CP entity type (e.g., "internetexchange").
   * @returns {string} Frontend URL slug (e.g., "ix"), or empty string if unmapped.
   */
  function getFrontendSlugByEntity(entity) {
    return ENTITY_SLUG_MAP[entity] || "";
  }

  /**
   * Builds the root-relative frontend URL path for the current entity context.
   * Purpose: Generate the canonical frontend path used for toolbar link href values.
   * Necessity: Centralizes path construction from entity type + ID to avoid slug/ID drift
   * across separate call sites that build frontend links.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ entity: string, entityId: string }} ctx - Route context from getRouteContext().
   * @returns {string} Root-relative path such as "/ix/42", or empty string on failure.
   */
  function getEntityFrontendPath(ctx) {
    const slug = getFrontendSlugByEntity(ctx?.entity);
    if (!slug || !ctx?.entityId) return "";
    return `/${slug}/${ctx.entityId}`;
  }

  /**
   * Resolves PeeringDB API resource slug for a CP entity type.
   * Purpose: Build direct JSON API links for the current entity page.
   * Necessity: CP workflows often require quick access to canonical API payloads.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} entity - Lowercase CP entity type (e.g., "internetexchange").
   * @returns {string} API resource slug (e.g., "ix"), or empty string if unmapped.
   */
  function getEntityApiResourceByEntity(entity) {
    return ENTITY_API_RESOURCE_MAP[entity] || "";
  }

  /**
   * Builds full API JSON URL for the current CP entity context.
   * Purpose: Provide one-click navigation to the matching API record.
   * Necessity: Avoid manual URL crafting when validating backend/source-of-truth data.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ entity: string, entityId: string }} ctx - Route context from getRouteContext().
   * @returns {string} Full API URL (e.g., "https://www.peeringdb.com/api/ix/42"), or empty string.
   */
  function getEntityApiJsonUrl(ctx) {
    const resource = getEntityApiResourceByEntity(ctx?.entity);
    const entityId = String(ctx?.entityId || "").trim();
    if (!resource || !entityId) return "";
    return `${PEERINGDB_API_BASE_URL}/${resource}/${entityId}`;
  }

  /**
   * Builds a canonical PeeringDB API object URL for resource/id pairs.
   * Purpose: Keep API endpoint construction centralized and consistent.
   * Necessity: Avoids hardcoded URL drift across modules.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} resource - API resource slug (e.g., "org", "ix").
   * @param {string|number} entityId - Entity record ID.
   * @returns {string} Full API URL, or empty string if either argument is invalid.
   */
  function getPeeringDbApiObjectUrl(resource, entityId) {
    const normalizedResource = String(resource || "").trim();
    const normalizedEntityId = String(entityId || "").trim();
    if (!normalizedResource || !normalizedEntityId) return "";
    return `${PEERINGDB_API_BASE_URL}/${normalizedResource}/${normalizedEntityId}`;
  }

  /**
   * Emits a one-time console warning for malformed or unexpected API payload shapes.
   * Purpose: Surface API contract violations in debug mode without flooding the console.
   * Necessity: The same endpoint can be called many times per session; deduplication
   * via a Set ensures the warning fires only once per source URL.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} source - Endpoint URL or identifier where the payload was received.
   * @param {*} payload - The malformed payload value forwarded to console.warn.
   */
  function warnMalformedApiPayloadOnce(source, payload) {
    if (!isDebugEnabled()) return;

    const warningKey = String(source || "unknown").trim() || "unknown";
    if (malformedApiPayloadWarnings.has(warningKey)) return;
    malformedApiPayloadWarnings.add(warningKey);

    const fetchFailure = lastFetchFailureByUrl.get(warningKey) || null;

    console.warn(
      `[${MODULE_PREFIX}] Unexpected API payload shape at '${warningKey}'`,
      {
        payload,
        fetchFailure,
      },
    );
  }

  /**
   * Records the most recent fetch failure details for a URL.
   * Purpose: Improve malformed payload diagnostics with concrete transport/parse reasons.
   * Necessity: Null payload alone is ambiguous during troubleshooting.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} url - Request URL key.
   * @param {object} details - Structured failure metadata.
   */
  function recordFetchFailure(url, details) {
    const key = String(url || "").trim();
    if (!key) return;
    lastFetchFailureByUrl.set(key, {
      ...(details || {}),
      at: new Date().toISOString(),
    });
  }

  /**
   * Clears tracked fetch-failure metadata for a URL after a successful fetch.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} url - Request URL key.
   */
  function clearFetchFailure(url) {
    const key = String(url || "").trim();
    if (!key) return;
    lastFetchFailureByUrl.delete(key);
  }

  /**
   * Safely returns the first data row from a PeeringDB list API response.
   * Purpose: Standardize extraction of the first `data` entry from API payloads.
   * Necessity: Reduces repeated optional-chaining and handles malformed shapes uniformly
   * by delegating shape warnings to warnMalformedApiPayloadOnce.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {*} payload - Raw JSON response object from a PeeringDB list endpoint.
   * @param {string} [source="unknown"] - Endpoint URL for diagnostic messages.
   * @returns {object|null} First item in `payload.data`, or null on any shape mismatch.
   */
  function getFirstApiDataItem(payload, source = "unknown") {
    if (!payload || typeof payload !== "object") {
      warnMalformedApiPayloadOnce(source, payload);
      return null;
    }

    if (!Array.isArray(payload.data)) {
      warnMalformedApiPayloadOnce(source, payload);
      return null;
    }

    const rows = payload.data;
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Returns a reason code when API JSON action should be blocked.
   * Purpose: Keep visibility and click-policy checks consistent.
   * Necessity: Some entities may not expose status reliably; block only when policy-relevant.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ entity: string, entityId: string }} ctx - Route context from getRouteContext().
   * @returns {string} Empty string when allowed; "missing-endpoint" or "status:<value>" otherwise.
   */
  function getApiJsonActionBlockReason(ctx) {
    const apiJsonUrl = getEntityApiJsonUrl(ctx);
    if (!apiJsonUrl) return "missing-endpoint";

    const entity = String(ctx?.entity || "").trim().toLowerCase();
    if (!ENTITY_TYPES.has(entity)) return "";

    const status = String(getSelectedStatus() || "").trim().toLowerCase();
    if (!status) return "";
    if (status !== "ok") return `status:${status}`;
    return "";
  }

  /**
   * Determines whether the API JSON action should be visible for current context.
   * Purpose: Avoid showing the button when action policy does not allow opening.
   * Necessity: Prevent no-op UI affordances for non-OK entities.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ entity: string, entityId: string }} ctx - Route context from getRouteContext().
   * @returns {boolean} True when the API JSON toolbar action should be shown.
   */
  function shouldShowApiJsonAction(ctx) {
    return !getApiJsonActionBlockReason(ctx);
  }

  /**
   * Debug-only OpenAPI coverage check for mapped CP API resources.
   * Purpose: Catch accidental resource-slug typos or drift early in diagnostics mode.
   * Necessity: ENTITY_API_RESOURCE_MAP is a critical integration point for API links/fetches.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function runApiResourceCoverageCheck() {
    if (!isDebugEnabled()) return;

    const mappedResources = Object.values(ENTITY_API_RESOURCE_MAP)
      .map((slug) => String(slug || "").trim())
      .filter(Boolean);

    const unknownResources = mappedResources.filter((slug) => !OPENAPI_KNOWN_RESOURCE_SLUGS.has(slug));
    if (unknownResources.length > 0) {
      console.warn(
        `[${MODULE_PREFIX}] self-check: unmapped OpenAPI resource slug(s) detected`,
        unknownResources,
      );
      return;
    }

    dbg("self-check", "api resource coverage ok", { count: mappedResources.length });
  }

  /**
   * Returns the entity-specific label for the secondary Copy URL action button.
   * Purpose: Make copy button labels contextually explicit (e.g., "Copy IX URL").
   * Necessity: A generic "Copy URL" label is ambiguous when Org and Entity
   * copy buttons both appear on the same secondary action row.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} entity - Lowercase CP entity type (e.g., "internetexchange").
   * @returns {string} Human-readable label string for the copy action.
   */
  function getEntityCopyLabel(entity) {
    const labelByEntity = {
      facility: "Copy Facility URL",
      network: "Copy Network URL",
      organization: "Copy Org URL",
      carrier: "Copy Carrier URL",
      internetexchange: "Copy IX URL",
      campus: "Copy Campus URL",
    };

    return labelByEntity[entity] || "Copy URL";
  }

  /**
   * Returns human-friendly website label for the current object type.
   * Purpose: Keep header website action labels concise and entity-specific.
   * Necessity: Replaces generic "ObjType Website" text with context-aware naming.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} entity - Lowercase CP entity type (e.g., "internetexchange").
   * @returns {string} Human-readable toolbar label (e.g., "IX Website").
   */
  function getEntityWebsiteLabel(entity) {
    const websiteLabelByEntity = {
      internetexchange: "IX Website",
      network: "Network Website",
      facility: "Facility Website",
      organization: "Org Website",
      carrier: "Carrier Website",
      campus: "Campus Website",
    };

    if (websiteLabelByEntity[entity]) {
      return websiteLabelByEntity[entity];
    }

    const fallback = String(entity || "")
      .trim()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());

    return `${fallback || "Entity"} Website`;
  }

  /**
   * Returns human-friendly frontend label for a CP entity.
   * Purpose: Make the main frontend action explicit about the destination entity type.
   * Necessity: Replaces generic "Frontend" text with entity-specific naming.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} entity - Lowercase CP entity type (e.g., "internetexchange").
  * @returns {string} Human-readable label (e.g., "IX (FP)").
   */
  function getEntityFrontendLabel(entity) {
    const frontendLabelByEntity = {
      internetexchange: "IX (FP)",
      network: "Network (FP)",
      facility: "Facility (FP)",
      organization: "Org (FP)",
      carrier: "Carrier (FP)",
      campus: "Campus (FP)",
    };

    if (frontendLabelByEntity[entity]) {
      return frontendLabelByEntity[entity];
    }

    const fallback = String(entity || "")
      .trim()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());

    return `${fallback || "Entity"} (FP)`;
  }

  /**
   * Returns human-friendly CP label for a CP entity.
   * Purpose: Keep CP-toolbar labels consistent across modules.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} entity - Lowercase CP entity type (e.g., "internetexchange").
   * @returns {string} Human-readable label (e.g., "IX (CP)").
   */
  function getEntityCpLabel(entity) {
    const cpLabelByEntity = {
      internetexchange: "IX (CP)",
      network: "Network (CP)",
      facility: "Facility (CP)",
      organization: "Org (CP)",
      carrier: "Carrier (CP)",
      campus: "Campus (CP)",
      networkixlan: "NetIXLAN (CP)",
    };

    if (cpLabelByEntity[entity]) {
      return cpLabelByEntity[entity];
    }

    const fallback = String(entity || "")
      .trim()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());

    return `${fallback || "Entity"} (CP)`;
  }

  /**
   * Resolves the organization ID to use when performing an Update Name action.
   * Purpose: Return the correct org ID source — the entity ID itself for org pages,
   * or the #id_org field for all other entity types.
   * Necessity: Organization pages use their own entity ID as the org reference;
   * child entities (networks, carriers, etc.) need the parent org from the form.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ isEntityChangePage: boolean, entity: string, entityId: string }} ctx
   * @returns {string} Organization ID string, or empty string if unresolvable.
   */
  function getOrganizationIdForNameUpdate(ctx) {
    if (!ctx?.isEntityChangePage) return "";
    if (ctx.entity === "organization") return String(ctx.entityId || "").trim();
    return getInputValue("#id_org");
  }

  /**
   * Locates and returns the primary CP object-tools toolbar UL element.
   * Purpose: Provide a single point of access for the main toolbar list.
   * Necessity: Toolbar selectors differ across Grappelli versions; a unified locator
   * with multiple fallback selectors avoids duplicate selector logic in every module.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @returns {HTMLUListElement|null} The primary toolbar list element, or null if absent.
   */
  function getToolbarList() {
    const toolbar = (
      qs("#grp-content-title > ul.grp-object-tools:not([data-pdb-cp-toolbar-row]):not([data-pdb-cp-action])") ||
      qs("#grp-content-title > ul.grp-object-tools") ||
      qs("#grp-content-title > ul")
    );
    return toolbar;
  }

  /**
   * Removes deprecated primary action row from legacy versions.
   * Purpose: Clean up stale DOM elements from previous script versions.
   * Necessity: Ensures backward compatibility when script updates; prevents duplicate action rows.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function cleanupLegacyPrimaryActionRow() {
    const legacyRow = qs(`#${MODULE_PREFIX}PrimaryActionRow`);
    if (!legacyRow) return;

    legacyRow.remove();
  }

  /**
   * Applies calculated vertical offset to secondary action row.
   * Purpose: Prevent overlap between primary toolbar and secondary action row.
   * Necessity: Secondary row appears below primary toolbar; must account for toolbar height
   * which varies by content. Uses BoundingClientRect to detect actual overlap.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLUListElement} row - The secondary action row element to adjust.
   */
  function applySecondaryRowVerticalOffset(row) {
    if (!row) return;

    const toolbar = getToolbarList();
    const baseOffset = 5;
    if (!toolbar) {
      row.style.marginTop = `${baseOffset}px`;
      return;
    }

    const toolbarRect = toolbar.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const overlap = Math.ceil(toolbarRect.bottom - rowRect.top);
    const computedOffset = overlap > 0 ? baseOffset + overlap : baseOffset;
    row.style.marginTop = `${computedOffset}px`;
  }

  /**
   * Creates and inserts a toolbar action button (link) into the primary toolbar.
   * Purpose: Standardized way to add custom buttons (Google Maps, Frontend links, etc.).
   * Necessity: Ensures consistent styling, idempotency (prevents duplicates), and placement.
   * Marks buttons with data-pdb-cp-action attribute for reordering and identification.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ id: string, label: string, href?: string, onClick?: Function,
   *           target?: string|null, insertLeft?: boolean }} opts
   * @returns {HTMLAnchorElement|null} The created anchor element, or null on failure.
   */
  function addToolbarAction({ id, label, href = "#", onClick, target = null, insertLeft = false }) {
    if (!id) return null;

    if (qs(`#${id}`)) {
      return qs(`#${id}`);
    }

    const toolbar = getToolbarList();
    if (!toolbar) return null;

    const li = document.createElement("li");
    li.setAttribute("data-pdb-cp-action", id);
    li.style.marginLeft = "5px";

    const a = document.createElement("a");
    a.id = id;
    a.href = href;
    a.textContent = label;
    a.style.cursor = "pointer";

    const normalizedTarget = String(target || "").trim();
    const requiresStableTarget =
      Boolean(href && href !== "#") &&
      (!normalizedTarget || normalizedTarget === "_new" || normalizedTarget === "_blank");
    const effectiveTarget = requiresStableTarget
      ? getStableToolbarLinkTarget(id)
      : normalizedTarget;

    if (effectiveTarget) {
      a.target = effectiveTarget;
    }

    a.addEventListener("click", (event) => {
      if (typeof onClick === "function") {
        event.preventDefault();
        onClick(event);
        return;
      }

      if (href && href !== "#") {
        event.preventDefault();
        const resolvedUrl = new URL(href, window.location.origin).toString();
        if (effectiveTarget && effectiveTarget !== "_self") {
          window.open(resolvedUrl, effectiveTarget, "noopener");
        } else {
          window.location.href = resolvedUrl;
        }
      }
    });

    li.appendChild(a);

    const firstCustom = qs("li[data-pdb-cp-action]", toolbar);
    const firstNonCustom = qs("li:not([data-pdb-cp-action])", toolbar);

    if (insertLeft) {
      if (firstCustom) {
        toolbar.insertBefore(li, firstCustom);
      } else if (firstNonCustom) {
        toolbar.insertBefore(li, firstNonCustom);
      } else {
        toolbar.appendChild(li);
      }
    } else if (firstNonCustom) {
      toolbar.insertBefore(li, firstNonCustom);
    } else {
      toolbar.appendChild(li);
    }

    return a;
  }

  /**
   * Constructs a reusable dropdown list-item element (toggle anchor + flyout menu).
   * Purpose: Build the shared DOM structure for multi-item toolbar and secondary-row menus.
   * Necessity: Both toolbar and secondary-row dropdown helpers use the same toggle/flyout
   * HTML pattern; centralizing avoids DOM duplication and styling drift.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ id: string, label: string, items: Array<{label: string, href: string, target?: string}>,
   *           resolveItemTarget?: Function }} opts
   * @returns {{ li: HTMLLIElement, toggle: HTMLAnchorElement }|null}
   */
  function createDropdownActionListItem({ id, label, items, resolveItemTarget = null }) {
    if (!id || !Array.isArray(items) || items.length === 0) return null;
    ensureDropdownGlobalCloseListener();

    const li = document.createElement("li");
    li.style.position = "relative";
    li.style.overflow = "visible";

    const toggle = document.createElement("a");
    toggle.id = id;
    toggle.href = "#";
    toggle.textContent = label;
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-haspopup", "true");

    const menu = document.createElement("div");
    menu.style.position = "absolute";
    menu.style.right = "0";
    menu.style.top = "calc(100% + 6px)";
    menu.style.display = "none";
    menu.style.flexDirection = "column";
    menu.style.gap = "4px";
    menu.style.padding = "6px";
    menu.style.background = "rgba(255, 255, 255, 0.98)";
    menu.style.border = "1px solid rgba(0, 0, 0, 0.12)";
    menu.style.borderRadius = "6px";
    menu.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.15)";
    menu.style.zIndex = "1000";
    menu.style.minWidth = "140px";

    items.forEach((item, index) => {
      const link = document.createElement("a");
      link.href = item.href;
      link.textContent = item.label;

      const explicitTarget = String(item?.target || "").trim();
      const computedTarget =
        typeof resolveItemTarget === "function"
          ? String(resolveItemTarget(item, index) || "").trim()
          : "";
      link.target = computedTarget || explicitTarget || "_blank";
      link.rel = "noopener noreferrer";
      link.style.display = "block";
      link.style.whiteSpace = "nowrap";
      link.style.padding = "2px 4px";
      link.addEventListener("click", () => {
        closeDropdownActionItem(li);
      });
      menu.appendChild(link);
    });

    const closeMenu = () => {
      closeDropdownActionItem(li);
    };

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = li.getAttribute("data-open") === "1";
      if (isOpen) {
        closeMenu();
        return;
      }

      closeAllDropdownActionItems(li);
      menu.style.display = "flex";
      toggle.setAttribute("aria-expanded", "true");
      li.setAttribute("data-open", "1");
      li.style.zIndex = "1001";
      openDropdownActionItems.add(li);
    });

    menu.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    li.appendChild(toggle);
    li.appendChild(menu);

    return { li, toggle };
  }

  /**
   * Creates and inserts a dropdown action button into the primary CP toolbar.
   * Purpose: Add multi-item expandable menus (e.g., Maps) to the main toolbar UL.
   * Necessity: Toolbar insertion semantics differ from the secondary row; wrapping
   * createDropdownActionListItem ensures correct placement and data-pdb-cp-action tagging.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ id: string, label: string, items: Array<{label: string, href: string}>,
   *           insertLeft?: boolean }} opts
   * @returns {HTMLAnchorElement|null} The dropdown toggle anchor element, or null on failure.
   */
  function addToolbarDropdownAction({ id, label, items, insertLeft = false }) {
    if (!id || !Array.isArray(items) || items.length === 0) return null;

    const existing = qs(`#${id}`);
    if (existing) {
      return existing;
    }

    const toolbar = getToolbarList();
    if (!toolbar) return null;

    const dropdown = createDropdownActionListItem({
      id,
      label,
      items,
      resolveItemTarget: (item, index) => {
        const explicitTarget = String(item?.target || "").trim();
        if (explicitTarget && explicitTarget !== "_new" && explicitTarget !== "_blank") {
          return explicitTarget;
        }

        const itemToken = toStableIdentityToken(item?.label || item?.href || `item_${index + 1}`, `item_${index + 1}`);
        return getStableToolbarLinkTarget(`${id}_${itemToken}`);
      },
    });
    if (!dropdown) return null;

    const { li, toggle } = dropdown;
    li.setAttribute("data-pdb-cp-action", id);
    li.style.marginLeft = "5px";

    const firstCustom = qs("li[data-pdb-cp-action]", toolbar);
    const firstNonCustom = qs("li:not([data-pdb-cp-action])", toolbar);

    if (insertLeft) {
      if (firstCustom) {
        toolbar.insertBefore(li, firstCustom);
      } else if (firstNonCustom) {
        toolbar.insertBefore(li, firstNonCustom);
      } else {
        toolbar.appendChild(li);
      }
    } else if (firstNonCustom) {
      toolbar.insertBefore(li, firstNonCustom);
    } else {
      toolbar.appendChild(li);
    }

    return toggle;
  }

  /**
   * Returns the secondary action row UL element, creating and inserting it if absent.
   * Purpose: Provide a persistent secondary UL row below the primary toolbar for custom buttons.
   * Necessity: Multiple modules inject secondary buttons; a shared row avoids
   * multiple disconnected rows and centralizes vertical offset handling.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {HTMLUListElement|null} The secondary action row element, or null on DOM failure.
   */
  function getOrCreateSecondaryActionRow() {
    const contentTitle = qs("#grp-content-title");
    if (!contentTitle) return null;

    const existing = qs(`#${MODULE_PREFIX}SecondaryActionRow`);
    if (existing) return existing;

    const row = document.createElement("ul");
    row.id = `${MODULE_PREFIX}SecondaryActionRow`;
    row.className = `grp-object-tools ${MODULE_PREFIX}SecondaryActionRow`;
    row.style.clear = "both";
    row.style.setProperty("float", "none", "important");
    row.style.setProperty("position", "static", "important");
    row.style.setProperty("top", "auto", "important");
    row.style.setProperty("right", "auto", "important");
    row.style.setProperty("left", "auto", "important");
    row.style.display = "block";
    row.style.textAlign = "right";
    row.style.width = "100%";
    row.style.marginTop = "5px";
    row.style.marginBottom = "10px";
    row.style.minHeight = "28px";
    row.style.boxSizing = "border-box";
    row.style.padding = "0";
    row.style.listStyle = "none";
    row.style.overflow = "visible";
    row.style.position = "relative";
    row.style.zIndex = "5";

    contentTitle.parentNode?.insertBefore(row, contentTitle.nextSibling);

    const syncOffset = () => applySecondaryRowVerticalOffset(row);
    requestAnimationFrame(syncOffset);
    setTimeout(syncOffset, 0);
    setTimeout(syncOffset, 80);

    if (!row.hasAttribute("data-offset-bound")) {
      row.setAttribute("data-offset-bound", "1");
      window.addEventListener("resize", syncOffset);
    }

    return row;
  }

  /**
   * Creates and appends a button to the secondary action row.
   * Purpose: Add custom actions to secondary row with consistent styling.
   * Necessity: Secondary row actions need inline-block styling and spacing different from primary toolbar.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ id: string, label: string, href?: string, title?: string, onClick: Function }} opts
   * @returns {HTMLAnchorElement|null} The created anchor element, or null on failure.
   */
  function addSecondaryActionButton({ id, label, href = "#", title = "", onClick }) {
    const row = getOrCreateSecondaryActionRow();
    if (!row || !id) return null;

    const existing = qs(`#${id}`);
    if (existing) return existing;

    const listItem = document.createElement("li");
    listItem.setAttribute("data-pdb-cp-secondary-action", id);
    listItem.style.display = "inline-block";
    listItem.style.setProperty("float", "none", "important");
    listItem.style.margin = "0";

    const hasExistingButtons = row.children.length > 0;
    if (hasExistingButtons) {
      listItem.style.marginLeft = "5px";
    }

    const button = document.createElement("a");
    button.id = id;
    button.href = href || "#";
    button.textContent = label;
    button.style.cursor = "pointer";
    if (title) {
      button.title = title;
    }

    if (typeof onClick === "function") {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        onClick(event);
      });
    }

    listItem.appendChild(button);
    row.appendChild(listItem);
    return button;
  }

  /**
   * Creates and appends a dropdown to the secondary action row.
   * Purpose: Add multi-item expandable actions (e.g., Maps) to the secondary row.
   * Necessity: Secondary row insertion semantics and item target resolution differ from
   * the primary toolbar; a dedicated helper keeps module code concise.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ id: string, label: string, items: Array<{label: string, href: string}> }} opts
   * @returns {HTMLAnchorElement|null} The dropdown toggle anchor element, or null on failure.
   */
  function addSecondaryDropdownAction({ id, label, items }) {
    const row = getOrCreateSecondaryActionRow();
    if (!row || !id || !Array.isArray(items) || items.length === 0) return null;

    const existing = qs(`#${id}`);
    if (existing) return existing;

    const dropdown = createDropdownActionListItem({ id, label, items });
    if (!dropdown) return null;

    const { li, toggle } = dropdown;
    li.setAttribute("data-pdb-cp-secondary-action", id);
    li.style.display = "inline-block";
    li.style.setProperty("float", "none", "important");
    li.style.margin = row.children.length > 0 ? "0 0 0 5px" : "0";
    li.style.verticalAlign = "top";

    row.appendChild(li);
    return toggle;
  }

  /**
   * Tests whether a container child element matches a priority descriptor.
   * Purpose: Support both CSS-selector strings and predicate functions in TOOLBAR_*_ORDER arrays.
   * Necessity: History item uses a function matcher; custom items use CSS attribute selectors;
   * a unified tester lets one reorder loop handle both types without branching.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {Element} child - DOM child element to test.
   * @param {string|Function} priority - CSS selector string or boolean predicate function.
   * @returns {boolean} True if `child` matches the given priority descriptor.
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
   * Identifies if a toolbar item is the History button.
   * Purpose: Handle History button specially in reordering (position it before custom actions).
   * Necessity: History button is Django admin native; needs position priority awareness.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {Element} child - Toolbar LI element to test.
   * @returns {boolean} True when the element is the native History button.
   */
  function isHistoryToolbarItem(child) {
    if (!child || child.hasAttribute("data-pdb-cp-action")) return false;

    const anchor = qs("a", child);
    if (!anchor) return false;

    const href = String(anchor.getAttribute("href") || "");
    const text = String(anchor.textContent || "").trim().toLowerCase();
    return href.includes("/history/") || text === "history";
  }

  /**
   * Reorders children of a container according to priority list.
   * Purpose: Establish deterministic button order (Frontend before Org links, History before custom).
   * Necessity: Ensures consistent UI layout across page variations and module load orders.
   * Unmatched children stay in original order at the end.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLElement} container - Parent element whose children will be reordered.
   * @param {Array<string|Function>} priorities - Ordered list of CSS selectors or predicate functions.
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
   * Enforces deterministic action button order in both primary and secondary toolbars (network only).
   * Purpose: Coordinate reordering of all network page toolbar buttons.
   * Necessity: Network pages have most custom actions; reordering provides consistent UX.
   * For other entity types, no special ordering applied (preserves natural order).
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ isEntityChangePage: boolean, entity: string }} ctx - Route context.
   */
  function enforceToolbarButtonOrder(ctx) {
    if (!ctx?.isEntityChangePage) return;

    const primaryToolbar = getToolbarList();
    if (primaryToolbar) {
      reorderChildrenByPriority(primaryToolbar, TOOLBAR_PRIMARY_ORDER);
    }

    const secondaryRow = qs(`#${MODULE_PREFIX}SecondaryActionRow`);
    if (secondaryRow) {
      reorderChildrenByPriority(secondaryRow, TOOLBAR_SECONDARY_ORDER);
    }
  }

  /**
   * Unified JSON fetch helper for all script-initiated HTTP requests.
   * Purpose: Single network abstraction with timeout, retry, and error normalisation
   * for both same-origin (PeeringDB API via fetch) and cross-origin (RDAP via
   * GM_xmlhttpRequest) call sites.
   * Necessity: Prevents N ad-hoc GM_xmlhttpRequest patterns from diverging on
   * timeout handling or header construction.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} url - Absolute URL to fetch.
   * @param {{ headers?: object, timeout?: number, retries?: number }} [options]
   * @returns {Promise<object|null>} Parsed JSON or null on any failure.
   */
  async function pdbFetch(url, { headers = {}, timeout = PDB_API_TIMEOUT_MS, retries = PDB_API_RETRIES } = {}) {
    const fullHeaders = buildTampermonkeyRequestHeaders(headers);
    let requestOrigin = "";
    try { requestOrigin = new URL(url, window.location.origin).origin; } catch (_err) { /* keep empty origin */ }
    const isSameOrigin = requestOrigin === window.location.origin;

    if (isSameOrigin) {
      for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
          logExternalRequestUserAgent({
            method: "GET",
            url,
            headers: fullHeaders,
            attempt: attempt + 1,
            retries,
            mode: "same-origin",
          });

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

          if (response.ok) {
            try {
              const parsed = await response.json();
              clearFetchFailure(url);
              return parsed;
            } catch (parseError) {
              recordFetchFailure(url, {
                type: "parse",
                mode: "same-origin",
                attempt: attempt + 1,
                retries,
                status: response.status,
                statusText: response.statusText,
                message: String(parseError?.message || parseError || "json-parse-failed"),
              });
              if (attempt + 1 >= retries) return null;
              continue;
            }
          }

          recordFetchFailure(url, {
            type: "http",
            mode: "same-origin",
            attempt: attempt + 1,
            retries,
            status: response.status,
            statusText: response.statusText,
            ok: false,
          });
        } catch (_err) {
          recordFetchFailure(url, {
            type: "exception",
            mode: "same-origin",
            attempt: attempt + 1,
            retries,
            message: String(_err?.message || _err || "fetch-exception"),
            name: String(_err?.name || "Error"),
            timeout,
          });
          if (attempt + 1 >= retries) return null;
        }
      }
      return null;
    }

    return new Promise((resolve) => {
      let attempts = 0;
      function attempt() {
        attempts += 1;
        logExternalRequestUserAgent({
          method: "GET",
          url,
          headers: fullHeaders,
          attempt: attempts,
          retries,
          mode: "cross-origin",
        });
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
                const parsed = JSON.parse(response.responseText);
                clearFetchFailure(url);
                resolve(parsed);
              }
              catch (_err) {
                recordFetchFailure(url, {
                  type: "parse",
                  mode: "cross-origin",
                  attempt: attempts,
                  retries,
                  status: response.status,
                  statusText: response.statusText,
                  message: String(_err?.message || _err || "json-parse-failed"),
                });
                resolve(null);
              }
            } else if (attempts < retries) {
              recordFetchFailure(url, {
                type: "http",
                mode: "cross-origin",
                attempt: attempts,
                retries,
                status: response.status,
                statusText: response.statusText,
                ok: false,
              });
              attempt();
            } else {
              recordFetchFailure(url, {
                type: "http",
                mode: "cross-origin",
                attempt: attempts,
                retries,
                status: response.status,
                statusText: response.statusText,
                ok: false,
              });
              resolve(null);
            }
          },
          onerror: () => {
            recordFetchFailure(url, {
              type: "error",
              mode: "cross-origin",
              attempt: attempts,
              retries,
              timeout,
            });
            if (attempts < retries) attempt(); else resolve(null);
          },
          ontimeout: () => {
            recordFetchFailure(url, {
              type: "timeout",
              mode: "cross-origin",
              attempt: attempts,
              retries,
              timeout,
            });
            if (attempts < retries) attempt(); else resolve(null);
          },
        });
      }
      attempt();
    });
  }

  /**
   * Executes HTTP POST/PUT/PATCH/DELETE request to PeeringDB API.
   * Purpose: Enable state-changing API operations (IXF import, carrierfac actions, etc.).
   * Necessity: pdbFetch supports only GET; this handles mutations with method/body.
   * Supports same-origin fetch and cross-origin GM_xmlhttpRequest delegation.
  * Returns mutation metadata including HTTP status, parsed JSON body (if any),
  * raw response text, and x-auth-status (when present).
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} url - API endpoint URL.
   * @param {string} method - HTTP method (POST, PUT, PATCH, DELETE).
   * @param {string|object} body - Request body (string or JSON object).
   * @param {{ headers?: object, contentType?: string, timeout?: number, retries?: number }} options
  * @returns {Promise<{ status: number, data?: object|null, rawBody?: string, authStatus?: string, headersRaw?: string, reason?: string, csrfSent?: boolean }>} Response metadata.
   */
  async function pdbPost(url, method = "POST", body = "", { headers = {}, contentType = "application/json", timeout = PDB_API_TIMEOUT_MS, retries = PDB_API_RETRIES } = {}) {
    const fullMethod = String(method || "POST").toUpperCase();
    const bodyString = typeof body === "string" ? body : JSON.stringify(body);
    const fullHeaders = buildTampermonkeyRequestHeaders({ ...headers, "content-type": contentType });
    const requiresCsrf = fullMethod !== "GET" && fullMethod !== "HEAD" && fullMethod !== "OPTIONS";
    let csrfSent = false;
    if (requiresCsrf) {
      const csrfToken = getCsrfToken();
      if (csrfToken && !fullHeaders["X-CSRFToken"] && !fullHeaders["x-csrftoken"]) {
        fullHeaders["X-CSRFToken"] = csrfToken;
        csrfSent = true;
      }
    }

    let requestOrigin = "";
    try { requestOrigin = new URL(url, window.location.origin).origin; } catch (_err) { /* keep empty origin */ }
    const isSameOrigin = requestOrigin === window.location.origin;

    if (isSameOrigin) {
      for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
          logExternalRequestUserAgent({
            method: fullMethod,
            url,
            headers: fullHeaders,
            attempt: attempt + 1,
            retries,
            mode: "same-origin",
          });

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const response = await fetch(url, {
            method: fullMethod,
            headers: getFetchSafeHeaders(fullHeaders),
            body: bodyString,
            credentials: "include",
            referrerPolicy: "strict-origin-when-cross-origin",
            signal: controller.signal,
          });
          clearTimeout(timer);

          const rawBody = await response.text();
          let data = null;
          try { data = JSON.parse(rawBody); } catch (_err) { /* ignore parse error */ }

          const authStatus = String(response.headers?.get("x-auth-status") || "");
          const headersRaw = Array.from(response.headers?.entries?.() || [])
            .map(([k, v]) => `${k}:${v}`)
            .join("\n");

          return {
            status: response.status,
            data,
            rawBody,
            authStatus,
            headersRaw,
            csrfSent,
          };
        } catch (_err) {
          if (attempt + 1 >= retries) {
            return { status: 0, data: null, rawBody: "", authStatus: "", headersRaw: "", reason: "network-error", csrfSent };
          }
        }
      }

      return { status: 0, data: null, rawBody: "", authStatus: "", headersRaw: "", reason: "network-error", csrfSent };
    }

    return new Promise((resolve) => {
      let attempts = 0;

      /**
       * Executes one cross-origin GM_xmlhttpRequest attempt with retry recursion.
       */
      function attempt() {
        attempts += 1;
        logExternalRequestUserAgent({
          method: fullMethod,
          url,
          headers: fullHeaders,
          attempt: attempts,
          retries,
          mode: "cross-origin",
        });
        GM_xmlhttpRequest({
          method: fullMethod,
          url,
          headers: fullHeaders,
          data: bodyString,
          withCredentials: true,
          anonymous: false,
          timeout,
          onload: (response) => {
            const headersRaw = String(response.responseHeaders || "");
            const authStatus = getHeaderValueFromRawHeaders(headersRaw, "x-auth-status");
            const rawBody = String(response.responseText || "");
            let data = null;
            try { data = JSON.parse(rawBody); } catch (_err) { /* ignore parse error */ }
            if (response.status >= 200 && response.status < 300) {
              resolve({ status: response.status, data, rawBody, authStatus, headersRaw, csrfSent });
            } else if (attempts < retries) {
              attempt();
            } else {
              resolve({ status: response.status, data, rawBody, authStatus, headersRaw, csrfSent });
            }
          },
          onerror: () => {
            if (attempts < retries) {
              attempt();
            } else {
              resolve({ status: 0, data: null, rawBody: "", authStatus: "", headersRaw: "", reason: "network-error", csrfSent });
            }
          },
          ontimeout: () => {
            if (attempts < retries) {
              attempt();
            } else {
              resolve({ status: 0, data: null, rawBody: "", authStatus: "", headersRaw: "", reason: "timeout", csrfSent });
            }
          },
        });
      }
      attempt();
    });
  }

  /**
   * Fetches organization name for an entity from its API response.
   * Purpose: Optimize carrier/campus Update Name by reading org_name directly
   * from the entity response instead of making a separate /api/org/{id} call.
   * Necessity: Carrier and Campus schemas include org_name as a readOnly field.
   * Returns null on network error or missing data (graceful degradation).
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} entity - Lowercase CP entity type (e.g., "carrier").
   * @param {string|number} entityId - CP entity record ID.
   * @returns {Promise<string|null>} Resolved organization name, or null on failure.
   */
  async function getOrganizationNameFromEntityApi(entity, entityId) {
    const resource = getEntityApiResourceByEntity(entity);
    if (!resource || !entityId) return null;

    try {
      const endpoint = getPeeringDbApiObjectUrl(resource, entityId);
      if (!endpoint) return null;

      const payload = await pdbFetch(endpoint);
      const entityData = getFirstApiDataItem(payload, endpoint);
      const resolved = String(entityData?.org_name || "").trim();
      if (!resolved) return null;
      return resolved;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Fetches organization name from PeeringDB API by organization ID.
   * Purpose: Resolve human-readable org names for network initialization.
   * Necessity: Network name should match org name; API lookup is more reliable than manual lookup.
   * Returns null on network error or missing data (graceful degradation).
   * @param {string|number} orgId - PeeringDB organization record ID.
   * @returns {Promise<string|null>} Resolved organization name, or null on failure.
   */
  /**
   * Detects if an organization name has RDAP corruption patterns.
   * Purpose: Identify org names that need sanitization/update.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} name - Organization name to test.
   * @returns {boolean} True if corruption patterns are detected.
   */
  function isRdapOrgNameMalformed(name) {
    const text = String(name || "").trim();
    if (!text) return false;

    const collapsedDuplicate = collapseExactCommaDuplicateName(text);
    const hasExactCommaDuplicate = collapsedDuplicate !== text;
    const hasCommaLegalAliasDuplicate = Boolean(resolveCompactNameFromCommaLegalAliases(text));

    // Patterns indicating RDAP corruption
    return (
      text.includes(", remarks:") ||
      text.includes(",remarks:") ||
      hasExactCommaDuplicate ||
      hasCommaLegalAliasDuplicate ||
      /\b(?:trad(?:ing)?\s+as|t\s*\/\s*a|d\s*\/?\s*b\s*\/?\s*a|dba)\s+/i.test(text) ||
      /^[^,]*,\s*[A-Z]{10,}/.test(text) // Comma followed by lots of caps (often remarks)
    );
  }

  /**
   * Fetches organization name and detects if it has RDAP corruption patterns.
   * Purpose: Identify and flag malformed org names for user awareness.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string|number} orgId - Organization ID to fetch.
   * @returns {Promise<{name: string, wasMalformed: boolean, knownAs: string}>} Name, malformation flag, and extracted AKA.
   */
  async function getOrganizationNameWithMalformationDetection(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return { name: null, wasMalformed: false, knownAs: "" };

    try {
      const endpoint = getPeeringDbApiObjectUrl("org", normalizedOrgId);
      if (!endpoint) return { name: null, wasMalformed: false, knownAs: "" };

      const payload = await pdbFetch(endpoint);
      const organizationData = getFirstApiDataItem(payload, endpoint);
      const rawName = String(organizationData?.name || "").trim();
      if (!rawName) return { name: null, wasMalformed: false, knownAs: "" };

      const wasMalformed = isRdapOrgNameMalformed(rawName);
      const identity = parseOrganizationNameIdentity(rawName);
      const cleanName = identity.name || sanitizeRdapOrgName(rawName);
      const knownAs = String(identity.knownAs || "").trim();

      setCachedOrganizationName(normalizedOrgId, cleanName);
      return { name: cleanName, wasMalformed, knownAs };
    } catch (_error) {
      return { name: null, wasMalformed: false, knownAs: "" };
    }
  }

  /**
   * Fetches and caches organization name by organization ID.
   * Purpose: Provide a simple org-name resolver for flows that do not require malformation metadata.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string|number} orgId - Organization ID to resolve.
   * @returns {Promise<string|null>} Sanitized organization name or null on failure.
   */
  async function getOrganizationName(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return null;

    const cached = getCachedOrganizationName(normalizedOrgId);
    if (cached) {
      // Still sanitize cached values in case they were stored before sanitization was added
      return sanitizeRdapOrgName(cached);
    }

    try {
      const endpoint = getPeeringDbApiObjectUrl("org", normalizedOrgId);
      if (!endpoint) return null;

      const payload = await pdbFetch(endpoint);
      const organizationData = getFirstApiDataItem(payload, endpoint);
      let resolved = String(organizationData?.name || "").trim();
      if (!resolved) return null;

      // Sanitize RDAP corruption patterns before caching
      resolved = sanitizeRdapOrgName(resolved);

      setCachedOrganizationName(normalizedOrgId, resolved);
      return resolved;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Updates organization name via PeeringDB API.
   * Purpose: Persist sanitized org names back to the database so all related entities benefit.
   * Necessity: When org names have RDAP corruption, updating the org ensures all networks/carriers/etc. under it reference the corrected name.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} orgId - Organization ID to update.
   * @param {string} newName - New organization name to save.
   * @param {string} [knownAs=""] - Optional AKA/legal owner name extracted from trading-as patterns.
   * @returns {Promise<{ok: boolean, reason: string}>} Result object with verification status.
   */
  async function updateOrganizationNameViaApi(orgId, newName, knownAs = "") {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    const normalizedName = sanitizeRdapOrgName(String(newName || "").trim());
    const normalizedKnownAs = String(knownAs || "").trim();

    if (!normalizedOrgId || !normalizedName) {
      return { ok: false, reason: "invalid-input" };
    }

    try {
      const endpoint = getPeeringDbApiObjectUrl("org", normalizedOrgId);
      if (!endpoint) return { ok: false, reason: "invalid-endpoint" };

      // PATCH is disabled in current PeeringDB API docs; use PUT for object updates.
      const payload = { name: normalizedName };
      if (normalizedKnownAs) {
        payload.aka = normalizedKnownAs;
      }
      const putResult = await pdbPost(endpoint, "PUT", payload, {
        contentType: "application/json",
        retries: 1,
      });

      if (!(putResult?.status >= 200 && putResult?.status < 300)) {
        const status = Number(putResult?.status || 0);
        if (isDebugEnabled()) {
          const authStatus = String(putResult?.authStatus || "").trim() || "missing";
          const reason = String(putResult?.reason || "http-error").trim();
          const csrfSent = Boolean(putResult?.csrfSent);
          const bodyText = putResult?.data
            ? JSON.stringify(putResult.data)
            : String(putResult?.rawBody || "");
          const compactBody = bodyText.replace(/\s+/g, " ").trim().slice(0, 220) || "<empty>";

          notifyUser({
            title: "PeeringDB CP (Debug)",
            text: `Org PUT failed: status=${status}, x-auth-status=${authStatus}, csrf-sent=${csrfSent}, reason=${reason}, body=${compactBody}`,
            timeout: 10000,
          });

          console.warn(`[${MODULE_PREFIX}] Org PUT debug failure`, {
            endpoint,
            status,
            authStatus,
            csrfSent,
            reason,
            data: putResult?.data || null,
            rawBody: putResult?.rawBody || "",
            headersRaw: putResult?.headersRaw || "",
          });
          dbg("org-put", "failure diagnostics", {
            endpoint,
            status,
            authStatus,
            csrfSent,
            reason,
            body: compactBody,
          });
        }
        return { ok: false, reason: `put-http-${status}` };
      }

      // Verifier: read-back org name from API and ensure the persisted value matches.
      const verifiedName = await getOrganizationName(normalizedOrgId);
      const normalizedVerified = sanitizeRdapOrgName(String(verifiedName || "").trim());
      if (!normalizedVerified) {
        return { ok: false, reason: "verify-empty" };
      }

      if (normalizedVerified !== normalizedName) {
        return { ok: false, reason: "verify-mismatch" };
      }

      setCachedOrganizationName(normalizedOrgId, normalizedVerified);
      appendOrgUpdateSuccessAuditEntry({
        orgId: normalizedOrgId,
        name: normalizedVerified,
        aka: normalizedKnownAs,
      });
      return { ok: true, reason: "verified" };
    } catch (_error) {
      return { ok: false, reason: "exception" };
    }
  }

  /**
   * Programmatically clicks the "Save and continue editing" button.
   * Purpose: Auto-submit form after automated edits (Reset Information, Update Name).
   * Necessity: Script-driven form changes need programmatic submission; improves UX.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @returns {boolean} True when the save button was found and clicked.
   */
  function clickSaveAndContinue() {
    const route = getRouteContext();
    if (route?.isEntityChangePage && route.entity === "network") {
      const changedRows = normalizeNetworkPocVisibilityPrivateToUsers();
      if (changedRows > 0) {
        dbg("network-save", `pre-submit normalized ${changedRows} private POC visibility value(s)`);
      }
    }

    const button =
      qs("form input[name='_continue']") ||
      qs("form > div > footer > div input[name='_continue']") ||
      qs("form > div > footer > div > div:nth-child(4) > input[name='_continue']");

    if (!button) return false;
    button.click();
    return true;
  }

  /**
   * Stores one-shot redirect intent for Update Name flow.
   * Purpose: Redirect to history only after next successful save round-trip.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ entity: string, entityId: string }} ctx - Route context.
   */
  function setPendingPostUpdateNameHistoryRedirect(ctx) {
    const entity = String(ctx?.entity || "").trim();
    const entityId = String(ctx?.entityId || "").trim();
    if (!entity || !entityId) return;

    const payload = {
      entity,
      entityId,
      createdAt: Date.now(),
      expiresAt: Date.now() + POST_UPDATE_NAME_HISTORY_REDIRECT_TTL_MS,
    };

    try {
      window.sessionStorage?.setItem(POST_UPDATE_NAME_HISTORY_REDIRECT_STORAGE_KEY, JSON.stringify(payload));
    } catch (_error) {
      // best-effort only
    }
  }

  /**
   * Clears one-shot redirect intent for Update Name flow.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function clearPendingPostUpdateNameHistoryRedirect() {
    try {
      window.sessionStorage?.removeItem(POST_UPDATE_NAME_HISTORY_REDIRECT_STORAGE_KEY);
    } catch (_error) {
      // best-effort only
    }
  }

  /**
   * Reads pending one-shot redirect intent.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @returns {{ entity: string, entityId: string, createdAt: number, expiresAt: number }|null} Parsed payload or null.
   */
  function getPendingPostUpdateNameHistoryRedirect() {
    try {
      const raw = window.sessionStorage?.getItem(POST_UPDATE_NAME_HISTORY_REDIRECT_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const entity = String(parsed?.entity || "").trim();
      const entityId = String(parsed?.entityId || "").trim();
      const createdAt = Number(parsed?.createdAt || 0);
      const expiresAt = Number(parsed?.expiresAt || 0);
      if (
        !entity ||
        !entityId ||
        !Number.isFinite(createdAt) ||
        createdAt <= 0 ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      ) {
        clearPendingPostUpdateNameHistoryRedirect();
        return null;
      }
      return { entity, entityId, createdAt, expiresAt };
    } catch (_error) {
      clearPendingPostUpdateNameHistoryRedirect();
      return null;
    }
  }

  /**
   * Determines whether current change page shows a successful save message.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {boolean} True when Django success message is present and no error notes are visible.
   */
  function hasSuccessfulChangeSaveMessage() {
    const hasErrors = Boolean(qs(".errornote") || qs(".errors") || qs("ul.errorlist li"));
    if (hasErrors) return false;

    const successItems = qsa(
      "ul.messagelist li, ul.grp-messagelist li, .messagelist li, .grp-messagelist li, .alert-success, .messages li, li.success",
    );
    return successItems.some((item) => {
      const text = String(item?.textContent || "").trim();
      return /(was\s+)?changed\s+successfully|successfully\s+changed|saved\s+successfully/i.test(text);
    });
  }

  /**
   * Fallback detector for successful post-submit round-trip when message markup differs.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ entity: string, entityId: string, createdAt: number }} pending - Pending redirect marker.
   * @returns {boolean} True when current page likely came from a successful same-page submit.
   */
  function isLikelySuccessfulPostSubmitRoundTrip(pending) {
    const hasErrors = Boolean(qs(".errornote") || qs(".errors") || qs("ul.errorlist li"));
    if (hasErrors) return false;

    const ageMs = Date.now() - Number(pending?.createdAt || 0);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 30 * 1000) return false;

    const expectedPath = `/cp/peeringdb_server/${pending.entity}/${pending.entityId}/change/`;
    const referrerPath = (() => {
      try {
        return new URL(String(document.referrer || ""), window.location.origin).pathname;
      } catch (_error) {
        return "";
      }
    })();

    return referrerPath === expectedPath;
  }

  /**
   * Redirects one time from change page to history page after successful Update Name save.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ entity: string, entityId: string, isEntityChangePage: boolean }} ctx - Route context.
   * @returns {boolean} True when redirect is triggered.
   */
  function maybeRedirectToHistoryAfterUpdateName(ctx) {
    if (!ctx?.isEntityChangePage) return false;

    const pending = getPendingPostUpdateNameHistoryRedirect();
    if (!pending) return false;

    if (pending.entity !== ctx.entity || pending.entityId !== String(ctx.entityId || "")) {
      return false;
    }

    if (!hasSuccessfulChangeSaveMessage() && !isLikelySuccessfulPostSubmitRoundTrip(pending)) {
      // Same page round-trip happened but no success (likely validation issue); do not keep stale intent.
      const hasValidationError = Boolean(qs(".errornote") || qs(".errors") || qs("ul.errorlist li"));
      if (hasValidationError) {
        clearPendingPostUpdateNameHistoryRedirect();
      }
      return false;
    }

    clearPendingPostUpdateNameHistoryRedirect();
    const historyPath = `/cp/peeringdb_server/${ctx.entity}/${ctx.entityId}/history/`;
    window.location.assign(historyPath);
    return true;
  }

  /**
   * Prompts user to confirm dangerous network reset operation.
   * Purpose: Prevent accidental data loss from Reset Information action.
   * Necessity: Shows user which network is being reset (by ID, ASN, name) for confirmation.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} asn - ASN string for the network being reset.
   * @param {string} networkName - Current network name shown in the confirmation prompt.
   * @param {string|number} networkId - CP network record ID.
   * @returns {boolean} True when the user confirmed; false when cancelled.
   */
  function confirmDangerousReset(asn, networkName, networkId) {
    const asnLabel = String(asn || "").trim();
    const nameLabel = String(networkName || "").trim();
    const networkIdLabel = String(networkId || "").trim();
    const summary = [
      networkIdLabel ? `ID ${networkIdLabel}` : null,
      asnLabel ? `AS${asnLabel}` : null,
      nameLabel || null,
    ]
      .filter(Boolean)
      .join(" / ");
    const contextLine = summary ? `\n\nTarget: ${summary}` : "";

    return window.confirm(
      `Are you sure you want to reset all network information? This action will clear many fields.${contextLine}`,
    );
  }

  /**
   * Copies text to clipboard with modern and fallback implementations.
   * Purpose: Enable "Copy URL" actions for user convenience.
   * Necessity: Handles browsers with and without Clipboard API support.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} text - Text content to write to the system clipboard.
   * @returns {Promise<boolean>} Resolves true when copy succeeded; false otherwise.
   */
  async function copyToClipboard(text) {
    const value = String(text || "");
    if (!value) return false;

    try {
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(value, "text");
        return true;
      }
    } catch (_error) {
      // fall through to browser clipboard APIs
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_error) {
      // fall through to legacy fallback
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "readonly");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      return Boolean(copied);
    } catch (_error) {
      return false;
    }
  }

  /**
   * Collects all currently rendered CP object change links from the active overview page.
   * Purpose: Support one-click copying of every visible change-page URL from a filtered list.
   * Necessity: Admin overview pages often expose many object rows and copying them manually
   * is tedious; harvesting current row links preserves the user's active filter/pagination view.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {string[]} Ordered, de-duplicated absolute change URLs currently present in the content area.
   */
  function getCurrentOverviewChangeLinks() {
    const anchors = qsa('#grp-content-container a[href*="/cp/peeringdb_server/"][href*="/change/"]');
    const seen = new Set();

    return anchors
      .map((anchor) => {
        const rawHref = String(anchor.getAttribute("href") || "").trim();
        if (!rawHref) return "";

        let absoluteUrl = "";
        try {
          absoluteUrl = new URL(rawHref, window.location.origin).toString();
        } catch (_error) {
          return "";
        }

        let parsed;
        try {
          parsed = new URL(absoluteUrl);
        } catch (_error) {
          return "";
        }

        if (!/^\/cp\/peeringdb_server\/[^/]+\/[^/]+\/change\/?$/i.test(parsed.pathname)) {
          return "";
        }

        if (seen.has(absoluteUrl)) return "";
        seen.add(absoluteUrl);
        return absoluteUrl;
      })
      .filter(Boolean);
  }

  /**
   * Builds a PeeringDB list API URL with query parameters.
   * Purpose: Centralize URL construction for sparse list retrieval calls.
   * Necessity: Reused by REST fallback and future bulk list scanners.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} resource - API resource slug (e.g., "net").
   * @param {Record<string, string|number|boolean|undefined|null>} [params={}] - Query parameter map.
   * @returns {string} Absolute URL string.
   */
  function buildPeeringDbListApiUrl(resource, params = {}) {
    const normalizedResource = String(resource || "").trim();
    if (!normalizedResource) return "";

    const url = new URL(`${PEERINGDB_API_BASE_URL}/${normalizedResource}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  /**
   * Normalizes API row objects into minimal network scan records.
   * Purpose: Keep name-pattern analysis independent of source transport shape.
   * Necessity: GraphQL and REST rows can differ slightly in key casing/types.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object} row - Source row object.
   * @returns {{ id: string, name: string }|null} Normalized record or null.
   */
  function normalizeNetworkNameRecord(row) {
    if (!row || typeof row !== "object") return null;
    const id = String(row.id || row.pk || "").trim();
    const name = String(row.name || "").trim();
    if (!id || !name) return null;
    return { id, name };
  }

  /**
   * Parses GraphQL response payload into normalized network records.
   * Purpose: Support multiple plausible GraphQL response envelopes safely.
   * Necessity: GraphQL schema details can vary; parser must be tolerant.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object|null} payload - GraphQL response payload.
   * @returns {{ id: string, name: string }[]} Parsed records.
   */
  function parseGraphQlNetworkRows(payload) {
    const data = payload && typeof payload === "object" ? payload.data : null;
    if (!data || typeof data !== "object") return [];

    const candidateContainers = [
      data.networks,
      data.network,
      data.networksConnection,
      data.net,
    ].filter(Boolean);

    const extractedRows = [];

    candidateContainers.forEach((container) => {
      if (Array.isArray(container)) {
        extractedRows.push(...container);
        return;
      }

      if (Array.isArray(container?.edges)) {
        container.edges.forEach((edge) => {
          if (edge?.node) extractedRows.push(edge.node);
        });
      }

      if (Array.isArray(container?.items)) {
        extractedRows.push(...container.items);
      }

      if (Array.isArray(container?.nodes)) {
        extractedRows.push(...container.nodes);
      }
    });

    return extractedRows
      .map((row) => normalizeNetworkNameRecord(row))
      .filter(Boolean);
  }

  /**
   * Executes one GraphQL network-name batch query via GET.
   * Purpose: Retrieve only id/name fields with schema-driven sparse selection.
   * Necessity: Keeps payload minimal and reusable for future GraphQL extensions.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ offset: number, limit: number }} opts - Pagination options.
   * @returns {Promise<{ id: string, name: string }[]|null>} Parsed rows or null when unavailable.
   */
  async function fetchGraphQlNetworkNameBatch({ offset, limit }) {
    const endpoint = `${window.location.origin}/api/graphql`;
    const query = `query NetworkNameBatch($first: Int!, $offset: Int!) {\n  networks(first: $first, offset: $offset, status: \"ok\") {\n    edges {\n      node {\n        id\n        name\n      }\n    }\n  }\n}`;
    const variables = { first: limit, offset };

    const url = `${endpoint}?query=${encodeURIComponent(query)}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
    const payload = await pdbFetch(url, {
      headers: {
        Accept: "application/json",
      },
      timeout: 15000,
      retries: 1,
    });
    if (!payload) return null;
    if (payload.errors && Array.isArray(payload.errors) && payload.errors.length > 0) return null;

    const rows = parseGraphQlNetworkRows(payload);
    return rows.length ? rows : null;
  }

  /**
   * Executes one REST network-name batch query with sparse fields.
   * Purpose: Reliable fallback when GraphQL endpoint is unavailable.
   * Necessity: Guarantees completion under strict request budgets.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ offset: number, limit: number }} opts - Pagination options.
   * @returns {Promise<{ id: string, name: string }[]>} Parsed rows.
   */
  async function fetchRestNetworkNameBatch({ offset, limit }) {
    const url = buildPeeringDbListApiUrl("net", {
      status: "ok",
      limit,
      skip: offset,
      depth: 0,
      fields: "id,name",
    });
    if (!url) return [];

    const payload = await pdbFetch(url, {
      headers: {
        Accept: "application/json",
      },
      timeout: 15000,
      retries: 1,
    });

    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return rows
      .map((row) => normalizeNetworkNameRecord(row))
      .filter(Boolean);
  }

  /**
   * Retrieves recent network names in fixed-size batches with minimal request count.
   * Purpose: Fetch up to 3000 names in 6 requests (500 each) under strict rate limits.
   * Necessity: Supports CP-side operational audits without backend tooling.
   * GraphQL is attempted once first; automatic REST fallback is used thereafter.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{
   *   targetCount?: number,
   *   pageSize?: number,
   *   requestLimit?: number,
   *   onProgress?: Function,
   * }} [opts]
   * @returns {Promise<{
   *   records: Array<{id: string, name: string}>,
   *   requestCount: number,
   *   transport: string,
   *   graphQlAttempted: boolean,
   * }>} Retrieval result.
   */
  async function fetchRecentNetworkNamesBatched(opts = {}) {
    const requestedTargetCount = Number(opts.targetCount ?? NETWORK_NAME_SCAN_TARGET_COUNT);
    const isTargetUnbounded = !Number.isFinite(requestedTargetCount) || requestedTargetCount <= 0;
    const targetCount = isTargetUnbounded
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(requestedTargetCount));
    const pageSize = Math.max(1, Math.floor(Number(opts.pageSize || NETWORK_NAME_SCAN_PAGE_SIZE)));
    const requestLimit = Math.max(1, Math.floor(Number(opts.requestLimit || NETWORK_NAME_SCAN_MAX_REQUESTS)));
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

    const totalBatches = Number.isFinite(targetCount) ? Math.ceil(targetCount / pageSize) : null;
    const records = [];
    const seenIds = new Set();
    let requestCount = 0;
    let graphQlAttempted = false;
    let graphQlEnabled = true;
    let transport = "rest";
    let batchIndex = 0;
    let offset = 0;

    while (requestCount < requestLimit && records.length < targetCount) {
      let rows = [];

      if (graphQlEnabled) {
        graphQlAttempted = true;
        const graphQlRows = await fetchGraphQlNetworkNameBatch({ offset, limit: pageSize });
        requestCount += 1;
        if (Array.isArray(graphQlRows) && graphQlRows.length > 0) {
          rows = graphQlRows;
          transport = "graphql";
        } else {
          graphQlEnabled = false;
          if (requestCount >= requestLimit) break;
          rows = await fetchRestNetworkNameBatch({ offset, limit: pageSize });
          requestCount += 1;
          transport = "rest";
        }
      } else {
        rows = await fetchRestNetworkNameBatch({ offset, limit: pageSize });
        requestCount += 1;
      }

      rows.forEach((row) => {
        if (records.length >= targetCount) return;
        if (seenIds.has(row.id)) return;
        seenIds.add(row.id);
        records.push(row);
      });

      if (onProgress) {
        onProgress({
          batchIndex: batchIndex + 1,
          totalBatches,
          recordsFetched: records.length,
          requestCount,
          transport,
        });
      }

      batchIndex += 1;
      offset += rows.length;

      if (rows.length === 0) break;
    }

    return { records, requestCount, transport, graphQlAttempted, totalBatches, isTargetUnbounded };
  }

  /**
   * Classifies one network name for likely auto-generated patterns.
   * Purpose: Prioritize names likely requiring manual "Update Name" remediation.
   * Necessity: Provides deterministic, extensible heuristics for operational triage.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
  * @param {string} name - Network name string.
  * @returns {{ score: number, reasons: string[] }} Classification result.
   */
  function classifyNetworkNamePattern(name) {
    const normalized = String(name || "").trim();
    if (!normalized) return { score: 0, reasons: [] };

    const reasons = [];
    let score = 0;
    const addReason = (reason, weight) => {
      reasons.push(reason);
      score += Math.max(0, Number(weight) || 0);
    };

    const letters = (normalized.match(/[A-Za-z]/g) || []).length;
    const digits = (normalized.match(/\d/g) || []).length;
    const alphaNumTotal = letters + digits;
    const digitRatio = alphaNumTotal > 0 ? digits / alphaNumTotal : 0;
    const separatorMatches = normalized.match(/[-_]/g) || [];
    const separatorCount = separatorMatches.length;
    const hasNoSpaces = !/\s/.test(normalized);
    const compactTokens = normalized.split(/[-_]/).filter(Boolean);
    const tokenCount = compactTokens.length;
    const totalTokenLength = compactTokens.reduce((sum, token) => sum + token.length, 0);
    const longestTokenLength = compactTokens.reduce((max, token) => Math.max(max, token.length), 0);
    const hasCompactDashedToken =
      hasNoSpaces && /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(normalized);
    const hasUppercaseLettersOnly = letters > 0 && normalized === normalized.toUpperCase();
    const hasMixedCaseLetters = /[a-z]/.test(normalized) && /[A-Z]/.test(normalized);

    const hasNumericOnly = /^\d{4,}$/.test(normalized);
    const hasAsnToken = /^(?:AS|ASN)[-_ ]?\d{2,}$/i.test(normalized);
    const hasOrgToken = /^ORG-[A-Z0-9-]{4,}$/i.test(normalized);
    const hasNirPrefix = /^(?:IDNIC|AFRINIC|LACNIC|APNIC|RIPE|ARIN)-/i.test(normalized);
    const hasGenericPrefixNumber = /^(?:NET|NETWORK|IX|CARRIER|FACILITY|CAMPUS)[-_ ]?\d{2,}$/i.test(normalized);
    const hasPlaceholderKeyword = /\b(?:test|dummy|temp|example|placeholder)\b/i.test(normalized);
    const hasDigitHeavy = digitRatio >= 0.60 && normalized.length >= 6;
    const hasLowAlphaSignal = letters <= 2 && normalized.length >= 7;
    const hasTokenLike = /^[A-Za-z0-9_-]{8,}$/.test(normalized) && hasNoSpaces && (hasAsnToken || hasOrgToken);
    const hasBoundaryAsAffix =
      /^(?:AS|ASN)[-_][A-Za-z0-9]{2,}$/i.test(normalized)
      || /^[A-Za-z0-9]{2,}[-_](?:AS|ASN)$/i.test(normalized);

    // Detect NIR country-code suffixes (2-letter country codes at end)
    const hasNirCountrySuffix = /-(?:AS|ID|IN|AP|BR|US|TW|RU|CN|AU|NZ|JP|KR|SG|HK|MY|TH|VN|PH|BD|PK|LK|NG|ZA|EG|KE|GH|ET|AR|CL|CO|PE|MX|CA|FR|DE|IT|ES|GB|NL|BE|CH|SE|NO|DK|FI|PL|CZ|RO|UA|EE|LV|LT|GR|HU|SK|IE|PT|TR|IL|AE|SA|KZ|UZ|TM|KG|AF|IR|IQ|JO|LB|SY)$/i.test(normalized);

    const hasWeakNirCountrySuffix = hasNirCountrySuffix && !hasNirPrefix;
    const hasStrongNirAffixCombo = hasNirPrefix && hasNirCountrySuffix;
    const hasStrongNirAffixMultiSegment = hasStrongNirAffixCombo && separatorCount >= 3;
    const hasStrongNirAffixLongToken = hasStrongNirAffixCombo && normalized.length >= 20;

    const hasDashedTokenBase =
      hasCompactDashedToken && !hasAsnToken && !hasOrgToken && !hasNirPrefix;
    const hasAllCapsCompactDashed = hasDashedTokenBase && hasUppercaseLettersOnly;
    const hasMixedCaseCompactDashed = hasDashedTokenBase && hasMixedCaseLetters;
    const hasMultiSegmentCompactDashed = hasDashedTokenBase && separatorCount >= 2;
    const hasLongCompactDashed = hasDashedTokenBase && normalized.length >= 18;
    const hasCompactInfraSuffixWord =
      hasDashedTokenBase && /(?:^|[-_])(?:NETWORK|NET)$/.test(normalized);

    // Detect loud punctuation that is uncommon in canonical compact net names.
    const hasInvalidChars = /[!@#$%^*=+\[\]{}|<>?\\]/.test(normalized);
    const hasTrailingLoudPunctuation = /(?:\s|^)[!]+$/.test(normalized) || /[!]+$/.test(normalized);

    if (hasNumericOnly) addReason("numeric-only", 13 + Math.min(4, Math.max(0, digits - 4)));
    if (hasPlaceholderKeyword) addReason("placeholder-keyword", 17);
    if (hasInvalidChars) addReason("invalid-chars", 13 + Math.min(3, separatorCount));
    if (hasAsnToken) addReason("asn-token", 12 + Math.min(3, Math.max(0, digits - 4)));
    if (hasOrgToken) addReason("org-token", 13 + Math.min(2, Math.max(0, tokenCount - 2)));
    if (hasNirPrefix) addReason("nir-prefix", 11 + Math.min(3, Math.max(0, tokenCount - 2)));
    if (hasWeakNirCountrySuffix) addReason("nir-country-suffix-weak", 2 + Math.min(2, Math.max(0, tokenCount - 2)));
    if (hasStrongNirAffixCombo) addReason("nir-affix-combo", 5 + Math.min(3, Math.max(0, tokenCount - 2)));
    if (hasStrongNirAffixMultiSegment) {
      addReason("nir-affix-multi-segment", 2 + Math.min(4, Math.max(0, separatorCount - 2)));
    }
    if (hasStrongNirAffixLongToken) {
      addReason(
        "nir-affix-long-token",
        2 + Math.min(5, Math.floor(Math.max(0, normalized.length - 20) / 4) + Math.floor(longestTokenLength / 12)),
      );
    }
    if (hasDashedTokenBase) {
      addReason(
        "compact-dashed-token",
        6 + Math.min(3, Math.max(0, tokenCount - 2)) + Math.min(2, Math.floor(totalTokenLength / 20)),
      );
    }
    if (hasBoundaryAsAffix) {
      addReason("boundary-as-affix", 8 + Math.min(2, Math.max(0, tokenCount - 2)));
    }
    if (hasAllCapsCompactDashed) {
      addReason("all-caps-compact-dashed", 4 + Math.min(3, Math.floor(letters / 10)));
    }
    if (hasMixedCaseCompactDashed) {
      addReason("mixed-case-compact-dashed", 3 + Math.min(3, Math.floor(letters / 12)));
    }
    if (hasMultiSegmentCompactDashed) {
      addReason("multi-segment-compact-dashed", 2 + Math.min(4, Math.max(0, tokenCount - 2)));
    }
    if (hasLongCompactDashed) {
      addReason("long-compact-dashed", 2 + Math.min(5, Math.floor(Math.max(0, normalized.length - 18) / 4)));
    }
    if (hasCompactInfraSuffixWord) {
      addReason("compact-infra-suffix", 4 + Math.min(2, Math.max(0, separatorCount - 1)));
    }
    if (hasGenericPrefixNumber) addReason("generic-prefix+number", 8 + Math.min(2, Math.max(0, digits - 2)));
    if (hasTokenLike) addReason("token-like", 2 + Math.min(3, Math.max(0, digits - 5)));
    if (hasDigitHeavy) addReason("digit-heavy", digitRatio >= 0.85 ? 6 : digitRatio >= 0.70 ? 5 : 4);
    if (hasLowAlphaSignal) addReason("low-alpha-signal", 3 + Math.min(2, Math.max(0, 2 - letters)));
    if (hasTrailingLoudPunctuation) addReason("trailing-loud-punctuation", 3);

    return { score, reasons };
  }

  /**
   * Analyzes network-name records and returns pattern diagnostics.
   * Purpose: Produce ranked candidate set and aggregate reason counts.
   * Necessity: Converts raw names into actionable remediation targets.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {Array<{id: string, name: string}>} records - Retrieved network records.
   * @returns {{
   *   scannedAt: string,
   *   total: number,
   *   suspiciousCount: number,
   *   suspicious: Array<{id: string, name: string, score: number, reasons: string[], changeUrl: string}>,
   *   reasonCounts: Record<string, number>,
   * }} Analysis payload.
   */
  function analyzeNetworkNamePatterns(records) {
    const inputRows = Array.isArray(records) ? records : [];
    const reasonCounts = {};
    const highConfidence = [];
    const review = [];
    const reviewThreshold = NETWORK_NAME_SCAN_MIN_SUSPICIOUS_SCORE;
    const highConfidenceThreshold = Math.max(
      reviewThreshold,
      NETWORK_NAME_SCAN_HIGH_CONFIDENCE_MIN_SCORE,
    );

    const sortByScoreAndIdDesc = (a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aDigits = Number.parseInt(String(a.id), 10);
      const bDigits = Number.parseInt(String(b.id), 10);
      if (Number.isFinite(aDigits) && Number.isFinite(bDigits)) {
        return bDigits - aDigits;
      }
      return String(b.id).localeCompare(String(a.id));
    };

    inputRows.forEach((row) => {
      const item = normalizeNetworkNameRecord(row);
      if (!item) return;

      const { score, reasons } = classifyNetworkNamePattern(item.name);
      reasons.forEach((reason) => {
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      });

      if (score >= highConfidenceThreshold) {
        highConfidence.push({
          ...item,
          tier: "high-confidence",
          score,
          reasons,
          changeUrl: `${window.location.origin}/cp/peeringdb_server/network/${item.id}/change/`,
        });
        return;
      }

      if (score >= reviewThreshold) {
        review.push({
          ...item,
          tier: "review",
          score,
          reasons,
          changeUrl: `${window.location.origin}/cp/peeringdb_server/network/${item.id}/change/`,
        });
      }
    });

    highConfidence.sort(sortByScoreAndIdDesc);
    review.sort(sortByScoreAndIdDesc);

    const suspicious = [...highConfidence, ...review];

    return {
      scannedAt: new Date().toISOString(),
      total: inputRows.length,
      highConfidenceCount: highConfidence.length,
      reviewCount: review.length,
      suspiciousCount: suspicious.length,
      highConfidence,
      review,
      suspicious,
      reasonCounts,
    };
  }

  /**
   * Returns a compact human-readable summary for notifications/logging.
   * Purpose: Surface key scan outcomes without requiring table inspection.
   * Necessity: Enables quick operator feedback after long-running scans.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object} result - Combined retrieval + analysis result.
   * @returns {string} One-line summary.
   */
  function buildNetworkNamePatternSummary(result) {
    const total = Number(result?.analysis?.total || 0);
    const highConfidenceCount = Number(result?.analysis?.highConfidenceCount || 0);
    const reviewCount = Number(result?.analysis?.reviewCount || 0);
    const suspiciousCount = Number(result?.analysis?.suspiciousCount || 0);
    const requestCount = Number(result?.requestCount || 0);
    const transport = String(result?.transport || "rest").toUpperCase();
    const source = String(result?.source || "fresh").toLowerCase() === "cache" ? "cache" : "fresh fetch";
    return `Scanned ${total} network names in ${requestCount} request${requestCount === 1 ? "" : "s"} (${transport}, ${source}); flagged ${suspiciousCount} names (${highConfidenceCount} high-confidence, ${reviewCount} review).`;
  }

  /**
   * Reads cached network-name retrieval payload when still fresh.
   * Purpose: Reuse previously fetched network rows without re-calling list endpoints.
   * Necessity: Scan-logic changes should not force a refetch of the same network-name data.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @returns {object|null} Cached retrieval payload or null.
   */
  function getCachedNetworkNameData() {
    try {
      if (
        networkNameDataMemoryCache?.payload &&
        Number.isFinite(networkNameDataMemoryCache?.expiresAt) &&
        networkNameDataMemoryCache.expiresAt > Date.now()
      ) {
        return networkNameDataMemoryCache.payload;
      }

      const storage = getDomainCacheStorage();
      const raw = storage?.getItem(NETWORK_NAME_CACHE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const expiresAt = Number(parsed?.expiresAt || 0);
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        storage?.removeItem(NETWORK_NAME_CACHE_KEY);
        return null;
      }

      const payload = parsed?.payload;
      if (!payload || typeof payload !== "object") return null;
      if (!Array.isArray(payload.records)) return null;
      networkNameDataMemoryCache = { expiresAt, payload };
      return payload;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Stores fetched network-name retrieval payload in short-lived domain cache.
   * Purpose: Cache full fetched row list once, then reuse for repeated analysis runs.
   * Necessity: Keeps scan cost low while allowing scan-logic reruns within TTL.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} payload - Retrieval payload including records + transport metadata.
   */
  function setCachedNetworkNameData(payload) {
    try {
      const expiresAt = Date.now() + NETWORK_NAME_CACHE_TTL_MS;
      networkNameDataMemoryCache = { expiresAt, payload };

      const storage = getDomainCacheStorage();
      storage?.setItem(
        NETWORK_NAME_CACHE_KEY,
        JSON.stringify({
          expiresAt,
          payload,
        }),
      );
    } catch (_error) {
      // Ignore cache-write failures.
    }
  }

  /**
   * Builds a stable signature for fetched network-name rows.
   * Purpose: Tie derived scan analysis to the exact cached dataset it was computed from.
   * Necessity: Separating data-cache and analysis-cache requires safe reuse boundaries.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {Array<{id: string, name: string}>} records - Normalized or raw network records.
   * @returns {string} Compact deterministic signature.
   */
  function buildNetworkNameRecordSignature(records) {
    const rows = Array.isArray(records) ? records : [];
    let hash = 0;

    rows.forEach((row) => {
      const id = String(row?.id || "").trim();
      const name = String(row?.name || "").trim();
      const token = `${id}:${name}|`;
      for (let index = 0; index < token.length; index += 1) {
        hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
      }
    });

    return `${rows.length}:${hash.toString(16)}`;
  }

  /**
   * Builds the cache signature for derived network-name scan analysis.
   * Purpose: Invalidate analysis whenever either the fetched dataset or scan logic changes.
   * Necessity: Logic changes should not force data refetches, but must prevent stale analysis reuse.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} retrieval - Retrieval payload containing fetched network records.
   * @returns {string} Deterministic analysis-cache signature.
   */
  function buildNetworkNameScanCacheSignature(retrieval) {
    const requestCount = Number(retrieval?.requestCount || 0);
    const transport = String(retrieval?.transport || "rest").trim().toLowerCase();
    const recordSignature = buildNetworkNameRecordSignature(retrieval?.records);
    return [
      `analysis-v${NETWORK_NAME_SCAN_ANALYSIS_VERSION}`,
      NETWORK_NAME_SCAN_MIN_SUSPICIOUS_SCORE,
      NETWORK_NAME_SCAN_HIGH_CONFIDENCE_MIN_SCORE,
      requestCount,
      transport,
      recordSignature,
    ].join(":");
  }

  /**
   * Reads cached derived network-name scan analysis when it matches current data and logic.
   * Purpose: Avoid re-running analysis while keeping scan-logic changes isolated from fetch cache.
   * Necessity: Operators may iterate on scan rules often; only derived results should churn.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} retrieval - Retrieval payload containing fetched network rows.
   * @returns {object|null} Cached analysis payload or null.
   */
  function getCachedNetworkNameScanAnalysis(retrieval) {
    try {
      const expectedSignature = buildNetworkNameScanCacheSignature(retrieval);
      if (
        networkNameScanMemoryCache?.payload &&
        Number.isFinite(networkNameScanMemoryCache?.expiresAt) &&
        networkNameScanMemoryCache.expiresAt > Date.now() &&
        networkNameScanMemoryCache.signature === expectedSignature
      ) {
        return networkNameScanMemoryCache.payload;
      }

      const storage = getDomainCacheStorage();
      const raw = storage?.getItem(NETWORK_NAME_SCAN_CACHE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const expiresAt = Number(parsed?.expiresAt || 0);
      const signature = String(parsed?.signature || "").trim();
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt || signature !== expectedSignature) {
        storage?.removeItem(NETWORK_NAME_SCAN_CACHE_KEY);
        return null;
      }

      const payload = parsed?.payload;
      if (!payload || typeof payload !== "object") return null;
      if (!Array.isArray(payload.suspicious)) return null;
      networkNameScanMemoryCache = { expiresAt, signature, payload };
      return payload;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Stores derived network-name scan analysis in short-lived domain cache.
   * Purpose: Reuse analysis results independently from the fetched row cache.
   * Necessity: Splitting caches allows scan logic to churn without invalidating network-name data.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} retrieval - Retrieval payload containing fetched network rows.
   * @param {object} analysis - Derived analysis payload.
   */
  function setCachedNetworkNameScanAnalysis(retrieval, analysis) {
    try {
      const expiresAt = Date.now() + NETWORK_NAME_SCAN_CACHE_TTL_MS;
      const signature = buildNetworkNameScanCacheSignature(retrieval);
      networkNameScanMemoryCache = { expiresAt, signature, payload: analysis };

      const storage = getDomainCacheStorage();
      storage?.setItem(
        NETWORK_NAME_SCAN_CACHE_KEY,
        JSON.stringify({
          expiresAt,
          signature,
          payload: analysis,
        }),
      );
    } catch (_error) {
      // Ignore cache-write failures.
    }
  }

  /**
   * Builds TSV text for suspicious network-name candidates.
   * Purpose: Provide copy-pastable remediation worklist for manual update runs.
   * Necessity: Operators frequently move candidate sets between browser and spreadsheets.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ suspicious: Array<{id: string, name: string, reasons: string[], changeUrl: string}> }} analysis - Analysis payload.
   * @returns {string} TSV output string.
   */
  function buildSuspiciousNetworkNameTsv(analysis) {
    const rows = Array.isArray(analysis?.suspicious) ? analysis.suspicious : [];
    const header = ["id", "name", "tier", "score", "reasons", "change_url"].join("\t");
    const lines = rows.map((item) => {
      const id = String(item?.id || "").trim();
      const name = String(item?.name || "").trim().replace(/\s+/g, " ");
      const tier = String(item?.tier || "review").trim();
      const score = String(item?.score ?? "").trim();
      const reasons = Array.isArray(item?.reasons) ? item.reasons.join(",") : "";
      const changeUrl = String(item?.changeUrl || "").trim();
      return [id, name, tier, score, reasons, changeUrl].join("\t");
    });
    return [header, ...lines].join("\n");
  }

  /**
   * Emits structured network-name diagnostics to the console.
   * Purpose: Keep detailed pattern evidence available without cluttering notifications.
   * Necessity: Manual cleanup planning benefits from sortable tables and reason distributions.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{
   *   requestCount: number,
   *   transport: string,
   *   graphQlAttempted: boolean,
   *   analysis: object,
   * }} result - Combined retrieval+analysis result.
   */
  function logNetworkNamePatternDiagnostics(result) {
    const analysis = result?.analysis || {};
    const suspicious = Array.isArray(analysis.suspicious) ? analysis.suspicious : [];
    const highConfidenceCount = Number(analysis.highConfidenceCount || 0);
    const reviewCount = Number(analysis.reviewCount || 0);
    const reasonCounts = analysis.reasonCounts || {};
    const reasonRows = Object.entries(reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    console.group(`[${MODULE_PREFIX}] Network name scan diagnostics`);
    console.info(buildNetworkNamePatternSummary(result));
    console.info({
      scannedAt: analysis.scannedAt,
      total: analysis.total,
      highConfidenceCount,
      reviewCount,
      suspiciousCount: analysis.suspiciousCount,
      source: String(result?.source || "fresh"),
      requestCount: result?.requestCount,
      transport: result?.transport,
      graphQlAttempted: Boolean(result?.graphQlAttempted),
    });

    if (reasonRows.length) {
      console.table(reasonRows);
    }

    if (suspicious.length) {
      const preview = suspicious.slice(0, 200).map((item) => ({
        id: item.id,
        name: item.name,
        tier: item.tier,
        score: item.score,
        reasons: item.reasons.join(", "),
        changeUrl: item.changeUrl,
      }));
      console.table(preview);
    }

    console.groupEnd();
  }

  /**
   * Shows a non-blocking userscript notification when supported.
   * Purpose: Surface completion/failure status for long-running CP actions.
   * Necessity: Async updates may complete after several network calls and benefit from toasts.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ title?: string, text: string, timeout?: number }} opts - Notification options.
   */
  function notifyUser({ title, text, timeout = 2500 }) {
    const normalizedTitle = String(title || "PeeringDB CP").trim();
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return;

    try {
      if (typeof GM_notification === "function") {
        GM_notification({
          title: normalizedTitle,
          text: normalizedText,
          timeout,
        });
      }
    } catch (_error) {
      // Notification support may vary per browser/extension environment.
    }
  }

  /**
   * Temporarily changes button text then reverts after a delay.
   * Purpose: Provide user feedback that copy action succeeded.
   * Necessity: "Copied" feedback improves UX for copy-to-clipboard buttons.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {HTMLAnchorElement} anchor - The toolbar button anchor whose text will pulse.
   * @param {string} [successLabel="Copied"] - Temporary label shown during the pulse.
   */
  function pulseToolbarButton(anchor, successLabel = "Copied") {
    if (!anchor) return;

    const original = anchor.textContent || "";
    anchor.textContent = successLabel;
    setTimeout(() => {
      anchor.textContent = original;
    }, 1000);
  }

  /**
   * Temporarily changes copy-icon button text then reverts after a delay.
   * Purpose: Give immediate feedback for field-level copy actions.
   * Necessity: Field copy buttons are icon-only by default and need success confirmation.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLButtonElement} button - The copy icon button whose text will pulse.
   * @param {string} [successLabel="Copied"] - Temporary label shown during the pulse.
   */
  function pulseCopyIconButton(button, successLabel = "Copied") {
    if (!button) return;

    const original = button.textContent || "";
    button.textContent = successLabel;
    setTimeout(() => {
      button.textContent = original;
    }, 1000);
  }

  /**
   * Ensures copy button CSS is available for field-level copy buttons.
   * Purpose: Keep button visuals consistent and lightweight without external CSS dependencies.
   * Necessity: The userscript runs in-page and must inject styles itself.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function ensureFieldCopyButtonStyles() {
    const styleId = `${MODULE_PREFIX}CopyFieldStyle`;
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .${MODULE_PREFIX}CopyFieldButton {
        float: right;
        margin-left: 6px;
        border: 1px solid #d7d7d7;
        border-radius: 3px;
        background: #f9f9f9;
        color: #444;
        font-size: 11px;
        line-height: 1.4;
        padding: 0 6px;
        cursor: pointer;
      }
      .${MODULE_PREFIX}CopyFieldButton:hover {
        background: #efefef;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Ensures CSS styles are available for inline rows marked for deletion.
   * Purpose: Make pending inline deletions visually obvious before save.
   * Necessity: Grappelli delete checkboxes can be easy to miss in dense tabular inlines.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function ensureInlineDeleteHighlightStyles() {
    const styleId = `${MODULE_PREFIX}InlineDeleteHighlightStyle`;
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .${MODULE_PREFIX}InlineMarkedDelete {
        background: linear-gradient(
          90deg,
          rgba(244, 67, 54, 0.28) 0%,
          rgba(244, 67, 54, 0.16) 100%
        ) !important;
        outline: 2px solid rgba(198, 40, 40, 0.9);
        outline-offset: -2px;
        box-shadow: inset 0 0 0 9999px rgba(244, 67, 54, 0.12);
      }

      .${MODULE_PREFIX}InlineMarkedDelete .grp-td {
        background-color: transparent !important;
      }

      .${MODULE_PREFIX}InlineMarkedDelete .grp-tools-container {
        background: rgba(183, 28, 28, 0.2) !important;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Returns the owning inline row element for a delete control.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {Element|null} element - Delete checkbox or delete icon descendant.
   * @returns {HTMLElement|null} Owning `.form-row.grp-dynamic-form` element.
   */
  function getInlineDeleteRowElement(element) {
    return element?.closest(".form-row.grp-dynamic-form") || null;
  }

  /**
   * Applies/removes the marked-for-deletion visual state on an inline row.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLElement|null} row - Inline row element.
   * @param {boolean} isMarkedForDelete - Whether delete checkbox is active.
   */
  function setInlineDeleteRowHighlight(row, isMarkedForDelete) {
    if (!row) return;
    row.classList.toggle(`${MODULE_PREFIX}InlineMarkedDelete`, Boolean(isMarkedForDelete));
  }

  /**
   * Syncs highlight state for one inline row based on its DELETE checkbox value.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLElement|null} row - Inline row element.
   */
  function syncInlineDeleteRowHighlight(row) {
    if (!row) return;
    const deleteCheckbox = qs('input[type="checkbox"][name$="-DELETE"]', row);
    setInlineDeleteRowHighlight(row, Boolean(deleteCheckbox?.checked));
  }

  /**
   * Binds delegated listeners that highlight rows when inline delete is toggled.
   * Purpose: Make delete actions (cross icon/checkbox) highly visible instantly.
   * Necessity: Inline rows are dynamic; delegated binding covers existing and added rows.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @returns {Function|null} Dispose function that removes listeners.
   */
  function bindInlineDeleteHighlightReactivity() {
    const container = qs("#grp-content-container");
    if (!container || container.hasAttribute("data-pdb-cp-inline-delete-highlight-bound")) {
      return null;
    }

    ensureInlineDeleteHighlightStyles();
    container.setAttribute("data-pdb-cp-inline-delete-highlight-bound", "1");

    qsa(".form-row.grp-dynamic-form", container).forEach((row) => {
      syncInlineDeleteRowHighlight(row);
    });

    const onChange = (event) => {
      const target = event?.target;
      if (!target?.matches?.('input[type="checkbox"][name$="-DELETE"]')) return;
      syncInlineDeleteRowHighlight(getInlineDeleteRowElement(target));
    };

    const onClick = (event) => {
      const deleteIcon = event?.target?.closest?.("a.grp-delete-handler");
      if (!deleteIcon) return;

      const row = getInlineDeleteRowElement(deleteIcon);
      // Grappelli toggles checkbox in its own click handler; defer one tick.
      setTimeout(() => {
        syncInlineDeleteRowHighlight(row);
      }, 0);
    };

    container.addEventListener("change", onChange);
    container.addEventListener("click", onClick);

    return () => {
      container.removeEventListener("change", onChange);
      container.removeEventListener("click", onClick);
      container.removeAttribute("data-pdb-cp-inline-delete-highlight-bound");
    };
  }

  /**
   * Normalizes text copied from rendered field contents.
   * Purpose: Remove excessive whitespace while preserving readable one-line output.
   * Necessity: Rendered HTML often contains line breaks and spacing artifacts.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {string} text - Raw text content extracted from the DOM.
   * @returns {string} Normalized single-line string with trimmed whitespace.
   */
  function normalizeRenderedCopyText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Finds the field label text for a value container.
   * Purpose: Support field-level filtering rules by human-visible label.
   * Necessity: Some CP rows are metadata or helper rows and should not get copy icons.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLElement} valueCell - The `.c-2` value cell whose parent row label is read.
   * @returns {string} Lowercase label text, or empty string if no label found.
   */
  function getFieldLabelText(valueCell) {
    const row = valueCell?.closest(".form-row");
    if (!row) return "";

    const label = qs(".c-1 label", row) || qs(".c-1", row);
    return normalizeRenderedCopyText(label?.textContent || "").toLowerCase();
  }

  /**
   * Resolves best non-help data value from direct controls inside a field value cell.
   * Purpose: Distinguish actual field data from explanatory helper text.
   * Necessity: Prevents copy buttons from appearing when only help text is present.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLElement} valueCell - The `.c-2` value cell to inspect.
   * @returns {string} Best available data value string, or empty string if none.
   */
  function getDirectFieldDataValue(valueCell) {
    if (!valueCell) return "";

    const readonly = qs(".grp-readonly", valueCell);
    if (readonly) {
      return normalizeRenderedCopyText(readonly.textContent || "");
    }

    const select = qs("select", valueCell);
    if (select) {
      const selectedOptions = Array.from(select.selectedOptions || []);
      const selectedText = selectedOptions
        .map((option) => normalizeRenderedCopyText(option.textContent || option.value || ""))
        .filter(Boolean)
        .join(", ");
      if (selectedText) return selectedText;
    }

    const textarea = qs("textarea", valueCell);
    if (textarea) {
      const value = normalizeRenderedCopyText(textarea.value || textarea.textContent || "");
      if (value) return value;
    }

    const input = qs("input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='file'])", valueCell);
    if (input) {
      const inputType = String(input.getAttribute("type") || "text").toLowerCase();
      if (inputType === "checkbox" || inputType === "radio") {
        return input.checked ? "true" : "false";
      }

      const value = normalizeRenderedCopyText(input.value || "");
      if (value) return value;
    }

    const anchor = qs("a[href^='http://'], a[href^='https://']", valueCell);
    if (anchor) {
      const href = normalizeRenderedCopyText(anchor.getAttribute("href") || "");
      if (href) return href;
    }

    return "";
  }

  /**
   * Determines whether a value container should receive a copy button.
   * Purpose: Exclude helper/metadata/lookup-only rows while keeping real data fields copiable.
   * Necessity: Avoids noisy icons on rows that do not represent useful copyable values.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLElement} valueCell - The `.c-2` cell to evaluate.
   * @returns {boolean} True when a copy button should be injected into this cell.
   */
  function shouldAttachCopyButtonToValueCell(valueCell) {
    if (!valueCell) return false;

    const labelText = getFieldLabelText(valueCell);
    if (COPY_FIELD_DENY_LABELS.has(labelText)) return false;

    const directValue = getDirectFieldDataValue(valueCell);
    const isConditionalEmptyField = COPY_FIELD_CONDITIONAL_EMPTY_LABELS.has(labelText);
    if (isConditionalEmptyField && !directValue) return false;

    if (qs("input[type='file']", valueCell)) return false;

    if (qs(".grp-help", valueCell) && !qs("input, textarea, select, .grp-readonly", valueCell)) {
      return false;
    }

    const hasReadonly = Boolean(qs(".grp-readonly", valueCell));
    const hasDataInput = Boolean(
      qs("input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='file']), textarea, select", valueCell),
    );
    const hasPublicLink = Boolean(qs("a[href^='http://'], a[href^='https://']", valueCell));

    return hasReadonly || hasDataInput || hasPublicLink;
  }

  /**
   * Resolves the best rendered value from a Django admin field value container.
   * Purpose: Prefer human-visible values (grp-readonly, selected option labels) over raw markup.
   * Necessity: Different field types render values differently in CP forms and inline forms.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {HTMLElement} container - The `.c-2` or similar value container element.
   * @returns {string} Best human-visible text value from the container.
   */
  function getRenderedFieldValue(container) {
    if (!container) return "";

    const directValue = getDirectFieldDataValue(container);
    if (directValue) return directValue;

    const clone = container.cloneNode(true);
    qsa(".grp-help", clone).forEach((help) => help.remove());
    qsa(`button.${MODULE_PREFIX}CopyFieldButton`, clone).forEach((button) => button.remove());
    return normalizeRenderedCopyText(clone.textContent || "");
  }

  /**
   * Adds a copy icon button to each rendered form value container.
   * Purpose: Make every visible field value directly copiable from the CP UI.
   * Necessity: Admin workflows often require copying readonly values such as Prefixes.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function addCopyButtonsToRenderedFields() {
    ensureFieldCopyButtonStyles();

    qsa(".form-row .c-2").forEach((valueCell) => {
      if (valueCell.hasAttribute("data-pdb-cp-copy-bound")) return;
      if (!shouldAttachCopyButtonToValueCell(valueCell)) return;

      const initialValue = getRenderedFieldValue(valueCell);
      if (!initialValue) return;

      valueCell.setAttribute("data-pdb-cp-copy-bound", "1");

      const button = document.createElement("button");
      button.type = "button";
      button.className = `${MODULE_PREFIX}CopyFieldButton`;
      button.title = "Copy value";
      button.setAttribute("aria-label", "Copy value");
      button.textContent = "⧉";

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const value = getRenderedFieldValue(valueCell);
        if (!value) return;

        const copied = await copyToClipboard(value);
        if (copied) {
          pulseCopyIconButton(button);
        }
      });

      valueCell.appendChild(button);
    });
  }

  /**
   * Determines the frontend URL path for a CP entity (network, carrier, ix).
   * Purpose: Generate correct copy-to-clipboard URL for the current entity type.
   * Necessity: Different entity types map to different URL paths.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ entity: string, entityId: string }} ctx - Route context from getRouteContext().
   * @returns {string} Root-relative frontend path (e.g., "/net/42").
   */
  function getCopyNetworkFrontendPath(ctx) {
    if (ctx.entity === "carrier") {
      return `/carrier/${ctx.entityId}`;
    }

    if (ctx.entity === "internetexchange") {
      return `/ix/${ctx.entityId}`;
    }

    return `/net/${ctx.entityId}`;
  }

  /**
   * Retrieves currently selected status from the status dropdown.
   * Purpose: Determine if network/entity is marked as deleted.
   * Necessity: Used to add " #deleted" suffix to entity names for deleted records.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {string} Lowercase status value (e.g., "ok", "deleted"), or empty string.
   */
  function getSelectedStatus() {
    const statusSelect = qs("#id_status");
    if (statusSelect) {
      const option = qs("option:checked", statusSelect) || qs("option[selected]", statusSelect);
      const value =
        (option && String(option.getAttribute("value") || "").trim()) ||
        String(statusSelect.value || "").trim();
      if (value) return value;
    }

    const statusRow = qsa(".form-row").find((row) => {
      const label = normalizeRenderedCopyText(
        (qs(".c-1 label", row) || qs(".c-1", row))?.textContent || "",
      ).toLowerCase();
      return label === "status";
    });

    const readonlyStatus = normalizeRenderedCopyText(qs(".grp-readonly", statusRow)?.textContent || "");
    return String(readonlyStatus || "").toLowerCase();
  }

  /**
   * Builds storage key for one-time pending network delete confirmation flow.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} networkId - CP network record ID.
   * @returns {string} Namespaced storage key.
   */
  function getNetworkDeleteConfirmStorageKey(networkId) {
    const normalizedNetworkId = String(networkId || "").trim();
    if (!normalizedNetworkId) return "";
    return `${NETWORK_DELETE_CONFIRM_STORAGE_PREFIX}${normalizedNetworkId}`;
  }

  /**
   * Persists one-time pending confirmation state for network delete page.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} networkId - CP network record ID.
   */
  function setPendingNetworkDeleteConfirm(networkId) {
    const storageKey = getNetworkDeleteConfirmStorageKey(networkId);
    if (!storageKey) return;

    try {
      const storage = getDomainCacheStorage();
      storage?.setItem(
        storageKey,
        JSON.stringify({
          networkId: String(networkId || "").trim(),
          expiresAt: Date.now() + NETWORK_DELETE_CONFIRM_TTL_MS,
        }),
      );
    } catch (_error) {
      // Ignore storage errors; delete flow remains best-effort.
    }
  }

  /**
   * Reads pending network delete confirmation state when still valid.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} networkId - CP network record ID.
   * @returns {{ networkId: string }|null} Pending state or null.
   */
  function getPendingNetworkDeleteConfirm(networkId) {
    const storageKey = getNetworkDeleteConfirmStorageKey(networkId);
    if (!storageKey) return null;

    try {
      const storage = getDomainCacheStorage();
      const raw = storage?.getItem(storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const expiresAt = Number(parsed?.expiresAt || 0);
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        storage?.removeItem(storageKey);
        return null;
      }

      return { networkId: String(parsed?.networkId || "").trim() };
    } catch (_error) {
      return null;
    }
  }

  /**
   * Clears pending network delete confirmation state.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} networkId - CP network record ID.
   */
  function clearPendingNetworkDeleteConfirm(networkId) {
    const storageKey = getNetworkDeleteConfirmStorageKey(networkId);
    if (!storageKey) return;

    try {
      const storage = getDomainCacheStorage();
      storage?.removeItem(storageKey);
    } catch (_error) {
      // Ignore storage cleanup errors.
    }
  }

  /**
   * Starts network delete via the footer delete link on network change page.
   * Purpose: Use native Django/Grappelli delete flow (includes confirmation page).
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} networkId - CP network record ID.
   * @returns {boolean} True when delete navigation was triggered.
   */
  function triggerNetworkFooterDeleteFlow(networkId) {
    const deleteLink =
      qs("footer.grp-submit-row a.grp-delete-link") ||
      qs("a.grp-button.grp-delete-link[href*='/cp/peeringdb_server/network/'][href$='/delete/']");
    if (!deleteLink || !("click" in deleteLink)) return false;

    setPendingNetworkDeleteConfirm(networkId);
    deleteLink.click();
    return true;
  }

  /**
   * Returns a `#<entityId>` suffix when the current entity status is "deleted".
   * Purpose: Append the entity ID to names of deleted records for disambiguation.
   * Necessity: Deleted entities may share similar names; a stable ID suffix makes
   * them distinguishable during audits and prevents duplicate-name collisions.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string|number} entityId - The current entity's CP record ID.
   * @returns {string} ` #<entityId>` when status is "deleted", otherwise empty string.
   */
  function getNameSuffixForDeletedEntity(entityId) {
    return getSelectedStatus() === "deleted" ? ` #${entityId}` : "";
  }

  /**
   * Builds storage key for persisted one-time network update-name retry state.
   * Purpose: Keep retry metadata isolated per network record.
   * Necessity: Enables safe post-submit retry on the next page load.
   * AI Maintenance: Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} networkId - CP network record ID.
   * @returns {string} Namespaced storage key.
   */
  function getNetworkUpdateNameRetryStorageKey(networkId) {
    const normalizedNetworkId = String(networkId || "").trim();
    if (!normalizedNetworkId) return "";
    return `${NETWORK_UPDATE_NAME_RETRY_STORAGE_PREFIX}${normalizedNetworkId}`;
  }

  /**
   * Extracts ASN digits from user/API values.
   * Purpose: Normalize ASN for deterministic retry suffixes.
   * Necessity: ASN values can include spaces or optional AS prefixes.
   * AI Maintenance: Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string|number} asnInput - Raw ASN value.
   * @returns {string} Numeric ASN text, or empty string when invalid.
   */
  function normalizeAsnForNameSuffix(asnInput) {
    const cleaned = String(asnInput || "").replace(/^AS\s*/i, "").trim();
    const parsed = Number.parseInt(cleaned, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return "";
    return String(parsed);
  }

  /**
   * Builds one retry variant by appending ` (AS<asn>)` when possible.
   * Purpose: Resolve duplicate-name validation conflicts deterministically.
   * Necessity: Some names collide only after submit-side uniqueness checks.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} name - Candidate network name.
   * @param {string|number} asnInput - ASN source value.
   * @returns {string} Retry candidate name, or empty string when unavailable.
   */
  function buildNetworkNameAsnRetryVariant(name, asnInput) {
    const baseName = String(name || "").trim();
    if (!baseName) return "";

    const normalizedAsn = normalizeAsnForNameSuffix(asnInput);
    if (!normalizedAsn) return "";

    const retrySuffix = ` (AS${normalizedAsn})`;
    if (baseName.endsWith(retrySuffix)) return baseName;
    return `${baseName}${retrySuffix}`;
  }

  /**
   * Determines whether network Update Name should force-append ` (AS<asn>)`.
   * Purpose: Apply deterministic disambiguation for known risky name patterns
   * during the first Update Name submit, not only after duplicate retries.
   * Necessity: Certain names (for example IPv4-leading labels) are likely to
   * collide operationally and benefit from explicit ASN suffixing immediately.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} name - Candidate network name before forced suffixing.
   * @returns {boolean} True when ASN suffix should be forced.
   */
  function shouldForceNetworkNameAsnSuffix(name) {
    const normalized = String(name || "").trim();
    if (!normalized) return false;

    const ipv4LeadingMatch = normalized.match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})(?=\s|\b|$|[-–—:])/);
    if (!ipv4LeadingMatch) return false;

    const octets = ipv4LeadingMatch[1].split(".");
    if (octets.length !== 4) return false;
    return octets.every((octet) => {
      const value = Number.parseInt(octet, 10);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    });
  }

  /**
  * Persists one-time retry metadata for network Update Name submit flow.
  * Purpose: Bridge state across page reload after first save attempt.
  * Necessity: Duplicate-name validation appears only after form submit.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{
   *   networkId: string|number,
   *   originalName: string,
   *   retryName: string,
   *   attempts?: number,
   * }} payload - Retry metadata payload.
   */
  function setPendingNetworkUpdateNameRetry(payload) {
    const networkId = String(payload?.networkId || "").trim();
    const originalName = String(payload?.originalName || "").trim();
    const retryName = String(payload?.retryName || "").trim();
    const attempts = Number(payload?.attempts || 0);
    if (!networkId || !originalName || !retryName) return;

    const storageKey = getNetworkUpdateNameRetryStorageKey(networkId);
    if (!storageKey) return;

    try {
      const storage = getDomainCacheStorage();
      storage?.setItem(
        storageKey,
        JSON.stringify({
          networkId,
          originalName,
          retryName,
          attempts,
          expiresAt: Date.now() + NETWORK_UPDATE_NAME_RETRY_TTL_MS,
        }),
      );
    } catch (_error) {
      // Ignore storage errors; retry remains best-effort.
    }
  }

  /**
  * Reads pending network update-name retry metadata when still valid.
  * Purpose: Resume one-time retry workflow after save-triggered page reload.
  * Necessity: Expired/stale payloads must be ignored to prevent unintended edits.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} networkId - CP network record ID.
   * @returns {{networkId: string, originalName: string, retryName: string, attempts: number}|null}
   */
  function getPendingNetworkUpdateNameRetry(networkId) {
    const storageKey = getNetworkUpdateNameRetryStorageKey(networkId);
    if (!storageKey) return null;

    try {
      const storage = getDomainCacheStorage();
      const raw = storage?.getItem(storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const expiresAt = Number(parsed?.expiresAt || 0);
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        storage?.removeItem(storageKey);
        return null;
      }

      const originalName = String(parsed?.originalName || "").trim();
      const retryName = String(parsed?.retryName || "").trim();
      if (!originalName || !retryName) {
        storage?.removeItem(storageKey);
        return null;
      }

      return {
        networkId: String(parsed?.networkId || "").trim(),
        originalName,
        retryName,
        attempts: Math.max(0, Number.parseInt(String(parsed?.attempts ?? 0), 10) || 0),
      };
    } catch (_error) {
      return null;
    }
  }

  /**
  * Clears pending network update-name retry metadata.
  * Purpose: Stop retry loop once success/failure outcome is known.
  * Necessity: Prevents stale retries from affecting later manual edits.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} networkId - CP network record ID.
   */
  function clearPendingNetworkUpdateNameRetry(networkId) {
    const storageKey = getNetworkUpdateNameRetryStorageKey(networkId);
    if (!storageKey) return;

    try {
      const storage = getDomainCacheStorage();
      storage?.removeItem(storageKey);
    } catch (_error) {
      // Ignore storage cleanup errors.
    }
  }

  /**
   * Detects duplicate network-name validation errors on the current form.
   * Purpose: Trigger retry only for the specific uniqueness validation failure.
   * Necessity: Avoids overriding names for unrelated form errors.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @returns {boolean} True when duplicate-name validation is present.
   */
  function hasDuplicateNetworkNameValidationError() {
    const errorRows = qsa("#id_name_error li, .name .errorlist li");
    if (!errorRows.length) return false;

    return errorRows.some((item) =>
      /name is already in use by another network/i.test(String(item?.textContent || "").trim()),
    );
  }

  /**
   * Detects validation errors caused by deprecated private POC visibility.
   * Purpose: Trigger automatic remediation from Private -> Users visibility.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @returns {boolean} True when private-contacts validation error is present.
   */
  function hasPrivateContactsUnsupportedValidationError() {
    const errorRows = qsa(
      ".errorlist li, .grp-errors li, #grp-content-container .messagelist li, .grp-messagelist li",
    );
    if (!errorRows.length) return false;

    return errorRows.some((item) =>
      /private contacts are no longer supported/i.test(String(item?.textContent || "").trim()),
    );
  }

  /**
   * Converts POC inline visibility from Private to Users where supported.
   * Purpose: Auto-remediate obsolete visibility mode rejected by backend validation.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @returns {number} Number of inline rows modified.
   */
  function normalizeNetworkPocVisibilityPrivateToUsers() {
    let changed = 0;

    const pocRows = qsa(".form-row[id^='poc_set']").filter((row) => {
      const rowId = String(row?.id || "").trim();
      if (!rowId) return false;
      if (rowId === "poc_set-group" || rowId === "poc_set-empty") return false;
      if (!/^poc_set\d+$/i.test(rowId) && !/^poc_set-\d+$/i.test(rowId) && !/^poc_set-__prefix__$/i.test(rowId)) {
        return false;
      }
      // Ignore template/new-row placeholders.
      if (rowId === "poc_set-__prefix__") return false;
      return true;
    });

    let inspectedPrivate = 0;
    let privateWithoutUsersOption = 0;

    pocRows.forEach((row) => {
      qsa("select", row).forEach((select) => {
        const selectedOption =
          qs("option:checked", select) ||
          qs("option[selected]", select) ||
          ("selectedIndex" in select && select.options?.[select.selectedIndex]) ||
          null;

        const currentText = String(selectedOption?.textContent || "").trim().toLowerCase();
        const currentValue = String(("value" in select && select.value) || "").trim().toLowerCase();
        const isPrivate = currentText.includes("private") || currentValue === "private";
        if (!isPrivate) return;
        inspectedPrivate += 1;

        const usersOption = Array.from(select.options || []).find((option) => {
          const text = String(option?.textContent || "").trim().toLowerCase();
          const value = String(option?.value || "").trim().toLowerCase();
          return text === "users" || value === "users" || text === "user" || value === "user";
        });
        if (!usersOption) {
          privateWithoutUsersOption += 1;
          return;
        }

        select.value = usersOption.value;
        usersOption.selected = true;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        changed += 1;
      });
    });

    if (isDebugEnabled()) {
      dbg("private-poc", "visibility normalization summary", {
        pocRows: pocRows.length,
        inspectedPrivate,
        changed,
        privateWithoutUsersOption,
      });
    }

    return changed;
  }

  /**
   * Auto-remediates private-contact visibility errors and retries save once.
   * Purpose: Recover from backend rejection without manual inline edits.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ entity: string, entityId: string, isEntityChangePage: boolean }} ctx - Route context.
   * @returns {boolean} True when a retry save was triggered.
   */
  function maybeRetryNetworkUpdateNameAfterPrivateContactsError(ctx) {
    if (!ctx?.isEntityChangePage || ctx.entity !== "network") return false;
    if (!hasPrivateContactsUnsupportedValidationError()) return false;

    const changedRows = normalizeNetworkPocVisibilityPrivateToUsers();
    if (changedRows <= 0) {
      notifyUser({
        title: "PeeringDB CP",
        text: "Update Name recovery: detected private-contact validation error but could not find editable Private visibility fields. Please review POC inlines manually.",
      });
      return false;
    }

    setPendingPostUpdateNameHistoryRedirect(ctx);
    const triggered = clickSaveAndContinue();
    if (!triggered) {
      clearPendingPostUpdateNameHistoryRedirect();
      return false;
    }

    notifyUser({
      title: "PeeringDB CP",
      text: `Update Name recovery: changed ${changedRows} POC visibility value(s) from Private to Users and retried save.`,
    });
    return true;
  }

  /**
   * Applies one automatic retry for Update Name when duplicate-name error appears.
   * Purpose: Retry with ` (AS<asn>)` suffix after server-side uniqueness rejection.
   * Necessity: Duplicate validation is only known after submit, requiring reload-time retry.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ entity: string, entityId: string, isEntityChangePage: boolean }} ctx - Route context.
   * @returns {boolean} True when retry save was triggered.
   */
  function maybeRetryNetworkUpdateNameAfterDuplicate(ctx) {
    if (!ctx?.isEntityChangePage || ctx.entity !== "network") return false;

    const pending = getPendingNetworkUpdateNameRetry(ctx.entityId);
    if (!pending) return false;

    const currentName = getInputValue("#id_name");
    const hasDuplicateError = hasDuplicateNetworkNameValidationError();

    if (!hasDuplicateError) {
      clearPendingNetworkUpdateNameRetry(ctx.entityId);
      return false;
    }

    if (currentName === pending.retryName) {
      clearPendingNetworkUpdateNameRetry(ctx.entityId);
      notifyUser({
        title: "PeeringDB CP",
        text: "Update Name retry also failed (duplicate). Please set a unique name manually.",
      });
      return false;
    }

    if (currentName !== pending.originalName) {
      clearPendingNetworkUpdateNameRetry(ctx.entityId);
      return false;
    }

    if (pending.attempts >= 1) {
      clearPendingNetworkUpdateNameRetry(ctx.entityId);
      return false;
    }

    setInputValue("#id_name", pending.retryName);
    setPendingNetworkUpdateNameRetry({
      networkId: ctx.entityId,
      originalName: pending.originalName,
      retryName: pending.retryName,
      attempts: pending.attempts + 1,
    });

    setPendingPostUpdateNameHistoryRedirect(ctx);
    const triggered = clickSaveAndContinue();
    if (!triggered) {
      clearPendingPostUpdateNameHistoryRedirect();
      clearPendingNetworkUpdateNameRetry(ctx.entityId);
      return false;
    }

    notifyUser({
      title: "PeeringDB CP",
      text: `Update Name retry: attempting '${pending.retryName}'.`,
    });
    return true;
  }

  /**
   * Reads a readonly field value from a form row by its visible label text.
   * Purpose: Prefer values already rendered on the change form over stale API payloads.
   * Necessity: Some readonly values can differ from API fetch timing/state on page load.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} labelText - Visible row label text (case-insensitive match).
   * @returns {string} Trimmed text content of the `.grp-readonly` element, or empty string.
   */
  function getReadonlyFieldValueByLabel(labelText) {
    const normalizedLabel = String(labelText || "").trim().toLowerCase();
    if (!normalizedLabel) return "";

    const row = qsa(".form-row").find((item) => {
      const label = normalizeRenderedCopyText(
        (qs(".c-1 label", item) || qs(".c-1", item))?.textContent || "",
      ).toLowerCase();
      return label === normalizedLabel;
    });

    return normalizeRenderedCopyText(qs(".grp-readonly", row)?.textContent || "");
  }

  /**
   * Reads a readonly link href from a form row by its visible label text.
   * Purpose: Reuse row-level links (e.g. Org website) as header actions.
   * Necessity: Some URLs are rendered as readonly anchors rather than inputs.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} labelText - Visible row label text (case-insensitive match).
   * @returns {string} href attribute value of the first public link in the row, or empty string.
   */
  function getReadonlyFieldLinkHrefByLabel(labelText) {
    const normalizedLabel = String(labelText || "").trim().toLowerCase();
    if (!normalizedLabel) return "";

    const row = qsa(".form-row").find((item) => {
      const label = normalizeRenderedCopyText(
        (qs(".c-1 label", item) || qs(".c-1", item))?.textContent || "",
      ).toLowerCase();
      return label === normalizedLabel;
    });

    return normalizeRenderedCopyText(qs(".c-2 a[href^='http://'], .c-2 a[href^='https://']", row)?.getAttribute("href") || "");
  }

  /**
   * Builds a stable link identity derived from Grainy namespace when available.
   * Purpose: Use deterministic per-object identity in window targets and action semantics.
   * Necessity: Avoid fragile IDs while preserving object-level context in opened links.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ entity: string, entityId: string }} ctx - Route context from getRouteContext().
   * @returns {string} Sanitized token derived from Grainy namespace or entity/ID fallback.
   */
  function getGrainyDerivedLinkIdentity(ctx) {
    const grainyNamespace = getReadonlyFieldValueByLabel("Grainy namespace");
    const fallbackIdentity = `${String(ctx?.entity || "").trim()}_${String(ctx?.entityId || "").trim()}`;
    const base = String(grainyNamespace || fallbackIdentity || "").trim();

    return base
      .replace(/^peeringdb\./i, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
  }

  /**
   * Normalizes arbitrary text into a deterministic token usable in window target names.
   * Purpose: Guarantee stable, safe target segments for toolbar links.
   * Necessity: Prevents dynamic labels/IDs from creating invalid or inconsistent target names.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {string} value - Raw string to normalize into a token.
   * @param {string} [fallback="item"] - Token to use when value normalizes to empty.
   * @returns {string} Lowercase alphanumeric-and-underscore token string.
   */
  function toStableIdentityToken(value, fallback = "item") {
    const normalized = String(value || "")
      .trim()
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();

    return normalized || String(fallback || "item");
  }

  /**
   * Builds deterministic target names for injected primary toolbar links.
   * Purpose: Ensure all nav-header links open in stable, object-scoped tab identities.
   * Necessity: Replaces ad-hoc _new/_blank targets with per-object deterministic targets.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {string} actionId - Action identifier string used to compose the target suffix.
   * @param {{ entity: string, entityId: string }} [ctx] - Route context; defaults to current page.
   * @returns {string} Stable window target name string (e.g., "pdb_ix_42_pdbCpConsolidatedFrontend").
   */
  function getStableToolbarLinkTarget(actionId, ctx = getRouteContext()) {
    const grainyIdentity = toStableIdentityToken(getGrainyDerivedLinkIdentity(ctx), "entity");
    const actionIdentity = toStableIdentityToken(actionId, "action");
    return `pdb_${grainyIdentity}_${actionIdentity}`;
  }

  /**
   * Marks inline form rows (POCs, netfacs, netixlans) for deletion if status = 'deleted'.
   * Purpose: Clean up stale inline items when network status is deleted.
   * Necessity: Automatic cleanup prevents orphaned POCs/facilities when network is marked deleted.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function clickDeleteHandlersForInlineSet(inlineSetPrefix) {
    let markedCount = 0;
    qsa(`div.form-row.grp-dynamic-form[id^='${inlineSetPrefix}']`).forEach((row) => {
      if (row.id === `${inlineSetPrefix}-empty`) return;
      // Only auto-delete existing persisted rows (has_original), not newly added rows.
      if (!row.classList.contains("has_original")) return;

      const statusField =
        qs('select[name$="-status"]', row) ||
        qs('select[id$="-status"]', row) ||
        qs('input[name$="-status"]', row) ||
        qs('input[id$="-status"]', row);

      const statusValue = statusField
        ? String(
            ("value" in statusField && statusField.value) ||
              qs("option:checked", statusField)?.value ||
              qs("option[selected]", statusField)?.value ||
              "",
          )
            .trim()
            .toLowerCase()
        : "";

      // Only mark rows for deletion when row status is already "deleted".
      if (statusValue !== "deleted") return;

      const deleteCheckbox = qs('input[type="checkbox"][name$="-DELETE"]', row);
      const deleteAction = qs('a.grp-icon.grp-delete-handler[title="Delete Item"]', row);

      if (!deleteAction || !deleteCheckbox || deleteCheckbox.checked) return;
      deleteAction.click();
      markedCount += 1;
    });

    return markedCount;
  }

  /**
   * Marks all deleted-status inline items for deletion across all inline sets.
   * Purpose: Centralize deletion of all stale inline items (POCs, facilities, ixlans).
   * Necessity: Ensures consistent cleanup of deleted network members across all relation types.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function markDeletedNetworkInlinesForDeletion() {
    let totalMarked = 0;
    NETWORK_INLINE_SET_PREFIXES.forEach((prefix) => {
      totalMarked += clickDeleteHandlersForInlineSet(prefix);
    });
    return totalMarked;
  }

  /**
   * Binds native save actions on network change pages to auto-mark child rows for deletion.
   * Purpose: Avoid save validation blocks when existing inline child rows already have status=deleted.
   * Necessity: Admins may use any native save action (Save, Save and add another, Save and continue).
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   * @returns {Function|null} Dispose function removing listeners, or null when form not found.
   */
  function bindNetworkSaveActionInlineDeletionGuard() {
    const form = qs("form#network_form") || qs("form");
    if (!form) return null;

    const saveButtons = qsa(
      "input[type='submit'][name='_save'], input[type='submit'][name='_addanother'], input[type='submit'][name='_continue']",
      form,
    );
    if (!saveButtons.length) return null;

    const clickHandler = () => {
      const visibilityChanged = normalizeNetworkPocVisibilityPrivateToUsers();
      const marked = markDeletedNetworkInlinesForDeletion();
      dbg(
        "network-save",
        `auto-normalized ${visibilityChanged} private POC visibility value(s), auto-marked ${marked} existing deleted inline row(s) via save-click`,
      );
    };

    saveButtons.forEach((button) => {
      button.addEventListener("click", clickHandler, true);
    });

    const submitHandler = (event) => {
      const submitterName = String(event?.submitter?.name || "");
      if (submitterName === "_save" || submitterName === "_addanother" || submitterName === "_continue") {
        const visibilityChanged = normalizeNetworkPocVisibilityPrivateToUsers();
        const marked = markDeletedNetworkInlinesForDeletion();
        dbg(
          "network-save",
          `auto-normalized ${visibilityChanged} private POC visibility value(s), auto-marked ${marked} existing deleted inline row(s) via submit:${submitterName}`,
        );
      }
    };
    form.addEventListener("submit", submitHandler, true);

    return () => {
      saveButtons.forEach((button) => {
        button.removeEventListener("click", clickHandler, true);
      });
      form.removeEventListener("submit", submitHandler, true);
    };
  }

  // RDAP client module (fully isolated from feature modules)
  /**
   * Isolated RDAP AutoNum client for resolving organization names by ASN.
   * Purpose: Provide fallback organization name lookup via IANA RDAP bootstrap.
   * Necessity: When org lookup fails (org_id invalid), RDAP provides ASN-based name resolution.
   * Bootstraps RDAP service URLs from IANA registry with 6-hour TTL cache.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  const rdapAutnumClient = (() => {
    const BOOTSTRAP_ASN_URL = "https://data.iana.org/rdap/asn.json"; // RFC 9224 bootstrap registry
    const RDAP_ACCEPT_HEADER = "application/rdap+json, application/json;q=0.8";

    const bootstrapCache = {
      loadedAt: 0,
      ttlMs: 6 * 60 * 60 * 1000,
      payload: null,
    };
    const resolvedOrgNameCacheByAsn = new Map();
    const resolvedOrgNameCacheTtlMs = 15 * 60 * 1000;

    /**
     * Parses and validates ASN from string input.
     * Purpose: Convert ASN string (with or without "AS" prefix) to integer.
     * Necessity: Validates ASN format before RDAP queries.
     */
    function parseAsn(value) {
      const normalized = String(value || "").replace(/^AS\s*/i, "").trim();
      const number = Number.parseInt(normalized, 10);
      if (!Number.isInteger(number) || number <= 0) return null;
      return number;
    }

    /**
     * Normalizes RDAP base URL by removing trailing slashes.
     * Purpose: Create consistent URLs for RDAP endpoint construction.
     * Necessity: Base URLs may have trailing slashes; normalization prevents double slashes.
     */
    function normalizeBaseUrl(baseUrl) {
      if (!baseUrl) return null;
      return String(baseUrl).replace(/\/+$/, "");
    }

    /**
     * Fetches JSON from URL using the shared pdbFetch client.
     * Purpose: Delegate cross-origin RDAP requests to the unified network abstraction.
     * Necessity: Centralises timeout, retry, and User-Agent header construction.
     */
    function requestJson(url) {
      return pdbFetch(url, { headers: { Accept: RDAP_ACCEPT_HEADER } });
    }

    /**
     * Fetches or retrieves cached IANA RDAP bootstrap registry.
     * Purpose: Get list of RDAP service providers for various ASN ranges.
     * Necessity: Bootstrap registry maps ASN ranges to RDAP endpoints; 6-hour TTL cache
     * reduces load on IANA servers. Required before any RDAP autnum queries.
     */
    async function getBootstrap() {
      const now = Date.now();
      if (
        bootstrapCache.payload &&
        bootstrapCache.loadedAt > 0 &&
        now - bootstrapCache.loadedAt < bootstrapCache.ttlMs
      ) {
        return bootstrapCache.payload;
      }

      const payload = await requestJson(BOOTSTRAP_ASN_URL);
      if (!payload) return null;

      bootstrapCache.payload = payload;
      bootstrapCache.loadedAt = now;
      return payload;
    }

    /**
     * Tests if ASN falls within a hyphen-separated range.
     * Purpose: Determine if given ASN matches a bootstrap range.
     * Necessity: Bootstrap registry uses ranges like "1-23456"; membership test needed
     * to find correct RDAP endpoint provider.
     */
    function isAsnInRange(asn, rangeText) {
      const range = String(rangeText || "").trim();
      if (!range) return false;

      const parts = range.split("-").map((item) => Number.parseInt(item, 10));
      if (parts.length !== 2 || parts.some((value) => !Number.isInteger(value))) {
        return false;
      }

      return asn >= parts[0] && asn <= parts[1];
    }

    /**
     * Finds the appropriate RDAP base URL for an ASN from bootstrap registry.
     * Purpose: Look up correct RDAP service endpoint (RIPE, APNIC, ARIN, etc.) by ASN.
     * Necessity: Different RIRs operate different RDAP endpoints; bootstrap maps ASNs to regions.
     */
    function getAutnumBaseUrlFromBootstrap(bootstrap, asn) {
      const services = Array.isArray(bootstrap?.services) ? bootstrap.services : [];

      for (const service of services) {
        const ranges = Array.isArray(service?.[0]) ? service[0] : [];
        const urls = Array.isArray(service?.[1]) ? service[1] : [];
        const matchesRange = ranges.some((rangeText) => isAsnInRange(asn, rangeText));
        if (!matchesRange || urls.length === 0) continue;

        const preferred = urls.find((url) => String(url).startsWith("https://"));
        return normalizeBaseUrl(preferred || urls[0]);
      }

      return null;
    }

    /**
     * Fetches RDAP AutNum record for a given ASN.
     * Purpose: Retrieve organization and contact data from authoritative RDAP source.
     * Necessity: RDAP provides RFC 7483 standard organization data including vcard info.
     */
    async function fetchAutnumRecord(asn) {
      const bootstrap = await getBootstrap();
      const baseUrl = getAutnumBaseUrlFromBootstrap(bootstrap, asn);
      if (!baseUrl) return null;

      return requestJson(`${baseUrl}/autnum/${asn}`);
    }

    /**
     * Extracts property value from RDAP vCard array.
     * Purpose: Safely retrieve vCard properties (fn=full name, org=organization).
     * Necessity: vCard is RFC 6350 format array; property names are lowercase.
     */
    function getVcardProperty(vcardArray, propertyName) {
      const cards = Array.isArray(vcardArray?.[1]) ? vcardArray[1] : [];
      const property = cards.find(
        (item) => Array.isArray(item) && String(item[0] || "").toLowerCase() === propertyName,
      );
      if (!property) return "";

      return String(property[3] || "").trim();
    }

    /**
     * Recursively collects entity candidates from RDAP payload with scoring.
     * Purpose: Build ranked list of organization name candidates.
     * Necessity: RDAP can have multiple entities (registrant, admin, billing, etc.);
     * scoring prioritizes registrant > administrative roles, organizations > people.
     */
    function collectEntityCandidates(entities, candidates = [], depth = 0) {
      if (!Array.isArray(entities)) return candidates;

      entities.forEach((entity) => {
        const roles = Array.isArray(entity?.roles) ? entity.roles.map((r) => String(r).toLowerCase()) : [];
        const fn = getVcardProperty(entity?.vcardArray, "fn");
        const org = getVcardProperty(entity?.vcardArray, "org");
        const kind = getVcardProperty(entity?.vcardArray, "kind").toLowerCase();
        const handle = String(entity?.handle || "").trim();

        const value = fn || org || "";
        if (value) {
          let score = 0;
          if (roles.includes("registrant")) score += 100;
          if (roles.includes("administrative")) score += 30;
          if (kind === "org" || kind === "organization") score += 40;
          if (org) score += 20;
          if (fn) score += 10;
          if (value === handle) score -= 20;
          score -= depth * 2;

          candidates.push({ value, score });
        }

        collectEntityCandidates(entity?.entities, candidates, depth + 1);
      });

      return candidates;
    }

    /**
     * Extracts best organization name from RDAP AutoNum payload.
     * Purpose: Determine most likely official name for network entity.
     * Necessity: Collects entities, scores by role/type, returns highest-scored name.
     * Also sanitizes RDAP corruption patterns (remarks, trading as, etc.).
     */
    function resolveOrganizationNameFromAutnumPayload(payload) {
      const candidates = collectEntityCandidates(payload?.entities, []);
      if (!candidates.length) return null;

      candidates.sort((a, b) => b.score - a.score);
      const rawName = candidates[0]?.value || null;
      return rawName ? sanitizeRdapOrgName(rawName) : null;
    }

    /**
     * Public API: Resolves organization name for ASN via RDAP lookup.
     * Purpose: Fallback organization name resolution when direct org ID lookup fails.
     * Necessity: Enables Reset Information to work even if org_id field is invalid/empty.
     * Returns null on network error or missing organization data (graceful degradation).
     */
    async function resolveOrganizationNameByAsn(asnInput) {
      const asn = parseAsn(asnInput);
      if (!asn) return null;

      const cached = resolvedOrgNameCacheByAsn.get(asn);
      if (cached && cached.expiresAt > Date.now() && cached.name) {
        return cached.name;
      }

      if (cached && cached.expiresAt <= Date.now()) {
        resolvedOrgNameCacheByAsn.delete(asn);
      }

      console.log(`[rdapAutnumClient] Requesting RDAP for AS${asn}...`);

      try {
        const payload = await fetchAutnumRecord(asn);
        if (!payload) return null;

        const name = resolveOrganizationNameFromAutnumPayload(payload);
        if (name) {
          console.log(`[rdapAutnumClient] Successfully resolved AS${asn}: ${name}`);
          resolvedOrgNameCacheByAsn.set(asn, {
            name,
            expiresAt: Date.now() + resolvedOrgNameCacheTtlMs,
          });
        }
        return name;
      } catch (_error) {
        console.error(`[rdapAutnumClient] Error resolving AS${asn}`, _error);
        return null;
      }
    }

    /**
     * Clears RDAP bootstrap and resolved-name caches.
     * Purpose: Allow explicit invalidation from user commands after external data changes.
     * Necessity: Manual cache reset is useful for debugging and immediate refresh scenarios.
     */
    function clearCache() {
      bootstrapCache.loadedAt = 0;
      bootstrapCache.payload = null;
      resolvedOrgNameCacheByAsn.clear();
    }

    return {
      resolveOrganizationNameByAsn,
      clearCache,
    };
  })();

  /**
   * Executes comprehensive network reset clearing all fields to defaults.
   * Purpose: Prepare network record for re-initialization (especially for RDAP lookups).
   * Necessity: Reset Information action clears stale data before re-populating from API sources.
   * Preserves critical fields (name handles separately) and marks deleted inlines for removal.
   * AI Maintenance: Preserve request retries/timeouts/error classification and payload assumptions.
   */
  function runNetworkResetActions() {
    const formArea = qs("#network_form > div > fieldset:nth-child(2)");
    if (!formArea) return;

    const eachInForm = (selector, callback) => {
      qsa(selector, formArea).forEach((item) => {
        try {
          callback(item);
        } catch (_error) {
          // no-op by design
        }
      });
    };

    eachInForm("input.vTextField", (item) => {
      if (item?.id === "id_name") return;
      item.value = "";
    });
    eachInForm("input.vURLField", (item) => {
      item.value = "";
    });
    eachInForm('input[name*="prefixes"]', (item) => {
      item.value = 0;
    });

    const socialMedia = qs("textarea#id_social_media", formArea);
    if (socialMedia) {
      socialMedia.value = "[]";
    }

    eachInForm('input[type="checkbox"]', (item) => {
      item.checked = false;
    });
    eachInForm("#id_allow_ixp_update", (item) => {
      item.checked = true;
    });

    eachInForm('select[name*="info"]', (item) => {
      if (item.multiple) {
        Array.from(item.options).forEach((opt) => { opt.selected = false; });
      }
      const firstOption = qs("option:first-child", item);
      if (firstOption) {
        firstOption.selected = true;
      }
    });
    eachInForm('select[name*="policy"]', (item) => {
      if (item.multiple) {
        Array.from(item.options).forEach((opt) => { opt.selected = false; });
      }
      const firstOption = qs("option:first-child", item);
      if (firstOption) {
        firstOption.selected = true;
      }
    });

    eachInForm("textarea.vLargeTextField", (item) => {
      item.value = "";
    });

    markDeletedNetworkInlinesForDeletion();
  }

  // ---------------------------------------------------------------------------
  // Module registry
  // Each entry declares: id (string), match (ctx predicate), optional preconditions
  // (ctx predicate), and run (ctx handler that may return a dispose function).
  // ---------------------------------------------------------------------------
  const modules = [
    {
      id: "network-name-pattern-diagnostics",
      match: (ctx) => ctx.isEntityListPage && ctx.entity === "network",
      preconditions: () => Boolean(getToolbarList()),
      run: () => {
        addToolbarAction({
          id: `${MODULE_PREFIX}AnalyzeNetworkNames`,
          label: CP_LIST_PAGE_ACTION_LABELS.ANALYZE_NETWORK_NAMES,
          insertLeft: true,
          onClick: async (event) => {
            const actionLockKey = `${MODULE_PREFIX}.analyzeNetworkNames`;
            if (!tryBeginActionLock(actionLockKey)) {
              notifyUser({
                title: "PeeringDB CP",
                text: "Network name analysis is already running.",
              });
              return;
            }

            const button = event?.target;
            const setButtonText = (text) => {
              if (!button) return;
              button.textContent = text;
            };
            let postRunButtonText = CP_LIST_PAGE_ACTION_LABELS.ANALYZE_NETWORK_NAMES;
            let postRunButtonDelayMs = 0;

            try {
              if (button) {
                button.style.opacity = "0.7";
                button.style.pointerEvents = "none";
              }

              let retrieval = getCachedNetworkNameData();
              const usedCache = Boolean(retrieval);
              if (!retrieval) {
                setButtonText("Scanning...");
                retrieval = await fetchRecentNetworkNamesBatched({
                  targetCount: NETWORK_NAME_SCAN_TARGET_COUNT,
                  pageSize: NETWORK_NAME_SCAN_PAGE_SIZE,
                  requestLimit: NETWORK_NAME_SCAN_MAX_REQUESTS,
                  onProgress: ({ batchIndex, totalBatches, recordsFetched }) => {
                    if (Number.isFinite(totalBatches)) {
                      setButtonText(`Scanning ${batchIndex}/${totalBatches}`);
                      return;
                    }
                    setButtonText(`Scanning ${batchIndex} (${recordsFetched})`);
                  },
                });

                setCachedNetworkNameData(retrieval);
              }

              setButtonText("Analyzing...");
              let analysis = getCachedNetworkNameScanAnalysis(retrieval);
              if (!analysis) {
                analysis = analyzeNetworkNamePatterns(retrieval.records);
                setCachedNetworkNameScanAnalysis(retrieval, analysis);
              }
              const result = {
                ...retrieval,
                source: usedCache ? "cache" : "fresh",
                analysis,
              };

              logNetworkNamePatternDiagnostics(result);

              const summary = buildNetworkNamePatternSummary(result);
              const suspiciousTsv = buildSuspiciousNetworkNameTsv(result.analysis);
              const copied = suspiciousTsv ? await copyToClipboard(suspiciousTsv) : false;
              if (suspiciousTsv) {
                dbg("network-name-scan", "clipboard copy result", {
                  copied,
                  rows: result.analysis?.suspiciousCount || 0,
                  chars: suspiciousTsv.length,
                });
              }

              setButtonText(usedCache ? "Cached" : "Fetched");
              postRunButtonDelayMs = 900;
              notifyUser({
                title: "PeeringDB CP",
                text: copied
                  ? `${summary} Candidate TSV copied to clipboard.`
                  : `${summary} Candidate TSV could not be copied to clipboard.`,
                timeout: 4000,
              });
            } catch (error) {
              console.error(`[${MODULE_PREFIX}] Network name analysis failed`, error);
              setButtonText("Scan failed");
              postRunButtonDelayMs = 1200;
              notifyUser({
                title: "PeeringDB CP",
                text: "Network name analysis failed. See console for details.",
              });
            } finally {
              if (button) {
                button.style.opacity = "";
                button.style.pointerEvents = "";

                if (postRunButtonDelayMs > 0) {
                  setTimeout(() => {
                    button.textContent = postRunButtonText;
                  }, postRunButtonDelayMs);
                } else {
                  button.textContent = postRunButtonText;
                }
              }
              endActionLock(actionLockKey);
            }
          },
        });
      },
    },
    {
      id: "copy-overview-change-links",
      match: (ctx) => ctx.isEntityListPage,
      preconditions: () => Boolean(getToolbarList()),
      run: (ctx) => {
        addToolbarAction({
          id: `${MODULE_PREFIX}CopyOverviewChangeLinks`,
          label: CP_LIST_PAGE_ACTION_LABELS.COPY_CHANGE_LINKS,
          insertLeft: true,
          onClick: async (event) => {
            const links = getCurrentOverviewChangeLinks();
            if (links.length === 0) {
              pulseToolbarButton(event?.target, "No links");
              notifyUser({
                title: "PeeringDB CP",
                text: `No change links found on current ${ctx.entity || "overview"} page.`,
              });
              return;
            }

            const copied = await copyToClipboard(links.join("\n"));
            if (copied) {
              pulseToolbarButton(event?.target, `Copied ${links.length}`);
              notifyUser({
                title: "PeeringDB CP",
                text: `Copied ${links.length} change link${links.length === 1 ? "" : "s"}.`,
              });
              return;
            }

            pulseToolbarButton(event?.target, "Copy failed");
            notifyUser({
              title: "PeeringDB CP",
              text: "Failed to copy overview change links.",
            });
          },
        });
      },
    },
    {
      id: "copy-frontend-urls",
      match: (ctx) => ctx.isEntityChangePage,
      preconditions: () => Boolean(getToolbarList()),
      run: (ctx) => {
        const entityPath = getEntityFrontendPath(ctx);
        const entityUrl = entityPath ? `https://www.peeringdb.com${entityPath}` : "";

        const apiJsonUrl = getEntityApiJsonUrl(ctx);
        if (shouldShowApiJsonAction(ctx) && apiJsonUrl) {
          addToolbarAction({
            id: `${MODULE_PREFIX}ApiJson`,
            label: "API JSON",
            href: apiJsonUrl,
            target: "_new",
            insertLeft: true,
            onClick: (event) => {
              const blockReason = getApiJsonActionBlockReason(ctx);
              if (blockReason) {
                const label = blockReason.startsWith("status:")
                  ? blockReason.slice("status:".length)
                  : blockReason;
                pulseToolbarButton(event?.target, `No-op (${label || "unknown"})`);
                return;
              }

              const resolvedUrl = new URL(apiJsonUrl, window.location.origin).toString();
              const stableTarget =
                event?.currentTarget?.target ||
                event?.target?.target ||
                getStableToolbarLinkTarget(`${MODULE_PREFIX}ApiJson`, ctx);
              window.open(resolvedUrl, stableTarget, "noopener");
            },
          });
        }

        if (ctx.entity === "networkixlan") {
          const networkId = String(getInputValue("#id_network") || "").trim();
          const ixlanId = String(getInputValue("#id_ixlan") || "").trim();

          void (async () => {
            let orgId = "";
            let ixId = "";

            if (/^\d+$/.test(networkId)) {
              const netApiUrl = getPeeringDbApiObjectUrl("net", networkId);
              const netPayload = netApiUrl ? await pdbFetch(netApiUrl) : null;
              const netRow = getFirstApiDataItem(netPayload, netApiUrl || "networkixlan-net");
              orgId = String(netRow?.org_id || "").trim();
            }

            if (/^\d+$/.test(ixlanId)) {
              const ixlanApiUrl = getPeeringDbApiObjectUrl("ixlan", ixlanId);
              const ixlanPayload = ixlanApiUrl ? await pdbFetch(ixlanApiUrl) : null;
              const ixlanRow = getFirstApiDataItem(ixlanPayload, ixlanApiUrl || "networkixlan-ixlan");
              ixId = String(ixlanRow?.ix_id ?? ixlanRow?.ix ?? "").trim();
            }

            if (/^\d+$/.test(orgId)) {
              addToolbarAction({
                id: `${MODULE_PREFIX}NetworkIxlanOrgCp`,
                label: getEntityCpLabel("organization"),
                href: `/cp/peeringdb_server/organization/${orgId}/change/`,
                target: "_new",
                insertLeft: true,
              });
            }

            if (/^\d+$/.test(networkId)) {
              addToolbarAction({
                id: `${MODULE_PREFIX}NetworkIxlanNetCp`,
                label: getEntityCpLabel("network"),
                href: `/cp/peeringdb_server/network/${networkId}/change/`,
                target: "_new",
                insertLeft: true,
              });
            }

            if (/^\d+$/.test(ixId)) {
              addToolbarAction({
                id: `${MODULE_PREFIX}NetworkIxlanIxCp`,
                label: getEntityCpLabel("internetexchange"),
                href: `/cp/peeringdb_server/ixlanprefix/?q=${encodeURIComponent(ixId)}`,
                target: "_new",
                insertLeft: true,
              });
            }

            // These links are injected after async API lookups; enforce shared ordering once added.
            scheduleDomUpdate(`${MODULE_PREFIX}.networkixlan.toolbarOrder`, () => {
              enforceToolbarButtonOrder(ctx);
            });
          })();
        }

        if (entityUrl) {
          const entityCopyLabel = `${getEntityCopyLabel(ctx.entity)} #${ctx.entityId}`;
          addSecondaryActionButton({
            id: `${MODULE_PREFIX}CopyEntityUrl`,
            label: entityCopyLabel,
            href: entityUrl,
            title: entityUrl,
            onClick: async (event) => {
              const copied = await copyToClipboard(entityUrl);
              if (copied) {
                pulseToolbarButton(event?.target, "Copied URL");
              }
            },
          });
        }

        if (ctx.entity === "user") {
          const userId = String(ctx.entityId || "").trim();
          const userProfileUrl = /^\d+$/.test(userId)
            ? `https://www.peeringdb.com/cp/peeringdb_server/user/${userId}/change/`
            : "";

          if (userProfileUrl) {
            addSecondaryActionButton({
              id: `${MODULE_PREFIX}CopyUserProfileUrl`,
              label: `Copy User Profile URL #${ctx.entityId}`,
              href: userProfileUrl,
              title: userProfileUrl,
              onClick: async (event) => {
                const copied = await copyToClipboard(userProfileUrl);
                if (copied) {
                  pulseToolbarButton(event?.target, "Copied User Profile URL");
                }
              },
            });
          }
        }

        const orgId = ctx.entity === "organization" ? "" : getInputValue("#id_org");
        if (!orgId) return;

        const orgUrl = `https://www.peeringdb.com/org/${orgId}`;

        addSecondaryActionButton({
          id: `${MODULE_PREFIX}CopyOrganizationUrl`,
          label: `Copy Org URL #${orgId}`,
          href: orgUrl,
          title: orgUrl,
          onClick: async (event) => {
            const copied = await copyToClipboard(orgUrl);
            if (copied) {
              pulseToolbarButton(event?.target, "Copied Org URL");
            }
          },
        });
      },
    },
    {
      id: "copy-rendered-field-values",
      match: (ctx) => ctx.isEntityChangePage,
      preconditions: () => Boolean(qs(".form-row .c-2")),
      run: () => {
        addCopyButtonsToRenderedFields();
      },
    },
    {
      id: "inline-delete-row-highlights",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "network",
      preconditions: () => Boolean(qs("#grp-content-container .inline-group.grp-tabular")),
      run: () => bindInlineDeleteHighlightReactivity(),
    },
    {
      id: "network-save-inline-deletion-guard",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "network",
      preconditions: () => Boolean(qs("form") && (qs("input[name='_save']") || qs("input[name='_continue']") || qs("input[name='_addanother']"))),
      run: () => bindNetworkSaveActionInlineDeletionGuard(),
    },
    {
      id: "facility-google-maps",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "facility",
      preconditions: () => Boolean(getOrCreateSecondaryActionRow()),
      run: () => {
        const query = encodeURIComponent(buildFacilityMapsQuerySource());
        const mapsItems = [
          { label: "Google Maps", href: `https://www.google.com/maps?q=${query}` },
          { label: "Bing Maps", href: `https://www.bing.com/maps?q=${query}` },
          { label: "OpenStreetMap", href: `https://www.openstreetmap.org/search?query=${query}` },
        ];

        addSecondaryDropdownAction({
          id: `${MODULE_PREFIX}MapsDropdown`,
          label: "Maps",
          items: mapsItems,
        });
      },
    },
    {
      id: "facility-advanced-search-link",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "facility",
      preconditions: () => Boolean(getOrCreateSecondaryActionRow() && qs("#id_country")),
      run: () => {
        const countryCode = getSelectedOptionValue("#id_country");
        const state = getInputValue("#id_state");
        const zipcode = getInputValue("#id_zipcode");

        if (!countryCode && !zipcode) return;

        const searchParams = new URLSearchParams();
        if (countryCode) searchParams.append("country__in", countryCode);
        if (state && countryCode === "US") searchParams.append("state", state);
        if (zipcode) searchParams.append("zipcode", zipcode);
        searchParams.append("reftag", "fac");

        const searchUrl = `https://www.peeringdb.com/advanced_search?${searchParams.toString()}`;

        addSecondaryActionButton({
          id: `${MODULE_PREFIX}FacilityAdvancedSearchLink`,
          label: "Search (FP)",
          href: searchUrl,
          onClick: (event) => {
            event?.preventDefault?.();
            window.open(searchUrl, "_blank", "noopener,noreferrer");
          },
          target: "_blank",
        });
      },
    },
    {
      id: "entity-website-new-tab",
      match: (ctx) =>
        ctx.isEntityChangePage &&
        ENTITY_TYPES.has(ctx.entity),
      preconditions: () => Boolean(qs(".website > div > div > p > a")),
      run: (ctx) => {
        const website = qs(".website > div > div > p > a");
        if (!website) return;

        website.target = `peeringdb_${ctx.entity}_${ctx.entityId}`;
      },
    },
    {
      id: "entity-website-header-links",
      match: (ctx) => ctx.isEntityChangePage,
      preconditions: () => Boolean(getToolbarList()),
      run: (ctx) => {
        const grainyIdentity = getGrainyDerivedLinkIdentity(ctx);

        const objTypeWebsiteUrl = String(
          getInputValue("#id_website") || getReadonlyFieldLinkHrefByLabel("Website") || "",
        ).trim();
        if (/^https?:\/\//i.test(objTypeWebsiteUrl)) {
          addToolbarAction({
            id: `${MODULE_PREFIX}ObjTypeWebsite`,
            label: getEntityWebsiteLabel(ctx.entity),
            href: objTypeWebsiteUrl,
            target: `pdb_${grainyIdentity}_objtype_website`,
            insertLeft: true,
          });
        }

        const objOrgWebsiteUrl = String(getReadonlyFieldLinkHrefByLabel("Org website") || "").trim();
        if (/^https?:\/\//i.test(objOrgWebsiteUrl)) {
          addToolbarAction({
            id: `${MODULE_PREFIX}ObjOrgWebsite`,
            label: "Org Website",
            href: objOrgWebsiteUrl,
            target: `pdb_${grainyIdentity}_objorg_website`,
            insertLeft: true,
          });
        }
      },
    },
    {
      id: "entity-state-visuals",
      match: (ctx) => ctx.isEntityChangePage,
      preconditions: () => Boolean(qs("#grp-content")),
      run: (ctx) => {
        applyEntityStateBackgroundClass(ctx);
        syncEntityStateTitleMarkers(ctx);
        bindFormFieldBus();
        return bindEntityStateBackgroundReactivity(ctx);
      },
    },
    {
      id: "frontend-links",
      match: (ctx) =>
        ctx.isEntityChangePage &&
        ENTITY_TYPES.has(ctx.entity),
      preconditions: () => Boolean(getToolbarList()),
      run: (ctx) => {
        const goto = getFrontendSlugByEntity(ctx.entity);
        if (!goto) return;

        const orgId = getInputValue("#id_org");

        if (goto !== "org" && orgId) {
          addToolbarAction({
            id: `${MODULE_PREFIX}OrganizationFrontend`,
            label: getEntityFrontendLabel("organization"),
            href: `/org/${orgId}`,
            target: "_new",
          });

          addToolbarAction({
            id: `${MODULE_PREFIX}OrganizationCp`,
            label: getEntityCpLabel("organization"),
            href: `/cp/peeringdb_server/organization/${orgId}/change/`,
            target: "_new",
          });
        }

        if (ctx.entity === "internetexchange") {
          const ixlanId = qsa('input[id^="id_ixlan_set-"][id$="-id"]')
            .map((input) => String(input?.value || "").trim())
            .find((value) => /^\d+$/.test(value));

          if (ixlanId) {
            const ixSearchTerm = String(getInputValue("#id_name") || ctx.entityId || "").trim();
            addToolbarAction({
              id: `${MODULE_PREFIX}InternetExchangeIxlanPrefixCp`,
              label: "IXLAN Prefix (CP)",
              href: `/cp/peeringdb_server/ixlanprefix/?q=${encodeURIComponent(ixSearchTerm)}`,
              target: "_new",
            });
          }
        }

        const entityStatus = getSelectedStatus();
        const isStatusOk = entityStatus === "ok";
        const frontendLabel = getEntityFrontendLabel(ctx.entity);

        qs(`#${MODULE_PREFIX}Frontend`)?.closest("li")?.remove();

        if (!isStatusOk) {
          const statusLabel = String(entityStatus || "unknown").toLowerCase();
          const disabledButton = addToolbarAction({
            id: `${MODULE_PREFIX}Frontend`,
            label: `${frontendLabel} (status: ${statusLabel})`,
            href: "#",
            target: null,
            onClick: (event) => {
              pulseToolbarButton(event?.target, `No-op (${statusLabel})`);
              notifyUser({
                title: "PeeringDB CP",
                text: `${frontendLabel} is unavailable while status is "${statusLabel}". Set status to "ok" to open FP.`,
              });
            },
          });

          if (disabledButton) {
            disabledButton.setAttribute("title", `${frontendLabel} is unavailable while status is \"${statusLabel}\". Set status to \"ok\" to enable.`);
            disabledButton.setAttribute("aria-disabled", "true");
            disabledButton.style.opacity = "0.65";
            disabledButton.style.cursor = "not-allowed";
          }

          return;
        }

        addToolbarAction({
          id: `${MODULE_PREFIX}Frontend`,
          label: frontendLabel,
          href: `/${goto}/${ctx.entityId}`,
          target: "_new",
        });
      },
    },
    {
      id: "search-user-email-by-username",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "user",
      preconditions: () => Boolean(getToolbarList()),
      run: () => {
        const breadcrumbUser = qs("#grp-breadcrumbs > ul > li:nth-child(4)");
        const username = String(breadcrumbUser?.innerText || "").trim();
        if (!username) return;

        addToolbarAction({
          id: `${MODULE_PREFIX}SearchUsername`,
          label: "Search Username",
          href: `/cp/account/emailaddress/?q=${encodeURIComponent(username)}`,
        });
      },
    },
    {
      id: "network-delete-confirmation-auto-submit",
      match: (ctx) => ctx.isCp && ctx.entity === "network" && ctx.pageKind === "delete",
      preconditions: (ctx) => Boolean(getPendingNetworkDeleteConfirm(ctx.entityId) && qs("form")),
      run: (ctx) => {
        const pending = getPendingNetworkDeleteConfirm(ctx.entityId);
        if (!pending) return;

        const form = qs("form");
        if (!form) return;

        const confirmButton =
          qs('input[type="submit"][name="post"]', form) ||
          qsa('input[type="submit"]', form).find((button) => !/cancel/i.test(String(button?.value || ""))) ||
          null;

        if (!confirmButton) {
          clearPendingNetworkDeleteConfirm(ctx.entityId);
          notifyUser({
            title: "PeeringDB CP",
            text: "Delete flow: confirmation submit button not found.",
          });
          return;
        }

        clearPendingNetworkDeleteConfirm(ctx.entityId);
        confirmButton.click();
        notifyUser({
          title: "PeeringDB CP",
          text: "Delete flow: confirmation submitted.",
        });
      },
    },
    {
      id: "network-update-name-retry-on-duplicate",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "network",
      preconditions: () => Boolean(qs("#id_name") && qs("form")),
      run: (ctx) => {
        if (isWriteActionBlockedForHardExcludedEntity(ctx)) {
          clearPendingNetworkUpdateNameRetry(ctx.entityId);
          return;
        }
        if (maybeRetryNetworkUpdateNameAfterPrivateContactsError(ctx)) {
          return;
        }
        maybeRetryNetworkUpdateNameAfterDuplicate(ctx);
      },
    },
    {
      id: "set-entity-name-equal-org-name",
      match: (ctx) =>
        ctx.isEntityChangePage && ENTITY_TYPES.has(ctx.entity),
      preconditions: (ctx) =>
        Boolean(
          getToolbarList() &&
            qs("#id_name") &&
            (ctx.entity === "organization" || qs("#id_org")),
        ),
      run: (ctx) => {
        addSecondaryActionButton({
          id: `${MODULE_PREFIX}UpdateEntityName`,
          label: "Update Name",
          onClick: async (event) => {
            if (isWriteActionBlockedForHardExcludedEntity(ctx)) {
              notifyWriteActionBlockedForHardExcludedEntity("Update Name", ctx);
              return;
            }
            if (getSelectedStatus() === "pending") {
              notifyUser({
                title: "PeeringDB CP",
                text: "Update Name is disabled while status is pending.",
              });
              return;
            }
            const actionLockKey = `${MODULE_PREFIX}.updateEntityName.${ctx.entity}.${ctx.entityId}`;
            if (!tryBeginActionLock(actionLockKey)) {
              notifyUser({
                title: "PeeringDB CP",
                text: "Update Name is already running.",
              });
              return;
            }

            try {
              const appendName = getNameSuffixForDeletedEntity(ctx.entityId);
              let baseName;
              let wasMalformedOrgName = false;
              let orgIdToUpdate = "";
              let orgKnownAs = "";
              if (ENTITY_TYPES_OWN_NAME.has(ctx.entity)) {
                const rawName = getInputValue("#id_name");
                const existingSuffix = ` #${ctx.entityId}`;
                baseName = rawName.endsWith(existingSuffix)
                  ? rawName.slice(0, -existingSuffix.length)
                  : rawName;

                // On organization pages, split "trading as" into canonical name + AKA.
                if (ctx.entity === "organization") {
                  const identity = parseOrganizationNameIdentity(baseName);
                  if (identity?.name) {
                    baseName = identity.name;
                  }
                  orgKnownAs = String(identity?.knownAs || "").trim();
                }
              } else {
                const anchor = event?.target;
                if (anchor) {
                  anchor.textContent = "Updating...";
                  anchor.style.opacity = "0.7";
                  anchor.style.pointerEvents = "none";
                }
                if (ctx.entity === "carrier" || ctx.entity === "campus") {
                  baseName = await getOrganizationNameFromEntityApi(ctx.entity, ctx.entityId);
                } else {
                  orgIdToUpdate = getOrganizationIdForNameUpdate(ctx);
                  // For networks, also detect if org name is malformed
                  if (ctx.entity === "network") {
                    const result = await getOrganizationNameWithMalformationDetection(orgIdToUpdate);
                    baseName = result.name;
                    wasMalformedOrgName = result.wasMalformed;
                    orgKnownAs = String(result.knownAs || "").trim();
                  } else {
                    baseName = await getOrganizationName(orgIdToUpdate);
                  }
                }
                if (anchor) {
                  anchor.textContent = "Update Name";
                  anchor.style.opacity = "";
                  anchor.style.pointerEvents = "";
                }
                if (!baseName) {
                  notifyUser({
                    title: "PeeringDB CP",
                    text: "Update Name: failed to resolve organization name.",
                  });
                  return;
                }
              }

              const fullName = String(baseName || "").trim();
              let nextLongName = "";
              let nextName = `${baseName}${appendName}`;
              let usedRdapAsnFallback = false;

              if (ctx.entity === "network") {
                const compactedName = compactEntityNameWithLongNameFallback(fullName);
                const compactNameBase = compactedName.shortName || fullName;
                nextLongName = compactedName.longName;
                nextName = `${compactNameBase}${appendName}`;

                if (isLikelyGeneratedHandleName(compactNameBase)) {
                  const currentNetworkName = getInputValue("#id_name");
                  const currentNetworkLongName = getNetworkLongNameValue();
                  const networkAsn = getInputValue("#id_asn");
                  const rdapOrgName = await rdapAutnumClient.resolveOrganizationNameByAsn(networkAsn);
                  const rdapCompacted = compactEntityNameWithLongNameFallback(String(rdapOrgName || "").trim());
                  const rdapNameBase = String(rdapCompacted.shortName || rdapOrgName || "").trim();

                  if (rdapNameBase && !isLikelyGeneratedHandleName(rdapNameBase)) {
                    nextName = `${rdapNameBase}${appendName}`;
                    usedRdapAsnFallback = true;
                    if (!nextLongName && rdapCompacted.longName) {
                      nextLongName = rdapCompacted.longName;
                    }
                  } else {
                    const preferredFallback = pickPreferredNetworkNameCandidate([
                      currentNetworkLongName,
                      currentNetworkName,
                      fullName,
                    ]);
                    let deterministicFallback = preferredFallback;
                    if (!deterministicFallback) {
                      // ASN has no meaningful name candidate and no RDAP owner name.
                      // Use native footer delete flow (with confirmation page) for decommissioned ASN records.
                      const deleteFlowStarted = triggerNetworkFooterDeleteFlow(ctx.entityId);
                      if (deleteFlowStarted) {
                        clearPendingNetworkUpdateNameRetry(ctx.entityId);
                        notifyUser({
                          title: "PeeringDB CP",
                          text: "Update Name: ASN owner lookup unresolved and no valid name candidates found; starting footer Delete flow.",
                        });
                        return;
                      }

                      deterministicFallback = `${getDeterministicNetworkFallbackName(networkAsn, ctx.entityId, "")}${appendName}`;
                    }
                    if (deterministicFallback) {
                      nextName = deterministicFallback;
                      if (!nextLongName && fullName && fullName !== deterministicFallback) {
                        nextLongName = fullName;
                      }
                    }
                  }
                }

                if (shouldForceNetworkNameAsnSuffix(nextName)) {
                  nextName = buildNetworkNameAsnRetryVariant(nextName, getInputValue("#id_asn")) || nextName;
                }
              } else if (ctx.entity === "organization") {
                const compactedName = compactEntityNameWithLongNameFallback(fullName);
                const compactNameBase = compactedName.shortName || fullName;
                nextLongName = compactedName.longName;
                nextName = `${compactNameBase}${appendName}`;
              }
              const currentName = getInputValue("#id_name");

              if (ctx.entity === "network") {
                nextName = normalizeSimpleSingleDashAlphabeticName(nextName);
                nextLongName = normalizeSimpleSingleDashAlphabeticName(nextLongName);
                orgKnownAs = normalizeSimpleSingleDashAlphabeticName(orgKnownAs);
              }

              // Safety net: if computed outcome is a no-op for networks and the current name still
              // looks handle-like, force one RDAP ASN lookup attempt before bailing out.
              if (ctx.entity === "network" && !usedRdapAsnFallback && nextName === currentName) {
                const currentNamePattern = classifyNetworkNamePattern(currentName);
                const looksHandleLikeForNoOpSafety =
                  isLikelyGeneratedHandleName(currentName)
                  || currentNamePattern.score >= NETWORK_NAME_SCAN_MIN_SUSPICIOUS_SCORE;

                if (looksHandleLikeForNoOpSafety) {
                  const networkAsnForSafety = getInputValue("#id_asn");
                  const rdapSafetyOrgName = await rdapAutnumClient.resolveOrganizationNameByAsn(networkAsnForSafety);
                  const rdapSafetyCompacted = compactEntityNameWithLongNameFallback(String(rdapSafetyOrgName || "").trim());
                  const rdapSafetyNameBase = String(rdapSafetyCompacted.shortName || rdapSafetyOrgName || "").trim();
                  const rdapSafetyNextName = rdapSafetyNameBase ? `${rdapSafetyNameBase}${appendName}` : "";

                  if (
                    rdapSafetyNextName &&
                    rdapSafetyNextName !== currentName &&
                    !isLikelyGeneratedHandleName(rdapSafetyNameBase)
                  ) {
                    nextName = rdapSafetyNextName;
                    usedRdapAsnFallback = true;
                    if (!nextLongName && rdapSafetyCompacted.longName) {
                      nextLongName = rdapSafetyCompacted.longName;
                    }
                  }
                }
              }

              const currentLongName =
                ctx.entity === "network"
                  ? getNetworkLongNameValue()
                  : ctx.entity === "organization"
                    ? getOrganizationLongNameValue()
                    : "";
              const normalizedCurrentLongName =
                (ctx.entity === "network" || ctx.entity === "organization") && currentLongName
                  ? sanitizeRdapOrgName(currentLongName)
                  : "";
              const hasMalformedCurrentLongName =
                ctx.entity === "network" &&
                currentLongName &&
                isRdapOrgNameMalformed(currentLongName);
              if (hasMalformedCurrentLongName && !nextLongName && normalizedCurrentLongName) {
                nextLongName = normalizedCurrentLongName;
              }
              const currentNetworkKnownAs = ctx.entity === "network" ? getInputValue("#id_aka") : "";
              const currentKnownAs = ctx.entity === "organization" ? getInputValue("#id_aka") : "";
              const normalizedNextNameForCompare = String(nextName || "").trim().toLowerCase();
              const normalizedCurrentNetworkKnownAsForCompare =
                ctx.entity === "network" ? String(currentNetworkKnownAs || "").trim().toLowerCase() : "";
              const shouldUpdateLongName =
                (ctx.entity === "network" || ctx.entity === "organization") &&
                nextLongName &&
                nextLongName !== currentLongName;
              const effectiveNetworkLongName =
                ctx.entity === "network"
                  ? String((shouldUpdateLongName ? nextLongName : currentLongName) || "").trim()
                  : "";
              const shouldClearNetworkLongName =
                ctx.entity === "network" &&
                effectiveNetworkLongName &&
                effectiveNetworkLongName === nextName;
              const shouldClearNetworkKnownAs =
                ctx.entity === "network" &&
                currentNetworkKnownAs &&
                (
                  normalizedCurrentNetworkKnownAsForCompare === normalizedNextNameForCompare ||
                  (effectiveNetworkLongName && normalizedCurrentNetworkKnownAsForCompare === effectiveNetworkLongName.trim().toLowerCase()) ||
                  containsAsnLikeToken(currentNetworkKnownAs)
                );
              const shouldUpdateNetworkKnownAs =
                ctx.entity === "network" &&
                orgKnownAs &&
                orgKnownAs !== currentNetworkKnownAs;
              const shouldUpdateOrganizationKnownAs =
                ctx.entity === "organization" && orgKnownAs && orgKnownAs !== currentKnownAs;
              const shouldAttemptOrgUpdate = Boolean((wasMalformedOrgName || hasMalformedCurrentLongName) && orgIdToUpdate);

              if (
                nextName === currentName &&
                !shouldUpdateLongName &&
                !shouldClearNetworkLongName &&
                !shouldClearNetworkKnownAs &&
                !shouldUpdateNetworkKnownAs &&
                !shouldUpdateOrganizationKnownAs &&
                !shouldAttemptOrgUpdate
              ) {
                pulseToolbarButton(event?.target, "No-op");
                notifyUser({
                  title: "PeeringDB CP",
                  text: usedRdapAsnFallback
                    ? `Update Name: used RDAP ASN fallback; no changes required for '${nextName}'.`
                    : `Update Name: no changes required for '${nextName}'.`,
                });
                return;
              }

              let queuedRetryName = "";
              if (ctx.entity === "network") {
                const visibilityChangedRows = normalizeNetworkPocVisibilityPrivateToUsers();
                if (visibilityChangedRows > 0) {
                  notifyUser({
                    title: "PeeringDB CP",
                    text: `Update Name: changed ${visibilityChangedRows} POC visibility value(s) from Private to Users before save.`,
                  });
                }

                queuedRetryName = buildNetworkNameAsnRetryVariant(nextName, getInputValue("#id_asn"));
                if (queuedRetryName && queuedRetryName !== nextName) {
                  setPendingNetworkUpdateNameRetry({
                    networkId: ctx.entityId,
                    originalName: nextName,
                    retryName: queuedRetryName,
                    attempts: 0,
                  });
                } else {
                  clearPendingNetworkUpdateNameRetry(ctx.entityId);
                }
              }

              // Update org via API BEFORE form submission if it was malformed
              let orgUpdateSucceeded = false;
              if (wasMalformedOrgName && orgIdToUpdate) {
                const orgUpdateResult = await updateOrganizationNameViaApi(orgIdToUpdate, fullName, orgKnownAs);
                orgUpdateSucceeded = Boolean(orgUpdateResult?.ok);
                if (orgUpdateSucceeded) {
                  notifyUser({
                    title: "PeeringDB CP",
                    text: orgKnownAs
                      ? `✓ Malformed org name cleaned and updated via API (aka='${orgKnownAs}').`
                      : "✓ Malformed org name cleaned and updated via API.",
                  });
                } else {
                  if (ctx.entity === "network") {
                    clearPendingNetworkUpdateNameRetry(ctx.entityId);
                  }
                  notifyUser({
                    title: "PeeringDB CP",
                    text: `Update Name aborted: org-name verification failed (${orgUpdateResult?.reason || "unknown"}).`,
                  });
                  return;
                }
              }

              if (nextName === currentName && !shouldUpdateLongName && !shouldClearNetworkLongName && !shouldClearNetworkKnownAs && !shouldUpdateNetworkKnownAs && !shouldUpdateOrganizationKnownAs) {
                pulseToolbarButton(event?.target, "Updated");
                notifyUser({
                  title: "PeeringDB CP",
                  text: "Update Name: organization updated; entity name unchanged.",
                });
                return;
              }

              markDeletedNetworkInlinesForDeletion();
              if (ctx.entity === "network" && shouldUpdateLongName && !shouldClearNetworkLongName) {
                setNetworkLongNameValue(nextLongName);
              }
              if (ctx.entity === "network" && shouldClearNetworkLongName) {
                setNetworkLongNameValue("");
              }
              if (ctx.entity === "organization" && nextLongName) {
                setOrganizationLongNameValue(nextLongName);
              }
              if (ctx.entity === "network" && shouldClearNetworkKnownAs) {
                setInputValue("#id_aka", "");
              }
              if (ctx.entity === "network" && shouldUpdateNetworkKnownAs) {
                setInputValue("#id_aka", orgKnownAs);
              }
              if (ctx.entity === "organization" && shouldUpdateOrganizationKnownAs) {
                setInputValue("#id_aka", orgKnownAs);
              }
              // "Floor" is deprecated; clear it on save if it has a value.
              if (getInputValue("#id_floor")) {
                setInputValue("#id_floor", "");
              }
              setInputValue("#id_name", nextName);
              setPendingPostUpdateNameHistoryRedirect(ctx);
              const didSubmit = clickSaveAndContinue();
              if (!didSubmit) {
                clearPendingPostUpdateNameHistoryRedirect();
                if (ctx.entity === "network") {
                  clearPendingNetworkUpdateNameRetry(ctx.entityId);
                }
                notifyUser({
                  title: "PeeringDB CP",
                  text: "Update Name: failed to trigger save action.",
                });
                return;
              }

              notifyUser({
                title: "PeeringDB CP",
                text:
                  ctx.entity === "network" && queuedRetryName
                    ? `Update Name: saved '${nextName}'. Auto-retry is armed for duplicate-name errors.`
                    : `Update Name: saved '${nextName}'.`,
              });
              if (ctx.entity === "network" && usedRdapAsnFallback) {
                notifyUser({
                  title: "PeeringDB CP",
                  text: "Update Name: used RDAP ASN fallback.",
                });
              }
            } finally {
              endActionLock(actionLockKey);
            }
          },
        });
      },
    },
    {
      id: "reset-network-information",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "network",
      preconditions: () => Boolean(getToolbarList() && qs("#id_org") && qs("#id_name") && getSelectedStatus() === "deleted"),
      run: (ctx) => {
        addToolbarAction({
          id: `${MODULE_PREFIX}ResetNetworkInformation`,
          label: "Reset Information",
          insertLeft: true,
          onClick: async (event) => {
            if (isWriteActionBlockedForHardExcludedEntity(ctx)) {
              notifyWriteActionBlockedForHardExcludedEntity("Reset Information", ctx);
              return;
            }
            const actionLockKey = `${MODULE_PREFIX}.resetNetworkInformation.${ctx.entityId}`;
            if (!tryBeginActionLock(actionLockKey)) {
              notifyUser({
                title: "PeeringDB CP",
                text: "Reset Information is already running.",
              });
              return;
            }

            try {
              const asn = getInputValue("#id_asn");
              const networkName = getInputValue("#id_name");

              if (!confirmDangerousReset(asn, networkName, ctx.entityId)) {
                return;
              }

              const button = event.target;
              button.textContent = "Processing...";
              button.style.opacity = "0.7";
              button.style.pointerEvents = "none";

              const orgId = getInputValue("#id_org");
              const appendName = getNameSuffixForDeletedEntity(ctx.entityId);
              let usedRdapFallback = false;

              runNetworkResetActions();

              // Seed name immediately so required-field validation can never block save.
              const fallbackName = getDeterministicNetworkFallbackName(asn, ctx.entityId, appendName);
              setNetworkNameValue(fallbackName);

              const baseName = await getOrganizationName(orgId);
              const resolvedNetworkName = baseName ? `${baseName}${appendName}` : "";

              if (resolvedNetworkName) {
                setNetworkNameValue(resolvedNetworkName);
              }

              // If resolved network name is empty, do an isolated RDAP ASN lookup
              // to resolve the responsible organization name.
              const currentName = getInputValue("#id_name");
              if (!currentName || currentName === fallbackName) {
                const rdapOrgName = await rdapAutnumClient.resolveOrganizationNameByAsn(asn);
                if (rdapOrgName) {
                  setNetworkNameValue(`${rdapOrgName}${appendName}`);
                  usedRdapFallback = true;
                }
              }

              // Final guard: keep name required-field validation from blocking first-run save.
              const finalNameInput = document.getElementById("id_name");
              if (!finalNameInput || !String(finalNameInput.value || "").trim()) {
                setNetworkNameValue(fallbackName);
              }

              clickSaveAndContinue();
              notifyUser({
                title: "PeeringDB CP",
                text: "Reset Information: changes prepared and save triggered.",
              });
              if (usedRdapFallback) {
                notifyUser({
                  title: "PeeringDB CP",
                  text: "Reset Information: RDAP fallback was used for name resolution.",
                });
              }
            } catch (error) {
              console.error(`[${MODULE_PREFIX}] Reset failed`, error);
              notifyUser({
                title: "PeeringDB CP",
                text: "Reset Information failed. See console for details.",
              });
              const button = event?.target;
              if (button) {
                button.textContent = "Reset Information";
                button.style.opacity = "1";
                button.style.pointerEvents = "auto";
              }
            } finally {
              const button = event?.target;
              if (button) {
                button.textContent = "Reset Information";
                button.style.opacity = "";
                button.style.pointerEvents = "";
              }
              endActionLock(actionLockKey);
            }
          },
        });
      },
    },
    {
      id: "carrierfac-approve-reject",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "carrierfacility",
      preconditions: () => Boolean(getToolbarList()),
      run: (ctx) => {
        const handleCarrierfacAction = async (action, event) => {
          const actionLockKey = `${MODULE_PREFIX}.carrierfacAction.${action}.${ctx.entityId}`;
          if (!tryBeginActionLock(actionLockKey)) {
            notifyUser({
              title: "PeeringDB CP",
              text: `Carrier Facility ${action} is already running.`,
            });
            return;
          }

          try {
            const button = event.target;
            button.textContent = `${action}ing...`;
            button.style.opacity = "0.7";
            button.style.pointerEvents = "none";

            const endpoint = `${PEERINGDB_API_BASE_URL}/carrierfac/${ctx.entityId}/${action.toLowerCase()}`;
            const result = await pdbPost(endpoint, "POST", {});

            if (result.status >= 200 && result.status < 300) {
              notifyUser({
                title: "PeeringDB CP",
                text: `Carrier Facility ${action} succeeded.`,
              });
            } else {
              notifyUser({
                title: "PeeringDB CP",
                text: `Carrier Facility ${action} failed (HTTP ${result.status}).`,
              });
            }
          } catch (error) {
            console.error(`[${MODULE_PREFIX}] Carrier Facility ${action} failed`, error);
            notifyUser({
              title: "PeeringDB CP",
              text: `Carrier Facility ${action} failed. See console for details.`,
            });
          } finally {
            const button = event?.target;
            if (button) {
              const origLabel = button.dataset.pdbCpOrigLabel || "Action";
              button.textContent = origLabel;
              button.style.opacity = "";
              button.style.pointerEvents = "";
            }
            endActionLock(actionLockKey);
          }
        };

        addToolbarAction({
          id: `${MODULE_PREFIX}CarrierfacApprove`,
          label: "Approve",
          insertLeft: true,
          onClick: (event) => {
            event.target.dataset.pdbCpOrigLabel = "Approve";
            handleCarrierfacAction("Approve", event);
          },
        });

        addToolbarAction({
          id: `${MODULE_PREFIX}CarrierfacReject`,
          label: "Reject",
          insertLeft: true,
          onClick: (event) => {
            event.target.dataset.pdbCpOrigLabel = "Reject";
            handleCarrierfacAction("Reject", event);
          },
        });
      },
    },
    {
      id: "request-ixf-import",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "internetexchange",
      preconditions: () => Boolean(getToolbarList()),
      run: (ctx) => {
        addToolbarAction({
          id: `${MODULE_PREFIX}RequestIxfImport`,
          label: "Request IXF Import",
          insertLeft: true,
          onClick: async (event) => {
            const actionLockKey = `${MODULE_PREFIX}.requestIxfImport.${ctx.entityId}`;
            if (!tryBeginActionLock(actionLockKey)) {
              notifyUser({
                title: "PeeringDB CP",
                text: "Request IXF Import is already running.",
              });
              return;
            }

            try {
              const button = event.target;
              button.textContent = "Requesting...";
              button.style.opacity = "0.7";
              button.style.pointerEvents = "none";

              const endpoint = `${PEERINGDB_API_BASE_URL}/ix/${ctx.entityId}/request_ixf_import`;
              const result = await pdbPost(endpoint, "POST", {});

              if (result.status >= 200 && result.status < 300) {
                notifyUser({
                  title: "PeeringDB CP",
                  text: "IXF import request submitted successfully.",
                });
              } else {
                notifyUser({
                  title: "PeeringDB CP",
                  text: `IXF import request failed (HTTP ${result.status}).`,
                });
              }
            } catch (error) {
              console.error(`[${MODULE_PREFIX}] Request IXF Import failed`, error);
              notifyUser({
                title: "PeeringDB CP",
                text: "Request IXF Import failed. See console for details.",
              });
            } finally {
              const button = event?.target;
              if (button) {
                button.textContent = "Request IXF Import";
                button.style.opacity = "";
                button.style.pointerEvents = "";
              }
              endActionLock(actionLockKey);
            }
          },
        });
      },
    },
    {
      id: "ixf-import-status-badge",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "internetexchange",
      preconditions: () => Boolean(qs("#grp-content-title")),
      run: async (ctx) => {
        try {
          const endpoint = getPeeringDbApiObjectUrl("ix", ctx.entityId);
          if (!endpoint) return;

          const statusPayload = await pdbFetch(endpoint);
          const ixData = getFirstApiDataItem(statusPayload, endpoint);
          const formIxfStatus = String(
            getReadonlyFieldValueByLabel("Manual IX-F import status") ||
            getReadonlyFieldValueByLabel("IX-F import request status") ||
            getReadonlyFieldValueByLabel("IXF import request status") ||
            "",
          ).trim().toLowerCase();
          const apiIxfStatus = String(ixData?.ixf_import_request_status || "").trim().toLowerCase();
          const status = formIxfStatus || apiIxfStatus;
          if (!status) return;

          const statusColors = {
            queued: "#ff9800",
            importing: "#2196f3",
            finished: "#4caf50",
            error: "#f44336",
            pending: "#ff9800",
          };
          const color = statusColors[status] || "#999";
          const lastImport = ixData?.ixf_last_import ? new Date(ixData.ixf_last_import).toLocaleDateString() : "never";

          const badge = document.createElement("span");
          badge.style.cssText = `
            display: inline-block;
            padding: 2px 8px;
            margin-left: 10px;
            background-color: ${color};
            color: white;
            border-radius: 3px;
            font-size: 12px;
            font-weight: bold;
            white-space: nowrap;
            title: "Last import: ${lastImport}";
          `;
          badge.textContent = `IXF: ${status}`;
          badge.title = `IXF import status: ${status}\nLast import: ${lastImport}`;

          const titleArea = qs("#grp-content-title h1") || qs("#grp-content-title");
          if (titleArea) {
            titleArea.appendChild(badge);
          }

          // Append clickable link to IXF member list URL if available.
          // Purpose: Direct access to the exchange member list without extra navigation.
          const memberListUrl = String(ixData?.ixf_ixp_member_list_url || "").trim();
          if (memberListUrl && titleArea) {
            const linkSpan = document.createElement("span");
            linkSpan.style.cssText = `
              display: inline-block;
              margin-left: 8px;
            `;
            const link = document.createElement("a");
            link.href = memberListUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "Members";
            link.style.cssText = `
              color: #2196f3;
              text-decoration: none;
              font-size: 12px;
              font-weight: bold;
            `;
            linkSpan.appendChild(link);
            titleArea.appendChild(linkSpan);
          }
        } catch (_error) {
          // Gracefully ignore API errors for status badge
        }
      },
    },
    {
      id: "network-rir-status-badge",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "network",
      preconditions: () => Boolean(qs("#grp-content-title")),
      run: async (ctx) => {
        try {
          const endpoint = getPeeringDbApiObjectUrl("net", ctx.entityId);
          if (!endpoint) return;

          const statusPayload = await pdbFetch(endpoint);
          const netData = getFirstApiDataItem(statusPayload, endpoint);
          const formRirStatus = String(getReadonlyFieldValueByLabel("RIR status") || "").trim().toLowerCase();
          const apiRirStatus = String(netData?.rir_status || "").trim().toLowerCase();
          const status = formRirStatus || apiRirStatus;
          if (!status) return;

          const statusColors = {
            ok: "#4caf50",
            invalid: "#f44336",
            pending: "#ff9800",
            na: "#999",
          };
          const color = statusColors[status] || "#999";
          const updated = netData.rir_status_updated ? new Date(netData.rir_status_updated).toLocaleDateString() : "unknown";

          const badge = document.createElement("span");
          badge.style.cssText = `
            display: inline-block;
            padding: 2px 8px;
            margin-left: 10px;
            background-color: ${color};
            color: white;
            border-radius: 3px;
            font-size: 12px;
            font-weight: bold;
            white-space: nowrap;
          `;
          badge.textContent = `RIR: ${status}`;
          badge.title = `RIR status: ${status}\nLast updated: ${updated}`;

          const titleArea = qs("#grp-content-title h1") || qs("#grp-content-title");
          if (titleArea) {
            titleArea.appendChild(badge);
          }

          // Append IRR AS-SET badge using the already-fetched network data.
          // Purpose: Surface the IRR route-object set identifier without a second API call.
          const irrAsSet = String(netData?.irr_as_set || "").trim();
          if (irrAsSet && titleArea) {
            const irrBadge = document.createElement("span");
            irrBadge.style.cssText = `
              display: inline-block;
              padding: 2px 8px;
              margin-left: 6px;
              background-color: #607d8b;
              color: white;
              border-radius: 3px;
              font-size: 12px;
              font-weight: bold;
              white-space: nowrap;
            `;
            irrBadge.textContent = `IRR: ${irrAsSet}`;
            irrBadge.title = `IRR AS-SET: ${irrAsSet}`;
            titleArea.appendChild(irrBadge);
          }
        } catch (_error) {
          // Gracefully ignore API errors for status badge
        }
      },
    },
    {
      id: "set-window-title",
      match: (ctx) =>
        ctx.isCp && (ctx.isEntityChangePage || (ctx.entity === "network" && ctx.pageKind === "history")),
      run: (ctx) => {
        const sep = " | ";
        let title = "";

        if (ctx.isEntityChangePage) {
          if (ctx.entity === "user") {
            const username = getInputValue("#id_username");
            const email = getInputValue("#id_email");
            title = `${username}${sep}${email}`;
          } else {
            const name = getInputValue("#id_name");
            const country = qs("#id_country > option[selected]")?.innerText || "";
            title = `${name}${sep}${country}`;
          }

          document.title = `PDB CP${sep}${ctx.entity.toUpperCase()}${sep}${title}`;
          return;
        }

        // Extract historyName from breadcrumbs first
        let historyName = "";
        const breadcrumbAnchors = qsa("#grp-breadcrumbs a");
        for (let i = breadcrumbAnchors.length - 1; i >= 0; i--) {
          const text = breadcrumbAnchors[i]?.innerText?.trim() || "";
          if (text && !/\bhistory\b/i.test(text)) {
            historyName = text;
            break;
          }
        }

        // Fallback: try #grp-content-title h1, h1 with trailing history token stripped
        if (!historyName) {
          const rawHistoryName = qs("#grp-content-title h1, h1")?.innerText?.trim() || "";
          historyName = rawHistoryName.replace(/\s*\bhistory\b\s*$/i, "").trim();
        }

        // Final fallback
        if (!historyName) {
          historyName = `network#${ctx.entityId}`;
        }

        const historyTitle = `PDB CP${sep}NETWORK${sep}${historyName}${sep}History`;
        document.title = historyTitle;
        setTimeout(() => {
          document.title = historyTitle;
        }, 250);
      },
    },
  ];

  /**
   * Executes all enabled modules that match the current route context.
   * Purpose: Central dispatcher that activates modules for the current page.
   * Necessity: Implements modular architecture; checks both enabled status and page match
   * before running each module. Catches and logs errors to prevent cascade failures.
   * AI Maintenance: Preserve execution ordering, locks, and route/module boundaries.
   * @param {{ entity: string, entityId: string, isEntityChangePage: boolean }} ctx - Route context.
   */
  function dispatchModules(ctx) {
    const disabledModules = getDisabledModules();
    dbg("dispatch", "running", { entity: ctx.entity, entityId: ctx.entityId });

    modules.forEach((module) => {
      try {
        if (!isModuleEnabled(module.id, disabledModules)) {
          dbg("dispatch", `skip (disabled) ${module.id}`);
          return;
        }
        if (!module.match(ctx)) {
          dbg("dispatch", `skip (no match) ${module.id}`);
          return;
        }
        if (typeof module.preconditions === "function" && !module.preconditions(ctx)) {
          dbg("dispatch", `skip (preconditions) ${module.id}`);
          return;
        }

        const existingDispose = moduleDisposers.get(module.id);
        if (typeof existingDispose === "function") {
          dbg("dispatch", `dispose ${module.id}`);
          try { existingDispose(); } catch (_err) { /* ignore dispose errors */ }
          moduleDisposers.delete(module.id);
        }

        dbg("dispatch", `run ${module.id}`);
        const result = module.run(ctx);
        if (typeof result === "function") {
          moduleDisposers.set(module.id, result);
          dbg("dispatch", `disposer stored ${module.id}`);
        }
      } catch (error) {
        console.warn(`[${MODULE_PREFIX}] module failed: ${module.id}`, error);
      }
    });
  }

  /**
   * Runs the complete initialization sequence for consolidated tools.
   * Purpose: Parse route, dispatch modules, and enforce button order on current page.
   * Necessity: Single entry point for all initialization logic; ensures modules run before layout.
   */
  let cpMenuCommandsRegistered = false;

  /**
   * Registers one-time Tampermonkey menu commands for common CP actions.
   * Purpose: Provide keyboard/popup access to frequent actions without toolbar clicks.
   * Necessity: Power users benefit from script actions in the Tampermonkey command menu.
   * AI Maintenance: Preserve selector contracts and idempotent DOM mutation behavior.
   */
  function registerCpMenuCommands() {
    if (cpMenuCommandsRegistered) return;
    if (typeof GM_registerMenuCommand !== "function") return;
    cpMenuCommandsRegistered = true;

    let debugToggleCommandId = null;
    let debugUserAgentCommandId = null;
    let featureFlagsShowCommandId = null;
    let featureFlagsResetCommandId = null;
    let featureFlagToggleCommandIds = [];

    const registerMenuCommandForButton = (buttonId, fallbackLabel) => {
      const button = qs(`#${buttonId}`);
      if (!button) return;

      const label = String(button.textContent || "").trim() || String(fallbackLabel || "").trim();
      if (!label) return;

      GM_registerMenuCommand(`CP: ${label}`, () => {
        qs(`#${buttonId}`)?.click();
      });
    };

    registerMenuCommandForButton(`${MODULE_PREFIX}UpdateEntityName`, "Update Name");
    registerMenuCommandForButton(`${MODULE_PREFIX}CopyEntityUrl`, "Copy Entity URL");
    registerMenuCommandForButton(`${MODULE_PREFIX}CopyUserProfileUrl`, "Copy User Profile URL");
    registerMenuCommandForButton(`${MODULE_PREFIX}CopyOrganizationUrl`, "Copy Org URL");
    registerMenuCommandForButton(`${MODULE_PREFIX}ResetNetworkInformation`, "Reset Information");

    GM_registerMenuCommand("CP: Clear Org Name Cache", () => {
      clearOrganizationNameCache();
      notifyUser({
        title: "PeeringDB CP",
        text: "Organization-name cache cleared.",
      });
    });

    GM_registerMenuCommand("CP: Clear RDAP Cache", () => {
      rdapAutnumClient.clearCache();
      notifyUser({
        title: "PeeringDB CP",
        text: "RDAP caches cleared.",
      });
    });

    const getDebugToggleMenuLabel = () => {
      const enabled = isDebugEnabled();
      return `CP: Debug Mode [${enabled ? "ON" : "OFF"}] (toggle to ${enabled ? "OFF" : "ON"})`;
    };

    const getDebugUserAgentMenuLabel = () => {
      return `CP: Log User-Agent (Debug ${isDebugEnabled() ? "ON" : "OFF"})`;
    };

    const refreshDebugMenuCommands = () => {
      if (typeof GM_unregisterMenuCommand === "function") {
        if (debugToggleCommandId != null) {
          GM_unregisterMenuCommand(debugToggleCommandId);
        }
        if (debugUserAgentCommandId != null) {
          GM_unregisterMenuCommand(debugUserAgentCommandId);
        }
      }

      debugToggleCommandId = GM_registerMenuCommand(getDebugToggleMenuLabel(), () => {
        const next = isDebugEnabled() ? null : "1";
        if (next) {
          window.localStorage?.setItem(DIAGNOSTICS_STORAGE_KEY, next);
        } else {
          window.localStorage?.removeItem(DIAGNOSTICS_STORAGE_KEY);
        }

        notifyUser({
          title: "PeeringDB CP",
          text: `Debug mode ${next ? "enabled" : "disabled"}.`,
        });

        if (next) {
          logCurrentUserAgentDebug();
        }

        if (typeof GM_unregisterMenuCommand === "function") {
          refreshDebugMenuCommands();
        }
      });

      debugUserAgentCommandId = GM_registerMenuCommand(getDebugUserAgentMenuLabel(), () => {
        const didLog = logCurrentUserAgentDebug();
        if (!didLog) {
          const host = String(window.location?.hostname || "").trim().toLowerCase();
          console.info(`[${MODULE_PREFIX}:ua] requested User-Agent log while debug mode is OFF`, {
            debugEnabled: false,
            host,
            userAgent: getCustomRequestUserAgent(),
          });

          notifyUser({
            title: "PeeringDB CP",
            text: "Enable debug mode first to log User-Agent details.",
          });
          return;
        }

        notifyUser({
          title: "PeeringDB CP",
          text: "User-Agent details logged to browser console.",
        });
      });
    };

    const getFeatureFlagToggleMenuLabel = (flagName) => {
      const state = getFeatureFlagState(flagName);
      if (!state) return `CP: Feature ${flagName}`;
      return `CP: Feature ${flagName} [${state.enabled ? "ON" : "OFF"}] (toggle to ${state.enabled ? "OFF" : "ON"})`;
    };

    const refreshFeatureFlagMenuCommands = () => {
      if (typeof GM_unregisterMenuCommand === "function") {
        if (featureFlagsShowCommandId != null) {
          GM_unregisterMenuCommand(featureFlagsShowCommandId);
        }
        if (featureFlagsResetCommandId != null) {
          GM_unregisterMenuCommand(featureFlagsResetCommandId);
        }
        featureFlagToggleCommandIds.forEach((commandId) => {
          if (commandId != null) GM_unregisterMenuCommand(commandId);
        });
      }

      featureFlagsShowCommandId = GM_registerMenuCommand("CP: Feature Flags (show in console)", () => {
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
          title: "PeeringDB CP",
          text: "Feature-flag snapshot logged to browser console.",
        });
      });

      featureFlagsResetCommandId = GM_registerMenuCommand("CP: Feature Flags (reset overrides)", () => {
        resetFeatureFlagOverrides();
        notifyUser({
          title: "PeeringDB CP",
          text: "Feature-flag overrides reset.",
        });
        if (typeof GM_unregisterMenuCommand === "function") {
          refreshFeatureFlagMenuCommands();
          refreshDebugMenuCommands();
        }
      });

      featureFlagToggleCommandIds = Object.keys(FEATURE_FLAGS)
        .sort()
        .map((flagName) =>
          GM_registerMenuCommand(getFeatureFlagToggleMenuLabel(flagName), () => {
            const state = getFeatureFlagState(flagName);
            if (!state) return;
            setFeatureFlagEnabled(flagName, !state.enabled);
            notifyUser({
              title: "PeeringDB CP",
              text: `Feature ${flagName} ${state.enabled ? "disabled" : "enabled"}.`,
            });
            if (typeof GM_unregisterMenuCommand === "function") {
              refreshFeatureFlagMenuCommands();
              refreshDebugMenuCommands();
            }
          }),
        );
    };

    refreshDebugMenuCommands();
    refreshFeatureFlagMenuCommands();
  }

  /**
   * Runs a lightweight set of DOM precondition checks on page load.
   * Purpose: Surface missing or renamed Django admin DOM landmarks early so
   * regressions are caught immediately in the console rather than mid-action.
   * Necessity: Grappelli admin markup can change between PeeringDB releases;
   * a self-check surfaces breakage before a user triggers an action.
   * Always logs to console.warn for any failed check; emits console.debug
   * details in debug mode. Runs at most once per page load.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   * @param {{ entity: string, entityId: string, pathName: string }} ctx - Route context.
   */
  function runSelfCheck(ctx) {
    runApiResourceCoverageCheck();

    const checks = [
      { id: "grp-content",       selector: "#grp-content",             critical: true },
      { id: "grp-content-title", selector: "#grp-content-title",       critical: true },
      { id: "toolbar",           selector: () => Boolean(getToolbarList()), critical: false },
      { id: "id_status",         selector: "#id_status",                critical: false },
    ];

    const failures = [];

    checks.forEach(({ id, selector, critical }) => {
      const found =
        typeof selector === "function"
          ? selector()
          : Boolean(qs(selector));
      dbg("self-check", `${found ? "ok" : "missing"} [${id}]`);
      if (!found) failures.push({ id, critical });
    });

    if (failures.length === 0) {
      dbg("self-check", "all checks passed", { entity: ctx.entity });
      return;
    }

    const criticalIds = failures.filter((f) => f.critical).map((f) => f.id);
    const warnIds    = failures.filter((f) => !f.critical).map((f) => f.id);

    if (criticalIds.length) {
      console.warn(
        `[${MODULE_PREFIX}] self-check: critical landmarks missing — ${criticalIds.join(", ")}`,
        { entity: ctx.entity, path: ctx.pathName },
      );
    }
    if (warnIds.length) {
      console.warn(
        `[${MODULE_PREFIX}] self-check: optional landmarks missing — ${warnIds.join(", ")}`,
        { entity: ctx.entity, path: ctx.pathName },
      );
    }
  }

  /**
   * Entry point for the consolidated CP userscript.
   * Purpose: Orchestrate the full initialization sequence — route context parse,
   * self-check, legacy cleanup, module dispatch, toolbar ordering, and TM menu registration.
   * Necessity: A single entry point ensures sequential, predictable initialization
   * regardless of DOMContentLoaded timing or future module additions.
   * AI Maintenance: Keep behavior stable and prefer minimal, localized edits.
   */
  function runConsolidatedInit() {
    const ctx = getRouteContext();

    if (!ctx.isCp || (!ctx.isEntityChangePage && !ctx.isEntityListPage)) {
      return;
    }

    if (ctx.isEntityChangePage) {
      runSelfCheck(ctx);
      if (maybeRedirectToHistoryAfterUpdateName(ctx)) {
        return;
      }
    }
    dbg("init", `v${SCRIPT_VERSION}`, { entity: ctx.entity, entityId: ctx.entityId });
    logCurrentUserAgentDebug();
    cleanupLegacyPrimaryActionRow();
    dispatchModules(ctx);
    enforceToolbarButtonOrder(ctx);
    registerCpMenuCommands();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runConsolidatedInit, { once: true });
  } else {
    runConsolidatedInit();
  }
})();
