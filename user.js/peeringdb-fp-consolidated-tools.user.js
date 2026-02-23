// ==UserScript==
// @name         PeeringDB FP - Consolidated Tools
// @namespace    https://www.peeringdb.com/
// @version      1.0.3.20260223
// @description  Consolidated FP userscript for PeeringDB frontend (Net/Org/Fac/IX/Carrier)
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-consolidated-tools.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-consolidated-tools.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function () {
  "use strict";

  const MODULE_PREFIX = "pdbFpConsolidated";

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

  function qs(selector, root = document) {
    return root.querySelector(selector);
  }

  function getText(selector, root = document) {
    const el = qs(selector, root);
    return el ? el.innerText.trim() : "";
  }

  function getInputValue(selector, root = document) {
    const el = qs(selector, root);
    if (!el) return "";

    if ("value" in el) {
      return String(el.value || "").trim();
    }

    return String(el.getAttribute("value") || "").trim();
  }

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

  function getTopRightToolbarContainer(parentSelector = "div.right.button-bar > div:first-child") {
    return qs(parentSelector);
  }

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

  function isNativeEditToolbarButton(child) {
    if (!child) return false;

    if (child.matches?.('a[data-edit-action="toggle-edit"]')) {
      return true;
    }

    return Boolean(qs('a[data-edit-action="toggle-edit"]', child));
  }

  function applyTopRightToolbarFlexLayout(parent) {
    if (!parent) return;

    // Two-row layout host: rows are right-aligned and vertically spaced.
    parent.style.display = "flex";
    parent.style.flexDirection = "column";
    parent.style.alignItems = "flex-end";
    parent.style.rowGap = "6px";
  }

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
    const moreToolsButton = qs('[data-pdb-fp-action="network-tools-overflow"]', parent);

    // Route deterministic first-row actions.
    [editButton, adminButton, copyUrlButton].forEach((item) => {
      if (item) row1.appendChild(item);
    });

    // Route deterministic second-row actions.
    [bgpToolsButton, bgpHeNetButton, moreToolsButton].forEach((item) => {
      if (item) row2.appendChild(item);
    });

    // Keep row visibility clean when optional buttons are absent.
    row1.style.display = row1.children.length > 0 ? "flex" : "none";
    row2.style.display = row2.children.length > 0 ? "flex" : "none";
  }

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

  function enforceTopRightButtonOrder() {
    const parent = getTopRightToolbarContainer();
    if (!parent) return;

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
      '[data-pdb-fp-action="network-tools-overflow"]',
    ]);

    routeTopRightButtonsToTwoRows(parent);

    applyTopRightCustomSpacing(parent);
    applyTopRightWrappedRowOffset(parent);
  }

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
        // Insert before the submit button in the user manager
        const parent = qs("#org-user-manager > div:nth-child(5)");
        const refNode = qs('a[data-edit-action="submit"]', parent);

        if (!parent || !refNode) return;

        const btn = document.createElement("a");
        btn.className = "btn btn-default";
        btn.style.textAlign = "center";
        btn.style.marginRight = "5px";
        btn.style.cursor = "pointer";
        btn.innerText = "Admin 📧";

        btn.addEventListener("click", () => {
          const admins = [];
          const members = [];

          const users = document.querySelectorAll(
            '#org-user-manager > div[data-edit-template="user-item"] > .editable'
          );

          users.forEach((item) => {
            const email = getText(".item > div:nth-child(2)", item);
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

  const ctx = getRouteContext();
  modules.forEach((module) => {
    try {
      if (module.match(ctx)) {
        module.run(ctx);
      }
    } catch (e) {
      console.warn(`[${MODULE_PREFIX}] Module ${module.id} failed`, e);
    }
  });

  enforceTopRightButtonOrder();
})();