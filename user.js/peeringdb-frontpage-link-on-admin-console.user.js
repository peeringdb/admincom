// ==UserScript==
// @name            PeeringDB - Frontpage Link on Admin Console
// @namespace       https://www.peeringdb.com/cp/
// @version         1.2.7.20231228
// @description     Add direct link to the PeeringDB frontend from the Admin Console to net
// @author          <chriztoffer@PeeringDB.com>
// @match           https://www.peeringdb.com/cp/peeringdb_server/facility/*/change/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/network/*/change/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/organization/*/change/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/carrier/*/change/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/internetexchange/*/change/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/campus/*/change/*
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-frontpage-link-on-admin-console.user.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-frontpage-link-on-admin-console.user.js

// ==/UserScript==

(function() {
  'use strict';

  /* Define variables */
  let goto, go, parent;

  let url = window.location;
  let path = url.pathname.replace('/', '').split('/');
  let type = path[2];
  let id = path[3];
  let navbar = document.querySelector('#grp-content-title');
  let org = '/org/', orgId, orgs = document.querySelectorAll('.grainy_namespace')[0].querySelector('.grp-readonly');

  function searchNs(item) {
    let result;

    if (item.innerText) {
      if (item.innerText.match(/^peeringdb\.organization\.(\d+)\./)) {
        result = item.innerText.match(/(\d+)/)[0];
      }
    }

    return result;
  }

  /* expand acronym when redirecting to admin console */
  if (type == 'facility') {
    goto = 'fac';

    orgId = searchNs(orgs);
  } else if (type == 'network') {
    goto = 'net';

    orgId = searchNs(orgs);
  } else if (type == 'organization') {
    goto = 'org';
  } else if (type == 'carrier') {
    goto = 'carrier';

    orgId = searchNs(orgs);
  } else if (type == 'internetexchange') {
    goto = 'ix';

    orgId = searchNs(orgs);
  } else if (type == 'campus') {
    goto = 'campus';

    orgId = searchNs(orgs);
  }

  const childNode = document.createElement('ul');
  const parentNode = document.querySelector('#grp-content-title > ul').parentNode;

  /* Avoid inserting a link to the organization two times */
  if (goto != 'org') {
    childNode.innerHTML = '<li class="grp-object-tools" style="padding-right:171px;"><a href="/org/' + orgId + '">Organization</a></li>';
  }

  childNode.innerHTML += '<li class="grp-object-tools" style="padding-right:80px;"><a href="/' + goto + '/' + id + '">Frontend</a></li>';

  let sp2 = document.querySelector('#grp-content-title > ul');
  parentNode.insertBefore(childNode, sp2);

})();
