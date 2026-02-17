// ==UserScript==
// @name         PeeringDB CP - Reset all network information
// @namespace    https://www.peeringdb.net/
// @version      0.1.0.20260217
// @description  Reset all information for the network due to reassigned ASN by the RIPE NCC
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/cp/peeringdb_server/network/*/change/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-reset-all-network-information.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-reset-all-network-information.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==


(function() {
  'use strict';

  function resetActions() {
    // Strings
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelectorAll('input.vTextField').forEach((item) => {item.setAttribute('value', '')});
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelectorAll('input.vURLField').forEach((item) => {item.setAttribute('value', '')});

    // Numbers
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelectorAll('input[name*="prefixes"]').forEach((item) => {item.setAttribute('value', 0)});

    // Arrays
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelector('textarea#id_social_media').innerText = '{}';

    // Checkbox - Uncheck everything by default
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelectorAll('input[type="checkbox"]').forEach((item) => {item.checked = false});
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelectorAll('input[type="checkbox"]#id_allow_ixp_update').forEach((item) => {item.checked = true});

    // Drop-downs
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelectorAll('select[name*="info"]').forEach((item) => {item.querySelector('option:first-child').selected = true});
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelectorAll('select[name*="policy"]').forEach((item) => {item.querySelector('option:first-child').selected = true});

    // Textareas
    document.querySelector('#network_form > div > fieldset:nth-child(2)').querySelectorAll('textarea.vLargeTextField').forEach((item) => {item.innerText = ''});

    // Check pre-delete action - Network Contacts, Network Facilities, Network IX LAN(s)
    document.querySelectorAll('div.grp-td.grp-tools-container > ul > li > a[title="Delete Item"]').forEach((item) => {item.parentNode.parentNode.parentNode.parentNode.parentNode.classList.add('grp-predelete')});
  }

  /* Define variables */
  let padLeft = 618,
      netAppendName,
      netId = window.location.pathname.split('/')[4],
      netName = document.getElementById('id_name'),
      netStatus = document.querySelector('#id_status > option[selected]').getAttribute('value'),
      orgId = document.getElementById('id_org').getAttribute('value'),
      orgName = document.getElementById('id_name'),
      saveContinueEditing = document.querySelector('#network_form > div > footer > div > div:nth-child(4) > input');

  const childNode = document.createElement('ul');
  const parentNode = document.querySelector('#grp-content-title > ul').parentNode;

  childNode.innerHTML = '<li class="grp-object-tools" style="padding-right:' + padLeft + 'px;"><a href="#" id="resetNetworkInformation">Reset Information</a></li>';

  let sp2 = document.querySelector('#grp-content-title > ul');
  parentNode.insertBefore(childNode, sp2);

  switch(netStatus) {
    case 'deleted':
      netAppendName = ' #' + netId;
      break;
    default:
      netAppendName = '';
  }

  document.getElementById('resetNetworkInformation').onclick = async() => {
    resetActions();
    let obj;
    const response = await fetch('https://www.peeringdb.com/api/org/' + orgId)
    obj = await response.json();
    orgName.setAttribute('value', obj.data[0].name + netAppendName);
    saveContinueEditing.click();
  };
})();