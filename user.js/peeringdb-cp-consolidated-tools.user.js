// ==UserScript==
// @name         PeeringDB CP - Consolidated Tools
// @namespace    https://www.peeringdb.com/cp/
// @version      1.0.1.20260217
// @description  Consolidated CP userscript with strict route-isolated modules for facility/network/user/entity workflows
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/cp/peeringdb_server/*/*/change/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-consolidated-tools.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-consolidated-tools.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function () {
  "use strict";

  const MODULE_PREFIX = "pdbCpConsolidated";
  const DUMMY_ORG_ID = 20525;
  const ENTITY_TYPES = new Set([
    "facility",
    "network",
    "organization",
    "carrier",
    "internetexchange",
    "campus",
  ]);

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

  function qs(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch (_error) {
      return null;
    }
  }

  function qsa(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  function getInputValue(selector) {
    const element = qs(selector);
    if (!element) return "";

    if (Object.prototype.hasOwnProperty.call(element, "value")) {
      return String(element.value || "").trim();
    }

    return String(element.getAttribute("value") || "").trim();
  }

  function setInputValue(selector, value) {
    const element = qs(selector);
    if (!element) return false;

    const normalized = String(value || "");
    if (Object.prototype.hasOwnProperty.call(element, "value")) {
      element.value = normalized;
    }

    element.setAttribute("value", normalized);
    return true;
  }

  function getToolbarList() {
    return qs("#grp-content-title > ul");
  }

  function addToolbarAction({ id, label, href = "#", onClick, paddingRight = null, target = null }) {
    const toolbar = getToolbarList();
    if (!toolbar || !id) return null;

    if (qs(`#${id}`)) {
      return qs(`#${id}`);
    }

    const parent = toolbar.parentNode;
    if (!parent) return null;

    const wrapper = document.createElement("ul");
    wrapper.setAttribute("data-pdb-cp-action", id);

    const li = document.createElement("li");
    li.className = "grp-object-tools";
    if (Number.isFinite(paddingRight)) {
      li.style.paddingRight = `${paddingRight}px`;
    }

    const a = document.createElement("a");
    a.id = id;
    a.href = href;
    a.textContent = label;

    if (target) {
      a.target = target;
    }

    if (typeof onClick === "function") {
      a.addEventListener("click", (event) => {
        event.preventDefault();
        onClick(event);
      });
    }

    li.appendChild(a);
    wrapper.appendChild(li);

    // Insert as a sibling UL, mirroring legacy CP scripts to avoid disturbing
    // the built-in toolbar/history layout implementation.
    parent.insertBefore(wrapper, toolbar);
    return a;
  }

  async function getOrganizationName(orgId) {
    if (!orgId) return null;

    try {
      const response = await fetch(`https://www.peeringdb.com/api/org/${orgId}`);
      if (!response.ok) return null;

      const payload = await response.json();
      return payload?.data?.[0]?.name || null;
    } catch (_error) {
      return null;
    }
  }

  function clickSaveAndContinue() {
    const button =
      qs("#network_form input[name='_continue']") ||
      qs("#network_form > div > footer > div input[name='_continue']") ||
      qs("#network_form > div > footer > div > div:nth-child(4) > input");

    if (!button) return false;
    button.click();
    return true;
  }

  function getSelectedStatus() {
    const option = qs("#id_status > option:checked") || qs("#id_status > option[selected]");
    return option ? String(option.getAttribute("value") || "") : "";
  }

  function getNameSuffixForDeletedNetwork(netId) {
    return getSelectedStatus() === "deleted" ? ` #${netId}` : "";
  }

  function clickDeleteHandlersForInlineSet(inlineSetPrefix) {
    qsa(`div.form-row.grp-dynamic-form[id^='${inlineSetPrefix}']`).forEach((row) => {
      if (row.id === `${inlineSetPrefix}-empty`) return;

      const deleteCheckbox = qs('input[type="checkbox"][name$="-DELETE"]', row);
      const deleteAction = qs('a.grp-icon.grp-delete-handler[title="Delete Item"]', row);

      if (!deleteAction || !deleteCheckbox || deleteCheckbox.checked) return;
      deleteAction.click();
    });
  }

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

    clickDeleteHandlersForInlineSet("poc_set");
    clickDeleteHandlersForInlineSet("netfac_set");
    clickDeleteHandlersForInlineSet("netixlan_set");
  }

  const modules = [
    {
      id: "facility-google-maps",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "facility",
      preconditions: () => Boolean(getToolbarList()),
      run: () => {
        const latitude = getInputValue("#id_latitude");
        const longitude = getInputValue("#id_longitude");
        const address1 = getInputValue("#id_address1");
        const city = getInputValue("#id_city");
        const state = getInputValue("#id_state");
        const zipcode = getInputValue("#id_zipcode");
        const country = getInputValue("#id_country");

        const querySource =
          latitude && longitude
            ? `${latitude},${longitude}`
            : `${address1}${city ? `+${city}` : ""}${state ? `+${state}` : ""}${zipcode ? `+${zipcode}` : ""}${country ? `+${country}` : ""}`;

        const query = encodeURIComponent(querySource);
        const href = `https://www.google.com/maps?q=${query}`;

        addToolbarAction({
          id: `${MODULE_PREFIX}GoogleMaps`,
          label: "Google Maps",
          href,
          target: query || "_blank",
          paddingRight: 459,
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
        const gotoByEntity = {
          facility: "fac",
          network: "net",
          organization: "org",
          carrier: "carrier",
          internetexchange: "ix",
          campus: "campus",
        };

        const goto = gotoByEntity[ctx.entity];
        if (!goto) return;

        const orgId = getInputValue("#id_org");

        if (goto !== "org" && orgId) {
          addToolbarAction({
            id: `${MODULE_PREFIX}OrganizationFrontend`,
            label: "Organization (front-end)",
            href: `/org/${orgId}`,
            target: "_new",
            paddingRight: 283,
          });

          addToolbarAction({
            id: `${MODULE_PREFIX}OrganizationCp`,
            label: "Organization",
            href: `/cp/peeringdb_server/organization/${orgId}/change/`,
            target: "_new",
            paddingRight: 171,
          });
        }

        addToolbarAction({
          id: `${MODULE_PREFIX}Frontend`,
          label: "Frontend",
          href: `/${goto}/${ctx.entityId}`,
          target: "_new",
          paddingRight: 80,
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
          paddingRight: 205,
        });
      },
    },
    {
      id: "set-network-name-equal-org-name",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "network",
      preconditions: () => Boolean(getToolbarList() && qs("#id_org") && qs("#id_name")),
      run: (ctx) => {
        addToolbarAction({
          id: `${MODULE_PREFIX}UpdateNetworkName`,
          label: "Update Name",
          paddingRight: 500,
          onClick: async () => {
            const orgId = getInputValue("#id_org");
            const baseName = await getOrganizationName(orgId);
            if (!baseName) return;

            const appendName = getNameSuffixForDeletedNetwork(ctx.entityId);
            const nextName = `${baseName}${appendName}`;
            setInputValue("#id_name", nextName);
            clickSaveAndContinue();
          },
        });
      },
    },
    {
      id: "reset-network-information",
      match: (ctx) => ctx.isEntityChangePage && ctx.entity === "network",
      preconditions: () => Boolean(getToolbarList() && qs("#id_org") && qs("#id_name")),
      run: (ctx) => {
        addToolbarAction({
          id: `${MODULE_PREFIX}ResetNetworkInformation`,
          label: "Reset Information",
          paddingRight: 618,
          onClick: async () => {
            const originalNetworkName = getInputValue("#id_name");
            const orgId = getInputValue("#id_org");

            runNetworkResetActions();

            const baseName = await getOrganizationName(orgId);
            const appendName = getNameSuffixForDeletedNetwork(ctx.entityId);
            const resolvedNetworkName = baseName
              ? `${baseName}${appendName}`
              : originalNetworkName;

            if (resolvedNetworkName) {
              setInputValue("#id_name", resolvedNetworkName);
            }

            if (!getInputValue("#id_name") && originalNetworkName) {
              setInputValue("#id_name", originalNetworkName);
            }

            clickSaveAndContinue();
          },
        });
      },
    },
  ];

  function dispatchModules(ctx) {
    modules.forEach((module) => {
      try {
        if (!module.match(ctx)) return;
        if (typeof module.preconditions === "function" && !module.preconditions(ctx)) return;
        module.run(ctx);
      } catch (error) {
        console.warn(`[${MODULE_PREFIX}] module failed: ${module.id}`, error);
      }
    });
  }

  const ctx = getRouteContext();

  // Hard route safety: consolidated script should never run outside intended CP entity change pages.
  if (!ctx.isCp || !ctx.isEntityChangePage) {
    return;
  }

  dispatchModules(ctx);
})();
