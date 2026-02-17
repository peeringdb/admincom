// ==UserScript==
// @name         PeeringDB FP - Copy user role list
// @namespace    https://www.peeringdb.com/
// @version      0.1.0.20260217
// @description  Copy PeeringDB Organization user role lists to clipboard
// @author       <chriztoffer@peeringdb.com>
// @include      /^https:\/\/(\w+)\.peeringdb\.com\/(org)\/(\d+)
// @icon         https://icons.duckduckgo.com/ip2/www.peeringdb.com.ico
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-copy-user-role-list.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-copy-user-role-list.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==

let sleepTimer = 1000; //time in ms

let seperator = '\t';
let newline = '\n';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateDataElement() {

  let users = document.querySelectorAll('#org-user-manager > div[data-edit-template="user-item"] > .editable')
  let members = [];
  let admins = [];
  let results = {admins, members};

  users.forEach((item) => {
    let name = item.getAttribute('data-edit-label');
    let email = item.querySelector('.item > div:nth-child(2)').innerText;
    let role = item.querySelector('.item > div:nth-child(3) > div:first-child').getAttribute('data-edit-value');

    if (role == 'admin') {
      admins.push(email);
    }

    if (role == 'member') {
      members.push(email);
    }
  });

  results.admins.push(admins);

  results.members.push(members);

  return results.admins.join('\n');
}

const work = async () => {
  await sleep(sleepTimer);

  (function() {

    function fallbackCopyTextToClipboard(text) {
      var textArea = document.createElement("textarea");
      textArea.value = text;

      // Avoid scrolling to bottom
      textArea.style.top = "0";
      textArea.style.left = "0";
      textArea.style.position = "fixed";

      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      try {
        var successful = document.execCommand('copy');
        var msg = successful ? 'successful' : 'unsuccessful';
        console.log('Fallback: Copying text command was ' + msg);
      } catch (err) {
        console.error('Fallback: Oops, unable to copy', err);
      }

      document.body.removeChild(textArea);
    }
    function copyTextToClipboard(text) {
      if (!navigator.clipboard) {
        fallbackCopyTextToClipboard(text);
        return;
      }
      navigator.clipboard.writeText(text).then(function() {
        console.log('Async: Copying to clipboard was successful!');
      }, function(err) {
        console.error('Async: Could not copy text: ', err);
      });
    }

    let copyTableRowsBtn = document.createElement('a');

    copyTableRowsBtn.setAttribute('style', 'text-align: center; margin-right: 5px;');
    copyTableRowsBtn.setAttribute('class', 'btn btn-default');
    copyTableRowsBtn.setAttribute('data-bind', 'click: click');
    copyTableRowsBtn.innerText = 'Admin 📧';

    const parentElement = document.querySelector( '#org-user-manager > div:nth-child(5)' );
    parentElement.insertBefore(copyTableRowsBtn, parentElement.querySelector( 'a[data-edit-action="submit"]' ));

    copyTableRowsBtn.addEventListener('click', function(event) {
      copyTextToClipboard(
        generateDataElement()
      );
    });

  })();

}

work();
