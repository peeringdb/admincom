// ==UserScript==
// @name         PeeringDB FP - Consolidated Tools
// @namespace    https://www.peeringdb.com/
// @version      1.0.25.20260323
// @description  Consolidated FP userscript for PeeringDB frontend (Net/Org/Fac/IX/Carrier)
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/*
// @exclude      https://www.peeringdb.com/cp/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-consolidated-tools.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-consolidated-tools.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function () {
  "use strict";

  const MODULE_PREFIX = "pdbFpConsolidated";
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
  const DEFAULT_REQUEST_USER_AGENT = "PeeringDB-Admincom-FP-Consolidated";
  const OBSERVER_IDLE_DISCONNECT_MS = 2000;

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
   */
  function getCustomRequestUserAgent() {
    const configured = String(window.localStorage?.getItem(USER_AGENT_STORAGE_KEY) || "").trim();
    if (configured) return configured;
    return buildTrustBasedUserAgent(window.location.hostname);
  }

  /**
   * Constructs HTTP headers for Tampermonkey requests with User-Agent.
   * Purpose: Centralize header building for all script-initiated requests.
   * Necessity: Ensures consistent User-Agent and other important headers across all API calls.
   */
  function buildTampermonkeyRequestHeaders(baseHeaders = {}) {
    const headers = { ...baseHeaders };
    const configured = String(window.localStorage?.getItem(USER_AGENT_STORAGE_KEY) || "").trim();

    const userAgent =
      configured ||
      buildTrustBasedUserAgent(window.location.hostname);

    if (userAgent) {
      headers["User-Agent"] = userAgent;
    }
    return headers;
  }

  /**
   * Parses the current URL to extract route context (entity type, ID, page kind).
   * Purpose: Provide route info to modules for conditional execution.
   * Necessity: Enables modules to match specific pages (e.g., /net/1234) and determine
   * whether to run. Used by all modules' match() function.
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
   */
  function qs(selector, root = document) {
    return root.querySelector(selector);
  }

  /**
   * Retrieves trimmed innerText from a selected element.
   * Purpose: Safe extraction of display text for form fields and data fields.
   * Necessity: Provides consistent empty-string fallback vs. throwing on missing elements.
   */
  function getText(selector, root = document) {
    const el = qs(selector, root);
    return el ? el.innerText.trim() : "";
  }

  /**
   * Retrieves trimmed value from form input elements (input, select, textarea).
   * Purpose: Unified value extraction that handles both .value property and data attributes.
   * Necessity: Normalizes form field reading across different input types.
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
   * Copies text to clipboard with modern and fallback implementations.
   * Purpose: Enable "Copy URL" and similar copy actions for user convenience.
   * Necessity: Handles browsers with and without Clipboard API support.
   */
  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.error("Async: Could not copy text: ", err);
      });
    } else {
      // Fallback
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand("copy");
      } catch (err) {
        console.error("Fallback: Oops, unable to copy", err);
      }
      document.body.removeChild(textArea);
    }
  }

  /**
   * Retrieves the container element for top-right toolbar buttons.
   * Purpose: Centralize toolbar element selection with fallback selectors.
   * Necessity: Top-right button area varies in PeeringDB pages; needs fallback chain.
   */
  function getTopRightToolbarContainer(parentSelector = "div.right.button-bar > div:first-child") {
    return qs(parentSelector);
  }

  /**
   * Creates and appends an action button to the top-right toolbar.
   * Purpose: Standardized way to add custom links (Admin Console, BGP tools, etc.) to FP pages.
   * Necessity: Ensures consistent styling, idempotency (prevents duplicates), and event handling.
   * Marks buttons with data-pdb-fp-action attribute for later reordering and identification.
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
    btn.className = "btn btn-primary";
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
    }

    parent.appendChild(btn);
    return btn;
  }

  /**
   * Creates an overflow dropdown menu in the top-right toolbar.
   * Purpose: Provide a compact menu for multiple related tools (RIPEstat, BGPView, CIDR Report, etc.).
   * Necessity: Prevents toolbar overcrowding by grouping secondary network analysis tools.
   * Manages menu open/close state and click-outside dismissal.
   */
  function createTopRightOverflowMenu({
    actionId,
    label,
    items,
    parentSelector = "div.right.button-bar > div:first-child",
  }) {
    if (!actionId || !Array.isArray(items) || items.length === 0) return null;

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
    toggle.className = "btn btn-primary";
    toggle.href = "#";
    toggle.textContent = label;
    toggle.style.cursor = "pointer";
    toggle.style.display = "inline-block";
    toggle.style.width = "auto";
    toggle.style.maxWidth = "none";
    toggle.style.whiteSpace = "nowrap";
    toggle.style.flex = "0 0 auto";
    toggle.style.userSelect = "none";

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
      link.className = "btn btn-primary";
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = item.label;
      link.style.whiteSpace = "nowrap";
      link.style.display = "block";
      menu.appendChild(link);
    });

    wrapper.appendChild(toggle);
    wrapper.appendChild(menu);
    parent.appendChild(wrapper);

    const closeMenu = () => {
      menu.style.display = "none";
      wrapper.removeAttribute("data-open");
    };

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      const isOpen = wrapper.getAttribute("data-open") === "1";
      if (isOpen) {
        closeMenu();
      } else {
        menu.style.display = "grid";
        wrapper.setAttribute("data-open", "1");
      }
    });

    document.addEventListener("click", (event) => {
      if (wrapper.getAttribute("data-open") !== "1") return;
      if (!wrapper.contains(event.target)) {
        closeMenu();
      }
    });

    return wrapper;
  }

  /**
   * Tests if a DOM element matches a given priority (CSS selector or function).
   * Purpose: Support flexible matching in reorderChildrenByPriority (handles strings and predicates).
   * Necessity: Enables both CSS-based matching and custom function-based matching in one API.
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
   */
  function isNativeEditToolbarButton(child) {
    if (!child) return false;

    if (child.matches?.('a[data-edit-action="toggle-edit"]')) {
      return true;
    }

    return Boolean(qs('a[data-edit-action="toggle-edit"]', child));
  }

  /**
   * Applies flex layout to toolbar container for two-row button arrangement.
   * Purpose: Enable column-based layout with right alignment and gap spacing.
   * Necessity: Foundation for enforceTopRightButtonOrder two-row structure.
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
   */
  function routeTopRightButtonsToTwoRows(parent) {
    if (!parent) return;

    const row1 = ensureTopRightRowContainer(parent, "1");
    const row2 = ensureTopRightRowContainer(parent, "2");
    if (!row1 || !row2) return;

    const editButton = Array.from(parent.children).find((child) => isNativeEditToolbarButton(child));
    const adminButton = qs('a[data-pdb-fp-action="admin-console"]', parent);
    const copyUrlButton = qs('a[data-pdb-fp-action="copy-url"]', parent);
    const bgpToolsButton = qs('a[data-pdb-fp-action="bgp-tools"]', parent);
    const bgpHeNetButton = qs('a[data-pdb-fp-action="bgp-he-net"]', parent);
    const copyAsnButton = qs('a[data-pdb-fp-action="copy-asn"]', parent);
    const moreToolsButton = qs('[data-pdb-fp-action="network-tools-overflow"]', parent);

    // Route deterministic first-row actions.
    [editButton, adminButton, copyUrlButton].forEach((item) => {
      if (item) row1.appendChild(item);
    });

    // Route deterministic second-row actions.
    [bgpToolsButton, bgpHeNetButton, copyAsnButton, moreToolsButton].forEach((item) => {
      if (item) row2.appendChild(item);
    });

    // Keep row visibility clean when optional buttons are absent.
    row1.style.display = row1.children.length > 0 ? "flex" : "none";
    row2.style.display = row2.children.length > 0 ? "flex" : "none";
  }

  /**
   * Groups custom toolbar items by vertical pixel position (visual rows).
   * Purpose: Detect which buttons wrap to new lines due to narrow viewports.
   * Necessity: Understand natural wrapping behavior for spacing adjustments.
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
   * Enforces deterministic button order and layout in top-right toolbar.
   * Purpose: Coordinate layout detection, reordering, and two-row routing for consistent UX.
   * Necessity: Main orchestrator for toolbar DOM changes; detects when PeeringDB has already
   * laid out buttons and skips processing to avoid interfering with native layout.
   * Version 1.0.20 adds detection for pre-existing data-pdb-fp-row containers.
   */
  function enforceTopRightButtonOrder() {
    const parent = getTopRightToolbarContainer();
    if (!parent) return;

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
    // 3) keep BGP links at end of the custom sequence
    reorderChildrenByPriority(parent, [
      isNativeEditToolbarButton,
      'a[data-pdb-fp-action="admin-console"]',
      'a[data-pdb-fp-action="copy-url"]',
      'a[data-pdb-fp-action="bgp-tools"]',
      'a[data-pdb-fp-action="bgp-he-net"]',
      'a[data-pdb-fp-action="copy-asn"]',
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
            [
              { id: "bgp-tools", label: "BGP.TOOLS", url: `https://bgp.tools/as${asn}` },
              { id: "bgp-he-net", label: "BGP.HE", url: `https://bgp.he.net/as${asn}` },
            ].forEach((tool) => {
              createTopRightAction({
                actionId: tool.id,
                label: tool.label,
                href: tool.url,
                target: "_blank",
              });
            });

            createTopRightAction({
              actionId: "copy-asn",
              label: `Copy AS${asn}`,
              onClick: (e) => {
                copyToClipboard(`AS${asn}`);
                const btn = e.target;
                const orig = btn.innerText;
                btn.innerText = "Copied!";
                setTimeout(() => { btn.innerText = orig; }, 1000);
              },
            });

            createTopRightOverflowMenu({
              actionId: "network-tools-overflow",
              label: "More Tools",
              items: [
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

          // Remove edit button if no website (legacy feature port)
          const website = getText('div[data-edit-name="website"]');
          if (!website) {
            qs('div[data-edit-toggled="view"] a[data-edit-action="toggle-edit"]')?.remove();
          }
        }
      },
    },
    {
      id: "copy-record-data",
      match: (ctx) => ctx.isEntityPage,
      run: () => {
        addButton("Copy URL", () => {
          const name = getText('.view_title > div[data-edit-name="name"]');
          const uri = window.location.href;
          copyToClipboard(`${name} (${uri})`);
        }, "div.right.button-bar > div:first-child", "copy-url");
      },
    },
    {
      id: "copy-user-roles",
      match: (ctx) => ctx.type === "org" && ctx.isEntityPage,
      run: () => {
        const CP_EMAIL_SEARCH_BASE = "https://www.peeringdb.com/cp/account/emailaddress/?q=";
        const EMAIL_REGEX = /[A-Z0-9._+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

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

        const users = document.querySelectorAll(
          '#org-user-manager > div[data-edit-template="user-item"] > .editable'
        );

        users.forEach((item) => {
          const usernameRow = item.querySelector(".item > div:nth-child(1) > div:nth-child(2)");
          if (usernameRow && !usernameRow.querySelector("a[data-pdb-fp-username-search]")) {
            const username = Array.from(usernameRow.childNodes)
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => String(node.textContent || ""))
              .join(" ")
              .trim();

            if (username) {
              const usernameSearchLink = createCpSearchLink(
                username,
                "Search user by username in CP email address"
              );
              usernameSearchLink.setAttribute("data-pdb-fp-username-search", "true");

              const badge = usernameRow.querySelector("span.badge-2fa-enabled");
              if (badge) {
                badge.insertAdjacentElement("afterend", usernameSearchLink);
              } else {
                usernameRow.appendChild(usernameSearchLink);
              }
            }
          }

          const emailCell = item.querySelector(".item > div:nth-child(2)");
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

        // Insert before the submit button in the user manager
        const parent = qs("#org-user-manager > div:nth-child(5)");
        const refNode = qs('a[data-edit-action="submit"]', parent);

        if (!parent || !refNode) return;

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
          const admins = [];
          const members = [];

          const currentUsers = document.querySelectorAll(
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
          copyToClipboard(admins.join("\n"));
        });

        parent.insertBefore(btn, refNode);
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
        console.warn(`[${MODULE_PREFIX}] Module ${module.id} failed`, error);
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
  let consolidatedObserver = null;
  let observerDisconnectTimer = 0;

  /**
   * Determines the best DOM root to observe for FP dynamic updates.
   * Purpose: Minimize observer workload by avoiding full-body observation when possible.
   * Necessity: Broad body/subtree observation can trigger excessive callbacks on busy pages.
   */
  function getObserverRootNode() {
    return (
      getTopRightToolbarContainer() ||
      qs("#content") ||
      qs("#view") ||
      document.body
    );
  }

  /**
   * Disconnects the shared MutationObserver and clears pending disconnect timers.
   * Purpose: Stop observation after page stabilizes to reduce long-lived callback overhead.
   * Necessity: Observer is only needed during dynamic render bursts and route transitions.
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
   */
  function ensureConsolidatedObserver() {
    if (consolidatedObserver || !document.body) return;

    const rootNode = getObserverRootNode();
    if (!rootNode) return;

    consolidatedObserver = new MutationObserver((mutations) => {
      if (isInitRunning) return;

      const hasStructuralChange = mutations.some(
        (mutation) =>
          mutation.type === "childList" &&
          ((mutation.addedNodes && mutation.addedNodes.length > 0) ||
            (mutation.removedNodes && mutation.removedNodes.length > 0)),
      );

      if (!hasStructuralChange) return;

      scheduleConsolidatedInit();
      scheduleObserverDisconnect();
    });

    consolidatedObserver.observe(rootNode, { childList: true, subtree: true });
    scheduleObserverDisconnect();
  }

  function runConsolidatedInit() {
    const ctx = getRouteContext();
    isInitRunning = true;
    try {
      dispatchModules(ctx);
      enforceTopRightButtonOrder();
    } finally {
      isInitRunning = false;
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
   * Bootstrap the consolidated init system and attach event listeners.
   * Purpose: Initialize the script on page load or immediately if DOM is ready.
   * Necessity: Entry point that hooks into DOMContentLoaded, popstate (SPA navigation),
   * and DOM mutations to detect when init should run. Sets up MutationObserver for AJAX/PJAX pages.
   */
  function bootstrapConsolidatedInit() {
    scheduleConsolidatedInit();
    ensureConsolidatedObserver();

    const onRouteChange = () => {
      ensureConsolidatedObserver();
      scheduleConsolidatedInit();
    };

    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("hashchange", onRouteChange);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapConsolidatedInit, { once: true });
  } else {
    bootstrapConsolidatedInit();
  }
})();
