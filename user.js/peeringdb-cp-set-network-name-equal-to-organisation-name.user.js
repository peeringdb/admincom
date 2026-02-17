// ==UserScript==
// @name         PeeringDB CP - Set Network name equal to organisation name
// @namespace    https://www.peeringdb.net/
// @version      0.1.0.20260217
// @description  Change the Network name to be identical to the organisation name
// @author       <chriztoffer@peeringdb.com>
// @match        https://www.peeringdb.com/cp/peeringdb_server/network/*/change/*
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-set-network-name-equal-to-organisation-name.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-set-network-name-equal-to-organisation-name.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==


(function() {
  'use strict';

  /* Define variables */
  let go, goto, parent;

  let padLeft = 500,
      navbar = document.getElementById('grp-content-title'),
      netId = window.location.pathname.split('/')[4],
      netStatus = document.querySelector('#id_status > option[selected]').getAttribute('value'),
      orgId = document.getElementById('id_org').getAttribute('value'),
      orgName = document.getElementById('id_name'),
      saveContinueEditing = document.querySelector('#network_form > div > footer > div > div:nth-child(4) > input');

  var appendName;

  const childNode4ikT = document.createElement('ul');
  const parentNode4ikT = document.querySelector('#grp-content-title > ul').parentNode;

  childNode4ikT.innerHTML = '<li class="grp-object-tools" style="padding-right:' + padLeft + 'px;"><a href="#" id="updateNetworkName">Update Name</a></li>';

  let sp2ikT = document.querySelector('#grp-content-title > ul');
  parentNode4ikT.insertBefore(childNode4ikT, sp2ikT);

  switch (netStatus) {
    case 'deleted':
      appendName = ' #' + netId;
      break;
    default:
      appendName = '';
  };

  document.getElementById('updateNetworkName').onclick = async() => {
    let obj;
    const response = await fetch('https://www.peeringdb.com/api/org/' + orgId)
    obj = await response.json();
    orgName.setAttribute('value', obj.data[0].name + appendName);
    saveContinueEditing.click();
  };
})();