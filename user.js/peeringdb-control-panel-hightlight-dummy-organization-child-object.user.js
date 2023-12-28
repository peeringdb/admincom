// ==UserScript==
// @name            PeeringDB - Control Panel Hightlight Dummy Organization child object
// @namespace       https://www.peeringdb.com/cp/peeringdb_server/facility/
// @version         1.1.4.20231228
// @description     Insert string in the title field to hightlight the organization parent reference needs to be updated
// @author          <chriztoffer@PeeringDB.com>
// @match           https://www.peeringdb.com/cp/peeringdb_server/facility/*/change/*
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-control-panel-hightlight-dummy-organization-child-object.user.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-control-panel-hightlight-dummy-organization-child-object.user.js
// ==/UserScript==

(function() {
  'use strict';

  let org = document.querySelector('#facility_form > div > fieldset:nth-child(2) > div.form-row.grp-row.grp-cells-1.grainy_namespace > div > div.c-2 > div');

  let orgId = parseInt(org.innerText.split('.')[2]);
  let dummyOrgId = parseInt(20525);

  let nav = document.querySelector('#grp-content-title');
  let title = nav.querySelector('h1');
  let bgContainer = document.querySelector('#grp-content');

  if (orgId === dummyOrgId ) {
    /* Append warning to title */
    title.innerHTML = title.innerHTML + ('<span style="text-align:center;color:red;font-weight:bold;">Child of dummy organization</span>').toUpperCase();

    /* Do not set this, as we already set the background colour */
    //nav.style.backgroundColor = 'rgba(255, 255, 0, 0.5)';

    /* Change background colour to make it very obvious */
    bgContainer.style.backgroundColor = 'rgba(255, 255, 0, 0.5)';
  }

})();
