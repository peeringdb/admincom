// ==UserScript==
// @name            PeeringDB CP - Frontpage Link on Admin Console
// @namespace       https://www.peeringdb.com/cp/
// @version         1.3.0.20260217
// @description     Add direct link to the PeeringDB frontend from the Admin Console to net
// @author          <chriztoffer@peeringdb.com>
// @include         /^https:\/\/(\w+)\.peeringdb\.com\/cp\/peeringdb_server\/(facility|network|organization|carrier|internetexchange|campus)\/(\d+)\/change\/(.*)
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-frontpage-link-on-admin-console.meta.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-frontpage-link-on-admin-console.user.js
// @supportURL      https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function() {
  'use strict';

  /* Define variables */
  let goto, go, parent;

  let padLeft = 80;

  let url = window.location;
  let path = url.pathname.replace('/', '').split('/');
  let type = path[2];
  let id = path[3];
  let navbar = document.querySelector('#grp-content-title');
  // let org = '/org/', orgId, orgs = document.querySelectorAll('.grainy_namespace')[0].querySelector('.grp-readonly');
  let orgId = (type != 'organization' ? document.getElementById('id_org').getAttribute('value') : '');


  // function searchNs(item) {
  //   let result;

  //   if (item.innerText) {
  //     if (item.innerText.match(/^peeringdb\.organization\.(\d+)\./)) {
  //       result = item.innerText.match(/(\d+)/)[0];
  //     }
  //   }

  //   return result;
  // }

  /* expand acronym when redirecting to admin console */
  if (type == 'facility') {
    goto = 'fac';

    // orgId = searchNs(orgs);
  } else if (type == 'network') {
    goto = 'net';

    // orgId = searchNs(orgs);
  } else if (type == 'organization') {
    goto = 'org';
  } else if (type == 'carrier') {
    goto = 'carrier';

    // orgId = searchNs(orgs);
  } else if (type == 'internetexchange') {
    goto = 'ix';

    // orgId = searchNs(orgs);
  } else if (type == 'campus') {
    goto = 'campus';

    // orgId = searchNs(orgs);
  }' + orgId + '

  const childNode8WkKj = document.createElement('ul');
  const parentNode8WkKj = document.querySelector('#grp-content-title > ul').parentNode;

  /* Avoid inserting a link to the organization two times */
  if (goto != 'org') {
    childNode8WkKj.innerHTML += '<li class="grp-object-tools" style="padding-right:' + (padLeft + 203) + 'px;"><a href="/org/' + orgId + '" target="_new">Organization (front-end)</a></li>';
    childNode8WkKj.innerHTML += '<li class="grp-object-tools" style="padding-right:' + (padLeft + 91) + 'px;"><a href="/cp/peeringdb_server/organization/' + orgId + '/change/" target="_new">Organization</a></li>';
  }

  childNode8WkKj.innerHTML += '<li class="grp-object-tools" style="padding-right:' + padLeft + 'px;"><a href="/' + goto + '/' + id + '" target="_new">Frontend</a></li>';

  let sp2WkKj = document.querySelector('#grp-content-title > ul');
  parentNode8WkKj.insertBefore(childNode8WkKj, sp2WkKj);

})();
