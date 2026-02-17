// ==UserScript==
// @name            PeeringDB CP - Admin Console set link target BLANK for entity website
// @namespace       https://www.peeringdb.com/cp/
// @version         1.1.0.20260217
// @description     Set the link target. Forcing clinking on the link to open a new tab.
// @author          <chriztoffer@peeringdb.com>
// @include         /^https:\/\/(\w+)\.peeringdb\.com\/cp\/peeringdb_server\/(facility|network|organization|carrier|internetexchange|campus)\/(\d+)\/change\/(.*)?
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-admin-console-set-link-target-blank-for-entity-website.meta.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-admin-console-set-link-target-blank-for-entity-website.user.js
// @supportURL      https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function() {
  'use strict';

  let path = window.location.pathname.replace(/(^\/|\/$)/g, '').split('/');
  let type = path[2];
  let id = path[3];

  // overwrite link target to new tab
  document.querySelector('.website > div > div > p > a').target = 'peeringdb_' + type + '_' + id;

})();