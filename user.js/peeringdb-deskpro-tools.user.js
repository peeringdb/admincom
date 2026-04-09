// ==UserScript==
// @name            PeeringDB DP - Consolidated Tools
// @namespace       https://www.peeringdb.com/
// @version         1.1.5.20260409
// @description     Consolidated DeskPro tools: linkifies ASN/org names (with ASN API name lookup), copies mailto addresses, and normalizes PeeringDB CP double-slash links
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
  const ACTION_LINK_ICON_ATTR = "data-pdb-action-link-icon";
  const ACTION_LINK_TEXT_ATTR = "data-pdb-action-link-text";
  const TARGET_ACTION_LINK_LABELS = new Set([
    "review affiliation/ownership request",
    "approve ownership request and notify user",
  ]);
  const PDB_CP_DOUBLE_SLASH_PREFIX = "https://www.peeringdb.com//cp/peeringdb_server";
  const PDB_CP_SINGLE_SLASH_PREFIX = "https://www.peeringdb.com/cp/peeringdb_server";
  const DEFAULT_REQUEST_USER_AGENT = "PeeringDB-Admincom-DP-Consolidated";
  const ASN_NAME_CACHE_STORAGE_PREFIX = "pdbDpConsolidated.asnNameCache.";
  const ASN_NAME_CACHE_SCHEMA_VERSION = 1;
  const ASN_API_TIMEOUT_MS = 12000;
  const ASN_API_RETRIES = 2;
  const ASN_NAME_CACHE_TTL_MS = 7.5 * 60 * 60 * 1000;

  const asnNameCache = new Map();
  const asnNameInFlight = new Map();

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
   * Builds localStorage key for ASN-name cache entries.
   * @param {string|number} asn - ASN value.
   * @returns {string} Namespaced cache key, or empty string when invalid.
   */
  function getAsnNameCacheStorageKey(asn) {
    const normalizedAsn = normalizeAsnForCache(asn);
    if (!normalizedAsn || !/^\d+$/.test(normalizedAsn)) return "";
    return `${ASN_NAME_CACHE_STORAGE_PREFIX}${normalizedAsn}`;
  }

  /**
   * Reads ASN name from localStorage cache when valid.
   * @param {string|number} asn - ASN value.
   * @returns {string|null} Cached ASN name, or null when absent/expired/invalid.
   */
  function getCachedAsnNameFromStorage(asn) {
    const storageKey = getAsnNameCacheStorageKey(asn);
    if (!storageKey) return null;

    try {
      const storage = getDomainCacheStorage();
      const raw = storage?.getItem(storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const cachedName = String(parsed?.name || "").trim();
      const expiresAt = Number(parsed?.expiresAt || 0);
      const schemaVersion = Number(parsed?.v ?? -1);
      const now = Date.now();
      if (
        !cachedName ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        schemaVersion !== ASN_NAME_CACHE_SCHEMA_VERSION
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
   * Stores ASN name into localStorage cache with TTL/schema metadata.
   * @param {string|number} asn - ASN value.
   * @param {string} name - Resolved network name.
   */
  function setCachedAsnNameInStorage(asn, name) {
    const storageKey = getAsnNameCacheStorageKey(asn);
    const normalizedName = String(name || "").trim();
    if (!storageKey || !normalizedName) return;

    try {
      const storage = getDomainCacheStorage();
      storage?.setItem(
        storageKey,
        JSON.stringify({
          v: ASN_NAME_CACHE_SCHEMA_VERSION,
          name: normalizedName,
          expiresAt: Date.now() + ASN_NAME_CACHE_TTL_MS,
        }),
      );
    } catch (_error) {
      // Ignore storage failures; in-memory cache still provides benefit.
    }
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
   * Returns the first item from PeeringDB list-style API payloads.
   * Purpose: Normalize shape handling for `/api/net?asn=` lookups.
   * @param {*} payload - Parsed API response.
   * @returns {object|null} First `data` entry, or null on malformed/empty payload.
   */
  function getFirstApiDataItem(payload) {
    if (!payload || typeof payload !== "object") return null;
    const data = payload.data;
    if (!Array.isArray(data) || data.length === 0) return null;
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
      const url = `https://www.peeringdb.com/api/net?asn=${encodeURIComponent(normalizedAsn)}`;
      const payload = await pdbFetch(url);
      const net = getFirstApiDataItem(payload);
      const resolved = String(net?.name || "").trim();

      asnNameCache.set(normalizedAsn, {
        name: resolved,
        expiresAt: Date.now() + ASN_NAME_CACHE_TTL_MS,
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
   * Hydrates an existing ASN link label with resolved API network name.
   * Purpose: Preserve fast initial rendering, then progressively enhance link text.
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
    anchor.title = `Open ASN${asn} (${resolvedName}) in PeeringDB`;
  }

  // Tags whose text content must never be linkified.
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
  ];

  // Quick pre-test — text nodes matching none of the rules are rejected early.
  const QUICK_TEST_REGEX = /\bASN?\d+\b|provided this ASN in their request:\s*\d+|wishes to be affiliated to Organization\s+['"\u201c\u201d\u2018\u2019][^'"\u201c\u201d\u2018\u2019\n]+['"\u201c\u201d\u2018\u2019]/i;

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
        hits.push({ start: match.index, end: match.index + match[0].length, rule, match });
      }
    }
    if (hits.length === 0) return null;

    hits.sort((a, b) => a.start - b.start);
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
   * Purpose: Run initial normalization/decorators and attach listeners/observer.
   */
  function init() {
    // Initial pass over whatever is already rendered.
    normalizePeeringDbCpDoubleSlashLinks(document.body);
    decorateTargetActionLinks(document.body);
    decorateMailtoLinks(document.body);
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
