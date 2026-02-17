// ==UserScript==
// @name         PeeringDB CP - Reset all network information
// @namespace    https://www.peeringdb.net/
// @version      0.1.1.20260217
// @description  Reset all information for the network due to reassigned ASN by the RIPE NCC
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/cp/peeringdb_server/network/*/change/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-reset-all-network-information.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-reset-all-network-information.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function () {
  "use strict";

  /**
   * Clicks all inline delete controls for a given Django inline formset prefix.
   * @param {string} inlineSetPrefix Prefix used by inline row IDs (e.g. netixlan_set)
   */
  function clickDeleteHandlersForInlineSet(inlineSetPrefix) {
    document
      .querySelectorAll(
        `div.form-row.grp-dynamic-form[id^="${inlineSetPrefix}"]`,
      )
      .forEach((row) => {
        if (row.id === `${inlineSetPrefix}-empty`) return;

        const deleteCheckbox = row.querySelector(
          'input[type="checkbox"][name$="-DELETE"]',
        ); // Django inline DELETE checkbox
        const deleteAction = row.querySelector(
          'a.grp-icon.grp-delete-handler[title="Delete Item"]',
        ); // Grappelli delete trigger

        if (!deleteAction || !deleteCheckbox) return;
        if (deleteCheckbox.checked) return;

        deleteAction.click();
      });
  }

  function resetNetworkContactsDeleteActions() {
    clickDeleteHandlersForInlineSet("poc_set");
  }

  function resetNetworkFacilitiesDeleteActions() {
    clickDeleteHandlersForInlineSet("netfac_set");
  }

  function resetNetworkIXLANDeleteActions() {
    clickDeleteHandlersForInlineSet("netixlan_set");
  }

  function resetActions() {
    const fieldsetSelector = "#network_form > div > fieldset:nth-child(2)"; // Network details fieldset
    const formArea = document.querySelector(fieldsetSelector); // Cached fieldset root for repeated queries

    const safeRun = (label, callback) => {
      try {
        callback();
      } catch (error) {
        console.warn("[resetActions] failed step:", label, error);
      }
    };

    const eachInForm = (label, selector, callback) => {
      safeRun(label, () => {
        if (!formArea) return;
        formArea.querySelectorAll(selector).forEach(callback);
      });
    };

    // Strings
    eachInForm("reset text fields", "input.vTextField", (item) => {
      item.value = "";
    });
    eachInForm("reset URL fields", "input.vURLField", (item) => {
      item.value = "";
    });

    // Numbers
    eachInForm("reset prefix counters", 'input[name*="prefixes"]', (item) => {
      item.value = 0;
    });

    // Arrays
    safeRun("reset social media JSON", () => {
      const socialMedia = formArea?.querySelector("textarea#id_social_media"); // Social media JSON textarea
      if (socialMedia) socialMedia.value = "{}";
    });

    // Checkbox - Uncheck everything by default
    eachInForm("uncheck checkboxes", 'input[type="checkbox"]', (item) => {
      item.checked = false;
    });
    eachInForm(
      "enable allow_ixp_update checkbox",
      'input[type="checkbox"]#id_allow_ixp_update',
      (item) => {
        item.checked = true;
      },
    );

    // Drop-downs
    eachInForm("reset info selects", 'select[name*="info"]', (item) => {
      const firstOption = item.querySelector("option:first-child"); // Default/first option in select
      if (firstOption) firstOption.selected = true;
    });
    eachInForm("reset policy selects", 'select[name*="policy"]', (item) => {
      const firstOption = item.querySelector("option:first-child"); // Default/first option in select
      if (firstOption) firstOption.selected = true;
    });

    // Textareas
    eachInForm("reset large textareas", "textarea.vLargeTextField", (item) => {
      item.value = "";
    });

    // Delete actions by inline group
    safeRun("delete network contacts entries", () => {
      resetNetworkContactsDeleteActions();
    });

    safeRun("delete network facilities entries", () => {
      resetNetworkFacilitiesDeleteActions();
    });

    safeRun("delete network ixlan entries", () => {
      resetNetworkIXLANDeleteActions();
    });
  }

  /* Define variables */
  let padLeft = 618, // Pixel offset used to position custom top action button
    netAppendName, // Name suffix appended for deleted networks (" #<netId>")
    netId = window.location.pathname.split("/")[4], // Network ID parsed from current URL
    netName = document.getElementById("id_name"), // Network name input element (#id_name)
    netStatus = document
      .querySelector("#id_status > option[selected]")
      .getAttribute("value"), // Currently selected network status
    orgId = document.getElementById("id_org").getAttribute("value"), // Related organization ID from form
    orgName = document.getElementById("id_name"), // Alias to the same #id_name input used for name updates
    saveContinueEditing = document.querySelector(
      "#network_form > div > footer > div > div:nth-child(4) > input",
    ); // "Save and continue editing" button

  const childNode = document.createElement("ul"); // Wrapper list for custom toolbar action
  const parentNode = document.querySelector(
    "#grp-content-title > ul",
  ).parentNode; // Parent container of page title tools

  childNode.innerHTML =
    '<li class="grp-object-tools" style="padding-right:' +
    padLeft +
    'px;"><a href="#" id="resetNetworkInformation">Reset Information</a></li>';

  let sp2 = document.querySelector("#grp-content-title > ul"); // Existing title tool list used as insertion anchor
  parentNode.insertBefore(childNode, sp2);

  switch (netStatus) {
    case "deleted":
      netAppendName = " #" + netId;
      break;
    default:
      netAppendName = "";
  }

  document.getElementById("resetNetworkInformation").onclick = async () => {
    const originalNetworkName = document.querySelector("#id_name")?.value || ""; // Preserve original name before resets
    resetActions();
    let obj; // Parsed org API response payload
    try {
      const response = await fetch(
        "https://www.peeringdb.com/api/org/" + orgId,
      ); // Org lookup by ID

      if (response.status === 404) {
        console.warn(
          "[resetActions] org lookup returned 404 (possibly soft-deleted):",
          orgId,
        );
        if (originalNetworkName) {
          orgName.setAttribute("value", originalNetworkName);
        }
      } else if (!response.ok) {
        console.warn(
          "[resetActions] org lookup failed:",
          response.status,
          response.statusText,
        );
      } else {
        obj = await response.json();
        if (obj?.data?.[0]?.name) {
          orgName.setAttribute("value", obj.data[0].name + netAppendName);
        }
      }
    } catch (error) {
      console.warn("[resetActions] org lookup request error:", error);
    }

    saveContinueEditing.click();
  };
})();
