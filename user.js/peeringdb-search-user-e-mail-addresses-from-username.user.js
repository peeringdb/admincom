// ==UserScript==
// @name            PeeringDB - Search user E-mail addresses from username
// @namespace       https://www.peeringdb.com/cp/peeringdb_server/user/
// @version         1.0.0.20231230
// @description     Lookup all User E-mail Addresses using the Username as the search key
// @author          <chriztoffer@PeeringDB.com>
// @match           https://www.peeringdb.com/cp/peeringdb_server/user/*/change/*
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-search-user-e-mail-addresses-from-username.user.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-search-user-e-mail-addresses-from-username.user.js
// ==/UserScript==

(function() {
  'use strict';

  let username = document.querySelector('#grp-breadcrumbs > ul > li:nth-child(4)').innerText;
  let navbar = document.querySelector('#grp-content-title');

  const childNode = document.createElement('ul');
  const parentNode = document.querySelector('#grp-content-title > ul').parentNode;

  childNode.innerHTML += '<li class="grp-object-tools" style="padding-right:205px;"><a href="/cp/account/emailaddress/?q=' + username + '">Search Username</a></li>';

  let sp2 = document.querySelector('#grp-content-title > ul');
  parentNode.insertBefore(childNode, sp2);
})();
