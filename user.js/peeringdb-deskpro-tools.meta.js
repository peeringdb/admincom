// ==UserScript==
// @name            PeeringDB DP - Consolidated Tools
// @namespace       https://www.peeringdb.com/
// @version         1.7.1.20260525
// @description     Consolidated DeskPro tools: linkifies/enriches PeeringDB links (ASN/IP/IX/NET), copies mailto addresses, normalizes PeeringDB CP double-slash links, generates pihole whitelist commands for IX/NET/FAC/Carrier approval tickets
// @author          <chriztoffer@peeringdb.com>
// @match           https://peeringdb.deskpro.com/app*
// @icon            https://icons.duckduckgo.com/ip2/deskpro.com.ico
// @grant           GM_xmlhttpRequest
// @grant           GM_registerMenuCommand
// @grant           GM_unregisterMenuCommand
// @grant           GM_addStyle
// @grant           GM_setClipboard
// @require         https://cdnjs.cloudflare.com/ajax/libs/psl/1.12.0/psl.min.js
// @connect         www.peeringdb.com
// @connect         peeringdb.com
// @connect         cdnjs.cloudflare.com
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-deskpro-tools.meta.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-deskpro-tools.user.js
// @supportURL      https://github.com/peeringdb/admincom/issues
// ==/UserScript==
