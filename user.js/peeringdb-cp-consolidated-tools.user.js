// ==UserScript==
// @name         PeeringDB CP - Consolidated Tools
// @namespace    https://www.peeringdb.com/cp/
// @version      1.0.5.20260218
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
    wrapper.style.pointerEvents = "none";

    const li = document.createElement("li");
    li.className = "grp-object-tools";
    if (Number.isFinite(paddingRight)) {
      li.style.paddingRight = `${paddingRight}px`;
    }

    const a = document.createElement("a");
    a.id = id;
    a.href = href;
    a.textContent = label;
    a.style.pointerEvents = "auto";

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

  // RDAP client module (fully isolated from feature modules)
  const rdapAutnumClient = (() => {
    const BOOTSTRAP_ASN_URL = "https://data.iana.org/rdap/asn.json"; // RFC 9224 bootstrap registry
    const RDAP_ACCEPT_HEADER = "application/rdap+json, application/json;q=0.8";

    const bootstrapCache = {
      loadedAt: 0,
      ttlMs: 6 * 60 * 60 * 1000,
      payload: null,
    };

    function parseAsn(value) {
      const number = Number.parseInt(String(value || "").trim(), 10);
      if (!Number.isInteger(number) || number <= 0) return null;
      return number;
    }

    function normalizeBaseUrl(baseUrl) {
      if (!baseUrl) return null;
      return String(baseUrl).replace(/\/+$/, "");
    }

    async function getBootstrap() {
      const now = Date.now();
      if (
        bootstrapCache.payload &&
        bootstrapCache.loadedAt > 0 &&
        now - bootstrapCache.loadedAt < bootstrapCache.ttlMs
      ) {
        return bootstrapCache.payload;
      }

      const response = await fetch(BOOTSTRAP_ASN_URL, {
        headers: { Accept: RDAP_ACCEPT_HEADER },
      });
      if (!response.ok) return null;

      const payload = await response.json();
      bootstrapCache.payload = payload;
      bootstrapCache.loadedAt = now;
      return payload;
    }

    function isAsnInRange(asn, rangeText) {
      const range = String(rangeText || "").trim();
      if (!range) return false;

      const parts = range.split("-").map((item) => Number.parseInt(item, 10));
      if (parts.length !== 2 || parts.some((value) => !Number.isInteger(value))) {
        return false;
      }

      return asn >= parts[0] && asn <= parts[1];
    }

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

    async function fetchAutnumRecord(asn) {
      const bootstrap = await getBootstrap();
      const baseUrl = getAutnumBaseUrlFromBootstrap(bootstrap, asn);
      if (!baseUrl) return null;

      const response = await fetch(`${baseUrl}/autnum/${asn}`, {
        headers: { Accept: RDAP_ACCEPT_HEADER },
      });
      if (!response.ok) return null;

      return response.json();
    }

    function getVcardProperty(vcardArray, propertyName) {
      const cards = Array.isArray(vcardArray?.[1]) ? vcardArray[1] : [];
      const property = cards.find(
        (item) => Array.isArray(item) && String(item[0] || "").toLowerCase() === propertyName,
      );
      if (!property) return "";

      return String(property[3] || "").trim();
    }

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

    function resolveOrganizationNameFromAutnumPayload(payload) {
      const candidates = collectEntityCandidates(payload?.entities, []);
      if (!candidates.length) return null;

      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.value || null;
    }

    async function resolveOrganizationNameByAsn(asnInput) {
      const asn = parseAsn(asnInput);
      if (!asn) return null;

      try {
        const payload = await fetchAutnumRecord(asn);
        if (!payload) return null;

        return resolveOrganizationNameFromAutnumPayload(payload);
      } catch (_error) {
        return null;
      }
    }

    return {
      resolveOrganizationNameByAsn,
    };
  })();

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
            const orgId = getInputValue("#id_org");
            const asn = getInputValue("#id_asn");
            const parsedAsn = Number.parseInt(asn, 10);

            runNetworkResetActions();

            const baseName = await getOrganizationName(orgId);
            const appendName = getNameSuffixForDeletedNetwork(ctx.entityId);
            const resolvedNetworkName = baseName ? `${baseName}${appendName}` : "";

            if (resolvedNetworkName) {
              setInputValue("#id_name", resolvedNetworkName);
            }

            // If resolved network name is empty, do an isolated RDAP ASN lookup
            // to resolve the responsible organization name.
            if (!getInputValue("#id_name")) {
              const rdapOrgName = await rdapAutnumClient.resolveOrganizationNameByAsn(asn);
              if (rdapOrgName) {
                setInputValue("#id_name", `${rdapOrgName}${appendName}`);
              }
            }

            // Final guard: keep name required-field validation from blocking first-run save.
            if (!getInputValue("#id_name")) {
              const deterministicFallbackName = Number.isInteger(parsedAsn) && parsedAsn > 0
                ? `AS${parsedAsn}${appendName}`
                : `AS${ctx.entityId}${appendName}`;
              setInputValue("#id_name", deterministicFallbackName);
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
