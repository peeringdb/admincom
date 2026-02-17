// ==UserScript==
// @name            PeeringDB FP - Admin Console Link on Frontpage
// @namespace       https://www.peeringdb.com/
// @version         2.2.0.20260217
// @description     Add direct link to the PeeringDB Admin Console from the frontpage to net/carrier/org/facility/ix
// @author          <chriztoffer@peeringdb.com>
// @match           https://www.peeringdb.com/net/*
// @match           https://www.peeringdb.com/asn/*
// @match           https://www.peeringdb.com/carrier/*
// @match           https://www.peeringdb.com/org/*
// @match           https://www.peeringdb.com/fac/*
// @match           https://www.peeringdb.com/ix/*
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-admin-console-link-on-frontpage.meta.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-admin-console-link-on-frontpage.user.js
// @supportURL      https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function() {
  'use strict';

  /* Define variables */
  let goto,
      go,
      parent,
      bgp_tools = false,
      he_net = false,
      asn,
      url = window.location,
      path = url.pathname.replace('/', '').split('/'),
      type = path[0],
      id = path[1],
      websiteLink;

  /* expand acronym when redirecting to admin console */
  if (type == 'fac') {
    goto = 'facility';
  } else if (type == 'net') {
    goto = 'network';
    // bgp_tools = true;
    // he_net = true;
    asn = document.querySelector('div[data-edit-name="asn"]').innerText;
    websiteLink = document.querySelector('div[data-edit-name="website"]').innerText.length;
  } else if (type == 'asn') {
    goto = 'network';
    /* Unset id and redine it to netid when we access the path using the asn-prefix */
    id = undefined;
    id = document.querySelector('div[data-edit-name="net_id"]').innerText;
    bgp_tools = true;
    he_net = true;
    asn = document.querySelector('div[data-edit-name="asn"]').innerText;
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
  parent = document.querySelector('div.right.button-bar > div:first-child');

  /* Define child and append element to parent */
  let copyBtnLabel = 'Admin Console';
  let editBtn = document.createElement('a');

  editBtn.setAttribute('href', go);
  editBtn.setAttribute('class', 'btn btn-primary');
  editBtn.innerText = copyBtnLabel;

  let editBtnInPage = parent
  //editBtnInPage.innerHTML = editBtnInPage.innerHTML;
  editBtnInPage.appendChild(editBtn);

  if (bgp_tools === true) {
    /* Define child and append element to parent */
    let copyBtnLabel = 'BGP.TOOLS';
    let editBtn = document.createElement('a');
    let href = 'https://bgp.tools/as' + asn;

    editBtn.setAttribute('href', href);
    editBtn.setAttribute('class', 'btn btn-primary');
    editBtn.style.marginLeft = '6px';
    editBtn.target = encodeURIComponent(GM_info.script.name + '_' + GM_info.version + '_' + new Date());
    editBtn.innerText = copyBtnLabel;

    let editBtnInPage = parent
    //editBtnInPage.innerHTML = editBtnInPage.innerHTML;
    editBtnInPage.appendChild(editBtn);

  }

  if (he_net === true) {
    /* Define child and append element to parent */
    let copyBtnLabel = 'BGP.HE.NET';
    let editBtn = document.createElement('a');
    let href = 'https://bgp.he.net/as' + asn;

    editBtn.setAttribute('href', href);
    editBtn.setAttribute('class', 'btn btn-primary');
    editBtn.style.marginLeft = '6px';
    editBtn.target = encodeURIComponent(GM_info.script.name + '_' + GM_info.version + '_' + new Date());
    editBtn.innerText = copyBtnLabel;

    let editBtnInPage = parent
    //editBtnInPage.innerHTML = editBtnInPage.innerHTML;
    editBtnInPage.appendChild(editBtn);

  }

  /**
   * Remove the EDIT button if there is no Website URL of the page - Applies to Networks
   */
  if (websiteLink < 1) {
    document.querySelector('div[data-edit-toggled="view"] a[data-edit-action="toggle-edit"]').remove();
  }

})();