// ==UserScript==
// @name            PeeringDB - Admin Console Link on Frontpage
// @namespace       https://www.peeringdb.com/
// @version         2.1.4.20231228
// @description     Add direct link to the PeeringDB Admin Console from the frontpage to net/carrier/org/facility/ix
// @author          <chriztoffer@PeeringDB.com>
// @match           https://www.peeringdb.com/net/*
// @match           https://www.peeringdb.com/asn/*
// @match           https://www.peeringdb.com/carrier/*
// @match           https://www.peeringdb.com/org/*
// @match           https://www.peeringdb.com/fac/*
// @match           https://www.peeringdb.com/ix/*
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-admin-console-link-on-frontpage.user.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-admin-console-link-on-frontpage.user.js
// ==/UserScript==

(function() {
  'use strict';

  /* Define variables */
  let goto, go, parent;

  let url = window.location;
  let path = url.pathname.replace('/', '').split('/');
  let type = path[0];
  let id = path[1];

  /* expand acronym when redirecting to admin console */
  if (type == 'fac') {
    goto = 'facility';
  } else if (type == 'net') {
    goto = 'network';
  } else if (type == 'asn') {
    goto = 'network';
    /* Unset id and redine it to netid when we access the path using the asn-prefix */
    id = undefined;
    id = document.querySelector('div[data-edit-name="net_id"]').innerText;
  } else if (type == 'org') {
    goto = 'organization';
  } else if (type == 'carrier') {
    goto = 'carrier';
  } else if (type == 'ix') {
    goto = 'internetexchange';
  }

  /* Construct admin console url */
  go = 'https://www.peeringdb.com/cp/peeringdb_server/' + goto + '/' + id + '/change/';

  /* Select parent for where to append child */
  parent = document.querySelector('#view > div:nth-child(4) > div > div > div.col-md-4.col-sm-4.col-2.right.button-bar > div:nth-child(1)');

  /* Define child and append element to parent */
  let copyBtnLabel = 'Admin Console';
  let editBtn = document.createElement('a');

  editBtn.setAttribute('href', go);
  editBtn.setAttribute('class', 'btn btn-primary');
  editBtn.innerText = copyBtnLabel;

  let editBtnInPage = parent
  //editBtnInPage.innerHTML = editBtnInPage.innerHTML;
  editBtnInPage.appendChild(editBtn);

})();
