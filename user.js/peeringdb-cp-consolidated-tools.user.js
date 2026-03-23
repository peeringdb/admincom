// ==UserScript==
// @name         PeeringDB CP - Consolidated Tools
// @namespace    https://www.peeringdb.com/cp/
// @version      1.0.50.20260323
// @description  Consolidated CP userscript with strict route-isolated modules for facility/network/user/entity workflows
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/cp/peeringdb_server/*/*/change/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
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

(function () {
  "use strict";

  const MODULE_PREFIX = "pdbCpConsolidated";
  const DUMMY_ORG_ID = 20525;
  const DISABLED_MODULES_STORAGE_KEY = `${MODULE_PREFIX}.disabledModules`;
  const USER_AGENT_STORAGE_KEY = `${MODULE_PREFIX}.userAgent`;
  const SESSION_UUID_STORAGE_KEY = `${MODULE_PREFIX}.sessionUuid`;
  const TRUSTED_DOMAINS_FOR_UA = [
    "peeringdb.com",
    "*.peeringdb.com",
    "api.peeringdb.com",
    "127.0.0.1",
    "::1",
    "localhost",
  ];
  const DEFAULT_REQUEST_USER_AGENT = "PeeringDB-Admincom-CP-Consolidated";
  const ORG_NAME_CACHE_TTL_MS = 15 * 60 * 1000;
  const ORG_NAME_CACHE_STORAGE_PREFIX = `${MODULE_PREFIX}.orgNameCache.`;
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
  const openDropdownActionItems = new Set();
  let dropdownGlobalCloseListenerBound = false;

  /**
   * Closes a single dropdown action item and resets its toggle accessibility state.
   * Purpose: Provide centralized close behavior for toolbar and secondary-row dropdowns.
   * Necessity: Shared close logic prevents duplicated listener code per dropdown instance.
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
   * Normalizes organization ID into a stable cache key suffix.
   * Purpose: Ensure cache keys are deterministic across string/number ID inputs.
   * Necessity: Different call sites may pass IDs with whitespace or mixed types.
   */
  function normalizeOrgIdForCache(orgId) {
    return String(orgId || "").trim();
  }

  /**
   * Builds sessionStorage key used for persisted org-name cache entries.
   * Purpose: Keep all org-name cache keys namespaced under module prefix.
   * Necessity: Avoid collisions with other userscripts and local app storage keys.
   */
  function getOrgNameCacheStorageKey(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return "";
    return `${ORG_NAME_CACHE_STORAGE_PREFIX}${normalizedOrgId}`;
  }

  /**
   * Reads a valid organization-name cache entry from in-memory or session storage.
   * Purpose: Reuse recent org-name lookups to reduce repeated API requests.
   * Necessity: Update Name and Reset Information may request the same org repeatedly.
   * Returns null when cache is absent, malformed, or expired.
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
      const raw = window.sessionStorage?.getItem(storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const cachedName = String(parsed?.name || "").trim();
      const expiresAt = Number(parsed?.expiresAt || 0);
      if (!cachedName || !Number.isFinite(expiresAt) || expiresAt <= now) {
        window.sessionStorage?.removeItem(storageKey);
        return null;
      }

      orgNameMemoryCache.set(normalizedOrgId, { name: cachedName, expiresAt });
      return cachedName;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Stores organization-name cache entry in memory and session storage.
   * Purpose: Persist successful org-name lookups for current tab lifecycle.
   * Necessity: Avoid duplicate network requests for frequently used org IDs.
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
      window.sessionStorage?.setItem(
        storageKey,
        JSON.stringify({ name: normalizedName, expiresAt }),
      );
    } catch (_error) {
      // sessionStorage may be unavailable; memory cache still provides benefit.
    }
  }

  /**
   * Retrieves the set of disabled module IDs from localStorage.
   * Purpose: Allows individual modules to be toggled on/off without code changes.
   * Necessity: Provides user-level module control for the modular architecture.
   * Supports both JSON array and comma-separated formats for backward compatibility.
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
   */
  function isModuleEnabled(moduleId, disabledModules) {
    if (!moduleId) return false;
    return !disabledModules.has(moduleId);
  }

  /**
   * Retrieves explicit or auto-computed User-Agent for this session.
   * Purpose: Provide flexible UA configuration with fallback to trust-based generation.
   * Necessity: Allows manual override via localStorage while auto-computing from domain trust.
   */
  function getCustomRequestUserAgent() {
    const configured = String(window.localStorage?.getItem(USER_AGENT_STORAGE_KEY) || "").trim();
    if (configured) return configured;
    // Auto-compute trust-based UA if not explicitly configured
    return buildTrustBasedUserAgent(window.location.hostname);
  }

  /**
   * Generates or retrieves a persistent session UUID for the browser session.
   * Purpose: Provides a unique identifier for correlating requests within a session.
   * Necessity: Enables server-side analytics and request tracking without exposing device fingerprint.
   * UUID persists across page reloads but is cleared when tab/session closes.
   */
  function getSessionUuid() {
    const sessionKey = SESSION_UUID_STORAGE_KEY;
    let uuid = window.sessionStorage?.getItem(sessionKey);
    if (!uuid) {
      uuid = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      if (window.sessionStorage) {
        window.sessionStorage.setItem(sessionKey, uuid);
      }
    }
    return uuid;
  }

  /**
   * Computes a stable client fingerprint from browser/device attributes.
   * Purpose: Creates a privacy-preserving identifier for requests from untrusted domains.
   * Necessity: Balances analytics tracking with user privacy for non-trusted networks.
   * Returns a 16-character hex string derived from UA, platform, language, CPU count, memory.
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
   */
  function buildTampermonkeyRequestHeaders(baseHeaders = {}) {
    const headers = { ...baseHeaders };
    const configured = String(window.localStorage?.getItem(USER_AGENT_STORAGE_KEY) || "").trim();

    // Use configured UA if explicitly set, otherwise auto-compute from domain trust
    const userAgent =
      configured ||
      buildTrustBasedUserAgent(window.location.hostname);

    if (userAgent) {
      headers["User-Agent"] = userAgent;
    }
    return headers;
  }

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
    };
  }

  /**
   * Convenience wrapper for querySelector.
   * Purpose: Reduce boilerplate for DOM querying throughout the script.
   * Necessity: Used extensively for finding form fields and toolbar elements.
   * Wraps in try-catch to safely return null on selector errors.
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
   */
  function getInputValue(selector) {
    const element = qs(selector);
    if (!element) return "";

    if ("value" in element) {
      return String(element.value || "").trim();
    }

    return String(element.getAttribute("value") || "").trim();
  }

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
   * Generates a deterministic ASN-based network name with optional suffix.
   * Purpose: Provide sensible fallback names for networks when org lookup fails.
   * Necessity: Required field can't be empty; ASN is stable and visible on network pages.
   * Includes '#deleted' suffix for networks in deleted status.
   */
  function getDeterministicNetworkFallbackName(asn, networkId, suffix = "") {
    const cleaned = String(asn || "").replace(/^AS/i, "").trim();
    const parsedAsn = Number.parseInt(cleaned, 10);
    if (Number.isInteger(parsedAsn) && parsedAsn > 0) {
      return `AS${parsedAsn}${suffix}`;
    }

    return `AS${networkId}${suffix}`;
  }

  function getFrontendSlugByEntity(entity) {
    const slugByEntity = {
      facility: "fac",
      network: "net",
      organization: "org",
      carrier: "carrier",
      internetexchange: "ix",
      campus: "campus",
    };

    return slugByEntity[entity] || "";
  }

  function getEntityFrontendPath(ctx) {
    const slug = getFrontendSlugByEntity(ctx?.entity);
    if (!slug || !ctx?.entityId) return "";
    return `/${slug}/${ctx.entityId}`;
  }

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

  function getOrganizationIdForNameUpdate(ctx) {
    if (!ctx?.isEntityChangePage) return "";
    if (ctx.entity === "organization") return String(ctx.entityId || "").trim();
    return getInputValue("#id_org");
  }

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

    if (target) {
      a.target = target;
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
        if (target && target !== "_self") {
          window.open(resolvedUrl, target, "noopener");
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

  function createDropdownActionListItem({ id, label, items }) {
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

    items.forEach((item) => {
      const link = document.createElement("a");
      link.href = item.href;
      link.textContent = item.label;
      link.target = item.target || "_blank";
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

  function addToolbarDropdownAction({ id, label, items, insertLeft = false }) {
    if (!id || !Array.isArray(items) || items.length === 0) return null;

    const existing = qs(`#${id}`);
    if (existing) {
      return existing;
    }

    const toolbar = getToolbarList();
    if (!toolbar) return null;

    const dropdown = createDropdownActionListItem({ id, label, items });
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
   */
  function addSecondaryActionButton({ id, label, onClick }) {
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
    button.href = "#";
    button.textContent = label;
    button.style.cursor = "pointer";

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
   */
  function enforceToolbarButtonOrder(ctx) {
    if (!ctx?.isEntityChangePage) return;

    const primaryToolbar = getToolbarList();
    if (primaryToolbar) {
      reorderChildrenByPriority(primaryToolbar, [
        'li[data-pdb-cp-action="pdbCpConsolidatedResetNetworkInformation"]',
        'li[data-pdb-cp-action="pdbCpConsolidatedFrontend"]',
        'li[data-pdb-cp-action="pdbCpConsolidatedOrganizationFrontend"]',
        'li[data-pdb-cp-action="pdbCpConsolidatedOrganizationCp"]',
        isHistoryToolbarItem,
      ]);
    }

    const secondaryRow = qs(`#${MODULE_PREFIX}SecondaryActionRow`);
    if (secondaryRow) {
      reorderChildrenByPriority(secondaryRow, [
        'li[data-pdb-cp-secondary-action="pdbCpConsolidatedUpdateEntityName"]',
        'li[data-pdb-cp-secondary-action="pdbCpConsolidatedMapsDropdown"]',
        'li[data-pdb-cp-secondary-action="pdbCpConsolidatedCopyEntityUrl"]',
        'li[data-pdb-cp-secondary-action="pdbCpConsolidatedCopyOrganizationUrl"]',
      ]);
    }
  }

  /**
   * Fetches organization name from PeeringDB API by organization ID.
   * Purpose: Resolve human-readable org names for network initialization.
   * Necessity: Network name should match org name; API lookup is more reliable than manual lookup.
   * Returns null on network error or missing data (graceful degradation).
   */
  async function getOrganizationName(orgId) {
    const normalizedOrgId = normalizeOrgIdForCache(orgId);
    if (!normalizedOrgId) return null;

    const cached = getCachedOrganizationName(normalizedOrgId);
    if (cached) return cached;

    try {
      const response = await fetch(`https://www.peeringdb.com/api/org/${normalizedOrgId}`);
      if (!response.ok) return null;

      const payload = await response.json();
      const resolved = String(payload?.data?.[0]?.name || "").trim();
      if (!resolved) return null;

      setCachedOrganizationName(normalizedOrgId, resolved);
      return resolved;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Programmatically clicks the "Save and continue editing" button.
   * Purpose: Auto-submit form after automated edits (Reset Information, Update Name).
   * Necessity: Script-driven form changes need programmatic submission; improves UX.
   */
  function clickSaveAndContinue() {
    const button =
      qs("form input[name='_continue']") ||
      qs("form > div > footer > div input[name='_continue']") ||
      qs("form > div > footer > div > div:nth-child(4) > input[name='_continue']");

    if (!button) return false;
    button.click();
    return true;
  }

  /**
   * Prompts user to confirm dangerous network reset operation.
   * Purpose: Prevent accidental data loss from Reset Information action.
   * Necessity: Shows user which network is being reset (by ID, ASN, name) for confirmation.
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
   */
  async function copyToClipboard(text) {
    const value = String(text || "");
    if (!value) return false;

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
   * Shows a non-blocking userscript notification when supported.
   * Purpose: Surface completion/failure status for long-running CP actions.
   * Necessity: Async updates may complete after several network calls and benefit from toasts.
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
   * Normalizes text copied from rendered field contents.
   * Purpose: Remove excessive whitespace while preserving readable one-line output.
   * Necessity: Rendered HTML often contains line breaks and spacing artifacts.
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
   */
  function getSelectedStatus() {
    const option = qs("#id_status > option:checked") || qs("#id_status > option[selected]");
    return option ? String(option.getAttribute("value") || "") : "";
  }

  function getNameSuffixForDeletedEntity(entityId) {
    return getSelectedStatus() === "deleted" ? ` #${entityId}` : "";
  }

  /**
   * Marks inline form rows (POCs, netfacs, netixlans) for deletion if status = 'deleted'.
   * Purpose: Clean up stale inline items when network status is deleted.
   * Necessity: Automatic cleanup prevents orphaned POCs/facilities when network is marked deleted.
   */
  function clickDeleteHandlersForInlineSet(inlineSetPrefix) {
    qsa(`div.form-row.grp-dynamic-form[id^='${inlineSetPrefix}']`).forEach((row) => {
      if (row.id === `${inlineSetPrefix}-empty`) return;

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
    });
  }

  /**
   * Marks all deleted-status inline items for deletion across all inline sets.
   * Purpose: Centralize deletion of all stale inline items (POCs, facilities, ixlans).
   * Necessity: Ensures consistent cleanup of deleted network members across all relation types.
   */
  function markDeletedNetworkInlinesForDeletion() {
    clickDeleteHandlersForInlineSet("poc_set");
    clickDeleteHandlersForInlineSet("netfac_set");
    clickDeleteHandlersForInlineSet("netixlan_set");
  }

  // RDAP client module (fully isolated from feature modules)
  /**
   * Isolated RDAP AutoNum client for resolving organization names by ASN.
   * Purpose: Provide fallback organization name lookup via IANA RDAP bootstrap.
   * Necessity: When org lookup fails (org_id invalid), RDAP provides ASN-based name resolution.
   * Bootstraps RDAP service URLs from IANA registry with 6-hour TTL cache.
   */
  const rdapAutnumClient = (() => {
    const BOOTSTRAP_ASN_URL = "https://data.iana.org/rdap/asn.json"; // RFC 9224 bootstrap registry
    const RDAP_ACCEPT_HEADER = "application/rdap+json, application/json;q=0.8";

    const bootstrapCache = {
      loadedAt: 0,
      ttlMs: 6 * 60 * 60 * 1000,
      payload: null,
    };

    /**
     * Parses and validates ASN from string input.
     * Purpose: Convert ASN string (with or without "AS" prefix) to integer.
     * Necessity: Validates ASN format before RDAP queries.
     */
    function parseAsn(value) {
      const number = Number.parseInt(String(value || "").trim(), 10);
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
     * Fetches JSON from URL with proper headers and error handling.
     * Purpose: Unified JSON request helper for RDAP API calls.
     * Necessity: Uses Tampermonkey's GM_xmlhttpRequest for cross-origin CORS-free requests.
     */
    function requestJson(url) {
      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers: buildTampermonkeyRequestHeaders({ Accept: RDAP_ACCEPT_HEADER }),
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              try {
                resolve(JSON.parse(response.responseText));
              } catch (_err) {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          },
          onerror: () => resolve(null),
        });
      });
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
     */
    function resolveOrganizationNameFromAutnumPayload(payload) {
      const candidates = collectEntityCandidates(payload?.entities, []);
      if (!candidates.length) return null;

      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.value || null;
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

      console.log(`[rdapAutnumClient] Requesting RDAP for AS${asn}...`);

      try {
        const payload = await fetchAutnumRecord(asn);
        if (!payload) return null;

        const name = resolveOrganizationNameFromAutnumPayload(payload);
        if (name) {
          console.log(`[rdapAutnumClient] Successfully resolved AS${asn}: ${name}`);
        }
        return name;
      } catch (_error) {
        console.error(`[rdapAutnumClient] Error resolving AS${asn}`, _error);
        return null;
      }
    }

    return {
      resolveOrganizationNameByAsn,
    };
  })();

  /**
   * Executes comprehensive network reset clearing all fields to defaults.
   * Purpose: Prepare network record for re-initialization (especially for RDAP lookups).
   * Necessity: Reset Information action clears stale data before re-populating from API sources.
   * Preserves critical fields (name handles separately) and marks deleted inlines for removal.
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
      socialMedia.value = "{}";
    }

    eachInForm('input[type="checkbox"]', (item) => {
      item.checked = false;
    });
    eachInForm("#id_allow_ixp_update", (item) => {
      item.checked = true;
    });

    eachInForm('select[name*="info"]', (item) => {
      const firstOption = qs("option:first-child", item);
      if (firstOption) {
        firstOption.selected = true;
      }
    });
    eachInForm('select[name*="policy"]', (item) => {
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

  const modules = [
    {
      id: "copy-frontend-urls",
      match: (ctx) => ctx.isEntityChangePage,
      preconditions: () => Boolean(getToolbarList()),
      run: (ctx) => {
        const entityPath = getEntityFrontendPath(ctx);
        if (entityPath) {
          addSecondaryActionButton({
            id: `${MODULE_PREFIX}CopyEntityUrl`,
            label: getEntityCopyLabel(ctx.entity),
            onClick: async (event) => {
              const url = `https://www.peeringdb.com${entityPath}`;
              const copied = await copyToClipboard(url);
              if (copied) {
                pulseToolbarButton(event?.target, "Copied URL");
              }
            },
          });
        }

        const orgId = ctx.entity === "organization" ? "" : getInputValue("#id_org");
        if (!orgId) return;

        addSecondaryActionButton({
          id: `${MODULE_PREFIX}CopyOrganizationUrl`,
          label: "Copy Org URL",
          onClick: async (event) => {
            const url = `https://www.peeringdb.com/org/${orgId}`;
            const copied = await copyToClipboard(url);
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
      id: "highlight-dummy-org-child",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "facility",
      preconditions: () => Boolean(qs("#id_org") && qs("#grp-content-title h1") && qs("#grp-content")),
      run: () => {
        const orgId = parseInt(getInputValue("#id_org"), 10);
        if (!Number.isFinite(orgId) || orgId !== DUMMY_ORG_ID) return;

        const title = qs("#grp-content-title h1");
        const bgContainer = qs("#grp-content");

        if (title && !title.textContent.includes("CHILD OF DUMMY ORGANIZATION")) {
          title.innerHTML +=
            '<span style="text-align:center;color:red;font-weight:bold;"> CHILD OF DUMMY ORGANIZATION</span>';
        }

        if (bgContainer) {
          bgContainer.style.backgroundColor = "rgba(255, 255, 0, 0.5)";
        }
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
            label: "Org (front-end)",
            href: `/org/${orgId}`,
            target: "_new",
          });

          addToolbarAction({
            id: `${MODULE_PREFIX}OrganizationCp`,
            label: "Org",
            href: `/cp/peeringdb_server/organization/${orgId}/change/`,
            target: "_new",
          });
        }

        addToolbarAction({
          id: `${MODULE_PREFIX}Frontend`,
          label: "Frontend",
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
      id: "set-entity-name-equal-org-name",
      match: (ctx) =>
        ctx.isEntityChangePage &&
        ["network", "facility", "internetexchange", "organization", "carrier", "campus"].includes(ctx.entity),
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
            const appendName = getNameSuffixForDeletedEntity(ctx.entityId);
            let baseName;
            if (["organization", "facility", "internetexchange"].includes(ctx.entity)) {
              const rawName = getInputValue("#id_name");
              const existingSuffix = ` #${ctx.entityId}`;
              baseName = rawName.endsWith(existingSuffix)
                ? rawName.slice(0, -existingSuffix.length)
                : rawName;
            } else {
              const anchor = event?.target;
              if (anchor) {
                anchor.textContent = "Updating...";
                anchor.style.opacity = "0.7";
                anchor.style.pointerEvents = "none";
              }
              const orgId = getOrganizationIdForNameUpdate(ctx);
              baseName = await getOrganizationName(orgId);
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

            const nextName = `${baseName}${appendName}`;
            const currentName = getInputValue("#id_name");
            if (nextName === currentName) return;

            markDeletedNetworkInlinesForDeletion();
            setInputValue("#id_name", nextName);
            clickSaveAndContinue();
            notifyUser({
              title: "PeeringDB CP",
              text: `Update Name: saved '${nextName}'.`,
            });
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
            const asn = getInputValue("#id_asn");
            const networkName = getInputValue("#id_name");

            if (!confirmDangerousReset(asn, networkName, ctx.entityId)) {
              return;
            }

            const button = event.target;
            const originalLabel = button.textContent;
            button.textContent = "Processing...";
            button.style.opacity = "0.7";
            button.style.pointerEvents = "none";

            try {
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
              button.textContent = originalLabel;
              button.style.opacity = "1";
              button.style.pointerEvents = "auto";
            }
          },
        });
      },
    },
    {
      id: "deleted-entity-highlight",
      match: (ctx) => ctx.isEntityChangePage && ENTITY_TYPES.has(ctx.entity),
      preconditions: () => Boolean(qs("#id_status") && qs("#grp-content")),
      run: () => {
        if (getSelectedStatus() !== "deleted") return;

        const bgContainer = qs("#grp-content");
        if (bgContainer) {
          bgContainer.style.backgroundColor = "rgba(200, 30, 30, 0.07)";
        }

        const title = qs("#grp-content-title h1");
        if (title && !qs(".pdb-deleted-badge", title)) {
          const badge = document.createElement("span");
          badge.className = "pdb-deleted-badge";
          badge.style.cssText =
            "margin-left:10px;color:#c0392b;font-weight:bold;font-size:0.8em;letter-spacing:0.05em;vertical-align:middle;";
          badge.textContent = "DELETED";
          title.appendChild(badge);
        }
      },
    },
    {
      id: "set-window-title",
      match: (ctx) => ctx.isCp && ctx.isEntityChangePage,
      run: (ctx) => {
        const sep = " | ";
        let title = "";

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
      },
    },
  ];

  /**
   * Executes all enabled modules that match the current route context.
   * Purpose: Central dispatcher that activates modules for the current page.
   * Necessity: Implements modular architecture; checks both enabled status and page match
   * before running each module. Catches and logs errors to prevent cascade failures.
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
        console.warn(`[${MODULE_PREFIX}] module failed: ${module.id}`, error);
      }
    });
  }

  /**
   * Runs the complete initialization sequence for consolidated tools.
   * Purpose: Parse route, dispatch modules, and enforce button order on current page.
   * Necessity: Single entry point for all initialization logic; ensures modules run before layout.
   */
  function runConsolidatedInit() {
    const ctx = getRouteContext();

    if (!ctx.isCp || !ctx.isEntityChangePage) {
      return;
    }

    cleanupLegacyPrimaryActionRow();
    dispatchModules(ctx);
    enforceToolbarButtonOrder(ctx);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runConsolidatedInit, { once: true });
  } else {
    runConsolidatedInit();
  }
})();
