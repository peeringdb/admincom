// ==UserScript==
// @name            PeeringDB FP - Copy record to Clipboard
// @namespace       https://www.peeringdb.com/
// @version         1.1.0.20260217
// @description     Generate a table containing search records. Copy the generated data object to the clipboard. Data can be pasted into e.g. Google Sheets.
// @author          <chriztoffer@peeringdb.com>
// @include         /^https:\/\/(\w+)\.peeringdb\.com\/(net|asn|carrier|org|fac|ix)\/(\d+)
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant           none
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-copy-record-to-clipboard.meta.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-copy-record-to-clipboard.user.js
// @supportURL      https://github.com/peeringdb/admincom/issues
// ==/UserScript==

let sleepTimer = 100; //time in ms

let seperator = '\t';
let newline = '\n';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateDataElement() {
  let result = '';
  let name = document.querySelector('.view_title > div[data-edit-name="name"]').innerText;
  let uri = window.location.href;

  result = name + ' (' + uri + ')';

  return result;
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

    let copyTableRowsBtn = document.createElement('span');
    let copyTableRowsBtnInner = document.createElement('a');

    // copyTableRowsBtnInner.setAttribute('href', '#');
    copyTableRowsBtnInner.setAttribute('class', 'btn btn-primary');
    copyTableRowsBtnInner.setAttribute('data-bind', 'click: click');
    copyTableRowsBtnInner.innerText = 'Copy Data';
    copyTableRowsBtnInner.style.marginLeft = '6px';

    document.querySelector( 'div.right.button-bar > div:first-child' ).appendChild(copyTableRowsBtn);
    copyTableRowsBtn.appendChild(copyTableRowsBtnInner);

    copyTableRowsBtn.addEventListener('click', function(event) {
      copyTextToClipboard(
        generateDataElement()
      );
    });

  })();

}

work();
