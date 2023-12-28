// ==UserScript==
// @name            PeeringDB - Replace double slashes in URI
// @namespace       https://www.peeringdb.com/
// @version         1.0.2.20231228
// @description     Redirect page while replace double-slashes in the URI with single-slash
// @author          <chriztoffer@PeeringDB.com>
// @match           https://www.peeringdb.com//*
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-replace-double-slashes-in-uri.user.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-replace-double-slashes-in-uri.user.js
// ==/UserScript==

(function() {
  'use strict';

  /* Define variables */
  let url = window.location;
  let path = url.pathname.replace('/', '').split('/');
  let type = path[0];
  let id = path[1];

  /* Redirect page to normal, if pathname starts with '//' */
  if (path.length > 2) {
    window.location.href = url.protocol + '//' + url.hostname + url.pathname.replace('//', '/');
  }

})();
