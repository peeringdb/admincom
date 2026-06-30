// ==UserScript==
// @name         PeeringDB CP - Consolidated Tools
// @namespace    https://www.peeringdb.com/cp/
// @version      2.0.208
// @description  Consolidated CP userscript with strict route-isolated modules for facility/network/user/entity workflows
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/cp/peeringdb_server/*
// @match        https://beta.peeringdb.com/cp/peeringdb_server/*
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
// @connect      *
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
// - IXLAN Renumber module: activates only on networkixlan changelist when a
//   '#pdb-renumber=v1&...' hash payload is present (handed off by the DP
//   launcher). MUST NOT cache netixlan rows during enumerate/apply; all
//   mutations go through pdbPost(PUT) (PATCH path is intentionally absent);
//   audit log uses its own storage key (IXLAN_RENUMBER_AUDIT_LOG_STORAGE_KEY).
// - IX-F Member Audit module: activates on the networkixlan changelist when
//   an ixlan filter is present (or via prompt). Cross-origin GET of the
//   ixlan's ixf_ixp_member_list_url uses GM_xmlhttpRequest with
//   anonymous:true and requires '@connect *' (IX portal hosts are operator-
//   defined). Merge keeps the older (lower-id) netixlan via pdbPost(PUT)
//   and DELETEs its sibling; audit log uses its own storage key
//   (IXF_MEMBER_AUDIT_LOG_STORAGE_KEY).
// - IXLAN Conflict Resolver: post-renumber phase reachable from the
//   IXLAN Renumber modal. For each row classified as "conflict" (target
//   IP already exists on the ixlan), runs a 7-gate verification including
//   live IX-F cross-check against the keeper, then DELETEs the doomed
//   duplicate via pdbPost("DELETE"). DELETEs are sequential, require a
//   typed ixlan-id confirmation + per-row checkbox + final window.confirm,
//   and IX-F unavailability hard-fails gates 5 & 6 ("200% sure"
//   directive). Audit log: CONFLICT_RESOLVE_AUDIT_LOG_STORAGE_KEY.
// - Recent IP Changes Report: read-only modal reachable from the
//   networkixlan changelist toolbar, IXLAN Renumber modal, and IX-F Member
//   Audit modal. Merges live /api/netixlan rows (last 60 min) with all
//   three local audit logs (renumber + IX-F merge + conflict-resolve) so
//   DELETEd rows still surface as "(deleted; superseded by #<keeperId>)".

(function () {
  "use strict";

  const MODULE_PREFIX = "pdbCpConsolidated";
  const SCRIPT_VERSION = "2.0.208";

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
    ixlanRenumber: true,
    ixfMemberAudit: true,
    conflictResolver: true,
    recentIpChanges: true,
  });
  const DISABLED_MODULES_STORAGE_KEY = `${MODULE_PREFIX}.disabledModules`;
  const ORG_UPDATE_AUDIT_LOG_STORAGE_KEY = `${MODULE_PREFIX}.orgUpdateAuditLog`;
  const ORG_UPDATE_AUDIT_LOG_MAX_ITEMS = 30;
  const IXLAN_RENUMBER_AUDIT_LOG_STORAGE_KEY = `${MODULE_PREFIX}.ixlanRenumberAuditLog`;
  const IXLAN_RENUMBER_AUDIT_LOG_MAX_ITEMS = 20;
  const IXLAN_RENUMBER_HASH_KEY = "pdb-renumber";
  const IXLAN_RENUMBER_HASH_VERSION = "v1";
  const IXLAN_RENUMBER_APPLY_DELAY_MS = 250;
  const IXF_MEMBER_AUDIT_LOG_STORAGE_KEY = `${MODULE_PREFIX}.ixfMemberAuditLog`;
  const IXF_MEMBER_AUDIT_LOG_MAX_ITEMS = 20;
  const IXF_MEMBER_APPLY_DELAY_MS = 250;
  const IXF_FETCH_TIMEOUT_MS = 15000;
  // Conflict resolver: deletes duplicate (stale) netixlan rows whose IPs
  // collide with an existing keeper row on the same ixlan, after multi-
  // gate verification against the IX-F member-export.
  const CONFLICT_RESOLVE_AUDIT_LOG_STORAGE_KEY = `${MODULE_PREFIX}.ixlanConflictResolveAuditLog`;
  const CONFLICT_RESOLVE_AUDIT_LOG_MAX_ITEMS = 20;
  const CONFLICT_RESOLVE_APPLY_DELAY_MS = 250;
  // Conflict-resolver data-loss guards. Gate 8 inspects every field in
  // PRESERVED_NETIXLAN_FIELDS on the non-conflicting family side; a
  // doomed row carrying a non-empty value the keeper lacks is
  // auto-absorbed when the field is in AUTO_MERGE_FIELDS, else the
  // gate hard-fails (operator must reconcile). A *mismatch* where BOTH
  // rows carry conflicting non-empty values always hard-fails. Policy:
  // AUTO_MERGE_FIELDS == PRESERVED_NETIXLAN_FIELDS — absorbing data the
  // keeper is missing is strictly additive and can never destroy
  // operator-entered values, while disagreements still require manual
  // resolution. Operator-discovered drivers:
  //   • ixlan #3990 AS211750: keeper had no IPv6; the doomed row's
  //     `2001:7f8:134::1b` would have been lost on a naive DELETE.
  //   • Same ixlan: real-world keeper/doomed pairs commonly disagree
  //     on `speed` etc., which used to hard-fail gate 8 with a
  //     would-lose:speed and made the row uncheckable even though the
  //     intent was plainly "absorb everything the keeper is missing".
  const PRESERVED_NETIXLAN_FIELDS = [
    "ipaddr4", "ipaddr6", "speed", "operational", "is_rs_peer", "bfd_support", "notes",
  ];
  const AUTO_MERGE_FIELDS = PRESERVED_NETIXLAN_FIELDS.slice();
  const CONFLICT_RESOLVE_GATE_COUNT = 8;
  // Recent IP changes report: window length in minutes for the audit view.
  const RECENT_IP_CHANGES_WINDOW_MIN = 60;
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
  const ORG_NAME_TAB_CACHE_STORAGE_PREFIX = `${MODULE_PREFIX}.orgNameTabCache.`;
  const ORG_NAME_TAB_CACHE_TTL_MS = 30 * 60 * 1000;
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
  const ORG_NAME_CACHE_SCHEMA_VERSION = 2;
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

  const displayTypeMap = {
    fac: "fac",
    facility: "fac",
    net: "net",
    network: "net",
    asn: "net",
    org: "org",
    organization: "org",
    carrier: "carrier",
    ix: "ix",
    internetexchange: "ix",
    campus: "campus",
    user: "user",
  };

  /**
   * Unified entity slug mapping for frontend URLs and API resource paths.
   * getFrontendSlugByEntity delegates to this map.
   */
  const ENTITY_SLUG_MAP = {
    facility: displayTypeMap.facility,
    network: displayTypeMap.network,
    organization: displayTypeMap.organization,
    carrier: displayTypeMap.carrier,
    internetexchange: displayTypeMap.internetexchange,
    campus: displayTypeMap.campus,
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
    `li[data-pdb-cp-secondary-action="${MODULE_PREFIX}ObjTypeWebsite"]`,
    `li[data-pdb-cp-secondary-action="${MODULE_PREFIX}ObjOrgWebsite"]`,
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
    RENUMBER_IXLAN_PEERS: "Renumber IXLAN Peers",
    AUDIT_IXF_MEMBERS: "Audit IX-F Members",
    RECENT_IP_CHANGES: `Recent IP Changes (\u2264${RECENT_IP_CHANGES_WINDOW_MIN} min)`,
  };
  let dropdownGlobalCloseListenerBound = false;

  /**
   * Reads JSON feature-flag overrides from localStorage.
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve execution ordering, locks, and route/module boundaries.
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
   * @ai Preserve execution ordering, locks, and route/module boundaries.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
   * @returns {boolean} True when debug mode is active.
   */
  function isDebugEnabled() {
    return isFeatureEnabled("debugMode") && window.localStorage?.getItem(DIAGNOSTICS_STORAGE_KEY) === "1";
  }

  /**
   * Structured debug logger — no-ops unless debug mode is active.
   * Purpose: Provide consistent prefixed console output for module and
   * bus diagnostics without polluting normal page console output.
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} orgId - Organization ID to build the key for.
   * @returns {string} Namespaced storage key, or empty string if orgId is invalid.
   */
  function getOrgNameCacheStorageKey(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return "";
    return `${ORG_NAME_CACHE_STORAGE_PREFIX}${normalizedOrgId}`;
  }

  /**
   * Builds storage key used for tab-scoped org-name cache entries.
   * Purpose: Keep org-name tab-cache keys namespaced under module prefix.
   * Necessity: Avoid collisions with unrelated session storage keys.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} orgId - Organization ID to build the key for.
   * @returns {string} Namespaced tab-cache key, or empty string if orgId is invalid.
   */
  function getOrgNameTabCacheStorageKey(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return "";
    return `${ORG_NAME_TAB_CACHE_STORAGE_PREFIX}${normalizedOrgId}`;
  }

  /**
   * Reads a valid organization-name cache entry from tab session storage.
   * Purpose: Reuse very recent org lookups without touching global storage.
   * Necessity: Supports strict cache order: global -> tab session -> API.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} orgId - Organization ID to look up.
   * @returns {string|null} Tab-cached organization name, or null on miss/expiry/malform.
   */
  function getSessionCachedOrganizationName(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return null;

    const storageKey = getOrgNameTabCacheStorageKey(normalizedOrgId);
    if (!storageKey) return null;

    try {
      const storage = getTabSessionStorage();
      const raw = storage?.getItem(storageKey);
      if (!raw) return null;

      const now = Date.now();
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

      return cachedName;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Stores organization-name cache entry in tab session storage.
   * Purpose: Persist short-lived per-tab org-name lookups.
   * Necessity: Completes ordered cache chain before API calls.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   * @param {string|number} orgId - Organization ID to cache the name for.
   * @param {string} name - Resolved organization name to persist.
   */
  function setSessionCachedOrganizationName(orgId, name) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    const normalizedName = String(name || "").trim();
    if (!normalizedOrgId || !normalizedName) return;

    const storageKey = getOrgNameTabCacheStorageKey(normalizedOrgId);
    if (!storageKey) return;

    try {
      const storage = getTabSessionStorage();
      storage?.setItem(
        storageKey,
        JSON.stringify({
          v: ORG_NAME_CACHE_SCHEMA_VERSION,
          name: normalizedName,
          expiresAt: Date.now() + ORG_NAME_TAB_CACHE_TTL_MS,
        }),
      );
    } catch (_error) {
      // Session storage may be unavailable.
    }
  }

  /**
   * Reads a valid organization-name cache entry from in-memory or domain storage.
   * Purpose: Reuse recent org-name lookups to reduce repeated API requests.
   * Necessity: Update Name and Reset Information may request the same org repeatedly.
   * Returns null when cache is absent, malformed, or expired.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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

    setSessionCachedOrganizationName(normalizedOrgId, normalizedName);
  }

  /**
   * Clears all organization-name cache entries from memory and domain storage.
   * Purpose: Provide explicit cache invalidation control for stale org-name lookups.
   * Necessity: Admin workflows occasionally require immediate refresh after org renames.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   */
  function clearOrganizationNameCache() {
    orgNameMemoryCache.clear();

    try {
      const storage = getDomainCacheStorage();
      if (storage) {
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
      }
    } catch (_error) {
      // Ignore storage failures; in-memory cache is still cleared.
    }

    try {
      const storage = getTabSessionStorage();
      if (!storage) return;

      const keysToDelete = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && key.startsWith(ORG_NAME_TAB_CACHE_STORAGE_PREFIX)) {
          keysToDelete.push(key);
        }
      }

      keysToDelete.forEach((key) => {
        storage.removeItem(key);
      });
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  /**
   * Retrieves the set of disabled module IDs from localStorage.
   * Purpose: Allows individual modules to be toggled on/off without code changes.
   * Necessity: Provides user-level module control for the modular architecture.
   * Supports both JSON array and comma-separated formats for backward compatibility.
   * @ai Preserve execution ordering, locks, and route/module boundaries.
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
   * @ai Preserve execution ordering, locks, and route/module boundaries.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve execution ordering, locks, and route/module boundaries.
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
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} entity - Route entity segment.
   * @returns {string} Canonical entity key, or empty string if unsupported.
   */
  function normalizeEntityTypeForHardExclude(entity) {
    const normalized = String(entity || "").trim().toLowerCase();
    return HARD_EXCLUDED_ENTITY_ALIASES[normalized] || "";
  }

  /**
   * Returns exclusion metadata when current route is hard-excluded.
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve execution ordering, locks, and route/module boundaries.
   * @param {{ isEntityChangePage: boolean, entity: string, entityId: string }} ctx - Route context.
   * @returns {boolean} True when write/change actions are disallowed for this entity.
   */
  function isWriteActionBlockedForHardExcludedEntity(ctx) {
    return Boolean(getHardExcludedEntityInfo(ctx));
  }

  /**
   * Notifies user that write/change action is blocked for hard-excluded entities.
   * @ai Preserve execution ordering, locks, and route/module boundaries.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @returns {string} Trimmed long-name value, or empty string when unavailable.
   */
  function getNetworkLongNameValue() {
    const input = getNetworkLongNameInputElement();
    if (!input) return "";
    return String(input.value || "").trim();
  }

  /**
   * Sets Long Name field value with change/input events.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
   * @returns {string} Trimmed long-name value, or empty string when unavailable.
   */
  function getOrganizationLongNameValue() {
    const input = getOrganizationLongNameInputElement();
    if (!input) return "";
    return String(input.value || "").trim();
  }

  /**
   * Sets organization Long Name field value with change/input events.
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
   * @param {string} name - Full organization name.
   * @returns {string} Name without leading company-type prefix or trailing suffix tokens.
   */
  function stripCompanyTypeSuffix(name) {
    const original = String(name || "").trim().replace(/\s+/g, " ");
    if (!original) return "";

    // Known false positive: keep brand name intact (do not strip trailing "ME").
    if (original === "Trade Me") return original;

    const legalSuffixPatterns = [
      "Corporation",
      "Incorporated",
      "Foundation",
      "Private\\s+Limited",
      "Limited",
      "Limitada",
      "L\\.?\\s*T\\.?\\s*D\\.?\\s*A\\.?\\s*-?\\s*E\\.?\\s*P\\.?\\s*P\\.?",
      "L\\.?\\s*T\\.?\\s*D\\.?\\s*A\\.?\\s*-?\\s*M\\.?\\s*E\\.?",
      "E\\.?\\s*I\\.?\\s*R\\.?\\s*E\\.?\\s*L\\.?\\s*I\\.?\\s*-?\\s*M\\.?\\s*E\\.?",
      "Limitada\\s*-?\\s*M\\.?\\s*E\\.?",
      "Limitada\\s*-?\\s*E\\.?\\s*P\\.?\\s*P\\.?",
      "G\\.?\\s*M\\.?\\s*B\\.?\\s*H\\.?\\s*&\\s*C\\.?\\s*O\\.?\\s*K\\.?\\s*G\\.?",
      "S\\.?\\s*A\\.?\\s*de\\s*C\\.?\\s*V\\.?",
      "S\\.?\\s*de\\s*R\\.?\\s*L\\.?\\s*de\\s*C\\.?\\s*V\\.?",
      "Unipessoal\\s+L\\.?\\s*d\\.?\\s*a\\.?",
      "P\\.?\\s*v\\.?\\s*t\\.?\\s*L\\.?\\s*t\\.?\\s*d\\.?",
      "S\\.?\\s*d\\.?\\s*n\\.?\\s*B\\.?\\s*h\\.?\\s*d\\.?",
      "j\\.?\\s*d\\.?\\s*o\\.?\\s*o\\.?",
      "E\\.?\\s*O\\.?\\s*O\\.?\\s*D\\.?",
      "L\\.?\\s*[tT]\\.?\\s*[dD]\\.?\\s*\\u015e[tT][iI\\u0130\\u0131]\\.?",
      "B\\.?\\s*V\\.?\\s*B\\.?\\s*A\\.?",
      "C\\.?\\s*V\\.?\\s*B\\.?\\s*A\\.?",
      "K\\.?\\s*G\\.?\\s*a\\.?\\s*A\\.?",
      "S\\.?\\s*A\\.?\\s*S\\.?\\s*U\\.?",
      "C\\.?\\s*o\\.?[,\\s]*L\\.?\\s*t\\.?\\s*d\\.?",
      "S\\.?\\s*p\\.?\\s*z\\.?\\s*o\\.?\\s*o\\.?",
      "P\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?",
      "J\\.?\\s*S\\.?\\s*C\\.?\\s*B\\.?",
      "J\\.?\\s*S\\.?\\s*C\\.?",
      "L\\.?\\s*T\\.?\\s*D\\.?\\s*A\\.?",
      "E\\.?\\s*I\\.?\\s*R\\.?\\s*E\\.?\\s*L\\.?\\s*I\\.?",
      "E\\.?\\s*U\\.?\\s*R\\.?\\s*L\\.?",
      "S\\.?\\s*A\\.?\\s*R\\.?\\s*L\\.?",
      "S\\.?\\s*A\\.?\\s*S\\.?",
      "S\\.?\\s*P\\.?\\s*R\\.?\\s*L\\.?",
      "S\\.?\\s*P\\.?\\s*A\\.?",
      "S\\.?\\s*R\\.?\\s*L\\.?",
      "S\\.?\\s*R\\.?\\s*O\\.?",
      "S\\.?\\s*C\\.?\\s*A\\.?",
      "S\\.?\\s*N\\.?\\s*C\\.?",
      "S\\.?\\s*C\\.?\\s*C\\.?",
      "S\\.?\\s*L\\.?\\s*U\\.?",
      "G\\.?\\s*M\\.?\\s*B\\.?\\s*H\\.?",
      "P\\.?\\s*L\\.?\\s*L\\.?\\s*C\\.?",
      "V\\.?\\s*O\\.?\\s*F\\.?",
      "O\\.?\\s*H\\.?\\s*G\\.?",
      "O\\.?\\s*O\\.?\\s*O\\.?",
      "P\\.?\\s*A\\.?\\s*O\\.?",
      "P\\.?\\s*A\\.?\\s*T\\.?",
      "O\\.?\\s*O\\.?\\s*D\\.?",
      "D\\.?\\s*O\\.?\\s*O\\.?",
      "T\\.?\\s*O\\.?\\s*V\\.?",
      "E\\.?\\s*P\\.?\\s*E\\.?",
      "I\\.?\\s*K\\.?\\s*E\\.?",
      "E\\.?\\s*P\\.?\\s*P\\.?",
      "M\\.?\\s*E\\.?\\s*I\\.?",
      "N\\.?\\s*y\\.?\\s*r\\.?\\s*t\\.?",
      "Z\\.?\\s*r\\.?\\s*t\\.?",
      "K\\.?\\s*f\\.?\\s*t\\.?",
      "A\\.?\\s*p\\.?\\s*S\\.?",
      "A\\.?\\s*N\\.?\\s*S\\.?",
      "A\\.?\\s*S\\.?\\s*A\\.?",
      "O\\.?\\s*y\\.?\\s*j\\.?",
      "S\\.?\\s*p\\.?\\s*k\\.?",
      "S\\.?\\s*p\\.?\\s*j\\.?",
      "d\\.?\\s*o\\.?\\s*o\\.?",
      "L\\.?\\s*d\\.?\\s*a\\.?",
      "U\\.?\\s*A\\.?\\s*B\\.?",
      "S\\.?\\s*I\\.?\\s*A\\.?",
      "Z\\.?\\s*A\\.?\\s*O\\.?",
      "L\\.?\\s*T\\.?\\s*D\\.?",
      "L\\.?\\s*L\\.?\\s*C\\.?",
      "L\\.?\\s*L\\.?\\s*P\\.?",
      "I\\.?\\s*N\\.?\\s*C\\.?",
      "P\\.?\\s*L\\.?\\s*C\\.?",
      "P\\.?\\s*T\\.?\\s*E\\.?",
      "P\\.?\\s*T\\.?\\s*Y\\.?",
      "L\\.?\\s*P\\.?",
      "A\\.?\\s*G\\.?",
      "K\\.?\\s*G\\.?",
      "U\\.?\\s*G\\.?",
      "O\\.?\\s*G\\.?",
      "G\\.?\\s*b\\.?\\s*R\\.?",
      "e\\.?\\s*V\\.?",
      "e\\.?\\s*K\\.?",
      "e\\.?\\s*G\\.?",
      "m\\.?\\s*b\\.?\\s*H\\.?",
      "B\\.?\\s*V\\.?",
      "N\\.?\\s*V\\.?",
      "C\\.?\\s*V\\.?",
      "A\\.?\\s*B\\.?",
      "H\\.?\\s*B\\.?",
      "K\\.?\\s*B\\.?",
      "O\\.?\\s*y\\.?",
      "A\\/S",
      "K\\/S",
      "I\\/S",
      "A\\.?\\s*S\\.?",
      "A\\.?\\s*O\\.?",
      "K\\.?\\s*K\\.?",
      "G\\.?\\s*K\\.?",
      "P\\.?\\s*v\\.?\\s*t\\.?",
      "B\\.?\\s*h\\.?\\s*d\\.?",
      "B\\.?\\s*t\\.?",
      "d\\.?\\s*d\\.?",
      "C\\.?\\s*o\\.?\\s*r\\.?\\s*p\\.?",
      "C\\.?\\s*C\\.?",
      "S[a\\u00e0]rl",
      "A\\.?\\s*\\u015e\\.?",
      "A\\.?\\s*D\\.?",
      "A\\.?\\s*E\\.?",
      "O\\.?\\s*E\\.?",
      "E\\.?\\s*E\\.?",
      "P\\.?\\s*P\\.?",
      "a\\.?\\s*s\\.?",
      "O[\\u00dc\\u00fc]|OU",
      "S\\.?\\s*E\\.?",
      "M\\.?\\s*B\\.?",
      "S\\.?\\s*A\\.?",
      "S\\.?\\s*L\\.?",
      "S\\.?\\s*C\\.?",
      "C\\.?\\s*A\\.?",
      "C\\.?\\s*O\\.?",
      "S\\.?\\s*S\\.?",
      "M\\.?\\s*E\\.?",
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
    if (!suffixRegex.test(candidate)) {
      const legalWithTrailingCountryCodeMatch = candidate.match(legalWithTrailingCountryCodeRegex);
      if (legalWithTrailingCountryCodeMatch?.[1] && legalWithTrailingCountryCodeMatch?.[2]) {
        candidate = `${legalWithTrailingCountryCodeMatch[1].trim()} ${legalWithTrailingCountryCodeMatch[2].trim()}`.trim();
      }
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
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
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * Parses an IPv4 or IPv6 address string into a BigInt + family pair.
   * Purpose: Shared low-level address parser used by CIDR + renumber helpers.
   * Necessity: The renumber workflow performs host-bit math on netixlan
   * addresses for both families; a single BigInt-backed parser avoids
   * pulling in an external library and keeps the script self-contained.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} text - Address literal (e.g. "185.0.1.50", "2001:db8::1").
   * @returns {{ family: 4|6, bigint: bigint }|null} Parsed value or null on
   *   malformed input.
   */
  function parseIp(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;

    if (raw.includes(":")) {
      // IPv6 — support `::` compression but not embedded IPv4 form.
      if (raw.indexOf("::") !== raw.lastIndexOf("::")) return null;
      const halves = raw.split("::");
      const left = halves[0] ? halves[0].split(":") : [];
      const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
      const explicit = left.length + right.length;
      if (halves.length === 1) {
        if (explicit !== 8) return null;
      } else if (explicit > 7) {
        return null;
      }
      const zeroCount = halves.length === 2 ? 8 - explicit : 0;
      const groups = [...left, ...Array(zeroCount).fill("0"), ...right];
      if (groups.length !== 8) return null;
      let value = 0n;
      for (const group of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
        value = (value << 16n) | BigInt(parseInt(group, 16));
      }
      return { family: 6, bigint: value };
    }

    const octets = raw.split(".");
    if (octets.length !== 4) return null;
    let value = 0n;
    for (const octet of octets) {
      if (!/^\d{1,3}$/.test(octet)) return null;
      const num = Number(octet);
      if (num < 0 || num > 255) return null;
      value = (value << 8n) | BigInt(num);
    }
    return { family: 4, bigint: value };
  }

  /**
   * Formats a family/BigInt address pair back into canonical string form.
   * Purpose: Produce stable on-screen + on-wire representations after host
   * arithmetic in replaceHostInPrefix().
   * Necessity: IPv6 in particular requires RFC 5952 lowercase compressed
   * form for parity with PeeringDB CP rendering.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {4|6} family - Address family.
   * @param {bigint} value - Numeric address.
   * @returns {string} Canonical address string, or empty string on invalid input.
   */
  function formatIp(family, value) {
    if (family === 4) {
      const octets = [];
      let remaining = value;
      for (let i = 0; i < 4; i += 1) {
        octets.unshift(String(Number(remaining & 0xffn)));
        remaining >>= 8n;
      }
      return octets.join(".");
    }
    if (family !== 6) return "";

    const groups = [];
    let remaining = value;
    for (let i = 0; i < 8; i += 1) {
      groups.unshift(Number(remaining & 0xffffn).toString(16));
      remaining >>= 16n;
    }
    // RFC 5952: collapse the longest run of all-zero groups (>=2) into "::".
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = 0; i < 8; i += 1) {
      if (groups[i] === "0") {
        if (curStart === -1) curStart = i;
        curLen += 1;
        if (curLen > bestLen) {
          bestLen = curLen;
          bestStart = curStart;
        }
      } else {
        curStart = -1;
        curLen = 0;
      }
    }
    if (bestLen < 2) return groups.join(":");
    const head = groups.slice(0, bestStart).join(":");
    const tail = groups.slice(bestStart + bestLen).join(":");
    return `${head}::${tail}`;
  }

  /**
   * Parses a CIDR literal (e.g. "185.0.1.0/24" or "2001:db8::/32") into
   * structured fields suitable for host-bit arithmetic.
   * Purpose: Foundation for the IXLAN peer renumber workflow.
   * Necessity: Renumbering preserves host bits across a prefix change, which
   * requires both the network base and a network mask as BigInts.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} text - CIDR literal.
   * @returns {{ family: 4|6, address: bigint, prefixLen: number,
   *             totalBits: number, networkMask: bigint, hostMask: bigint,
   *             network: bigint }|null} Parsed CIDR or null on malformed input.
   */
  function parseCidr(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const slashIdx = raw.indexOf("/");
    if (slashIdx === -1) return null;
    const addressPart = raw.slice(0, slashIdx);
    const prefixPart = raw.slice(slashIdx + 1);
    if (!/^\d+$/.test(prefixPart)) return null;
    const prefixLen = Number(prefixPart);
    const parsedAddress = parseIp(addressPart);
    if (!parsedAddress) return null;
    const totalBits = parsedAddress.family === 4 ? 32 : 128;
    if (prefixLen < 0 || prefixLen > totalBits) return null;
    const totalMask = (1n << BigInt(totalBits)) - 1n;
    const hostBitCount = BigInt(totalBits - prefixLen);
    const hostMask = hostBitCount === 0n ? 0n : (1n << hostBitCount) - 1n;
    const networkMask = totalMask ^ hostMask;
    const network = parsedAddress.bigint & networkMask;
    return {
      family: parsedAddress.family,
      address: parsedAddress.bigint,
      prefixLen,
      totalBits,
      networkMask,
      hostMask,
      network,
    };
  }

  /**
   * Computes the renumbered address for `ip` when its containing prefix
   * changes from `oldCidrText` to `newCidrText`, preserving host bits.
   * Purpose: Single point of truth for the IXLAN renumber math used by both
   * the dry-run preview and the apply loop.
   * Necessity: Host bits must remain stable across prefix changes (e.g.
   * 185.0.1.50/24 -> 185.1.184.50/23). The result also tells callers when
   * the host portion does not fit the new prefix (returns fits:false).
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} ipText - The current address to rewrite.
   * @param {string} oldCidrText - Source prefix in CIDR notation.
   * @param {string} newCidrText - Target prefix in CIDR notation.
   * @returns {{ fits: boolean, ip: string, reason?: string }} Rewritten
   *   address (when fits) plus diagnostic reason when not eligible.
   */
  function replaceHostInPrefix(ipText, oldCidrText, newCidrText) {
    const parsedIp = parseIp(ipText);
    if (!parsedIp) return { fits: false, ip: "", reason: "invalid-ip" };
    const oldCidr = parseCidr(oldCidrText);
    if (!oldCidr) return { fits: false, ip: "", reason: "invalid-old-cidr" };
    const newCidr = parseCidr(newCidrText);
    if (!newCidr) return { fits: false, ip: "", reason: "invalid-new-cidr" };
    if (parsedIp.family !== oldCidr.family || oldCidr.family !== newCidr.family) {
      return { fits: false, ip: "", reason: "family-mismatch" };
    }
    if ((parsedIp.bigint & oldCidr.networkMask) !== oldCidr.network) {
      return { fits: false, ip: "", reason: "ip-not-in-old-prefix" };
    }
    const hostBits = parsedIp.bigint & oldCidr.hostMask;
    // Host bits beyond the new prefix's host space cannot be preserved
    // verbatim — flag the row so the operator can decide how to handle it.
    if ((hostBits & newCidr.networkMask) !== 0n) {
      return { fits: false, ip: "", reason: "host-out-of-range" };
    }
    const newAddress = newCidr.network | hostBits;
    return { fits: true, ip: formatIp(newCidr.family, newAddress) };
  }

  // ── IXLAN Peer Renumber (helpers) ──────────────────────────────────────────
  // Helpers consumed by the CP-side renumber module. The module is gated on
  // a hash payload produced by the DP launcher (`#pdb-renumber=v1&...`); the
  // CP module is dormant on any networkixlan changelist that does not carry
  // a valid payload. All mutations go through pdbPost(PUT) with CSRF + audit
  // logging; no netixlan caching is used during enumerate/apply since rows
  // may flip status mid-flow.
  // -------------------------------------------------------------------------

  /**
   * Parses the renumber hash payload produced by the DP launcher.
   * Purpose: Single authoritative parser for the `#pdb-renumber=v1&...`
   * fragment; downstream code never touches `location.hash` directly.
   * Necessity: Hash payload is the contract between the DP and CP scripts;
   * keeping a strict parser guards against drift and rejects malformed or
   * spoofed fragments before any UI is built.
   * @ai Preserve URL hash schema; DP-side builder depends on these keys.
   * @param {string} hashText - Raw value of `location.hash` (with or
   *   without the leading "#").
   * @returns {{ old4: string, new4: string, old6: string, new6: string,
   *             ixlanId: string, ticketId: string, hasV4: boolean,
   *             hasV6: boolean }|null} Parsed payload or null when the
   *   hash does not carry a valid v1 renumber payload.
   */
  function parseRenumberHash(hashText) {
    const raw = String(hashText || "").replace(/^#/, "");
    if (!raw) return null;
    let params;
    try {
      params = new URLSearchParams(raw);
    } catch (_error) {
      return null;
    }
    if (params.get(IXLAN_RENUMBER_HASH_KEY) !== IXLAN_RENUMBER_HASH_VERSION) return null;
    const result = {
      old4: String(params.get("old4") || "").trim(),
      new4: String(params.get("new4") || "").trim(),
      old6: String(params.get("old6") || "").trim(),
      new6: String(params.get("new6") || "").trim(),
      ixlanId: String(params.get("ixlan") || "").trim(),
      ticketId: String(params.get("ticket") || "").trim(),
    };
    result.hasV4 = Boolean(result.old4 && result.new4);
    result.hasV6 = Boolean(result.old6 && result.new6);
    if (!result.hasV4 && !result.hasV6) return null;
    return result;
  }

  /**
   * Fetches netixlan rows potentially affected by a renumber payload.
   * Purpose: Enumerate the working set for the renumber modal.
   * Necessity: When the DP launcher supplies an ixlan id we can query
   * directly; without it we fall back to a startswith scan against the v4
   * (or v6) old prefix's address portion and the CP modal then groups by
   * `ixlan_id` for an operator selection step.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object} payload - Parsed renumber payload from parseRenumberHash().
   * @returns {Promise<{rows: object[], scanFilter: string, error: string}>}
   *   List of API rows plus the filter string used (for diagnostics) and an
   *   error code on failure ("" on success).
   */
  async function fetchRenumberAffectedRows(payload) {
    if (!payload) return { rows: [], conflictingIps4: [], conflictingIps6: [], scanFilter: "", error: "no-payload" };
    const filterParts = [];
    if (payload.ixlanId && /^\d+$/.test(payload.ixlanId)) {
      filterParts.push(`ixlan_id=${encodeURIComponent(payload.ixlanId)}`);
    } else if (payload.hasV4) {
      const v4Cidr = parseCidr(payload.old4);
      if (!v4Cidr || v4Cidr.family !== 4) return { rows: [], conflictingIps4: [], conflictingIps6: [], scanFilter: "", error: "bad-old4" };
      // Use the dotted address portion as a startswith filter; full
      // host-bit math runs later via replaceHostInPrefix().
      const networkText = formatIp(4, v4Cidr.network);
      const truncated = networkText.split(".").slice(0, Math.max(1, Math.floor(v4Cidr.prefixLen / 8))).join(".");
      filterParts.push(`ipaddr4__startswith=${encodeURIComponent(truncated + (truncated.split(".").length < 4 ? "." : ""))}`);
    } else if (payload.hasV6) {
      const v6Cidr = parseCidr(payload.old6);
      if (!v6Cidr || v6Cidr.family !== 6) return { rows: [], conflictingIps4: [], conflictingIps6: [], scanFilter: "", error: "bad-old6" };
      // Pick the longest hex prefix common to all addresses in the source
      // /N — keep it conservative so the server scan still narrows the set.
      const networkText = formatIp(6, v6Cidr.network);
      const colonSlice = networkText.split(":").slice(0, Math.max(1, Math.floor(v6Cidr.prefixLen / 16))).join(":");
      filterParts.push(`ipaddr6__startswith=${encodeURIComponent(colonSlice)}`);
    } else {
      return { rows: [], conflictingIps4: [], conflictingIps6: [], scanFilter: "", error: "empty-payload" };
    }
    const filterQuery = filterParts.join("&");
    const endpoint = `${PEERINGDB_API_BASE_URL}/netixlan?${filterQuery}&depth=0`;
    let rows = [];
    try {
      const data = await pdbFetch(endpoint);
      rows = Array.isArray(data?.data) ? data.data : [];
    } catch (_error) {
      return { rows: [], conflictingIps4: [], conflictingIps6: [], scanFilter: filterQuery, error: "fetch-failed" };
    }

    // Pre-flight conflict scan: fetch any netixlan globally already living
    // in the *new* prefix range so cross-ixlan or same-network duplicates
    // can be classified before apply. PeeringDB enforces uniqueness of an
    // IP across the whole netixlan table, so these would otherwise come
    // back as opaque HTTP 400 responses mid-apply.
    const conflictingIps4 = [];
    const conflictingIps6 = [];
    if (payload.hasV4) {
      try {
        const newCidr = parseCidr(payload.new4);
        if (newCidr && newCidr.family === 4) {
          const networkText = formatIp(4, newCidr.network);
          const truncated = networkText.split(".").slice(0, Math.max(1, Math.floor(newCidr.prefixLen / 8))).join(".");
          const newQuery = `ipaddr4__startswith=${encodeURIComponent(truncated + (truncated.split(".").length < 4 ? "." : ""))}`;
          const conflictData = await pdbFetch(`${PEERINGDB_API_BASE_URL}/netixlan?${newQuery}&depth=0`);
          const conflictRows = Array.isArray(conflictData?.data) ? conflictData.data : [];
          for (const r of conflictRows) {
            const ip = String(r.ipaddr4 || "").trim();
            if (ip) conflictingIps4.push(ip);
          }
        }
      } catch (_error) {
        // Best-effort; conflict-pre-flight failure should not block the modal.
      }
    }
    if (payload.hasV6) {
      try {
        const newCidr = parseCidr(payload.new6);
        if (newCidr && newCidr.family === 6) {
          const networkText = formatIp(6, newCidr.network);
          const colonSlice = networkText.split(":").slice(0, Math.max(1, Math.floor(newCidr.prefixLen / 16))).join(":");
          const newQuery = `ipaddr6__startswith=${encodeURIComponent(colonSlice)}`;
          const conflictData = await pdbFetch(`${PEERINGDB_API_BASE_URL}/netixlan?${newQuery}&depth=0`);
          const conflictRows = Array.isArray(conflictData?.data) ? conflictData.data : [];
          for (const r of conflictRows) {
            const ip = String(r.ipaddr6 || "").trim();
            if (ip) conflictingIps6.push(ip);
          }
        }
      } catch (_error) {
        // Best-effort; conflict-pre-flight failure should not block the modal.
      }
    }
    return { rows, conflictingIps4, conflictingIps6, scanFilter: filterQuery, error: "" };
  }

  /**
   * Classifies fetched netixlan rows against a renumber payload.
   * Purpose: Produce a per-row, per-family diagnostic the modal renders.
   * Necessity: Operators need to see which rows are eligible, skipped (no
   * change), out of host range, or conflicting before approving the apply
   * step. Classification is pure and re-run on every Dry run press.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {object[]} rows - netixlan rows from fetchRenumberAffectedRows().
   * @param {object} payload - Parsed renumber payload.
   * @returns {Array<{ row: object, v4: object|null, v6: object|null,
   *                   anyEligible: boolean }>} Classified per-row entries.
   */
  function classifyRenumberRows(rows, payload, options = {}) {
    const entries = [];
    const existingV4 = new Set(rows.map((r) => String(r.ipaddr4 || "").trim()).filter(Boolean));
    const existingV6 = new Set(rows.map((r) => String(r.ipaddr6 || "").trim()).filter(Boolean));
    for (const ip of (options.extraConflictIps4 || [])) existingV4.add(String(ip).trim());
    for (const ip of (options.extraConflictIps6 || [])) existingV6.add(String(ip).trim());
    for (const row of rows) {
      let v4 = null;
      if (payload.hasV4 && row.ipaddr4) {
        const result = replaceHostInPrefix(row.ipaddr4, payload.old4, payload.new4);
        if (result.fits) {
          if (result.ip === row.ipaddr4) {
            v4 = { status: "no-change", oldIp: row.ipaddr4, newIp: result.ip };
          } else if (existingV4.has(result.ip)) {
            v4 = { status: "conflict", oldIp: row.ipaddr4, newIp: result.ip };
          } else {
            v4 = { status: "eligible", oldIp: row.ipaddr4, newIp: result.ip };
          }
        } else if (result.reason === "ip-not-in-old-prefix") {
          v4 = null; // row is not in the source prefix; ignore v4 here
        } else {
          v4 = { status: "skip", oldIp: row.ipaddr4, newIp: "", reason: result.reason };
        }
      }
      let v6 = null;
      if (payload.hasV6 && row.ipaddr6) {
        const result = replaceHostInPrefix(row.ipaddr6, payload.old6, payload.new6);
        if (result.fits) {
          if (result.ip === row.ipaddr6) {
            v6 = { status: "no-change", oldIp: row.ipaddr6, newIp: result.ip };
          } else if (existingV6.has(result.ip)) {
            v6 = { status: "conflict", oldIp: row.ipaddr6, newIp: result.ip };
          } else {
            v6 = { status: "eligible", oldIp: row.ipaddr6, newIp: result.ip };
          }
        } else if (result.reason === "ip-not-in-old-prefix") {
          v6 = null;
        } else {
          v6 = { status: "skip", oldIp: row.ipaddr6, newIp: "", reason: result.reason };
        }
      }
      const anyEligible = (v4?.status === "eligible") || (v6?.status === "eligible");
      if (v4 || v6) entries.push({ row, v4, v6, anyEligible });
    }
    return entries;
  }

  /**
   * Persists a renumber audit entry to the dedicated audit log key.
   * Purpose: Keep a forensic record of every applied netixlan rewrite so
   * operators can manually revert if needed.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} entry - Audit entry payload.
   */
  function recordRenumberAuditEntry(entry) {
    const storage = getDomainCacheStorage();
    if (!storage) return;
    const item = {
      ts: new Date().toISOString(),
      ticketId: String(entry?.ticketId || "").trim(),
      ixlanId: String(entry?.ixlanId || "").trim(),
      payload: entry?.payload || null,
      rows: Array.isArray(entry?.rows) ? entry.rows : [],
      version: SCRIPT_VERSION,
    };
    try {
      const raw = String(storage.getItem(IXLAN_RENUMBER_AUDIT_LOG_STORAGE_KEY) || "").trim();
      const current = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(current) ? current : [];
      list.unshift(item);
      storage.setItem(
        IXLAN_RENUMBER_AUDIT_LOG_STORAGE_KEY,
        JSON.stringify(list.slice(0, IXLAN_RENUMBER_AUDIT_LOG_MAX_ITEMS)),
      );
      dbg("renumber-audit", "renumber outcome recorded", item);
    } catch (_error) {
      // Never let audit logging break the apply flow.
    }
  }

  /**
   * Strips read-only / server-managed fields from a netixlan row before
   * round-tripping it through a PUT request.
   * Purpose: Avoid sending derived metadata back to the API.
   * @ai Keep behavior stable and prefer minimal, localized edits.
   * @param {object} row - netixlan row as returned by the list endpoint.
   * @returns {object} Sanitized payload safe for PUT.
   */
  function buildNetixlanPutPayload(row) {
    const payload = { ...row };
    for (const key of ["id", "created", "updated", "_grainy_status", "status_dashboard_url"]) {
      delete payload[key];
    }
    // DRF rejects null on ipaddr4/ipaddr6 ("This field may not be null."),
    // but the list endpoint serializes empty addresses as null. Normalize
    // back to empty strings so a v4-only or v6-only row round-trips cleanly.
    if (payload.ipaddr4 === null || payload.ipaddr4 === undefined) payload.ipaddr4 = "";
    if (payload.ipaddr6 === null || payload.ipaddr6 === undefined) payload.ipaddr6 = "";
    return payload;
  }

  /**
   * Extracts a human-readable error detail from a pdbPost result.
   * Purpose: Surface PeeringDB's per-field DRF validation messages (which
   * are how the 400 "IP already exists" responses come back) instead of
   * the opaque "http-error" placeholder.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object} result - Return value of pdbPost().
   * @returns {string} Compact, single-line error detail string.
   */
  function extractRenumberApiErrorDetail(result) {
    if (!result) return "http-error";
    if (result.reason) return String(result.reason);
    const data = result.data;
    if (data && typeof data === "object") {
      if (typeof data.detail === "string") return data.detail;
      const fieldParts = [];
      for (const [field, value] of Object.entries(data)) {
        if (field === "meta") continue;
        const text = Array.isArray(value) ? value.join("; ") : (typeof value === "string" ? value : JSON.stringify(value));
        fieldParts.push(`${field}: ${text}`);
      }
      if (fieldParts.length) return fieldParts.join(" | ").slice(0, 240);
    }
    const raw = String(result.rawBody || "").trim();
    if (raw) return raw.slice(0, 240);
    return `http-${result.status || "error"}`;
  }

  /**
   * Applies a renumber plan by issuing one PUT per selected family per row.
   * Purpose: Sequential apply loop with per-row status reporting and an
   * external cancel signal so the modal can abort mid-flight.
   * Necessity: PeeringDB API rejects PATCH; updates must round-trip the
   * full record. Sequential issue keeps server pressure low and respects
   * the API's per-key rate limit.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object[]} entries - Selected classified entries to apply.
   * @param {{ cancelled: boolean }} signal - Cancel flag flipped by UI.
   * @param {Function} onProgress - Invoked per row with status updates.
   * @returns {Promise<object[]>} Apply outcomes for the audit log.
   */
  async function applyRenumberRows(entries, signal, onProgress) {
    const outcomes = [];
    for (const entry of entries) {
      if (signal?.cancelled) {
        outcomes.push({ netixlanId: entry.row.id, asn: entry.row.asn, status: "cancelled" });
        continue;
      }
      const payload = buildNetixlanPutPayload(entry.row);
      if (entry.v4Selected && entry.v4?.status === "eligible") payload.ipaddr4 = entry.v4.newIp;
      if (entry.v6Selected && entry.v6?.status === "eligible") payload.ipaddr6 = entry.v6.newIp;
      const url = `${PEERINGDB_API_BASE_URL}/netixlan/${entry.row.id}`;
      onProgress?.(entry, { status: "in-flight" });
      const result = await pdbPost(url, "PUT", payload, { contentType: "application/json", retries: 1 });
      const ok = Number(result?.status || 0) >= 200 && Number(result?.status || 0) < 300;
      const outcome = {
        netixlanId: entry.row.id,
        asn: entry.row.asn,
        oldIp4: entry.row.ipaddr4 || "",
        newIp4: payload.ipaddr4 || "",
        oldIp6: entry.row.ipaddr6 || "",
        newIp6: payload.ipaddr6 || "",
        status: ok ? "done" : "error",
        httpStatus: Number(result?.status || 0),
        error: ok ? "" : extractRenumberApiErrorDetail(result),
      };
      outcomes.push(outcome);
      onProgress?.(entry, outcome);
      if (IXLAN_RENUMBER_APPLY_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, IXLAN_RENUMBER_APPLY_DELAY_MS));
      }
    }
    return outcomes;
  }

  /**
   * Builds and shows the renumber modal for a parsed payload.
   * Purpose: Top-level UI entry point invoked from the toolbar button.
   * Necessity: Centralizes Dry run + Apply orchestration so the toolbar
   * button stays a one-liner and dispose() is straightforward.
   * @ai Preserve menu command registration behavior and gating on feature flag.
   * @param {object} payload - Parsed renumber payload.
   */
  async function openIxlanRenumberModal(payload) {
    const BACKDROP_ID = `${MODULE_PREFIX}RenumberBackdrop`;
    document.getElementById(BACKDROP_ID)?.remove();

    const backdrop = document.createElement("div");
    backdrop.id = BACKDROP_ID;
    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.45)",
      zIndex: "2147483646", display: "flex", alignItems: "center",
      justifyContent: "center",
    });
    const modal = document.createElement("div");
    Object.assign(modal.style, {
      background: "#fff", color: "#111", padding: "16px 20px",
      borderRadius: "8px", width: "min(960px, 96vw)", maxWidth: "96vw",
      maxHeight: "92vh", display: "flex", flexDirection: "column",
      boxSizing: "border-box", minHeight: "0", minWidth: "0",
      boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
      font: "13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif",
    });
    const header = document.createElement("h2");
    header.textContent = `Renumber IXLAN Peers — ticket #${payload.ticketId || "?"}`;
    Object.assign(header.style, { margin: "0 0 6px", fontSize: "16px" });
    modal.appendChild(header);

    const summary = document.createElement("div");
    Object.assign(summary.style, { fontSize: "12px", color: "#444", marginBottom: "10px" });
    const summaryParts = [];
    if (payload.hasV4) summaryParts.push(`IPv4 ${payload.old4} → ${payload.new4}`);
    if (payload.hasV6) summaryParts.push(`IPv6 ${payload.old6} → ${payload.new6}`);
    if (payload.ixlanId) summaryParts.push(`ixlan #${payload.ixlanId}`);
    summary.textContent = summaryParts.join("  •  ");
    modal.appendChild(summary);

    const status = document.createElement("div");
    Object.assign(status.style, { fontSize: "12px", color: "#666", marginBottom: "8px" });
    status.textContent = "Loading affected rows…";
    modal.appendChild(status);

    // Top-of-modal conflict banner — primary, impossible-to-miss entry
    // into the conflict resolver. Cannot be clipped by viewport height
    // or flex-row overflow because it sits above the scrollable table.
    const conflictsBanner = document.createElement("div");
    Object.assign(conflictsBanner.style, {
      display: "none", alignItems: "center", justifyContent: "space-between", gap: "12px",
      flexWrap: "wrap", rowGap: "8px",
      background: "#fef2f2", border: "1px solid #fecaca", color: "#7f1d1d",
      borderRadius: "6px", padding: "10px 12px", marginBottom: "10px", fontSize: "13px",
    });
    const conflictsBannerText = document.createElement("div");
    Object.assign(conflictsBannerText.style, { flex: "1 1 420px", minWidth: "220px" });

    const shapeActionIconBtn = (btn) => {
      Object.assign(btn.style, {
        width: "34px", minWidth: "34px", height: "34px", padding: "0",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: "16px", lineHeight: "1", fontWeight: "700",
        margin: "0", flex: "0 0 34px", boxSizing: "border-box",
      });
    };
    const setActionIconLabel = (btn, icon, label) => {
      btn.textContent = icon;
      btn.title = label;
      btn.setAttribute("aria-label", label);
    };

    const conflictsBannerBtn = document.createElement("button");
    conflictsBannerBtn.type = "button";
    Object.assign(conflictsBannerBtn.style, {
      border: "0", background: "#b91c1c", color: "#fff",
      borderRadius: "5px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: "0", marginLeft: "auto",
    });
    shapeActionIconBtn(conflictsBannerBtn);
    setActionIconLabel(conflictsBannerBtn, "\u26a0", "Resolve conflicts");
    conflictsBanner.append(conflictsBannerText, conflictsBannerBtn);
    modal.appendChild(conflictsBanner);

    const tableWrap = document.createElement("div");
    // No fixed maxHeight: tableWrap is `flex: 1 1 auto` inside a column
    // flex parent capped at 92vh, so it shrinks first to keep the
    // sticky button row below visible on any viewport.
    Object.assign(tableWrap.style, { overflow: "auto", flex: "1 1 auto", minHeight: "0", minWidth: "0", width: "100%", border: "1px solid #ddd", borderRadius: "4px", marginBottom: "10px" });
    const table = document.createElement("table");
    Object.assign(table.style, { width: "100%", borderCollapse: "collapse", fontSize: "12px" });
    tableWrap.appendChild(table);
    modal.appendChild(tableWrap);

    // Sticky bottom button row — right-start icon strip with fixed offsets.
    const buttons = document.createElement("div");
    Object.assign(buttons.style, {
      display: "flex", flexDirection: "row-reverse", justifyContent: "flex-start", alignItems: "center",
      gap: "10px", flexShrink: "0", flexWrap: "wrap", rowGap: "10px", width: "100%", minWidth: "0",
      position: "sticky", bottom: "0", background: "#fff",
      paddingTop: "10px", borderTop: "1px solid #eee", marginTop: "auto",
    });
    // Desktop-only strict single-line variant, left-to-right with fixed spacing.
    if (window.matchMedia("(min-width: 1024px)").matches) {
      Object.assign(buttons.style, { flexWrap: "nowrap", rowGap: "0", overflowX: "auto", overflowY: "hidden" });
    }
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    Object.assign(closeBtn.style, { border: "1px solid #bbb", background: "#f5f5f5", borderRadius: "5px", cursor: "pointer" });
    shapeActionIconBtn(closeBtn);
    setActionIconLabel(closeBtn, "\u2715", "Close");
    const dryBtn = document.createElement("button");
    dryBtn.type = "button";
    Object.assign(dryBtn.style, { border: "1px solid #bbb", background: "#eef", borderRadius: "5px", cursor: "pointer" });
    shapeActionIconBtn(dryBtn);
    setActionIconLabel(dryBtn, "\u2697", "Dry run (re-classify)");
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    Object.assign(applyBtn.style, { border: "0", background: "#1a73e8", color: "#fff", borderRadius: "5px", cursor: "pointer" });
    shapeActionIconBtn(applyBtn);
    setActionIconLabel(applyBtn, "\u2713", "Apply");
    const cancelApplyBtn = document.createElement("button");
    cancelApplyBtn.type = "button";
    Object.assign(cancelApplyBtn.style, { border: "1px solid #d93025", background: "#fff", color: "#d93025", borderRadius: "5px", cursor: "pointer", display: "none" });
    shapeActionIconBtn(cancelApplyBtn);
    setActionIconLabel(cancelApplyBtn, "\u25a0", "Cancel apply");
    // Bottom-row resolve button is a secondary entry point. The primary
    // (impossible-to-miss) entry is the top banner above.
    const resolveConflictsBtn = document.createElement("button");
    resolveConflictsBtn.type = "button";
    Object.assign(resolveConflictsBtn.style, { border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", borderRadius: "5px", cursor: "pointer", display: "none" });
    shapeActionIconBtn(resolveConflictsBtn);
    setActionIconLabel(resolveConflictsBtn, "\u26a0", "Resolve conflicts");
    const recentChangesBtn = document.createElement("button");
    recentChangesBtn.type = "button";
    Object.assign(recentChangesBtn.style, { border: "1px solid #bbb", background: "#f5f5f5", borderRadius: "5px", cursor: "pointer" });
    shapeActionIconBtn(recentChangesBtn);
    setActionIconLabel(recentChangesBtn, "\u23f2", `Recent IP changes (\u2264${RECENT_IP_CHANGES_WINDOW_MIN}m)`);
    // Right-start fixed-offset strip (icons), then flow leftward.
    buttons.append(applyBtn, cancelApplyBtn, resolveConflictsBtn, recentChangesBtn, dryBtn, closeBtn);
    modal.appendChild(buttons);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    /**
     * Removes the modal from the DOM.
     */
    function close() { backdrop.remove(); }
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) close(); });

    let entries = [];
    let cancelSignal = { cancelled: false };
    let selectedIxlanId = payload.ixlanId;

    /**
     * Renders the entry table; recomputes selection checkboxes.
     */
    function render() {
      table.textContent = "";
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      for (const label of ["✓v4", "✓v6", "ASN", "ixlan", "IPv4 (old → new)", "IPv6 (old → new)", "Status"]) {
        const th = document.createElement("th");
        th.textContent = label;
        Object.assign(th.style, { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #ccc", background: "#fafafa", position: "sticky", top: "0" });
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const entry of entries) {
        const tr = document.createElement("tr");
        tr.dataset.entryRow = String(entry.row.id);
        const td = (text) => { const cell = document.createElement("td"); cell.textContent = String(text); Object.assign(cell.style, { padding: "5px 8px", borderBottom: "1px solid #eee", verticalAlign: "top" }); return cell; };

        const v4Cell = document.createElement("td");
        Object.assign(v4Cell.style, { padding: "5px 8px", borderBottom: "1px solid #eee", textAlign: "center" });
        if (entry.v4?.status === "eligible") {
          const cb = document.createElement("input");
          cb.type = "checkbox"; cb.checked = entry.v4Selected !== false;
          cb.addEventListener("change", () => { entry.v4Selected = cb.checked; });
          v4Cell.appendChild(cb);
        }
        const v6Cell = document.createElement("td");
        Object.assign(v6Cell.style, { padding: "5px 8px", borderBottom: "1px solid #eee", textAlign: "center" });
        if (entry.v6?.status === "eligible") {
          const cb = document.createElement("input");
          cb.type = "checkbox"; cb.checked = entry.v6Selected !== false;
          cb.addEventListener("change", () => { entry.v6Selected = cb.checked; });
          v6Cell.appendChild(cb);
        }

        const v4Text = entry.v4 ? (entry.v4.newIp ? `${entry.v4.oldIp} → ${entry.v4.newIp}` : `${entry.v4.oldIp} (${entry.v4.reason || entry.v4.status})`) : "";
        const v6Text = entry.v6 ? (entry.v6.newIp ? `${entry.v6.oldIp} → ${entry.v6.newIp}` : `${entry.v6.oldIp} (${entry.v6.reason || entry.v6.status})`) : "";
        const statusText = entry.applyStatus || (entry.v4?.status === "eligible" || entry.v6?.status === "eligible" ? "ready" : (entry.v4?.status || entry.v6?.status || ""));

        tr.append(v4Cell, v6Cell, td(entry.row.asn || ""), td(entry.row.ixlan_id || ""), td(v4Text), td(v6Text), td(statusText));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    /**
     * Issues the fetch + classify pipeline; supports re-runs.
     */
    async function refresh() {
      status.textContent = "Loading affected rows…";
      const queryPayload = { ...payload, ixlanId: selectedIxlanId };
      const { rows, conflictingIps4, conflictingIps6, error, scanFilter } = await fetchRenumberAffectedRows(queryPayload);
      if (error) {
        status.textContent = `Fetch failed: ${error} (filter: ${scanFilter})`;
        return;
      }
      // Group by ixlan_id when no ixlan id was provided and more than one was returned.
      if (!selectedIxlanId) {
        const ixlanIds = Array.from(new Set(rows.map((r) => String(r.ixlan_id)).filter(Boolean)));
        if (ixlanIds.length > 1) {
          status.textContent = "";
          const prompt = document.createElement("div");
          prompt.textContent = `Multiple ixlans matched (${ixlanIds.length}). Pick one to continue:`;
          status.appendChild(prompt);
          const select = document.createElement("select");
          Object.assign(select.style, { marginLeft: "8px" });
          for (const id of ixlanIds) {
            const opt = document.createElement("option"); opt.value = id; opt.textContent = `ixlan #${id} (${rows.filter((r) => String(r.ixlan_id) === id).length} rows)`;
            select.appendChild(opt);
          }
          const pickBtn = document.createElement("button");
          pickBtn.type = "button"; pickBtn.textContent = "Use this ixlan";
          Object.assign(pickBtn.style, { marginLeft: "8px", padding: "3px 10px" });
          pickBtn.addEventListener("click", () => { selectedIxlanId = select.value; refresh(); });
          status.appendChild(select);
          status.appendChild(pickBtn);
          entries = [];
          render();
          return;
        }
        if (ixlanIds.length === 1) selectedIxlanId = ixlanIds[0];
      }
      entries = classifyRenumberRows(rows, queryPayload, { extraConflictIps4: conflictingIps4, extraConflictIps6: conflictingIps6 }).map((e) => ({ ...e, v4Selected: e.v4?.status === "eligible", v6Selected: e.v6?.status === "eligible", applyStatus: "" }));
      const counts = entries.reduce((acc, e) => {
        if (e.v4?.status === "eligible") acc.v4Eligible += 1;
        else if (e.v4?.status === "conflict") acc.conflicts += 1;
        if (e.v6?.status === "eligible") acc.v6Eligible += 1;
        else if (e.v6?.status === "conflict") acc.conflicts += 1;
        return acc;
      }, { v4Eligible: 0, v6Eligible: 0, conflicts: 0 });
      status.textContent = `ixlan #${selectedIxlanId || "?"} — ${entries.length} affected rows • v4 eligible: ${counts.v4Eligible} • v6 eligible: ${counts.v6Eligible} • conflicts: ${counts.conflicts}`;
      updateResolveConflictsButton();
      render();
    }

    /**
     * Updates the "Resolve conflicts (N)" button label and visibility based
     * on the current entries' conflict status. Mirrors state into the
     * top-of-modal banner so the operator always has a visible entry.
     */
    function updateResolveConflictsButton() {
      if (!isFeatureEnabled("conflictResolver")) {
        resolveConflictsBtn.style.display = "none";
        conflictsBanner.style.display = "none";
        return;
      }
      const conflictItems = collectConflictItemsFromEntries(entries);
      const n = conflictItems.length;
      resolveConflictsBtn.title = `Resolve conflicts (${n})`;
      resolveConflictsBtn.setAttribute("aria-label", `Resolve conflicts (${n})`);
      resolveConflictsBtn.style.display = n > 0 ? "" : "none";
      resolveConflictsBtn.disabled = n === 0;
      if (n > 0) {
        conflictsBanner.style.display = "flex";
        conflictsBannerText.textContent = `${n} row${n === 1 ? "" : "s"} have IP conflicts that block Apply. Resolve them first to absorb the doomed rows into the existing keepers.`;
        conflictsBannerBtn.title = `Resolve conflicts (${n})`;
        conflictsBannerBtn.setAttribute("aria-label", `Resolve conflicts (${n})`);
      } else {
        conflictsBanner.style.display = "none";
      }
    }

    resolveConflictsBtn.addEventListener("click", () => {
      const conflictItems = collectConflictItemsFromEntries(entries);
      if (conflictItems.length === 0) return;
      if (!selectedIxlanId) { status.textContent = "Select an ixlan first."; return; }
      openConflictResolverModal({
        ixlanId: String(selectedIxlanId),
        ticketId: payload.ticketId || "",
        payload,
        conflictItems,
      });
    });
    conflictsBannerBtn.addEventListener("click", () => resolveConflictsBtn.click());

    recentChangesBtn.addEventListener("click", () => {
      if (!isFeatureEnabled("recentIpChanges")) { status.textContent = "Recent IP changes feature is disabled."; return; }
      if (!selectedIxlanId) { status.textContent = "Select an ixlan first."; return; }
      openRecentIpChangesModal(String(selectedIxlanId));
    });

    dryBtn.addEventListener("click", () => { refresh(); });
    applyBtn.addEventListener("click", async () => {
      const selected = entries.filter((e) =>
        (e.v4Selected && e.v4?.status === "eligible") || (e.v6Selected && e.v6?.status === "eligible"),
      );
      if (selected.length === 0) {
        status.textContent = "Nothing selected to apply.";
        return;
      }
      const v4Count = selected.filter((e) => e.v4Selected && e.v4?.status === "eligible").length;
      const v6Count = selected.filter((e) => e.v6Selected && e.v6?.status === "eligible").length;
      const confirmed = window.confirm(
        `Apply ${selected.length} netixlan update(s)?\n` +
        `  IPv4 rewrites: ${v4Count}\n` +
        `  IPv6 rewrites: ${v6Count}\n` +
        `  ixlan: #${selectedIxlanId || "?"}\n` +
        `Press OK to proceed; updates run sequentially and may be cancelled mid-flight.`,
      );
      if (!confirmed) return;
      applyBtn.disabled = true; dryBtn.disabled = true;
      cancelApplyBtn.style.display = ""; cancelSignal = { cancelled: false };
      cancelApplyBtn.onclick = () => { cancelSignal.cancelled = true; };
      const outcomes = await applyRenumberRows(selected, cancelSignal, (entry, update) => {
        entry.applyStatus = update.status === "in-flight" ? "applying…" : `${update.status}${update.httpStatus ? ` (${update.httpStatus})` : ""}${update.error ? ` — ${update.error}` : ""}`;
        render();
      });
      recordRenumberAuditEntry({ ticketId: payload.ticketId, ixlanId: selectedIxlanId, payload, rows: outcomes });
      applyBtn.disabled = false; dryBtn.disabled = false; cancelApplyBtn.style.display = "none";
      const okCount = outcomes.filter((o) => o.status === "done").length;
      const errCount = outcomes.filter((o) => o.status === "error").length;
      status.textContent = `Apply complete — ok:${okCount} error:${errCount} cancelled:${outcomes.filter((o) => o.status === "cancelled").length}`;
      // Promote 400 "already exists" errors into conflict items so the
      // "Resolve conflicts (N)" button picks them up — they were eligible
      // at Dry-run time but a keeper appeared between Dry-run and Apply.
      for (const outcome of outcomes) {
        if (outcome.status !== "error") continue;
        const httpStatus = Number(outcome.httpStatus || 0);
        if (httpStatus !== 400) continue;
        const detail = String(outcome.error || "").toLowerCase();
        const looksLikeDup = detail.includes("already exists") || detail.includes("unique") || detail.includes("already been taken");
        if (!looksLikeDup) continue;
        const entry = entries.find((e) => String(e.row.id) === String(outcome.netixlanId));
        if (!entry) continue;
        if (outcome.newIp4 && entry.v4?.status === "eligible") entry.v4 = { status: "conflict", oldIp: outcome.oldIp4, newIp: outcome.newIp4 };
        if (outcome.newIp6 && entry.v6?.status === "eligible") entry.v6 = { status: "conflict", oldIp: outcome.oldIp6, newIp: outcome.newIp6 };
      }
      updateResolveConflictsButton();
    });

    await refresh();
  }

  // ── IX-F Member Audit (helpers) ────────────────────────────────────────────
  // Compares a PeeringDB ixlan's current netixlan rows against the upstream
  // IX-F JSON export (ixf_ixp_member_list_url) and proposes merges of split
  // v4-only / v6-only netixlan rows that the IX-F member-export confirms
  // belong to the same ASN. The keeper is always the older (lower-id) row;
  // its sibling is DELETEd after the keeper is PUT with both addresses.
  // All mutations run sequentially with an inflight cancel signal and are
  // captured in a dedicated audit log.
  // -------------------------------------------------------------------------

  /**
   * Reads the ixlan filter from a Django changelist URL.
   * Purpose: Detect when the operator has scoped the netixlan changelist to
   * a single ixlan so the module can derive ixlanId without prompting.
   * Necessity: The IX-F audit is scoped to one ixlan at a time; running
   * unscoped would be expensive and ambiguous.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} href - URL to inspect (defaults to current location).
   * @returns {string} Numeric ixlan id, or "" when no single-ixlan filter is set.
   */
  function parseIxlanFilterFromChangelistUrl(href) {
    try {
      const url = new URL(String(href || window.location.href), window.location.origin);
      const candidateKeys = ["ixlan__id__exact", "ixlan__exact", "ixlan_id__exact", "ixlan_id", "ixlan"];
      for (const key of candidateKeys) {
        const value = String(url.searchParams.get(key) || "").trim();
        if (value && /^\d+$/.test(value)) return value;
      }
    } catch (_error) {
      // Ignore URL parse errors; caller will prompt for the ixlan id.
    }
    return "";
  }

  /**
   * Fetches an ixlan record and returns its IX-F member-list URL.
   * Purpose: Centralize the "does this ixlan publish IX-F?" check.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} ixlanId - Numeric ixlan id.
   * @returns {Promise<{ ixfUrl: string, ixlan: object|null, error: string }>}
   */
  async function fetchIxlanIxfMemberListUrl(ixlanId) {
    if (!/^\d+$/.test(String(ixlanId || ""))) return { ixfUrl: "", ixlan: null, error: "bad-ixlan-id" };
    try {
      const endpoint = `${PEERINGDB_API_BASE_URL}/ixlan/${ixlanId}?depth=0`;
      const data = await pdbFetch(endpoint);
      const ixlan = Array.isArray(data?.data) ? data.data[0] : null;
      if (!ixlan) return { ixfUrl: "", ixlan: null, error: "ixlan-not-found" };
      const ixfUrl = String(ixlan.ixf_ixp_member_list_url || "").trim();
      if (!ixfUrl) return { ixfUrl: "", ixlan, error: "no-ixf-url" };
      return { ixfUrl, ixlan, error: "" };
    } catch (_error) {
      return { ixfUrl: "", ixlan: null, error: "fetch-failed" };
    }
  }

  /**
   * Cross-origin GET of an IX-F member-export JSON document.
   * Purpose: Retrieve the upstream IX-F data via GM_xmlhttpRequest because
   * the IX portal hostname is not same-origin with PeeringDB.
   * Necessity: pdbFetch uses fetch() which is blocked by CORS for arbitrary
   * IX portals; we need the userscript-grant code path.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} ixfUrl - The IX-F export URL.
   * @returns {Promise<{ data: object|null, status: number, error: string }>}
   */
  function fetchIxfMemberExport(ixfUrl) {
    return new Promise((resolve) => {
      let urlString = "";
      try { urlString = new URL(ixfUrl).toString(); } catch (_error) { resolve({ data: null, status: 0, error: "bad-url" }); return; }
      logExternalRequestUserAgent({ method: "GET", url: urlString, headers: {}, attempt: 1, retries: 1, mode: "cross-origin-ixf" });
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url: urlString,
          headers: { Accept: "application/json" },
          timeout: IXF_FETCH_TIMEOUT_MS,
          anonymous: true,
          onload: (response) => {
            const status = Number(response?.status || 0);
            const raw = String(response?.responseText || "");
            let data = null;
            try { data = JSON.parse(raw); } catch (_err) { resolve({ data: null, status, error: "parse-failed" }); return; }
            if (status >= 200 && status < 300) {
              resolve({ data, status, error: "" });
            } else {
              resolve({ data, status, error: `http-${status}` });
            }
          },
          onerror: () => resolve({ data: null, status: 0, error: "network-error" }),
          ontimeout: () => resolve({ data: null, status: 0, error: "timeout" }),
        });
      } catch (_error) {
        resolve({ data: null, status: 0, error: "request-failed" });
      }
    });
  }

  /**
   * Normalizes an IPv6 string for comparison (lowercase, compressed).
   * Purpose: PDB rows and IX-F exports may differ in v6 spelling
   * (e.g. "2001:DB8::1" vs "2001:db8:0:0:0:0:0:1") even though they
   * refer to the same address.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} ip - IPv6 string (or empty).
   * @returns {string} Canonical lowercase compressed form, or "" on error.
   */
  function normalizeIpv6ForCompare(ip) {
    const text = String(ip || "").trim();
    if (!text) return "";
    try {
      const parsed = parseIp(text);
      if (!parsed || parsed.family !== 6) return text.toLowerCase();
      return formatIp(6, parsed.bigint);
    } catch (_error) {
      return text.toLowerCase();
    }
  }

  /**
   * Builds an ASN-keyed map of (ipv4, ipv6) pairs from an IX-F export.
   * Purpose: Surface the IX-F "this ASN has this v4 alongside this v6 on
   * a single vlan/connection" relationship that the audit needs to confirm
   * a merge is safe.
   * Necessity: IX-F treats v4 and v6 as fields of one vlan entry; PeeringDB
   * historically allows them as separate netixlan rows, which is the
   * mismatch this module is built to reconcile.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {object} ixfData - Parsed IX-F member-export JSON (v0.x or v1.x).
   * @returns {Map<string, Array<{v4: string, v6: string, v6Norm: string, ixpId: string|number}>>}
   */
  function extractIxfAsnIpPairs(ixfData) {
    const map = new Map();
    const memberList = Array.isArray(ixfData?.member_list) ? ixfData.member_list : [];
    for (const member of memberList) {
      const asn = String(member?.asnum ?? member?.asn ?? "").trim();
      if (!asn) continue;
      const connections = Array.isArray(member?.connection_list) ? member.connection_list : [];
      for (const connection of connections) {
        const ixpId = connection?.ixp_id ?? "";
        const vlanList = Array.isArray(connection?.vlan_list) ? connection.vlan_list : [];
        for (const vlan of vlanList) {
          const v4 = String(vlan?.ipv4?.address || "").trim();
          const v6 = String(vlan?.ipv6?.address || "").trim();
          if (!v4 && !v6) continue;
          const entry = { v4, v6, v6Norm: normalizeIpv6ForCompare(v6), ixpId };
          if (!map.has(asn)) map.set(asn, []);
          map.get(asn).push(entry);
        }
      }
    }
    return map;
  }

  /**
   * Identifies merge candidates from PDB rows and IX-F pairs.
   * Purpose: Given the ixlan's PDB netixlan rows grouped by ASN plus the
   * IX-F (v4, v6) pair list also by ASN, find pairs where PDB has the
   * data split across two rows that IX-F asserts belong together.
   * Necessity: Eliminates manual cross-referencing.
   *
   * Two shapes are recognized:
   *  • "split"      — one row v4-only, the other v6-only; IX-F confirms
   *                   they belong to the same member. Merge into the
   *                   lower-id row, DELETE the other.
   *  • "stale-dual" — one row v4-only with v4 == IX-F.v4 (the fresh
   *                   keeper, typically created by a recent renumber),
   *                   the other row carries BOTH a non-IX-F v4 (stale,
   *                   usually still in the renumber-source prefix) AND
   *                   a v6 that matches IX-F.v6. We absorb the stale
   *                   row's v6 into the v4-only keeper and DELETE the
   *                   stale dual row. Discovered via operator report
   *                   (ixlan #3990, AS211750) where the pair otherwise
   *                   slipped through the audit silently.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {object[]} rows - netixlan rows for the ixlan.
   * @param {Map<string, Array<{v4: string, v6: string, v6Norm: string}>>} ixfMap
   * @returns {Array<{ asn: string, keeperRow: object, otherRow: object,
   *                   ipv4: string, ipv6: string, ixfEntry: object,
   *                   shape: "split"|"stale-dual" }>}
   */
  function findIxfMergeCandidates(rows, ixfMap) {
    const candidates = [];
    const byAsn = new Map();
    for (const row of rows) {
      const asn = String(row.asn || "").trim();
      if (!asn) continue;
      if (!byAsn.has(asn)) byAsn.set(asn, []);
      byAsn.get(asn).push(row);
    }
    for (const [asn, asnRows] of byAsn.entries()) {
      if (asnRows.length !== 2) continue;
      const ixfEntries = ixfMap.get(asn) || [];
      if (ixfEntries.length === 0) continue;

      // Shape 1 — clean v4-only + v6-only split.
      const v4Only = asnRows.find((r) => String(r.ipaddr4 || "").trim() && !String(r.ipaddr6 || "").trim());
      const v6Only = asnRows.find((r) => !String(r.ipaddr4 || "").trim() && String(r.ipaddr6 || "").trim());
      if (v4Only && v6Only && v4Only !== v6Only) {
        const v4Text = String(v4Only.ipaddr4 || "").trim();
        const v6Text = String(v6Only.ipaddr6 || "").trim();
        const v6Norm = normalizeIpv6ForCompare(v6Text);
        const ixfMatch = ixfEntries.find((entry) => entry.v4 === v4Text && entry.v6Norm === v6Norm);
        if (ixfMatch) {
          const keeperRow = Number(v4Only.id) <= Number(v6Only.id) ? v4Only : v6Only;
          const otherRow = keeperRow === v4Only ? v6Only : v4Only;
          candidates.push({ asn, keeperRow, otherRow, ipv4: v4Text, ipv6: v6Text, ixfEntry: ixfMatch, shape: "split" });
          continue;
        }
      }

      // Shape 2 — v4-only fresh keeper + v4+v6 stale doomed.
      // Required: the v4-only row's v4 matches IX-F.v4, AND the dual row
      // carries v6 == IX-F.v6 but v4 != IX-F.v4 (i.e. the stale v4 is
      // not what IX-F asserts — usually because a renumber created the
      // v4-only keeper and the operator did not delete the old row).
      // We DO NOT match shape 2 when the dual row's v4 already equals
      // IX-F.v4 — that would mean two rows claim the same v4 and the
      // safer Renumber/Conflict-resolver path should handle it instead.
      const v4OnlyRow = v4Only;
      const dualRow = asnRows.find((r) => String(r.ipaddr4 || "").trim() && String(r.ipaddr6 || "").trim());
      if (v4OnlyRow && dualRow && v4OnlyRow !== dualRow) {
        const keeperV4 = String(v4OnlyRow.ipaddr4 || "").trim();
        const staleV4 = String(dualRow.ipaddr4 || "").trim();
        const staleV6 = String(dualRow.ipaddr6 || "").trim();
        const staleV6Norm = normalizeIpv6ForCompare(staleV6);
        const ixfMatch = ixfEntries.find((entry) =>
          entry.v4 === keeperV4 &&
          entry.v6Norm === staleV6Norm &&
          entry.v4 !== staleV4,
        );
        if (ixfMatch) {
          candidates.push({
            asn,
            keeperRow: v4OnlyRow,
            otherRow: dualRow,
            ipv4: keeperV4,
            ipv6: staleV6,
            ixfEntry: ixfMatch,
            shape: "stale-dual",
          });
          continue;
        }
      }
    }
    return candidates;
  }

  /**
   * Persists an IX-F merge audit entry.
   * Purpose: Forensic record of every merge so operators can manually undo
   * if the IX-F export turns out to have been wrong.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} entry - Audit entry payload.
   */
  function recordIxfMergeAuditEntry(entry) {
    const storage = getDomainCacheStorage();
    if (!storage) return;
    const item = {
      ts: new Date().toISOString(),
      ixlanId: String(entry?.ixlanId || "").trim(),
      ixfUrl: String(entry?.ixfUrl || "").trim(),
      outcomes: Array.isArray(entry?.outcomes) ? entry.outcomes : [],
      version: SCRIPT_VERSION,
    };
    try {
      const raw = String(storage.getItem(IXF_MEMBER_AUDIT_LOG_STORAGE_KEY) || "").trim();
      const current = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(current) ? current : [];
      list.unshift(item);
      storage.setItem(
        IXF_MEMBER_AUDIT_LOG_STORAGE_KEY,
        JSON.stringify(list.slice(0, IXF_MEMBER_AUDIT_LOG_MAX_ITEMS)),
      );
      dbg("ixf-audit", "IX-F merge outcome recorded", item);
    } catch (_error) {
      // Never let audit logging break the apply flow.
    }
  }

  /**
   * Applies a list of merge candidates sequentially.
    * Purpose: For each candidate, pre-clear the sibling row's transfer IP
    * (so unique-ip validation does not block keeper PUT), then PUT the
    * keeper with both ipv4 + ipv6, then DELETE the sibling.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object[]} candidates - Selected merge candidates.
   * @param {{ cancelled: boolean }} signal - External cancel flag.
   * @param {Function} onProgress - Per-row callback.
   * @returns {Promise<object[]>} Outcomes for the audit log.
   */
  async function applyIxfMerges(candidates, signal, onProgress) {
    const outcomes = [];
    for (const candidate of candidates) {
      const base = {
        asn: candidate.asn,
        keeperId: candidate.keeperRow.id,
        otherId: candidate.otherRow.id,
        ipv4: candidate.ipv4,
        ipv6: candidate.ipv6,
        shape: candidate.shape || "split",
      };
      if (signal?.cancelled) {
        outcomes.push({ ...base, status: "cancelled" });
        continue;
      }

      onProgress?.(candidate, { status: "in-flight" });

      const otherOriginal = buildNetixlanPutPayload(candidate.otherRow);
      const otherNeutralized = { ...otherOriginal };
      const candidateV4 = String(candidate.ipv4 || "").trim();
      const candidateV6Norm = normalizeIpv6ForCompare(candidate.ipv6 || "");
      const otherV4 = String(otherOriginal.ipaddr4 || "").trim();
      const otherV6Norm = normalizeIpv6ForCompare(otherOriginal.ipaddr6 || "");
      let neutralizeChanged = false;

      // Unique IP constraint blocks keeper PUT while sibling still holds
      // the transfer address. Pre-clear the sibling's matching family.
      if (candidateV4 && otherV4 === candidateV4) {
        otherNeutralized.ipaddr4 = "";
        neutralizeChanged = true;
      }
      if (candidateV6Norm && otherV6Norm === candidateV6Norm) {
        otherNeutralized.ipaddr6 = "";
        neutralizeChanged = true;
      }

      if (neutralizeChanged) {
        const otherUrl = `${PEERINGDB_API_BASE_URL}/netixlan/${candidate.otherRow.id}`;
        const neutralizeRes = await pdbPost(otherUrl, "PUT", otherNeutralized, { contentType: "application/json", retries: 1 });
        const neutralizeOk = Number(neutralizeRes?.status || 0) >= 200 && Number(neutralizeRes?.status || 0) < 300;
        if (!neutralizeOk) {
          const outcome = {
            ...base,
            status: "preclear-failed",
            httpStatus: Number(neutralizeRes?.status || 0),
            error: extractRenumberApiErrorDetail(neutralizeRes),
          };
          outcomes.push(outcome);
          onProgress?.(candidate, outcome);
          if (IXF_MEMBER_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, IXF_MEMBER_APPLY_DELAY_MS));
          continue;
        }
      }

      const putBody = buildNetixlanPutPayload(candidate.keeperRow);
      putBody.ipaddr4 = candidate.ipv4;
      putBody.ipaddr6 = candidate.ipv6;
      const putUrl = `${PEERINGDB_API_BASE_URL}/netixlan/${candidate.keeperRow.id}`;
      const putResult = await pdbPost(putUrl, "PUT", putBody, { contentType: "application/json", retries: 1 });
      const putOk = Number(putResult?.status || 0) >= 200 && Number(putResult?.status || 0) < 300;
      if (!putOk) {
        let rollbackStatus = 0;
        let rollbackError = "";
        if (neutralizeChanged) {
          const otherUrl = `${PEERINGDB_API_BASE_URL}/netixlan/${candidate.otherRow.id}`;
          const rollbackRes = await pdbPost(otherUrl, "PUT", otherOriginal, { contentType: "application/json", retries: 1 });
          rollbackStatus = Number(rollbackRes?.status || 0);
          const rollbackOk = rollbackStatus >= 200 && rollbackStatus < 300;
          if (!rollbackOk) rollbackError = extractRenumberApiErrorDetail(rollbackRes);
        }
        const outcome = {
          ...base,
          status: "put-failed",
          httpStatus: Number(putResult?.status || 0),
          error: extractRenumberApiErrorDetail(putResult),
          rollbackStatus,
          rollbackError,
        };
        outcomes.push(outcome);
        onProgress?.(candidate, outcome);
        if (IXF_MEMBER_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, IXF_MEMBER_APPLY_DELAY_MS));
        continue;
      }
      const delUrl = `${PEERINGDB_API_BASE_URL}/netixlan/${candidate.otherRow.id}`;
      const delResult = await pdbPost(delUrl, "DELETE", "", { contentType: "application/json", retries: 1 });
      const delOk = Number(delResult?.status || 0) >= 200 && Number(delResult?.status || 0) < 300;
      const outcome = {
        ...base,
        status: delOk ? "done" : "delete-failed",
        httpStatus: Number(delResult?.status || 0),
        error: delOk ? "" : extractRenumberApiErrorDetail(delResult),
      };
      outcomes.push(outcome);
      onProgress?.(candidate, outcome);
      if (IXF_MEMBER_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, IXF_MEMBER_APPLY_DELAY_MS));
    }
    return outcomes;
  }

  /**
   * Opens the IX-F audit modal for a chosen ixlan.
   * Purpose: Top-level entry point invoked from the toolbar button.
   * @ai Preserve menu command registration behavior and gating on feature flag.
   * @param {string} ixlanId - Numeric ixlan id to audit.
   */
  async function openIxfMemberAuditModal(ixlanId) {
    const BACKDROP_ID = `${MODULE_PREFIX}IxfAuditBackdrop`;
    document.getElementById(BACKDROP_ID)?.remove();

    const backdrop = document.createElement("div");
    backdrop.id = BACKDROP_ID;
    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.45)",
      zIndex: "2147483646", display: "flex", alignItems: "center", justifyContent: "center",
    });
    const modal = document.createElement("div");
    Object.assign(modal.style, {
      background: "#fff", color: "#111", padding: "16px 20px",
      borderRadius: "8px", width: "min(1080px, 96vw)", maxWidth: "96vw",
      maxHeight: "92vh", display: "flex", flexDirection: "column",
      boxSizing: "border-box", minHeight: "0", minWidth: "0",
      boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
      font: "13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif",
    });
    const header = document.createElement("h2");
    header.textContent = `IX-F Member Audit — ixlan #${ixlanId}`;
    Object.assign(header.style, { margin: "0 0 6px", fontSize: "16px" });
    modal.appendChild(header);

    const status = document.createElement("div");
    Object.assign(status.style, { fontSize: "12px", color: "#444", marginBottom: "8px" });
    status.textContent = "Loading…";
    modal.appendChild(status);

    const tableWrap = document.createElement("div");
    // No fixed maxHeight — column flex parent handles it; see Renumber
    // modal note about clipping.
    Object.assign(tableWrap.style, { overflow: "auto", flex: "1 1 auto", minHeight: "0", minWidth: "0", width: "100%", border: "1px solid #ddd", borderRadius: "4px", marginBottom: "10px" });
    const table = document.createElement("table");
    Object.assign(table.style, { width: "100%", borderCollapse: "collapse", fontSize: "12px" });
    tableWrap.appendChild(table);
    modal.appendChild(tableWrap);

    const buttons = document.createElement("div");
    Object.assign(buttons.style, {
      display: "flex", flexDirection: "row", justifyContent: "flex-end", alignItems: "center",
      gap: "10px", flexShrink: "0", flexWrap: "wrap", rowGap: "10px", width: "100%", minWidth: "0",
      position: "sticky", bottom: "0", background: "#fff",
      paddingTop: "10px", borderTop: "1px solid #eee", marginTop: "auto",
    });
    // Desktop-only strict single-line variant, right aligned with fixed spacing.
    if (window.matchMedia("(min-width: 1024px)").matches) {
      Object.assign(buttons.style, { flexWrap: "nowrap", rowGap: "0", overflowX: "auto", overflowY: "hidden" });
    }

    const applyIconButtonShape = (btn) => {
      Object.assign(btn.style, {
        width: "34px", minWidth: "34px", height: "34px", padding: "0",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: "16px", lineHeight: "1", fontWeight: "700",
        margin: "0", flex: "0 0 34px", boxSizing: "border-box",
      });
    };
    const setIconButtonLabel = (btn, icon, hoverText) => {
      btn.textContent = icon;
      btn.title = hoverText;
      btn.setAttribute("aria-label", hoverText);
    };

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    Object.assign(closeBtn.style, { border: "1px solid #bbb", background: "#f5f5f5", borderRadius: "5px", cursor: "pointer" });
    applyIconButtonShape(closeBtn);
    setIconButtonLabel(closeBtn, "\u2715", "Close");

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    Object.assign(refreshBtn.style, { border: "1px solid #bbb", background: "#eef", borderRadius: "5px", cursor: "pointer" });
    applyIconButtonShape(refreshBtn);
    setIconButtonLabel(refreshBtn, "\u21bb", "Re-scan");

    const cancelApplyBtn = document.createElement("button");
    cancelApplyBtn.type = "button";
    Object.assign(cancelApplyBtn.style, { border: "1px solid #d93025", background: "#fff", color: "#d93025", borderRadius: "5px", cursor: "pointer", display: "none" });
    applyIconButtonShape(cancelApplyBtn);
    setIconButtonLabel(cancelApplyBtn, "\u25a0", "Cancel apply");

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    Object.assign(applyBtn.style, { border: "0", background: "#1a73e8", color: "#fff", borderRadius: "5px", cursor: "pointer" });
    applyIconButtonShape(applyBtn);
    setIconButtonLabel(applyBtn, "\u2713", "Apply merges");

    const recentChangesBtn = document.createElement("button");
    recentChangesBtn.type = "button";
    Object.assign(recentChangesBtn.style, { border: "1px solid #bbb", background: "#f5f5f5", borderRadius: "5px", cursor: "pointer" });
    applyIconButtonShape(recentChangesBtn);
    setIconButtonLabel(recentChangesBtn, "\u23f2", `Recent IP changes (\u2264${RECENT_IP_CHANGES_WINDOW_MIN}m)`);
    recentChangesBtn.addEventListener("click", () => {
      if (!isFeatureEnabled("recentIpChanges")) return;
      openRecentIpChangesModal(String(ixlanId));
    });
    // Right-aligned fixed-offset strip: buttons stay side-by-side.
    buttons.append(closeBtn, refreshBtn, recentChangesBtn, cancelApplyBtn, applyBtn);
    modal.appendChild(buttons);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    /** Removes the modal. */
    function close() { backdrop.remove(); }
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) close(); });

    let candidates = [];
    let ixfUrlInUse = "";
    let cancelSignal = { cancelled: false };

    /** Re-renders the candidate table. */
    function render() {
      table.textContent = "";
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      for (const label of ["✓", "ASN", "Shape", "Keeper id", "Other id", "IPv4", "IPv6", "Status"]) {
        const th = document.createElement("th");
        th.textContent = label;
        Object.assign(th.style, { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #ccc", background: "#fafafa", position: "sticky", top: "0" });
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const candidate of candidates) {
        const tr = document.createElement("tr");
        const td = (text) => { const cell = document.createElement("td"); cell.textContent = String(text); Object.assign(cell.style, { padding: "5px 8px", borderBottom: "1px solid #eee", verticalAlign: "top" }); return cell; };
        const cbCell = document.createElement("td");
        Object.assign(cbCell.style, { padding: "5px 8px", borderBottom: "1px solid #eee", textAlign: "center" });
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = candidate.selected !== false;
        cb.addEventListener("change", () => { candidate.selected = cb.checked; });
        cbCell.appendChild(cb);
        const shapeCell = td(candidate.shape || "split");
        if (candidate.shape === "stale-dual") {
          shapeCell.title = "v4-only keeper + dual stale row: absorb v6, DELETE the stale row whose v4 disagrees with IX-F.";
          Object.assign(shapeCell.style, { color: "#b45309", fontWeight: "600" });
        }
        tr.append(cbCell, td(candidate.asn), shapeCell, td(candidate.keeperRow.id), td(candidate.otherRow.id), td(candidate.ipv4 || ""), td(candidate.ipv6 || ""), td(candidate.applyStatus || "ready"));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    /** Runs the fetch + analysis pipeline. */
    async function refresh() {
      status.textContent = "Fetching ixlan record…";
      const ixlanResult = await fetchIxlanIxfMemberListUrl(ixlanId);
      if (ixlanResult.error) {
        status.textContent = `Cannot audit: ${ixlanResult.error === "no-ixf-url" ? "ixlan has no IX-F member-export URL configured." : ixlanResult.error}`;
        candidates = []; render(); return;
      }
      ixfUrlInUse = ixlanResult.ixfUrl;
      status.textContent = `Fetching IX-F export from ${ixfUrlInUse}…`;
      const ixfResult = await fetchIxfMemberExport(ixfUrlInUse);
      if (ixfResult.error) {
        status.textContent = `IX-F fetch failed (${ixfResult.error}); URL: ${ixfUrlInUse}`;
        candidates = []; render(); return;
      }
      status.textContent = `Fetching PDB netixlan rows for ixlan #${ixlanId}…`;
      let rows = [];
      try {
        const netixlanData = await pdbFetch(`${PEERINGDB_API_BASE_URL}/netixlan?ixlan_id=${encodeURIComponent(ixlanId)}&depth=0`);
        rows = Array.isArray(netixlanData?.data) ? netixlanData.data : [];
      } catch (_error) {
        status.textContent = "PDB netixlan fetch failed.";
        candidates = []; render(); return;
      }
      const ixfMap = extractIxfAsnIpPairs(ixfResult.data);
      candidates = findIxfMergeCandidates(rows, ixfMap).map((c) => ({ ...c, selected: true, applyStatus: "" }));
      status.textContent = `ixlan #${ixlanId} — ${rows.length} PDB rows • ${ixfMap.size} IX-F ASNs • ${candidates.length} mergeable split pair(s)`;
      render();
    }

    refreshBtn.addEventListener("click", () => { refresh(); });
    applyBtn.addEventListener("click", async () => {
      const selected = candidates.filter((c) => c.selected);
      if (selected.length === 0) { status.textContent = "Nothing selected to apply."; return; }
      const confirmed = window.confirm(
        `Merge ${selected.length} split netixlan pair(s)?\n` +
        `Each merge will pre-clear the sibling transfer IP if needed, PUT both IPs onto the older (lower-id) row, then DELETE the sibling.\n` +
        `ixlan: #${ixlanId}\n` +
        `IX-F source: ${ixfUrlInUse}`,
      );
      if (!confirmed) return;
      applyBtn.disabled = true; refreshBtn.disabled = true;
      cancelApplyBtn.style.display = ""; cancelSignal = { cancelled: false };
      cancelApplyBtn.onclick = () => { cancelSignal.cancelled = true; };
      const outcomes = await applyIxfMerges(selected, cancelSignal, (candidate, update) => {
        candidate.applyStatus = update.status === "in-flight" ? "applying…" : `${update.status}${update.httpStatus ? ` (${update.httpStatus})` : ""}${update.error ? ` — ${update.error}` : ""}`;
        render();
      });
      recordIxfMergeAuditEntry({ ixlanId, ixfUrl: ixfUrlInUse, outcomes });
      applyBtn.disabled = false; refreshBtn.disabled = false; cancelApplyBtn.style.display = "none";
      const ok = outcomes.filter((o) => o.status === "done").length;
      const preclearErr = outcomes.filter((o) => o.status === "preclear-failed").length;
      const putErr = outcomes.filter((o) => o.status === "put-failed").length;
      const delErr = outcomes.filter((o) => o.status === "delete-failed").length;
      status.textContent = `Apply complete — ok:${ok} preclear-failed:${preclearErr} put-failed:${putErr} delete-failed:${delErr} cancelled:${outcomes.filter((o) => o.status === "cancelled").length}`;
    });

    await refresh();
  }

  // ── IXLAN Conflict Resolver (helpers) ──────────────────────────────────────
  // Follow-up phase after an IXLAN renumber Apply run: handles the rows that
  // ended in "conflict" because the renumber-target IP already belongs to a
  // different netixlan ("keeper") on the same ixlan. The keeper is usually
  // the correct/new row that was created ahead of (or during) the renumber;
  // the original (doomed) row is now a stale duplicate. This module DELETEs
  // the doomed row, but only after a 7-gate verification chain against the
  // upstream IX-F member-export plus a live API re-read of both rows.
  // No PATCH; no bulk DELETE; each delete is its own request, sequential,
  // with re-verification immediately before issue. Outcomes are persisted
  // to a dedicated audit log.
  // -------------------------------------------------------------------------

  /**
   * Resolves the "keeper" netixlan row that already occupies a renumber's
   * target IP on a given ixlan.
   * Purpose: Locate the unambiguous row that the conflict-resolver may need
   * to keep (i.e. NOT delete) before deleting the stale doomed row.
   * Necessity: A keeper must exist by definition for the doomed row to have
   * been flagged as a conflict; if zero or multiple rows are returned, the
   * resolver MUST refuse to act.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {{ ixlanId: string, doomedId: string|number, asn: string|number,
   *           family: 4|6, newIp: string }} args
   * @returns {Promise<{ keeper: object|null, error: string }>}
   */
  async function findKeeperForConflict(args) {
    const ixlanId = String(args?.ixlanId || "").trim();
    const newIp = String(args?.newIp || "").trim();
    const family = Number(args?.family);
    if (!ixlanId || !newIp || (family !== 4 && family !== 6)) {
      return { keeper: null, error: "bad-args" };
    }
    const ipKey = family === 4 ? "ipaddr4" : "ipaddr6";
    const url = `${PEERINGDB_API_BASE_URL}/netixlan?ixlan_id=${encodeURIComponent(ixlanId)}&${ipKey}=${encodeURIComponent(newIp)}&depth=0`;
    try {
      const data = await pdbFetch(url);
      const rows = Array.isArray(data?.data) ? data.data : [];
      const matches = rows.filter((r) => String(r.ixlan_id) === ixlanId && String(r[ipKey] || "").trim() === newIp);
      if (matches.length === 0) return { keeper: null, error: "no-keeper" };
      if (matches.length > 1) return { keeper: null, error: `ambiguous-${matches.length}` };
      const keeper = matches[0];
      if (String(keeper.id) === String(args.doomedId)) return { keeper: null, error: "keeper-is-doomed" };
      if (String(keeper.asn) !== String(args.asn)) return { keeper, error: "asn-mismatch" };
      return { keeper, error: "" };
    } catch (_error) {
      return { keeper: null, error: "fetch-failed" };
    }
  }

  /**
   * Re-fetches a single netixlan row by id from the live API.
   * Purpose: Pre-delete confirmation that nothing has shifted since the
   * keeper/doomed snapshot was taken.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string|number} id - netixlan id.
   * @returns {Promise<{ row: object|null, error: string }>}
   */
  async function fetchNetixlanRowById(id) {
    const idStr = String(id || "").trim();
    if (!/^\d+$/.test(idStr)) return { row: null, error: "bad-id" };
    try {
      const data = await pdbFetch(`${PEERINGDB_API_BASE_URL}/netixlan/${idStr}?depth=0`);
      const row = Array.isArray(data?.data) ? data.data[0] : null;
      if (!row) return { row: null, error: "not-found" };
      return { row, error: "" };
    } catch (_error) {
      return { row: null, error: "fetch-failed" };
    }
  }

  /**
   * Returns true when a netixlan field carries a real value (not null,
   * undefined, or empty string). Numeric `0` and boolean `false` count
   * as empty for our purposes here because the netixlan model treats
   * those as "absent / default off" for the fields we inspect.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {*} value
   * @returns {boolean}
   */
  function isMergeableValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim() !== "";
    if (typeof value === "number") return value !== 0;
    if (typeof value === "boolean") return value === true;
    return true;
  }

  /**
   * Normalizes a netixlan field value for cross-row equality. IPv6 gets
   * collapsed via normalizeIpv6ForCompare so that `2001:7f8::1` and
   * `2001:7f8:0:0:0:0:0:1` are treated as the same address.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string} field
   * @param {*} value
   * @returns {string}
   */
  function normalizeNetixlanFieldForCompare(field, value) {
    if (value === null || value === undefined) return "";
    if (field === "ipaddr6") return normalizeIpv6ForCompare(String(value).trim());
    if (typeof value === "string") return value.trim();
    return String(value);
  }

  /**
   * Builds a per-field "merge plan" describing what must be copied from
   * the doomed row into the keeper row before the keeper can safely
   * absorb the doomed row's network attachment. Only fields in
   * AUTO_MERGE_FIELDS are auto-copied; fields outside that whitelist
   * surface in `blockers` and require manual operator action.
   *
   * Skips the conflicting family entirely — the renumber flow already
   * gives the keeper its post-renumber IP on that family (gates 3 & 4
   * verify this).
   *
   * Purpose: Prevent IP-family / attribute data loss when a DELETE would
   * otherwise destroy the only carrier of a value (operator-discovered
   * bug: ixlan #3990, doomed #93168 IPv6 would have been lost).
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {{ doomedRow: object, keeperRow: object, family: 4|6 }} args
   * @returns {{ merge: object, blockers: Array<{ field: string, kind: string, doomed: *, keeper: * }> }}
   */
  function buildMergePlan(args) {
    const { doomedRow, keeperRow, family } = args || {};
    const merge = {};
    const blockers = [];
    if (!doomedRow || !keeperRow) return { merge, blockers };
    const conflictingFamilyField = family === 4 ? "ipaddr4" : "ipaddr6";
    for (const field of PRESERVED_NETIXLAN_FIELDS) {
      if (field === conflictingFamilyField) continue;
      const d = doomedRow[field];
      const k = keeperRow[field];
      const dHas = isMergeableValue(d);
      const kHas = isMergeableValue(k);
      if (dHas && kHas) {
        const dn = normalizeNetixlanFieldForCompare(field, d);
        const kn = normalizeNetixlanFieldForCompare(field, k);
        if (dn !== kn) {
          blockers.push({ field, kind: "field-mismatch", doomed: d, keeper: k });
        }
        continue;
      }
      if (dHas && !kHas) {
        if (AUTO_MERGE_FIELDS.includes(field)) {
          merge[field] = d;
        } else {
          blockers.push({ field, kind: "would-lose", doomed: d, keeper: k });
        }
      }
    }
    return { merge, blockers };
  }

  /**
   * Verifies a doomed/keeper conflict pair against all 8 safety gates.
   * Purpose: Single source of truth for "is it safe to absorb the
   * doomed netixlan into the keeper and DELETE it?". Every gate must
   * pass; any failure locks the row out. The IX-F gates require the
   * export to be reachable — when ixfMap is null the gates 5 & 6
   * hard-fail (we choose 200% sure over 90%). Gate 8 catches the
   * silent-data-loss case where the doomed row carries a non-empty
   * field value the keeper lacks and that field is not auto-mergeable.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {{ doomedRow: object, keeperRow: object, payload: object,
   *           ixfMap: Map|null, family: 4|6 }} args
   * @returns {{ gates: Array<{ name: string, ok: boolean, detail: string }>,
   *             ok: boolean, mergePlan: { merge: object, blockers: Array<object> } }}
   */
  function verifyConflictGates(args) {
    const { doomedRow, keeperRow, payload, ixfMap, family } = args || {};
    const gates = [];
    const pushGate = (name, ok, detail = "") => gates.push({ name, ok: Boolean(ok), detail: String(detail || "") });

    // Gate 1 — ASN match between doomed and keeper.
    pushGate(
      "asn-match",
      doomedRow && keeperRow && String(doomedRow.asn) === String(keeperRow.asn),
      `doomed=${doomedRow?.asn ?? "?"} keeper=${keeperRow?.asn ?? "?"}`,
    );

    // Gate 2 — Both rows live on the same ixlan.
    pushGate(
      "same-ixlan",
      doomedRow && keeperRow && String(doomedRow.ixlan_id) === String(keeperRow.ixlan_id),
      `doomed=${doomedRow?.ixlan_id ?? "?"} keeper=${keeperRow?.ixlan_id ?? "?"}`,
    );

    // Gate 3 — Keeper IP matches the renumber target for the conflicting family.
    let keeperIp = "";
    let targetIp = "";
    if (family === 4 && payload?.hasV4) {
      keeperIp = String(keeperRow?.ipaddr4 || "").trim();
      const result = replaceHostInPrefix(String(doomedRow?.ipaddr4 || "").trim(), payload.old4, payload.new4);
      targetIp = result.fits ? result.ip : "";
      pushGate("keeper-ip-is-target", Boolean(keeperIp) && keeperIp === targetIp, `keeper=${keeperIp} target=${targetIp}`);
    } else if (family === 6 && payload?.hasV6) {
      keeperIp = normalizeIpv6ForCompare(String(keeperRow?.ipaddr6 || "").trim());
      const result = replaceHostInPrefix(String(doomedRow?.ipaddr6 || "").trim(), payload.old6, payload.new6);
      targetIp = result.fits ? normalizeIpv6ForCompare(result.ip) : "";
      pushGate("keeper-ip-is-target", Boolean(keeperIp) && keeperIp === targetIp, `keeper=${keeperIp} target=${targetIp}`);
    } else {
      pushGate("keeper-ip-is-target", false, "payload-missing-family");
    }

    // Gate 4 — Doomed IP still lives in the renumber source prefix.
    let doomedIp = "";
    let oldCidr = "";
    if (family === 4 && payload?.hasV4) {
      doomedIp = String(doomedRow?.ipaddr4 || "").trim();
      oldCidr = String(payload.old4 || "");
      const cidr = parseCidr(oldCidr);
      const ip = parseIp(doomedIp);
      const inPrefix = cidr && ip && ip.family === cidr.family && (ip.bigint & cidr.networkMask) === cidr.network;
      pushGate("doomed-ip-in-source-prefix", Boolean(inPrefix), `${doomedIp} in ${oldCidr}`);
    } else if (family === 6 && payload?.hasV6) {
      doomedIp = String(doomedRow?.ipaddr6 || "").trim();
      oldCidr = String(payload.old6 || "");
      const cidr = parseCidr(oldCidr);
      const ip = parseIp(doomedIp);
      const inPrefix = cidr && ip && ip.family === cidr.family && (ip.bigint & cidr.networkMask) === cidr.network;
      pushGate("doomed-ip-in-source-prefix", Boolean(inPrefix), `${doomedIp} in ${oldCidr}`);
    } else {
      pushGate("doomed-ip-in-source-prefix", false, "payload-missing-family");
    }

    // Gates 5 & 6 — IX-F member-export agreement.
    if (!ixfMap) {
      pushGate("ixf-asserts-keeper", false, "ixf-unavailable");
      pushGate("ixf-does-not-assert-doomed", false, "ixf-unavailable");
    } else {
      const asn = String(doomedRow?.asn || "").trim();
      const ixfEntries = ixfMap.get(asn) || [];
      if (ixfEntries.length === 0) {
        pushGate("ixf-asserts-keeper", false, `ixf-missing-asn:${asn}`);
        pushGate("ixf-does-not-assert-doomed", false, `ixf-missing-asn:${asn}`);
      } else {
        // Gate 5: at least one IX-F vlan entry for this ASN names the keeper's
        // IP on the conflicting family.
        const keeperV4 = String(keeperRow?.ipaddr4 || "").trim();
        const keeperV6Norm = normalizeIpv6ForCompare(String(keeperRow?.ipaddr6 || "").trim());
        const keeperAsserted = ixfEntries.some((entry) => {
          if (family === 4) return entry.v4 && entry.v4 === keeperV4;
          return entry.v6Norm && entry.v6Norm === keeperV6Norm;
        });
        pushGate(
          "ixf-asserts-keeper",
          keeperAsserted,
          family === 4 ? `keeperV4=${keeperV4}` : `keeperV6=${keeperV6Norm}`,
        );

        // Gate 6: NO IX-F vlan entry for this ASN names the doomed IP. This
        // catches dual-attached members who legitimately publish both
        // addresses — they must NOT have either row deleted.
        const doomedAsserted = ixfEntries.some((entry) => {
          if (family === 4) return entry.v4 && entry.v4 === doomedIp;
          const doomedV6Norm = normalizeIpv6ForCompare(doomedIp);
          return entry.v6Norm && entry.v6Norm === doomedV6Norm;
        });
        pushGate(
          "ixf-does-not-assert-doomed",
          !doomedAsserted,
          family === 4 ? `doomedV4=${doomedIp}` : `doomedV6=${normalizeIpv6ForCompare(doomedIp)}`,
        );
      }
    }

    // Gate 7 — "Fresh re-read agrees" is checked separately, immediately
    // before the DELETE issue (see applyConflictDeletes). It is reported as
    // a placeholder here so the modal can render all 8 gates uniformly.
    pushGate("fresh-reread-agrees", true, "checked at apply time");

    // Gate 8 — No silent data loss. The doomed row must not carry any
    // non-empty field value (on the non-conflicting family, or scalar
    // fields like speed/notes/...) that the keeper lacks AND that we
    // cannot auto-merge. Mismatched non-null values always hard-fail
    // (manual review required). See PRESERVED_NETIXLAN_FIELDS and
    // AUTO_MERGE_FIELDS for the policy. The merge plan returned with
    // the gates feeds the two-phase apply (PUT keeper, then DELETE).
    const mergePlan = buildMergePlan({ doomedRow, keeperRow, family });
    if (mergePlan.blockers.length === 0) {
      const summary = Object.keys(mergePlan.merge).length === 0
        ? "no merge required"
        : `auto-merge: ${Object.keys(mergePlan.merge).join(",")}`;
      pushGate("no-data-loss-on-delete", true, summary);
    } else {
      const detail = mergePlan.blockers
        .map((b) => `${b.kind}:${b.field}`)
        .join(" ");
      pushGate("no-data-loss-on-delete", false, detail);
    }

    return { gates, ok: gates.every((g) => g.ok), mergePlan };
  }

  /**
   * Persists a conflict-resolve audit entry.
   * Purpose: Forensic record of every DELETE so operators can manually
   * audit and (if needed) reverse via the netixlan admin.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   * @param {object} entry - Audit entry payload.
   */
  function recordConflictResolveAuditEntry(entry) {
    const storage = getDomainCacheStorage();
    if (!storage) return;
    const item = {
      ts: new Date().toISOString(),
      ixlanId: String(entry?.ixlanId || "").trim(),
      ticketId: String(entry?.ticketId || "").trim(),
      ixfUrl: String(entry?.ixfUrl || "").trim(),
      payload: entry?.payload || null,
      outcomes: Array.isArray(entry?.outcomes) ? entry.outcomes : [],
      version: SCRIPT_VERSION,
    };
    try {
      const raw = String(storage.getItem(CONFLICT_RESOLVE_AUDIT_LOG_STORAGE_KEY) || "").trim();
      const current = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(current) ? current : [];
      list.unshift(item);
      storage.setItem(
        CONFLICT_RESOLVE_AUDIT_LOG_STORAGE_KEY,
        JSON.stringify(list.slice(0, CONFLICT_RESOLVE_AUDIT_LOG_MAX_ITEMS)),
      );
      dbg("conflict-resolve", "DELETE outcome recorded", item);
    } catch (_error) {
      // Never let audit logging break the apply flow.
    }
  }

  /**
  /**
   * Applies the conflict-resolver merge+DELETE sequence.
   * Purpose: For each ticked conflict item, re-read both rows from the
   * live API and re-run all 8 gates; on agreement, run the two-phase
   * apply — PUT the keeper with any auto-merged fields (e.g. an IPv6
   * the keeper was missing), re-read to confirm the merge landed, and
   * only then DELETE the doomed row. Any drift or failure aborts that
   * specific row without affecting others — and critically, no DELETE
   * ever runs unless the merge PUT both succeeded and verified.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object[]} items - Selected conflict items.
   * @param {object} payload - Renumber payload (for prefix gates).
   * @param {Map|null} ixfMap - IX-F ASN→pairs map, or null if unavailable.
   * @param {{ cancelled: boolean }} signal - External cancel flag.
   * @param {Function} onProgress - Per-row progress callback.
   * @returns {Promise<object[]>} Outcomes for the audit log.
   */
  async function applyConflictDeletes(items, payload, ixfMap, signal, onProgress) {
    const outcomes = [];
    for (const item of items) {
      const baseOutcome = {
        doomedId: String(item.doomedRow.id),
        keeperId: String(item.keeperRow.id),
        asn: String(item.doomedRow.asn || ""),
        family: item.family,
        oldIp4: String(item.doomedRow.ipaddr4 || ""),
        oldIp6: String(item.doomedRow.ipaddr6 || ""),
        keeperIp4: String(item.keeperRow.ipaddr4 || ""),
        keeperIp6: String(item.keeperRow.ipaddr6 || ""),
        mergePlan: {},
        keeperPutStatus: 0,
        phase: "blocked",
      };
      if (signal?.cancelled) {
        outcomes.push({ ...baseOutcome, status: "cancelled" });
        continue;
      }
      onProgress?.(item, { status: "in-flight" });

      // Gate 7 — live re-read of both rows, then re-run all 8 gates on
      // the live response. If anything moved, or gate 8 now reports new
      // blockers, abort this row.
      const [freshDoomedRes, freshKeeperRes] = await Promise.all([
        fetchNetixlanRowById(item.doomedRow.id),
        fetchNetixlanRowById(item.keeperRow.id),
      ]);
      if (freshDoomedRes.error || freshKeeperRes.error) {
        const outcome = { ...baseOutcome, status: "aborted", gateFailed: "fresh-reread", error: freshDoomedRes.error || freshKeeperRes.error };
        outcomes.push(outcome);
        onProgress?.(item, outcome);
        if (CONFLICT_RESOLVE_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CONFLICT_RESOLVE_APPLY_DELAY_MS));
        continue;
      }
      const liveGates = verifyConflictGates({
        doomedRow: freshDoomedRes.row,
        keeperRow: freshKeeperRes.row,
        payload,
        ixfMap,
        family: item.family,
      });
      if (!liveGates.ok) {
        const failed = liveGates.gates.filter((g) => !g.ok).map((g) => g.name).join(",");
        const outcome = { ...baseOutcome, status: "aborted", gateFailed: failed || "unknown", error: "live-gate-failed" };
        outcomes.push(outcome);
        onProgress?.(item, outcome);
        if (CONFLICT_RESOLVE_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CONFLICT_RESOLVE_APPLY_DELAY_MS));
        continue;
      }

      const liveMerge = (liveGates.mergePlan && liveGates.mergePlan.merge) || {};
      baseOutcome.mergePlan = { ...liveMerge };

      // Phase 1 — Merge into keeper, if there is anything to absorb.
      let keeperRowForDelete = freshKeeperRes.row;
      if (Object.keys(liveMerge).length > 0) {
        const mergedPayload = { ...buildNetixlanPutPayload(freshKeeperRes.row), ...liveMerge };
        const putUrl = `${PEERINGDB_API_BASE_URL}/netixlan/${item.keeperRow.id}`;
        const putResult = await pdbPost(putUrl, "PUT", JSON.stringify(mergedPayload), { contentType: "application/json", retries: 1 });
        const putStatus = Number(putResult?.status || 0);
        baseOutcome.keeperPutStatus = putStatus;
        const putOk = putStatus >= 200 && putStatus < 300;
        if (!putOk) {
          const outcome = {
            ...baseOutcome,
            status: "keeper-merge-failed",
            phase: "blocked",
            error: extractRenumberApiErrorDetail(putResult),
          };
          outcomes.push(outcome);
          onProgress?.(item, outcome);
          if (CONFLICT_RESOLVE_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CONFLICT_RESOLVE_APPLY_DELAY_MS));
          continue;
        }
        // Verify the merge landed by re-reading the keeper. If any
        // requested field does not match what we asked for, DO NOT
        // proceed to DELETE — the doomed row is the last carrier.
        const verifyRes = await fetchNetixlanRowById(item.keeperRow.id);
        if (verifyRes.error || !verifyRes.row) {
          const outcome = {
            ...baseOutcome,
            status: "keeper-merge-verify-failed",
            phase: "blocked",
            error: verifyRes.error || "no-row",
          };
          outcomes.push(outcome);
          onProgress?.(item, outcome);
          if (CONFLICT_RESOLVE_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CONFLICT_RESOLVE_APPLY_DELAY_MS));
          continue;
        }
        const mismatched = [];
        for (const [field, wanted] of Object.entries(liveMerge)) {
          const got = verifyRes.row[field];
          const wn = normalizeNetixlanFieldForCompare(field, wanted);
          const gn = normalizeNetixlanFieldForCompare(field, got);
          if (wn !== gn) mismatched.push(field);
        }
        if (mismatched.length > 0) {
          const outcome = {
            ...baseOutcome,
            status: "keeper-merge-verify-failed",
            phase: "blocked",
            error: `mismatch:${mismatched.join(",")}`,
          };
          outcomes.push(outcome);
          onProgress?.(item, outcome);
          if (CONFLICT_RESOLVE_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CONFLICT_RESOLVE_APPLY_DELAY_MS));
          continue;
        }
        keeperRowForDelete = verifyRes.row;
        baseOutcome.phase = "merge-then-delete";
      } else {
        baseOutcome.phase = "delete-only";
      }

      // Phase 2 — DELETE the doomed row.
      const delUrl = `${PEERINGDB_API_BASE_URL}/netixlan/${item.doomedRow.id}`;
      const delResult = await pdbPost(delUrl, "DELETE", "", { contentType: "application/json", retries: 1 });
      const delOk = Number(delResult?.status || 0) >= 200 && Number(delResult?.status || 0) < 300;
      if (!delOk) {
        const outcome = {
          ...baseOutcome,
          status: "delete-failed",
          httpStatus: Number(delResult?.status || 0),
          error: extractRenumberApiErrorDetail(delResult),
        };
        outcomes.push(outcome);
        onProgress?.(item, outcome);
        if (CONFLICT_RESOLVE_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CONFLICT_RESOLVE_APPLY_DELAY_MS));
        continue;
      }

      // Post-condition: keeper still exists.
      const postKeeper = await fetchNetixlanRowById(item.keeperRow.id);
      const outcome = {
        ...baseOutcome,
        status: postKeeper.row ? "done" : "done-keeper-missing",
        httpStatus: Number(delResult?.status || 0),
        error: postKeeper.row ? "" : `post-check:${postKeeper.error}`,
      };
      outcomes.push(outcome);
      onProgress?.(item, outcome);
      if (CONFLICT_RESOLVE_APPLY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CONFLICT_RESOLVE_APPLY_DELAY_MS));
    }
    return outcomes;
  }

  /**
   * Builds the conflict-item list from renumber classified entries.
   * Purpose: Translate the renumber modal's per-row classification into
   * one conflict item per (row, family) that needs resolution. A row
   * with conflicts on both families produces two items.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {object[]} entries - classifyRenumberRows() output.
   * @returns {Array<{ doomedRow: object, family: 4|6, newIp: string }>}
   */
  function collectConflictItemsFromEntries(entries) {
    const items = [];
    for (const entry of entries || []) {
      if (entry?.v4?.status === "conflict") {
        items.push({ doomedRow: entry.row, family: 4, newIp: entry.v4.newIp });
      }
      if (entry?.v6?.status === "conflict") {
        items.push({ doomedRow: entry.row, family: 6, newIp: entry.v6.newIp });
      }
    }
    return items;
  }

  /**
   * Opens the conflict-resolver modal for a renumber run.
   * Purpose: Operator UI for reviewing per-row verification gates and
   * approving (or refusing) the DELETE of stale duplicates.
   * Necessity: The DELETE is destructive and cross-references upstream
   * IX-F data; this MUST NOT be a one-click operation.
   * @ai Preserve menu command registration behavior and gating on feature flag.
   * @param {{ ixlanId: string, ticketId: string, payload: object,
   *           conflictItems: object[] }} args
   */
  async function openConflictResolverModal(args) {
    const ixlanId = String(args?.ixlanId || "").trim();
    const normalizedExpectedIxlanId = String(ixlanId || "").replace(/\D+/g, "");
    const ticketId = String(args?.ticketId || "").trim();
    const payload = args?.payload || {};
    const initialItems = Array.isArray(args?.conflictItems) ? args.conflictItems.slice() : [];

    const BACKDROP_ID = `${MODULE_PREFIX}ConflictResolverBackdrop`;
    document.getElementById(BACKDROP_ID)?.remove();
    const backdrop = document.createElement("div");
    backdrop.id = BACKDROP_ID;
    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)",
      zIndex: "2147483647", display: "flex", alignItems: "center", justifyContent: "center",
    });
    const modal = document.createElement("div");
    Object.assign(modal.style, {
      background: "#fff", color: "#111", padding: "16px 20px",
      borderRadius: "8px", width: "min(1180px, 96vw)", maxWidth: "96vw",
      maxHeight: "92vh", display: "flex", flexDirection: "column",
      boxSizing: "border-box", minHeight: "0", minWidth: "0",
      boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
      font: "13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif",
    });

    const header = document.createElement("h2");
    header.textContent = `Resolve Renumber Conflicts — ixlan #${ixlanId}${ticketId ? ` — ticket #${ticketId}` : ""}`;
    Object.assign(header.style, { margin: "0 0 6px", fontSize: "16px" });
    const subhead = document.createElement("div");
    Object.assign(subhead.style, { margin: "0 0 8px", color: "#444" });
    const summaryParts = [];
    if (payload.hasV4) summaryParts.push(`IPv4 ${payload.old4} → ${payload.new4}`);
    if (payload.hasV6) summaryParts.push(`IPv6 ${payload.old6} → ${payload.new6}`);
    subhead.textContent = summaryParts.join(" • ");

    const warn = document.createElement("div");
    Object.assign(warn.style, {
      margin: "4px 0 8px", padding: "8px 10px", background: "#fef3c7",
      border: "1px solid #d97706", borderRadius: "4px", color: "#7c2d12",
    });
    warn.textContent = "DELETEs are destructive. Every ticked row must pass all 8 verification gates AND you must type this ixlan id below to enable Apply. When the keeper is missing a value the doomed row carries (e.g. IPv6), the resolver will PUT the keeper to absorb it BEFORE the DELETE — no row is ever deleted without a verified merge.";

    const status = document.createElement("div");
    Object.assign(status.style, { margin: "4px 0", color: "#444", minHeight: "1.4em" });

    const prereq = document.createElement("div");
    Object.assign(prereq.style, { margin: "0 0 8px", color: "#666", fontSize: "12px" });

    const tableWrap = document.createElement("div");
    // Table is the only scroll region. All controls are rendered above
    // it, so no bottom action can be clipped by viewport height.
    Object.assign(tableWrap.style, { overflow: "auto", border: "1px solid #ddd", borderRadius: "4px", flex: "1 1 0", minHeight: "120px", minWidth: "0" });
    const table = document.createElement("table");
    Object.assign(table.style, { width: "100%", borderCollapse: "collapse", fontSize: "12px" });
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr>" + ["", "ASN", "Family", "Doomed id", "Doomed IP", "Keeper id", "Keeper IP", "Merge plan", "Gates", "Status"]
      .map((h) => `<th style=\"text-align:left;padding:6px 8px;background:#f7f7f7;border-bottom:1px solid #ddd;\">${h}</th>`).join("") + "</tr>";
    const tbody = document.createElement("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    const controls = document.createElement("div");
    Object.assign(controls.style, {
      display: "flex", flexDirection: "column", gap: "8px", padding: "8px 10px", marginBottom: "8px",
      border: "1px solid #eee", borderRadius: "6px", background: "#fafafa",
      alignItems: "stretch", flexShrink: "0",
    });

    const confirmRow = document.createElement("div");
    Object.assign(confirmRow.style, {
      display: "flex", gap: "8px",
      justifyContent: "flex-start", alignItems: "center", flexWrap: "wrap",
      width: "100%", minWidth: "0", flexShrink: "0",
    });
    const confirmLabel = document.createElement("label");
    Object.assign(confirmLabel.style, { color: "#444" });
    confirmLabel.textContent = `Type ixlan id "${ixlanId}" to enable Apply: `;
    const confirmInput = document.createElement("input");
    confirmInput.type = "text";
    confirmInput.placeholder = normalizedExpectedIxlanId || ixlanId;
    // Pre-fill to prevent false lockout where the operator sees "3990"
    // but Apply remains disabled due placeholder/value confusion.
    // Final window.confirm remains in place as destructive safeguard.
    confirmInput.value = normalizedExpectedIxlanId;
    Object.assign(confirmInput.style, { padding: "4px 6px", marginLeft: "6px", width: "100px" });
    confirmLabel.appendChild(confirmInput);
    confirmRow.appendChild(confirmLabel);

    const buttonRow = document.createElement("div");
    Object.assign(buttonRow.style, {
      display: "flex", flexDirection: "row-reverse", justifyContent: "flex-start", alignItems: "center",
      gap: "8px", flexWrap: "wrap", rowGap: "8px", width: "100%", minWidth: "0", flexShrink: "0",
    });
    // Desktop-only strict single-line variant (right anchored, leftward).
    if (window.matchMedia("(min-width: 1024px)").matches) {
      Object.assign(buttonRow.style, { flexWrap: "nowrap", rowGap: "0", overflowX: "auto", overflowY: "hidden" });
    }

    const shapeResolverIconBtn = (btn) => {
      Object.assign(btn.style, {
        width: "34px", minWidth: "34px", height: "34px", padding: "0",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: "16px", lineHeight: "1", fontWeight: "700",
        margin: "0", flex: "0 0 34px", boxSizing: "border-box",
      });
    };
    const setResolverIconLabel = (btn, icon, label) => {
      btn.textContent = icon;
      btn.title = label;
      btn.setAttribute("aria-label", label);
    };

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    Object.assign(closeBtn.style, { border: "1px solid #bbb", background: "#f5f5f5", borderRadius: "5px", cursor: "pointer" });
    shapeResolverIconBtn(closeBtn);
    setResolverIconLabel(closeBtn, "\u2715", "Close");

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    Object.assign(refreshBtn.style, { border: "1px solid #bbb", background: "#eef", borderRadius: "5px", cursor: "pointer" });
    shapeResolverIconBtn(refreshBtn);
    setResolverIconLabel(refreshBtn, "\u21bb", "Re-verify");

    // Bulk-select convenience: tick every row that passes all 8 gates.
    // Manually ticking 14+ checkboxes was the operator's blocker for
    // 'cannot trigger the conflict resolver action'.
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    Object.assign(selectAllBtn.style, { border: "1px solid #15803d", background: "#f0fdf4", color: "#14532d", borderRadius: "5px", cursor: "pointer" });
    shapeResolverIconBtn(selectAllBtn);
    setResolverIconLabel(selectAllBtn, "\u2611", "Select all ready (0)");

    const cancelApplyBtn = document.createElement("button");
    cancelApplyBtn.type = "button";
    Object.assign(cancelApplyBtn.style, { border: "1px solid #d93025", background: "#fff", color: "#d93025", borderRadius: "5px", cursor: "pointer", display: "none" });
    shapeResolverIconBtn(cancelApplyBtn);
    setResolverIconLabel(cancelApplyBtn, "\u25a0", "Cancel apply");

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    Object.assign(applyBtn.style, { background: "#b91c1c", color: "#fff", border: "0", borderRadius: "5px", cursor: "pointer" });
    shapeResolverIconBtn(applyBtn);
    setResolverIconLabel(applyBtn, "\u2326", "Delete selected");

    // Right-anchored fixed-offset strip: first appended is rightmost,
    // subsequent buttons are placed leftward with a fixed gap.
    buttonRow.appendChild(applyBtn);
    buttonRow.appendChild(cancelApplyBtn);
    buttonRow.appendChild(selectAllBtn);
    buttonRow.appendChild(refreshBtn);
    buttonRow.appendChild(closeBtn);
    controls.appendChild(confirmRow);
    controls.appendChild(buttonRow);

    modal.appendChild(header);
    modal.appendChild(subhead);
    modal.appendChild(warn);
    modal.appendChild(status);
    modal.appendChild(prereq);
    modal.appendChild(controls);
    modal.appendChild(tableWrap);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    closeBtn.addEventListener("click", () => backdrop.remove());

    // State.
    let items = initialItems.map((it) => ({
      ...it,
      keeperRow: null,
      keeperError: "",
      gates: null,
      selected: false,
      applyStatus: "",
    }));
    let ixfMap = null;
    let ixfUrlInUse = "";
    let ixfError = "";
    let cancelSignal = { cancelled: false };

    function getNormalizedTypedIxlanId() {
      return String(confirmInput.value || "").replace(/\D+/g, "");
    }

    function recomputeApplyEnabled() {
      const typedOk = getNormalizedTypedIxlanId() === normalizedExpectedIxlanId;
      const anyEligible = items.some((it) => it.selected && it.gates?.ok);
      applyBtn.disabled = !(typedOk && anyEligible);
      applyBtn.style.cursor = applyBtn.disabled ? "not-allowed" : "pointer";
      const selectedReadyCount = items.reduce((n, it) => n + (it.selected && it.gates?.ok ? 1 : 0), 0);
      prereq.textContent = `Apply prerequisites: typed ixlan id ${typedOk ? "yes" : "no"} • selected ready rows ${selectedReadyCount}`;
      prereq.style.color = typedOk && selectedReadyCount > 0 ? "#15803d" : "#b91c1c";
      // Keep the bulk-select label and disabled state in sync with how
      // many rows have passed all 8 gates.
      const readyCount = items.reduce((n, it) => n + (it.gates?.ok ? 1 : 0), 0);
      const allTicked = readyCount > 0 && items.every((it) => !it.gates?.ok || it.selected);
      const selectLabel = allTicked ? `Unselect all (${readyCount})` : `Select all ready (${readyCount})`;
      selectAllBtn.title = selectLabel;
      selectAllBtn.setAttribute("aria-label", selectLabel);
      selectAllBtn.disabled = readyCount === 0;
    }
    confirmInput.addEventListener("input", recomputeApplyEnabled);
    confirmInput.addEventListener("change", recomputeApplyEnabled);
    selectAllBtn.addEventListener("click", () => {
      const readyItems = items.filter((it) => it.gates?.ok);
      if (readyItems.length === 0) return;
      const allTicked = readyItems.every((it) => it.selected);
      const next = !allTicked;
      for (const it of readyItems) it.selected = next;
      render();
    });

    function render() {
      tbody.innerHTML = "";
      for (const it of items) {
        const tr = document.createElement("tr");
        Object.assign(tr.style, { borderBottom: "1px solid #eee" });
        const cells = [];

        const cbCell = document.createElement("td");
        Object.assign(cbCell.style, { padding: "6px 8px", verticalAlign: "top" });
        const cb = document.createElement("input"); cb.type = "checkbox";
        cb.disabled = !it.gates?.ok;
        cb.checked = Boolean(it.selected) && cb.disabled === false;
        cb.addEventListener("change", () => { it.selected = cb.checked; recomputeApplyEnabled(); });
        cbCell.appendChild(cb);
        cells.push(cbCell);

        const td = (text) => {
          const c = document.createElement("td");
          Object.assign(c.style, { padding: "6px 8px", verticalAlign: "top" });
          c.textContent = String(text ?? "");
          return c;
        };
        cells.push(td(it.doomedRow.asn));
        cells.push(td(`IPv${it.family}`));
        cells.push(td(it.doomedRow.id));
        const doomedIp = it.family === 4 ? (it.doomedRow.ipaddr4 || "") : (it.doomedRow.ipaddr6 || "");
        cells.push(td(doomedIp));
        cells.push(td(it.keeperRow?.id || (it.keeperError || "—")));
        const keeperIp = it.keeperRow ? (it.family === 4 ? (it.keeperRow.ipaddr4 || "") : (it.keeperRow.ipaddr6 || "")) : "";
        cells.push(td(keeperIp));

        const mergeCell = document.createElement("td");
        Object.assign(mergeCell.style, { padding: "6px 8px", verticalAlign: "top", fontFamily: "monospace", fontSize: "11px" });
        const mergePlan = it.gates?.mergePlan;
        if (mergePlan && (mergePlan.merge || mergePlan.blockers)) {
          const mergeEntries = Object.entries(mergePlan.merge || {});
          const blockers = mergePlan.blockers || [];
          if (mergeEntries.length === 0 && blockers.length === 0) {
            mergeCell.textContent = "—";
            mergeCell.style.color = "#6b7280";
          } else {
            for (const [field, value] of mergeEntries) {
              const span = document.createElement("span");
              const keeperVal = it.keeperRow ? it.keeperRow[field] : "";
              const before = isMergeableValue(keeperVal) ? String(keeperVal) : "\u2205";
              span.textContent = `${field}: ${before} → ${value}`;
              span.title = "Will be PUT into keeper before DELETE";
              Object.assign(span.style, { display: "block", color: "#15803d" });
              mergeCell.appendChild(span);
            }
            for (const b of blockers) {
              const span = document.createElement("span");
              const d = isMergeableValue(b.doomed) ? String(b.doomed) : "\u2205";
              const k = isMergeableValue(b.keeper) ? String(b.keeper) : "\u2205";
              span.textContent = `${b.kind}:${b.field} (doomed=${d}, keeper=${k})`;
              span.title = "Manual reconciliation required — gate 8 blocks DELETE.";
              Object.assign(span.style, { display: "block", color: "#b91c1c" });
              mergeCell.appendChild(span);
            }
          }
        } else {
          mergeCell.textContent = "(pending)";
          mergeCell.style.color = "#6b7280";
        }
        cells.push(mergeCell);

        const gatesCell = document.createElement("td");
        Object.assign(gatesCell.style, { padding: "6px 8px", verticalAlign: "top", fontFamily: "monospace", fontSize: "11px" });
        if (it.gates) {
          for (const g of it.gates.gates) {
            const span = document.createElement("span");
            span.textContent = (g.ok ? "✓ " : "✗ ") + g.name;
            span.title = g.detail || "";
            Object.assign(span.style, { display: "block", color: g.ok ? "#15803d" : "#b91c1c" });
            gatesCell.appendChild(span);
          }
        } else {
          gatesCell.textContent = "(pending)";
        }
        cells.push(gatesCell);

        cells.push(td(it.applyStatus || (it.gates?.ok ? "ready" : "locked")));

        for (const c of cells) tr.appendChild(c);
        tbody.appendChild(tr);
      }
      recomputeApplyEnabled();
    }
    render();

    async function refresh() {
      status.textContent = "Resolving keepers and fetching IX-F…";
      applyBtn.disabled = true; refreshBtn.disabled = true;
      try {
        // Fetch IX-F once for the whole batch.
        if (!ixfMap) {
          const ixfMeta = await fetchIxlanIxfMemberListUrl(ixlanId);
          if (ixfMeta.error || !ixfMeta.ixfUrl) {
            ixfError = ixfMeta.error || "no-ixf-url";
          } else {
            ixfUrlInUse = ixfMeta.ixfUrl;
            const ixfRes = await fetchIxfMemberExport(ixfMeta.ixfUrl);
            if (ixfRes.error || !ixfRes.data) {
              ixfError = ixfRes.error || "no-data";
            } else {
              ixfMap = extractIxfAsnIpPairs(ixfRes.data);
              ixfError = "";
            }
          }
        }
        // Resolve keepers and run gates for each item.
        for (const it of items) {
          const ipKey = it.family === 4 ? "ipaddr4" : "ipaddr6";
          if (!it.keeperRow) {
            const kRes = await findKeeperForConflict({
              ixlanId, doomedId: it.doomedRow.id, asn: it.doomedRow.asn,
              family: it.family, newIp: it.newIp,
            });
            it.keeperRow = kRes.keeper;
            it.keeperError = kRes.error;
          }
          if (it.keeperRow) {
            it.gates = verifyConflictGates({
              doomedRow: it.doomedRow,
              keeperRow: it.keeperRow,
              payload,
              ixfMap,
              family: it.family,
            });
          } else {
            it.gates = { ok: false, gates: [{ name: "keeper-resolution", ok: false, detail: it.keeperError || "no-keeper" }] };
          }
          render();
        }
        const ok = items.filter((it) => it.gates?.ok).length;
        const ixfState = ixfMap ? `IX-F ok (${ixfMap.size} ASNs)` : `IX-F unavailable (${ixfError || "?"})`;
        status.textContent = `${items.length} conflict item(s) — ${ok} pass all 8 gates • ${ixfState}`;
      } finally {
        refreshBtn.disabled = false;
        recomputeApplyEnabled();
      }
    }

    refreshBtn.addEventListener("click", () => { refresh(); });
    cancelApplyBtn.addEventListener("click", () => { cancelSignal.cancelled = true; });

    applyBtn.addEventListener("click", async () => {
      if (getNormalizedTypedIxlanId() !== normalizedExpectedIxlanId) {
        status.textContent = `Type the ixlan id "${normalizedExpectedIxlanId || ixlanId}" exactly to enable Apply.`;
        return;
      }
      const selected = items.filter((it) => it.selected && it.gates?.ok);
      if (selected.length === 0) { status.textContent = "Nothing selected to apply."; return; }
      const mergeRows = selected.filter((it) => it.gates?.mergePlan && Object.keys(it.gates.mergePlan.merge || {}).length > 0);
      const confirmed = window.confirm(
        `Resolve ${selected.length} netixlan conflict(s)?\n\n` +
        (mergeRows.length > 0
          ? `${mergeRows.length} row(s) will PUT keeper to absorb fields before DELETE:\n` +
            mergeRows.map((it) => `  → keeper #${it.keeperRow?.id}: ${Object.keys(it.gates.mergePlan.merge).join(", ")}`).join("\n") + "\n\n"
          : "") +
        `Then DELETE the following doomed row(s):\n` +
        selected.map((it) => `• ASN ${it.doomedRow.asn} — netixlan #${it.doomedRow.id} (IPv${it.family}: ${it.family === 4 ? it.doomedRow.ipaddr4 : it.doomedRow.ipaddr6})`).join("\n") +
        `\n\nNo DELETE runs unless its keeper PUT both succeeded and verified.\nThis action cannot be undone via the userscript.\nPress OK to proceed.`,
      );
      if (!confirmed) return;
      applyBtn.disabled = true; refreshBtn.disabled = true;
      cancelApplyBtn.style.display = ""; cancelSignal = { cancelled: false };
      const outcomes = await applyConflictDeletes(selected, payload, ixfMap, cancelSignal, (it, update) => {
        it.applyStatus = update.status === "in-flight" ? "deleting…" : `${update.status}${update.httpStatus ? ` (${update.httpStatus})` : ""}${update.error ? ` — ${update.error}` : ""}${update.gateFailed ? ` [gate:${update.gateFailed}]` : ""}`;
        render();
      });
      recordConflictResolveAuditEntry({ ixlanId, ticketId, ixfUrl: ixfUrlInUse, payload, outcomes });
      applyBtn.disabled = false; refreshBtn.disabled = false; cancelApplyBtn.style.display = "none";
      const done = outcomes.filter((o) => o.status === "done" || o.status === "done-keeper-missing").length;
      const aborted = outcomes.filter((o) => o.status === "aborted").length;
      const delFailed = outcomes.filter((o) => o.status === "delete-failed").length;
      const cancelled = outcomes.filter((o) => o.status === "cancelled").length;
      status.textContent = `Apply complete — deleted:${done} aborted:${aborted} delete-failed:${delFailed} cancelled:${cancelled}`;
    });

    await refresh();
  }

  // ── Recent IP Changes Audit Report (helpers) ───────────────────────────────
  // Per-ixlan diagnostic that lists every netixlan whose IP address(es)
  // changed within the last RECENT_IP_CHANGES_WINDOW_MIN minutes. Merges
  // two sources: (a) PDB API filtered by ?updated__gte=... for current
  // state + authoritative timestamp; (b) local audit logs from the three
  // mutation modules (renumber, IX-F merge, conflict-resolve) for the
  // "old" address that the API can no longer show. Read-only.
  // -------------------------------------------------------------------------

  /**
   * Fetches netixlan rows updated within the last `windowMinutes` minutes on
   * a given ixlan. Falls back to a client-side filter if the server rejects
   * `updated__gte`.
   * Purpose: Retrieve the authoritative current state for the report.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} ixlanId
   * @param {number} windowMinutes
   * @returns {Promise<{ rows: object[], cutoffIso: string, source: string, error: string }>}
   */
  async function fetchRecentNetixlanChanges(ixlanId, windowMinutes) {
    const id = String(ixlanId || "").trim();
    if (!/^\d+$/.test(id)) return { rows: [], cutoffIso: "", source: "", error: "bad-ixlan-id" };
    const cutoffMs = Date.now() - Math.max(1, Number(windowMinutes) || 60) * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    // Try server-side filter first.
    try {
      const serverUrl = `${PEERINGDB_API_BASE_URL}/netixlan?ixlan_id=${encodeURIComponent(id)}&updated__gte=${encodeURIComponent(cutoffIso)}&depth=0&limit=250`;
      const data = await pdbFetch(serverUrl);
      const rows = Array.isArray(data?.data) ? data.data : [];
      return { rows, cutoffIso, source: "server-filter", error: "" };
    } catch (_serverErr) {
      // Fallback: pull recent and client-filter.
    }
    try {
      const fallbackUrl = `${PEERINGDB_API_BASE_URL}/netixlan?ixlan_id=${encodeURIComponent(id)}&depth=0&limit=250`;
      const data = await pdbFetch(fallbackUrl);
      const rowsAll = Array.isArray(data?.data) ? data.data : [];
      const rows = rowsAll.filter((r) => {
        const t = Date.parse(String(r.updated || ""));
        return Number.isFinite(t) && t >= cutoffMs;
      });
      return { rows, cutoffIso, source: "client-filter", error: "" };
    } catch (_fallbackErr) {
      return { rows: [], cutoffIso, source: "", error: "fetch-failed" };
    }
  }

  /**
   * Walks all three local audit logs (renumber, IX-F merge, conflict-
   * resolve) and emits outcome entries within `windowMinutes` of now.
   * Purpose: Provide the "old IP" side of the merge for IP changes the
   * userscript itself performed.
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
   * @param {number} windowMinutes
   * @param {string} ixlanFilter - When non-empty, restricts to that ixlan id.
   * @returns {Array<{ netixlanId: string, asn: string, oldIp4: string,
   *                   newIp4: string, oldIp6: string, newIp6: string,
   *                   source: string, ts: string, deleted: boolean,
   *                   keeperId: string }>}
   */
  function readAllNetixlanAuditOutcomes(windowMinutes, ixlanFilter) {
    const storage = getDomainCacheStorage();
    if (!storage) return [];
    const cutoffMs = Date.now() - Math.max(1, Number(windowMinutes) || 60) * 60 * 1000;
    const out = [];

    const readList = (key) => {
      try {
        const raw = String(storage.getItem(key) || "").trim();
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        return [];
      }
    };
    const ixlanMatches = (entryIxlanId) => {
      if (!ixlanFilter) return true;
      return String(entryIxlanId || "").trim() === String(ixlanFilter).trim();
    };
    const tsOk = (ts) => {
      const t = Date.parse(String(ts || ""));
      return Number.isFinite(t) && t >= cutoffMs;
    };

    // Renumber audit: { ts, ixlanId, ticketId, payload, rows: [{ netixlanId, asn, oldIp4, newIp4, oldIp6, newIp6, status }] }
    for (const entry of readList(IXLAN_RENUMBER_AUDIT_LOG_STORAGE_KEY)) {
      if (!tsOk(entry?.ts) || !ixlanMatches(entry?.ixlanId)) continue;
      for (const o of (entry.rows || [])) {
        if (o?.status !== "done") continue;
        out.push({
          netixlanId: String(o.netixlanId || ""),
          asn: String(o.asn || ""),
          oldIp4: String(o.oldIp4 || ""),
          newIp4: String(o.newIp4 || ""),
          oldIp6: String(o.oldIp6 || ""),
          newIp6: String(o.newIp6 || ""),
          source: "renumber",
          ts: String(entry.ts || ""),
          deleted: false,
          keeperId: "",
        });
      }
    }
    // IX-F merge: { ts, ixlanId, outcomes: [{ asn, keeperId, otherId, ipv4, ipv6, status }] }
    for (const entry of readList(IXF_MEMBER_AUDIT_LOG_STORAGE_KEY)) {
      if (!tsOk(entry?.ts) || !ixlanMatches(entry?.ixlanId)) continue;
      for (const o of (entry.outcomes || [])) {
        if (o?.status !== "done") continue;
        // Keeper was PUT with both addresses — its "old" v6 was empty if it
        // was the v4-only row, and vice versa. We can't know that direction
        // without more state, so we just record the merged IPs as the new
        // state and leave oldIp4/oldIp6 blank for the API merge step to
        // overlay current state.
        out.push({
          netixlanId: String(o.keeperId || ""),
          asn: String(o.asn || ""),
          oldIp4: "",
          newIp4: String(o.ipv4 || ""),
          oldIp6: "",
          newIp6: String(o.ipv6 || ""),
          source: "ixf-merge-keeper",
          ts: String(entry.ts || ""),
          deleted: false,
          keeperId: "",
        });
        // The sibling row was DELETEd.
        out.push({
          netixlanId: String(o.otherId || ""),
          asn: String(o.asn || ""),
          oldIp4: "",
          newIp4: "",
          oldIp6: "",
          newIp6: "",
          source: "ixf-merge-deleted",
          ts: String(entry.ts || ""),
          deleted: true,
          keeperId: String(o.keeperId || ""),
        });
      }
    }
    // Conflict-resolve: { ts, ixlanId, outcomes: [{ doomedId, keeperId, asn, oldIp4, oldIp6, status, mergePlan?, phase? }] }
    for (const entry of readList(CONFLICT_RESOLVE_AUDIT_LOG_STORAGE_KEY)) {
      if (!tsOk(entry?.ts) || !ixlanMatches(entry?.ixlanId)) continue;
      for (const o of (entry.outcomes || [])) {
        if (o?.status !== "done" && o?.status !== "done-keeper-missing") continue;
        out.push({
          netixlanId: String(o.doomedId || ""),
          asn: String(o.asn || ""),
          oldIp4: String(o.oldIp4 || ""),
          newIp4: "",
          oldIp6: String(o.oldIp6 || ""),
          newIp6: "",
          source: "conflict-resolve",
          ts: String(entry.ts || ""),
          deleted: true,
          keeperId: String(o.keeperId || ""),
          absorbedFromId: "",
        });
        // If the resolver absorbed fields into the keeper before deleting
        // the doomed row (gate 8 / two-phase apply), emit a synthetic
        // record so the keeper surfaces in Recent IP Changes with the
        // values it picked up and an "absorbed from #<doomedId>" hint.
        const mergePlan = o.mergePlan && typeof o.mergePlan === "object" ? o.mergePlan : null;
        if (mergePlan && (mergePlan.ipaddr4 || mergePlan.ipaddr6) && o.keeperId) {
          out.push({
            netixlanId: String(o.keeperId),
            asn: String(o.asn || ""),
            oldIp4: "",
            newIp4: String(mergePlan.ipaddr4 || ""),
            oldIp6: "",
            newIp6: String(mergePlan.ipaddr6 || ""),
            source: "conflict-resolve-absorbed",
            ts: String(entry.ts || ""),
            deleted: false,
            keeperId: "",
            absorbedFromId: String(o.doomedId || ""),
          });
        }
      }
    }
    return out;
  }

  /**
   * Merges PDB API rows with local audit outcomes, keyed by netixlan id.
   * Purpose: API gives current state and authoritative timestamp; logs give
   * the historical "old IP" the API can no longer show.
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {object[]} apiRows - From fetchRecentNetixlanChanges().
   * @param {object[]} logOutcomes - From readAllNetixlanAuditOutcomes().
   * @returns {Array<{ netixlanId: string, asn: string, name: string,
   *                   oldIp4: string, newIp4: string, oldIp6: string,
   *                   newIp6: string, deleted: boolean, keeperId: string,
   *                   sources: string[], ts: string }>}
   */
  function mergeAuditSources(apiRows, logOutcomes) {
    const byId = new Map();
    for (const row of (apiRows || [])) {
      const id = String(row.id || "");
      if (!id) continue;
      byId.set(id, {
        netixlanId: id,
        asn: String(row.asn || ""),
        name: String(row.name || ""),
        oldIp4: "",
        newIp4: String(row.ipaddr4 || ""),
        oldIp6: "",
        newIp6: String(row.ipaddr6 || ""),
        deleted: false,
        keeperId: "",
        absorbedFromId: "",
        sources: ["api"],
        ts: String(row.updated || ""),
      });
    }
    for (const o of (logOutcomes || [])) {
      const id = String(o.netixlanId || "");
      if (!id) continue;
      let cur = byId.get(id);
      if (!cur) {
        cur = {
          netixlanId: id,
          asn: String(o.asn || ""),
          name: "",
          oldIp4: "",
          newIp4: "",
          oldIp6: "",
          newIp6: "",
          deleted: false,
          keeperId: "",
          absorbedFromId: "",
          sources: [],
          ts: String(o.ts || ""),
        };
        byId.set(id, cur);
      }
      if (o.oldIp4 && !cur.oldIp4) cur.oldIp4 = o.oldIp4;
      if (o.oldIp6 && !cur.oldIp6) cur.oldIp6 = o.oldIp6;
      if (o.absorbedFromId && !cur.absorbedFromId) cur.absorbedFromId = o.absorbedFromId;
      if (o.deleted) {
        cur.deleted = true;
        if (o.keeperId) cur.keeperId = o.keeperId;
        // The API may still return the row briefly after delete; trust the log.
        cur.newIp4 = "";
        cur.newIp6 = "";
      } else if (!cur.newIp4 && o.newIp4) {
        cur.newIp4 = o.newIp4;
      }
      if (!cur.deleted && !cur.newIp6 && o.newIp6) cur.newIp6 = o.newIp6;
      if (!cur.asn && o.asn) cur.asn = o.asn;
      if (!cur.sources.includes(o.source)) cur.sources.push(o.source);
      // Prefer the most recent timestamp.
      const curT = Date.parse(cur.ts);
      const oT = Date.parse(o.ts);
      if (Number.isFinite(oT) && (!Number.isFinite(curT) || oT > curT)) cur.ts = o.ts;
    }
    return Array.from(byId.values()).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }

  /**
   * Renders merged audit entries to the operator-facing line format.
   * Purpose: One line per IP family that changed; DELETE rows get a
   * "(deleted; superseded by #<keeperId>)" suffix.
   * Format: "<Network name> (AS<asn>); netixlan #<id>; <oldIP> → <newIP>"
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {object[]} merged - From mergeAuditSources().
   * @returns {string[]} One string per emitted line.
   */
  function formatRecentChangeLines(merged) {
    const lines = [];
    for (const m of (merged || [])) {
      const namePart = m.name ? m.name : "(unknown network)";
      const asnPart = m.asn ? `AS${m.asn}` : "AS?";
      const idPart = m.netixlanId ? `netixlan #${m.netixlanId}` : "netixlan #?";
      if (m.deleted) {
        // Emit one line per family with a known oldIp.
        if (m.oldIp4) {
          const suffix = m.keeperId ? `(deleted; superseded by #${m.keeperId})` : "(deleted)";
          lines.push(`${namePart} (${asnPart}); ${idPart}; ${m.oldIp4} → ${suffix}`);
        }
        if (m.oldIp6) {
          const suffix = m.keeperId ? `(deleted; superseded by #${m.keeperId})` : "(deleted)";
          lines.push(`${namePart} (${asnPart}); ${idPart}; ${m.oldIp6} → ${suffix}`);
        }
        if (!m.oldIp4 && !m.oldIp6) {
          const suffix = m.keeperId ? `(deleted; superseded by #${m.keeperId})` : "(deleted)";
          lines.push(`${namePart} (${asnPart}); ${idPart}; ? → ${suffix}`);
        }
        continue;
      }
      const v4Changed = (m.oldIp4 || m.newIp4) && m.oldIp4 !== m.newIp4;
      const v6Changed = (m.oldIp6 || m.newIp6) && m.oldIp6 !== m.newIp6;
      const absorbedSuffix = m.absorbedFromId ? ` (absorbed from #${m.absorbedFromId})` : "";
      if (v4Changed) {
        lines.push(`${namePart} (${asnPart}); ${idPart}; ${m.oldIp4 || "?"} → ${m.newIp4 || "?"}${absorbedSuffix}`);
      }
      if (v6Changed) {
        lines.push(`${namePart} (${asnPart}); ${idPart}; ${m.oldIp6 || "?"} → ${m.newIp6 || "?"}${absorbedSuffix}`);
      }
      // Row exists in API window but local log has no "old IP" — still
      // surface it so operators see all touched rows.
      if (!v4Changed && !v6Changed && m.sources.includes("api")) {
        const v4 = m.newIp4 || "(no v4)";
        const v6 = m.newIp6 || "(no v6)";
        lines.push(`${namePart} (${asnPart}); ${idPart}; current: ${v4} / ${v6} (no historical IP recorded)`);
      }
    }
    return lines;
  }

  /**
   * Backfills missing network names on merged entries via /api/net.
   * Purpose: API-only rows already carry a `name` field, but log-only rows
   * (e.g. DELETE entries where the row is gone) do not.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {object[]} merged - From mergeAuditSources().
   * @returns {Promise<void>} Mutates entries in place.
   */
  async function backfillNetworkNames(merged) {
    const asnsNeedingName = Array.from(new Set(
      (merged || []).filter((m) => !m.name && /^\d+$/.test(String(m.asn || ""))).map((m) => String(m.asn)),
    ));
    if (asnsNeedingName.length === 0) return;
    try {
      const url = `${PEERINGDB_API_BASE_URL}/net?asn__in=${encodeURIComponent(asnsNeedingName.join(","))}&depth=0&limit=${asnsNeedingName.length}`;
      const data = await pdbFetch(url);
      const nets = Array.isArray(data?.data) ? data.data : [];
      const byAsn = new Map(nets.map((n) => [String(n.asn), String(n.name || "")]));
      for (const m of merged) {
        if (!m.name) {
          const name = byAsn.get(String(m.asn));
          if (name) m.name = name;
        }
      }
    } catch (_error) {
      // Best-effort; report continues to render without names.
    }
  }

  /**
   * Opens the Recent IP Changes report modal for one ixlan.
   * Purpose: Read-only audit view; text area + sortable table + copy.
   * @ai Preserve menu command registration behavior and gating on feature flag.
   * @param {string} ixlanId - Numeric ixlan id.
   */
  async function openRecentIpChangesModal(ixlanId) {
    const id = String(ixlanId || "").trim();
    const BACKDROP_ID = `${MODULE_PREFIX}RecentIpChangesBackdrop`;
    document.getElementById(BACKDROP_ID)?.remove();
    const backdrop = document.createElement("div");
    backdrop.id = BACKDROP_ID;
    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.45)",
      zIndex: "2147483646", display: "flex", alignItems: "center", justifyContent: "center",
    });
    const modal = document.createElement("div");
    Object.assign(modal.style, {
      background: "#fff", color: "#111", padding: "16px 20px",
      borderRadius: "8px", width: "min(1100px, 96vw)", maxWidth: "96vw",
      maxHeight: "92vh", display: "flex", flexDirection: "column",
      boxSizing: "border-box", minHeight: "0", minWidth: "0",
      boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
      font: "13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif",
    });

    const header = document.createElement("h2");
    header.textContent = `Recent IP Changes — ixlan #${id} (last ${RECENT_IP_CHANGES_WINDOW_MIN} min)`;
    Object.assign(header.style, { margin: "0 0 6px", fontSize: "16px" });
    const status = document.createElement("div");
    Object.assign(status.style, { margin: "4px 0", color: "#444", minHeight: "1.4em" });

    const textArea = document.createElement("textarea");
    textArea.readOnly = true;
    Object.assign(textArea.style, {
      width: "100%", minHeight: "240px", maxHeight: "60vh", fontFamily: "monospace",
      fontSize: "12px", boxSizing: "border-box", padding: "8px",
      border: "1px solid #ddd", borderRadius: "4px", resize: "vertical",
    });

    const buttonRow = document.createElement("div");
    Object.assign(buttonRow.style, {
      display: "flex", flexDirection: "row-reverse", justifyContent: "flex-start", alignItems: "center",
      gap: "10px", marginTop: "10px", flexWrap: "wrap", rowGap: "10px", width: "100%", minWidth: "0", flexShrink: "0",
    });
    // Desktop-only strict single-line variant, right-start with fixed spacing.
    if (window.matchMedia("(min-width: 1024px)").matches) {
      Object.assign(buttonRow.style, { flexWrap: "nowrap", rowGap: "0", overflowX: "auto", overflowY: "hidden" });
    }

    const shapeIconButton = (btn) => {
      Object.assign(btn.style, {
        width: "34px", minWidth: "34px", height: "34px", padding: "0",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: "16px", lineHeight: "1", fontWeight: "700",
        margin: "0", flex: "0 0 34px", boxSizing: "border-box",
      });
    };
    const iconLabel = (btn, icon, label) => {
      btn.textContent = icon;
      btn.title = label;
      btn.setAttribute("aria-label", label);
    };

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    Object.assign(closeBtn.style, { border: "1px solid #bbb", background: "#f5f5f5", borderRadius: "5px", cursor: "pointer" });
    shapeIconButton(closeBtn);
    iconLabel(closeBtn, "\u2715", "Close");

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    Object.assign(copyBtn.style, { border: "1px solid #bbb", background: "#f5f5f5", borderRadius: "5px", cursor: "pointer" });
    shapeIconButton(copyBtn);
    iconLabel(copyBtn, "\u2398", "Copy");

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    Object.assign(refreshBtn.style, { border: "1px solid #1a73e8", background: "#1a73e8", color: "#fff", borderRadius: "5px", cursor: "pointer" });
    shapeIconButton(refreshBtn);
    iconLabel(refreshBtn, "\u21bb", "Refresh");

    // Right-start fixed-offset strip (icons), then flow leftward.
    buttonRow.append(refreshBtn, copyBtn, closeBtn);

    modal.appendChild(header);
    modal.appendChild(status);
    modal.appendChild(textArea);
    modal.appendChild(buttonRow);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    closeBtn.addEventListener("click", () => backdrop.remove());

    async function refresh() {
      refreshBtn.disabled = true; copyBtn.disabled = true;
      status.textContent = "Fetching…";
      try {
        const [apiRes] = await Promise.all([
          fetchRecentNetixlanChanges(id, RECENT_IP_CHANGES_WINDOW_MIN),
        ]);
        const logOutcomes = readAllNetixlanAuditOutcomes(RECENT_IP_CHANGES_WINDOW_MIN, id);
        const merged = mergeAuditSources(apiRes.rows, logOutcomes);
        await backfillNetworkNames(merged);
        const lines = formatRecentChangeLines(merged);
        textArea.value = lines.length ? lines.join("\n") : "(no IP changes recorded in window)";
        const srcNote = apiRes.error ? `API: ${apiRes.error}` : `API: ${apiRes.source} (${apiRes.rows.length} rows)`;
        status.textContent = `Cut-off ${apiRes.cutoffIso} — ${lines.length} line(s) • ${srcNote} • Local audit outcomes: ${logOutcomes.length}`;
      } finally {
        refreshBtn.disabled = false; copyBtn.disabled = false;
      }
    }

    refreshBtn.addEventListener("click", () => { refresh(); });
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(textArea.value);
      status.textContent = ok ? `Copied ${textArea.value.split("\n").length} line(s) to clipboard.` : "Copy failed.";
    });

    await refresh();
  }

  /**
   * Returns a reason code when API JSON action should be blocked.
   * Purpose: Keep visibility and click-policy checks consistent.
   * Necessity: Some entities may not expose status reliably; block only when policy-relevant.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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

  const ACTION_ICON_EMOJI_BY_TYPE = Object.freeze({
    submenu: "☰",
    "new-tab": "↗",
    "same-tab": "→",
    "cp-new-tab": "🛠↗",
    "cp-same-tab": "🛠→",
    "fp-new-tab": "🌐↗",
    "fp-same-tab": "🌐→",
  });

  /**
   * Detects whether Font Awesome is already available on the page.
   * Purpose: Optional icon-class support without adding dependencies.
   * Necessity: Keep icon rendering emoji-first and dependency-free by default.
   * @returns {boolean} True when a likely Font Awesome stylesheet is present.
   */
  function isFontAwesomeLoaded() {
    return Boolean(
      qs('link[href*="font-awesome" i], link[href*="fontawesome" i], style[id*="font-awesome" i]')
    );
  }

  /**
   * Parses a link destination into a compact icon action type.
   * Purpose: Infer icon intent from current href/target behavior with minimal call-site edits.
   * Necessity: Preserve YAGNI by reusing existing routing semantics.
   * @param {{ href?: string, target?: string, defaultTarget?: string }} args - Link metadata.
   * @returns {string} Resolved action type key, or empty string when not inferable.
   */
  function detectActionTypeFromLink({ href = "", target = "", defaultTarget = "_blank" } = {}) {
    const normalizedHref = String(href || "").trim();
    if (!normalizedHref || normalizedHref === "#") return "";

    const effectiveTarget = String(target || defaultTarget || "_blank").trim();
    const isSameTab = effectiveTarget === "_self";

    let parsed = null;
    try {
      parsed = new URL(normalizedHref, window.location.origin);
    } catch (_error) {
      return isSameTab ? "same-tab" : "new-tab";
    }

    const hostname = String(parsed.hostname || "").toLowerCase();
    const isPeeringDbHost =
      hostname === "peeringdb.com" ||
      hostname === "www.peeringdb.com" ||
      hostname === "beta.peeringdb.com";

    if (!isPeeringDbHost) {
      return isSameTab ? "same-tab" : "new-tab";
    }

    const isCpPath = String(parsed.pathname || "").startsWith("/cp/");
    if (isCpPath) {
      return isSameTab ? "cp-same-tab" : "cp-new-tab";
    }

    return isSameTab ? "fp-same-tab" : "fp-new-tab";
  }

  /**
   * Sets button/link text and appends a right-side icon suffix.
   * Purpose: Centralize icon decoration for toolbar and dropdown actions.
   * Necessity: Keep icon behavior consistent across CP action constructors.
   * @param {HTMLElement} element - Target clickable element.
   * @param {string} label - Base label text.
   * @param {{ actionType?: string, iconEmoji?: string, iconFaClass?: string }} [opts] - Icon options.
   */
  function setActionLabelWithIcon(element, label, { actionType = "", iconEmoji = "", iconFaClass = "" } = {}) {
    if (!element) return;

    const baseLabel = String(label || "").trim();
    const suffixEmoji = String(iconEmoji || "").trim() || ACTION_ICON_EMOJI_BY_TYPE[actionType] || "";
    element.textContent = suffixEmoji ? `${baseLabel} ${suffixEmoji}` : baseLabel;

    const faClass = String(iconFaClass || "").trim();
    if (!faClass || !isFontAwesomeLoaded()) return;

    const iconNode = document.createElement("i");
    iconNode.className = faClass;
    iconNode.style.marginLeft = "4px";
    iconNode.setAttribute("aria-hidden", "true");
    element.appendChild(iconNode);
  }

  /**
   * Creates and inserts a toolbar action button (link) into the primary toolbar.
   * Purpose: Standardized way to add custom buttons (Google Maps, Frontend links, etc.).
   * Necessity: Ensures consistent styling, idempotency (prevents duplicates), and placement.
   * Marks buttons with data-pdb-cp-action attribute for reordering and identification.
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ id: string, label: string, href?: string, onClick?: Function,
   *           target?: string|null, insertLeft?: boolean }} opts
   * @returns {HTMLAnchorElement|null} The created anchor element, or null on failure.
   */
  function addToolbarAction({
    id,
    label,
    href = "#",
    onClick,
    target = null,
    insertLeft = false,
    iconType = "",
    iconEmoji = "",
    iconFaClass = "",
  }) {
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
    setActionLabelWithIcon(a, label, {
      actionType: iconType || detectActionTypeFromLink({ href, target, defaultTarget: "_blank" }),
      iconEmoji,
      iconFaClass,
    });
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ id: string, label: string, items: Array<{label: string, href: string, target?: string}>,
   *           resolveItemTarget?: Function }} opts
   * @returns {{ li: HTMLLIElement, toggle: HTMLAnchorElement }|null}
   */
  function createDropdownActionListItem({
    id,
    label,
    items,
    resolveItemTarget = null,
    iconType = "",
    iconEmoji = "",
    iconFaClass = "",
  }) {
    if (!id || !Array.isArray(items) || items.length === 0) return null;
    ensureDropdownGlobalCloseListener();

    const li = document.createElement("li");
    li.style.position = "relative";
    li.style.overflow = "visible";

    const toggle = document.createElement("a");
    toggle.id = id;
    toggle.href = "#";
    setActionLabelWithIcon(toggle, label, {
      actionType: iconType || "submenu",
      iconEmoji,
      iconFaClass,
    });
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
      setActionLabelWithIcon(link, String(item?.label || "Action"), {
        actionType:
          String(item?.iconType || "").trim() ||
          detectActionTypeFromLink({ href: item?.href, target: item?.target, defaultTarget: "_blank" }),
        iconEmoji: String(item?.iconEmoji || "").trim(),
        iconFaClass: String(item?.iconFaClass || "").trim(),
      });

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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ id: string, label: string, items: Array<{label: string, href: string}>,
   *           insertLeft?: boolean }} opts
   * @returns {HTMLAnchorElement|null} The dropdown toggle anchor element, or null on failure.
   */
  function addToolbarDropdownAction({
    id,
    label,
    items,
    insertLeft = false,
    iconType = "",
    iconEmoji = "",
    iconFaClass = "",
  }) {
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
      iconType,
      iconEmoji,
      iconFaClass,
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
   * @param {{ id: string, label: string, href?: string, title?: string, onClick: Function }} opts
   * @returns {HTMLAnchorElement|null} The created anchor element, or null on failure.
   */
  function addSecondaryActionButton({
    id,
    label,
    href = "#",
    title = "",
    onClick,
    iconType = "",
    iconEmoji = "",
    iconFaClass = "",
  }) {
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
    setActionLabelWithIcon(button, label, {
      actionType: iconType || detectActionTypeFromLink({ href, target: "_blank", defaultTarget: "_blank" }),
      iconEmoji,
      iconFaClass,
    });
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
   * @param {{ id: string, label: string, items: Array<{label: string, href: string}> }} opts
   * @returns {HTMLAnchorElement|null} The dropdown toggle anchor element, or null on failure.
   */
  function addSecondaryDropdownAction({ id, label, items, iconType = "", iconEmoji = "", iconFaClass = "" }) {
    const row = getOrCreateSecondaryActionRow();
    if (!row || !id || !Array.isArray(items) || items.length === 0) return null;

    const existing = qs(`#${id}`);
    if (existing) return existing;

    const dropdown = createDropdownActionListItem({
      id,
      label,
      items,
      iconType,
      iconEmoji,
      iconFaClass,
    });
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
   * @param {string} entity - Lowercase CP entity type (e.g., "carrier").
   * @param {string|number} entityId - CP entity record ID.
   * @returns {Promise<string|null>} Resolved organization name, or null on failure.
   */
  async function getOrganizationNameFromEntityApi(entity, entityId) {
    const resource = getEntityApiResourceByEntity(entity);
    if (!resource || !entityId) return null;

    const orgIdFromForm = normalizeOrgIdForCache(getInputValue("#id_org"));
    if (orgIdFromForm) {
      const resolvedFromOrgId = await getOrganizationName(orgIdFromForm);
      if (resolvedFromOrgId) return resolvedFromOrgId;
    }

    try {
      const endpoint = getPeeringDbApiObjectUrl(resource, entityId);
      if (!endpoint) return null;

      const payload = await pdbFetch(endpoint);
      const entityData = getFirstApiDataItem(payload, endpoint);
      const resolved = String(entityData?.org_name || "").trim();
      if (!resolved) return null;

      const normalizedResolved = sanitizeRdapOrgName(resolved);

      const orgIdFromPayload = normalizeOrgIdForCache(entityData?.org_id);
      if (orgIdFromPayload) {
        setCachedOrganizationName(orgIdFromPayload, normalizedResolved);
      }
      return normalizedResolved;
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
   * @param {string|number} orgId - Organization ID to fetch.
   * @returns {Promise<{name: string, wasMalformed: boolean, knownAs: string}>} Name, malformation flag, and extracted AKA.
   */
  async function getOrganizationNameWithMalformationDetection(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return { name: null, wasMalformed: false, knownAs: "" };

    const globalCachedName = getCachedOrganizationName(normalizedOrgId);
    if (globalCachedName) {
      return {
        name: sanitizeRdapOrgName(globalCachedName),
        wasMalformed: false,
        knownAs: "",
      };
    }

    const tabCachedName = getSessionCachedOrganizationName(normalizedOrgId);
    if (tabCachedName) {
      const sanitized = sanitizeRdapOrgName(tabCachedName);
      setCachedOrganizationName(normalizedOrgId, sanitized);
      return {
        name: sanitized,
        wasMalformed: false,
        knownAs: "",
      };
    }

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
   * @ai Keep behavior stable and prefer minimal, localized edits.
   * @param {string|number} orgId - Organization ID to resolve.
   * @returns {Promise<string|null>} Sanitized organization name or null on failure.
   */
  async function getOrganizationName(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return null;

    const globalCached = getCachedOrganizationName(normalizedOrgId);
    if (globalCached) {
      // Still sanitize cached values in case they were stored before sanitization was added
      return sanitizeRdapOrgName(globalCached);
    }

    const tabCached = getSessionCachedOrganizationName(normalizedOrgId);
    if (tabCached) {
      const sanitizedTabCached = sanitizeRdapOrgName(tabCached);
      setCachedOrganizationName(normalizedOrgId, sanitizedTabCached);
      return sanitizedTabCached;
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
      .${MODULE_PREFIX}FieldLinkButton {
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
        text-decoration: none;
      }
      .${MODULE_PREFIX}FieldLinkButton:hover {
        background: #efefef;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Ensures CSS styles are available for inline rows marked for deletion.
   * Purpose: Make pending inline deletions visually obvious before save.
   * Necessity: Grappelli delete checkboxes can be easy to miss in dense tabular inlines.
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
   * @param {Element|null} element - Delete checkbox or delete icon descendant.
   * @returns {HTMLElement|null} Owning `.form-row.grp-dynamic-form` element.
   */
  function getInlineDeleteRowElement(element) {
    return element?.closest(".form-row.grp-dynamic-form") || null;
  }

  /**
   * Applies/removes the marked-for-deletion visual state on an inline row.
   * @ai Keep behavior stable and prefer minimal, localized edits.
   * @param {HTMLElement|null} row - Inline row element.
   * @param {boolean} isMarkedForDelete - Whether delete checkbox is active.
   */
  function setInlineDeleteRowHighlight(row, isMarkedForDelete) {
    if (!row) return;
    row.classList.toggle(`${MODULE_PREFIX}InlineMarkedDelete`, Boolean(isMarkedForDelete));
  }

  /**
   * Syncs highlight state for one inline row based on its DELETE checkbox value.
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
    qsa(`a.${MODULE_PREFIX}FieldLinkButton`, clone).forEach((link) => link.remove());
    return normalizeRenderedCopyText(clone.textContent || "");
  }

  /**
   * Extracts the first valid CIDR prefix from rendered field text.
   * Purpose: Resolve IX prefix values into deep-link compatible inputs.
   * Necessity: Prefix rows may contain plain text and multiple values.
   * @param {string} text - Rendered value text from a CP field.
   * @returns {string} First valid CIDR string, or empty string when absent.
   */
  function extractFirstCidrPrefix(text) {
    const source = String(text || "");
    const candidates = source.match(/(?:\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b)|(?:\b[0-9a-fA-F:]+\/\d{1,3}\b)/g) || [];

    for (const candidate of candidates) {
      const cidr = String(candidate || "").trim();
      if (!cidr) continue;

      if (cidr.includes(".")) {
        const [ip, prefixText] = cidr.split("/");
        const prefix = Number(prefixText);
        const octets = String(ip || "").split(".");
        const isValidIpv4 =
          octets.length === 4 &&
          octets.every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255) &&
          Number.isInteger(prefix) &&
          prefix >= 0 &&
          prefix <= 32;
        if (isValidIpv4) return cidr;
        continue;
      }

      if (cidr.includes(":")) {
        const [ip, prefixText] = cidr.split("/");
        const prefix = Number(prefixText);
        const isValidIpv6 =
          Boolean(ip) &&
          String(ip).includes(":") &&
          Number.isInteger(prefix) &&
          prefix >= 0 &&
          prefix <= 128;
        if (isValidIpv6) return cidr;
      }
    }

    return "";
  }

  /**
   * Builds a BGP.HE prefix deep-link URL.
   * @param {string} prefix - Prefix CIDR.
   * @returns {string} BGP.HE URL.
   */
  function buildBgpHePrefixUrl(prefix) {
    return `https://bgp.he.net/net/${encodeURI(String(prefix || "").trim())}`;
  }

  /**
   * Builds a BGP.tools prefix deep-link URL.
   * @param {string} prefix - Prefix CIDR.
   * @returns {string} BGP.tools URL.
   */
  function buildBgpToolsPrefixUrl(prefix) {
    return `https://bgp.tools/prefix/${encodeURI(String(prefix || "").trim())}`;
  }

  /**
   * Adds a copy icon button to each rendered form value container.
   * Purpose: Make every visible field value directly copiable from the CP UI.
   * Necessity: Admin workflows often require copying readonly values such as Prefixes.
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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

      const labelText = getFieldLabelText(valueCell);
      const prefix = labelText === "prefixes" ? extractFirstCidrPrefix(initialValue) : "";
      if (!prefix) return;

      const heLink = document.createElement("a");
      heLink.className = `${MODULE_PREFIX}FieldLinkButton`;
      heLink.href = buildBgpHePrefixUrl(prefix);
      heLink.target = "_blank";
      heLink.rel = "noopener noreferrer";
      heLink.textContent = "BGP.HE";
      heLink.title = `Open in BGP.HE (${prefix})`;
      heLink.setAttribute("aria-label", `Open in BGP.HE for ${prefix}`);
      valueCell.appendChild(heLink);

      const toolsLink = document.createElement("a");
      toolsLink.className = `${MODULE_PREFIX}FieldLinkButton`;
      toolsLink.href = buildBgpToolsPrefixUrl(prefix);
      toolsLink.target = "_blank";
      toolsLink.rel = "noopener noreferrer";
      toolsLink.textContent = "BGP.TOOLS";
      toolsLink.title = `Open in BGP.TOOLS (${prefix})`;
      toolsLink.setAttribute("aria-label", `Open in BGP.TOOLS for ${prefix}`);
      valueCell.appendChild(toolsLink);
    });
  }

  /**
   * Determines the frontend URL path for a CP entity (network, carrier, ix).
   * Purpose: Generate correct copy-to-clipboard URL for the current entity type.
   * Necessity: Different entity types map to different URL paths.
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve shared storage/cache key contracts and TTL behavior.
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
   * @ai Preserve normalization/parsing rules and backward-compatible output formats.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
      * @ai Preserve the permissive `AS`-prefix stripping and positive-integer guard so RDAP lookups reject malformed identifiers without throwing.
      * @param {string|number} value - Raw ASN input from UI fields or callers.
      * @returns {number|null} Parsed ASN integer, or null when invalid.
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
      * @ai Keep this normalization limited to trailing slashes only so bootstrap hostnames and paths are preserved exactly as published.
      * @param {string} baseUrl - Candidate RDAP service base URL.
      * @returns {string|null} Normalized base URL, or null when empty.
     */
    function normalizeBaseUrl(baseUrl) {
      if (!baseUrl) return null;
      return String(baseUrl).replace(/\/+$/, "");
    }

    /**
     * Fetches JSON from URL using the shared pdbFetch client.
     * Purpose: Delegate cross-origin RDAP requests to the unified network abstraction.
     * Necessity: Centralises timeout, retry, and User-Agent header construction.
      * @ai Preserve delegation to `pdbFetch` with the RDAP Accept header so RDAP traffic keeps the same retry, timeout, and header behavior as the rest of the script.
      * @param {string} url - Absolute RDAP or bootstrap URL.
      * @returns {Promise<object|null>} Parsed JSON payload, or null when the request fails.
     */
    function requestJson(url) {
      return pdbFetch(url, { headers: { Accept: RDAP_ACCEPT_HEADER } });
    }

    /**
     * Fetches or retrieves cached IANA RDAP bootstrap registry.
     * Purpose: Get list of RDAP service providers for various ASN ranges.
     * Necessity: Bootstrap registry maps ASN ranges to RDAP endpoints; 6-hour TTL cache
     * reduces load on IANA servers. Required before any RDAP autnum queries.
      * @ai Preserve the TTL cache semantics and null-on-failure behavior so RDAP resolution degrades safely without thrashing IANA bootstrap requests.
      * @returns {Promise<object|null>} Bootstrap payload, or null when unavailable.
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
      * @ai Keep range parsing strict and side-effect free because bootstrap data can contain unexpected values and callers depend on a simple boolean result.
      * @param {number} asn - Parsed ASN integer.
      * @param {string} rangeText - Hyphen-separated range from the bootstrap payload.
      * @returns {boolean} True when the ASN falls inside the range.
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
      * @ai Preserve HTTPS preference and the first-match behavior so RDAP endpoint selection remains deterministic across bootstrap provider lists.
      * @param {object|null} bootstrap - IANA bootstrap payload.
      * @param {number} asn - Parsed ASN integer.
      * @returns {string|null} Normalized RDAP base URL, or null when no match exists.
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
      * @ai Preserve the bootstrap lookup step before the record fetch so requests stay aligned with the current authoritative RIR endpoint for the ASN.
      * @param {number} asn - Parsed ASN integer.
      * @returns {Promise<object|null>} RDAP autnum payload, or null when lookup fails.
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
      * @ai Keep this accessor tolerant of malformed RDAP arrays and always return a string so candidate scoring stays defensive.
      * @param {*} vcardArray - RDAP vCard array payload.
      * @param {string} propertyName - Lowercase property name to read.
      * @returns {string} Trimmed property value, or an empty string.
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
      * @ai Preserve the recursive accumulation and relative scoring weights because downstream organization resolution assumes this ranking model when multiple RDAP entities are present.
      * @param {Array} entities - RDAP entity array to traverse.
      * @param {Array<{ value: string, score: number }>} [candidates=[]] - Accumulator for scored candidates.
      * @param {number} [depth=0] - Current recursion depth used to down-rank nested entities.
      * @returns {Array<{ value: string, score: number }>} Candidate list sorted later by the caller.
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
      * @ai Preserve the sanitize-after-ranking flow so RDAP cleanup does not change candidate scoring inputs or mask the best raw match.
      * @param {object|null} payload - RDAP autnum payload.
      * @returns {string|null} Best sanitized organization name, or null when no candidate is found.
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
      * @ai Preserve the cache semantics and null-on-failure contract because callers treat this as an optional enrichment step rather than a hard dependency.
      * @param {string|number} asnInput - Raw ASN value from the current workflow.
      * @returns {Promise<string|null>} Resolved organization name, or null when unavailable.
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
      * @ai Keep cache clearing limited to in-memory RDAP state so manual invalidation does not unexpectedly affect unrelated CP caches.
      * @returns {void}
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
   * @ai Preserve request retries/timeouts/error classification and payload assumptions.
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
          iconType: "submenu",
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
          iconType: "submenu",
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
                iconType: "cp-new-tab",
              });
            }

            if (/^\d+$/.test(networkId)) {
              addToolbarAction({
                id: `${MODULE_PREFIX}NetworkIxlanNetCp`,
                label: getEntityCpLabel("network"),
                href: `/cp/peeringdb_server/network/${networkId}/change/`,
                target: "_new",
                insertLeft: true,
                iconType: "cp-new-tab",
              });
            }

            if (/^\d+$/.test(ixId)) {
              addToolbarAction({
                id: `${MODULE_PREFIX}NetworkIxlanIxCp`,
                label: getEntityCpLabel("internetexchange"),
                href: `/cp/peeringdb_server/ixlanprefix/?q=${encodeURIComponent(ixId)}`,
                target: "_new",
                insertLeft: true,
                iconType: "cp-new-tab",
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
          const entityName = getInputValue("#id_name");
          const copyText = entityName ? `${entityName} | ${entityUrl}` : `${entityCopyLabel} | ${entityUrl}`;
          addSecondaryActionButton({
            id: `${MODULE_PREFIX}CopyEntityUrl`,
            label: entityCopyLabel,
            href: entityUrl,
            title: entityUrl,
            onClick: async (event) => {
              const copied = await copyToClipboard(copyText);
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
            // Priority A: Get org name from dropdown selection
            let orgName = (qs("#id_org > option[selected]")?.innerText || "").trim();

            // Priority B: Check global cache if dropdown is empty
            if (!orgName) {
              orgName = getCachedOrganizationName(orgId) || "";
            }

            // Priority C: Check tab-session cache if global cache misses
            if (!orgName) {
              orgName = getSessionCachedOrganizationName(orgId) || "";
            }

            // Priority D: API fetch if cache miss and status is not deleted
            if (!orgName) {
              const status = String(getSelectedStatus() || "").trim().toLowerCase();
              if (status !== "deleted") {
                try {
                  const data = await pdbFetch(`/api/v2/org/${orgId}/`);
                  if (data) {
                    const fetchedName = String(data?.name || "").trim();
                    if (fetchedName) {
                      orgName = fetchedName;
                      setCachedOrganizationName(orgId, fetchedName);
                    }
                  }
                } catch (_error) {
                  // Silently fall through to URI-only copy
                }
              }
            }

            // Priority E: Build copy text (org name + URL or URI only)
            const copyText = orgName ? `${orgName} | ${orgUrl}` : orgUrl;
            const copied = await copyToClipboard(copyText);
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
          iconType: "submenu",
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
      preconditions: () => Boolean(qs("#grp-content-title")),
      run: (ctx) => {
        const grainyIdentity = getGrainyDerivedLinkIdentity(ctx);

        const objTypeWebsiteUrl = String(
          getInputValue("#id_website") || getReadonlyFieldLinkHrefByLabel("Website") || "",
        ).trim();
        if (/^https?:\/\//i.test(objTypeWebsiteUrl)) {
          const objTypeTarget = `pdb_${grainyIdentity}_objtype_website`;
          addSecondaryActionButton({
            id: `${MODULE_PREFIX}ObjTypeWebsite`,
            label: getEntityWebsiteLabel(ctx.entity),
            href: objTypeWebsiteUrl,
            title: objTypeWebsiteUrl,
            onClick: () => {
              const resolvedUrl = new URL(objTypeWebsiteUrl, window.location.origin).toString();
              window.open(resolvedUrl, objTypeTarget, "noopener");
            },
          });
        }

        const objOrgWebsiteUrl = String(getReadonlyFieldLinkHrefByLabel("Org website") || "").trim();
        if (/^https?:\/\//i.test(objOrgWebsiteUrl)) {
          const objOrgTarget = `pdb_${grainyIdentity}_objorg_website`;
          addSecondaryActionButton({
            id: `${MODULE_PREFIX}ObjOrgWebsite`,
            label: "Org Website",
            href: objOrgWebsiteUrl,
            title: objOrgWebsiteUrl,
            onClick: () => {
              const resolvedUrl = new URL(objOrgWebsiteUrl, window.location.origin).toString();
              window.open(resolvedUrl, objOrgTarget, "noopener");
            },
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
            iconType: "fp-new-tab",
          });

          addToolbarAction({
            id: `${MODULE_PREFIX}OrganizationCp`,
            label: getEntityCpLabel("organization"),
            href: `/cp/peeringdb_server/organization/${orgId}/change/`,
            target: "_new",
            iconType: "cp-new-tab",
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
              iconType: "cp-new-tab",
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
          iconType: "submenu",
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
    {
      id: "ixlan-renumber-peers",
      match: (ctx) =>
        Boolean(ctx?.isEntityListPage) &&
        ctx?.entity === "networkixlan" &&
        Boolean(parseRenumberHash(window.location.hash)),
      preconditions: () => isFeatureEnabled("ixlanRenumber") && Boolean(getToolbarList()),
      run: () => {
        const payload = parseRenumberHash(window.location.hash);
        if (!payload) return;
        addToolbarAction({
          id: `${MODULE_PREFIX}RenumberIxlanPeers`,
          label: CP_LIST_PAGE_ACTION_LABELS.RENUMBER_IXLAN_PEERS,
          insertLeft: true,
          onClick: async (event) => {
            const actionLockKey = `${MODULE_PREFIX}.ixlanRenumber`;
            if (!tryBeginActionLock(actionLockKey)) {
              notifyUser({
                title: "PeeringDB CP",
                text: "Renumber tooling is already running.",
              });
              return;
            }
            try {
              await openIxlanRenumberModal(payload);
            } catch (error) {
              console.error(`[${MODULE_PREFIX}] Renumber modal failed`, error);
              notifyUser({
                title: "PeeringDB CP",
                text: "Renumber tooling failed. See console for details.",
              });
            } finally {
              endActionLock(actionLockKey);
            }
          },
        });
      },
    },
    {
      id: "ix-f-member-audit",
      match: (ctx) => Boolean(ctx?.isEntityListPage) && ctx?.entity === "networkixlan",
      preconditions: () => isFeatureEnabled("ixfMemberAudit") && Boolean(getToolbarList()),
      run: () => {
        addToolbarAction({
          id: `${MODULE_PREFIX}AuditIxfMembers`,
          label: CP_LIST_PAGE_ACTION_LABELS.AUDIT_IXF_MEMBERS,
          insertLeft: true,
          onClick: async () => {
            const actionLockKey = `${MODULE_PREFIX}.ixfMemberAudit`;
            if (!tryBeginActionLock(actionLockKey)) {
              notifyUser({ title: "PeeringDB CP", text: "IX-F audit is already running." });
              return;
            }
            try {
              let ixlanId = parseIxlanFilterFromChangelistUrl(window.location.href);
              if (!ixlanId) {
                const promptResponse = window.prompt(
                  "Enter the ixlan id to audit against its IX-F member-export URL:",
                  "",
                );
                ixlanId = String(promptResponse || "").trim();
                if (!/^\d+$/.test(ixlanId)) {
                  notifyUser({ title: "PeeringDB CP", text: "Aborted: ixlan id is required for IX-F audit." });
                  return;
                }
              }
              await openIxfMemberAuditModal(ixlanId);
            } catch (error) {
              console.error(`[${MODULE_PREFIX}] IX-F audit failed`, error);
              notifyUser({ title: "PeeringDB CP", text: "IX-F audit failed. See console for details." });
            } finally {
              endActionLock(actionLockKey);
            }
          },
        });
      },
    },
    {
      id: "recent-ip-changes",
      match: (ctx) => Boolean(ctx?.isEntityListPage) && ctx?.entity === "networkixlan",
      preconditions: () => isFeatureEnabled("recentIpChanges") && Boolean(getToolbarList()),
      run: () => {
        addToolbarAction({
          id: `${MODULE_PREFIX}RecentIpChanges`,
          label: CP_LIST_PAGE_ACTION_LABELS.RECENT_IP_CHANGES,
          insertLeft: true,
          onClick: async () => {
            const actionLockKey = `${MODULE_PREFIX}.recentIpChanges`;
            if (!tryBeginActionLock(actionLockKey)) {
              notifyUser({ title: "PeeringDB CP", text: "Recent IP changes report is already open." });
              return;
            }
            try {
              let ixlanId = parseIxlanFilterFromChangelistUrl(window.location.href);
              if (!ixlanId) {
                const promptResponse = window.prompt(
                  `Enter the ixlan id to report IP changes for (last ${RECENT_IP_CHANGES_WINDOW_MIN} min):`,
                  "",
                );
                ixlanId = String(promptResponse || "").trim();
                if (!/^\d+$/.test(ixlanId)) {
                  notifyUser({ title: "PeeringDB CP", text: "Aborted: ixlan id is required for the IP changes report." });
                  return;
                }
              }
              await openRecentIpChangesModal(ixlanId);
            } catch (error) {
              console.error(`[${MODULE_PREFIX}] Recent IP changes report failed`, error);
              notifyUser({ title: "PeeringDB CP", text: "Recent IP changes report failed. See console for details." });
            } finally {
              endActionLock(actionLockKey);
            }
          },
        });
      },
    },
  ];

  /**
   * Executes all enabled modules that match the current route context.
   * Purpose: Central dispatcher that activates modules for the current page.
   * Necessity: Implements modular architecture; checks both enabled status and page match
   * before running each module. Catches and logs errors to prevent cascade failures.
   * @ai Preserve execution ordering, locks, and route/module boundaries.
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
   * @ai Preserve selector contracts and idempotent DOM mutation behavior.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
   * @ai Keep behavior stable and prefer minimal, localized edits.
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
