/**
 * @file approve.js
 * Logic of approve.html, the extension's own approval page. The page's address says which of
 * three questions it asks:
 *   ?url=<address>          OpenCode wants to open this address, whose site is not approved.
 *                           On Allow the choice is recorded and the address loads in this tab.
 *   ?host=<site>&from=<id>  "Review" was pressed on the bar inside tab <id>: may OpenCode use
 *                           <site>? After the answer this tab closes and tab <id> comes back.
 *   ?control=1              May OpenCode control the browser at all (the switch that is off
 *                           when Chrome starts)?
 * Every button reacts to real clicks only (event.isTrusted).
 * Project: opencode-browser-control
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

const params = new URLSearchParams(location.search);
/** True when this page was opened to ask for browser control as a whole (?control=1), not for one site. */
const forControl = params.get('control') === '1';
/** The address OpenCode asked for (?url=), or "" in the other two cases. */
const target = params.get('url') || '';
/** Id of the tab whose bar sent the user here (?from=), or null. */
const fromTab = params.get('from') ? Number(params.get('from')) : null;

/**
 * Host name of a web address.
 * @param {string} url - the address
 * @returns {string} lower-case host name, or "" when it is not an http or https address
 */
function hostOf(url) {
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : ''; } catch { return ''; }
}

/** The site being asked about: from ?url=, or from ?host= (checked to be a plain host name). */
const host = target ? hostOf(target) : hostOf('http://' + (params.get('host') || '')) === (params.get('host') || '').toLowerCase() ? (params.get('host') || '').toLowerCase() : '';

/**
 * Closes this tab. Before that, brings the tab the user came from back to the front.
 * @returns {void}
 */
function closeThisTab() {
  const close = () => chrome.tabs.getCurrent(tab => { if (tab) chrome.tabs.remove(tab.id); else window.close(); });
  if (fromTab !== null) chrome.tabs.update(fromTab, { active: true }, () => { void chrome.runtime.lastError; close(); }); // the tab may be gone; close anyway
  else close();
}

/**
 * Records the choice with the background worker, then loads the site, closes, or shows "denied".
 * @param {'once'|'always'|'deny'} choice - which button was pressed
 * @returns {void}
 */
function decide(choice) {
  if (!host) return;
  chrome.runtime.sendMessage({ type: 'oc-approve', host, choice }, () => {
    if (!target) closeThisTab();                 // came from a page's bar: go back to that tab
    else if (choice === 'deny') document.getElementById('note').textContent = 'Denied. You can close this tab.';
    else location.replace(target);               // the address OpenCode wanted, now allowed
  });
}

if (forControl) {
  // Same page, different question: may OpenCode control this browser at all?
  document.querySelector('h1').textContent = 'OpenCode wants to control this browser';
  document.querySelector('p').textContent = 'It will work only in its own "OpenCode" tab group and only on sites you approve one by one. This stays on until the task ends, you switch it off, press Stop, or quit Chrome.';
  document.getElementById('url').remove();
  document.getElementById('always').remove();
  document.getElementById('once').textContent = 'Allow browser control';
  document.getElementById('once').addEventListener('click', e => { if (e.isTrusted) chrome.runtime.sendMessage({ type: 'oc-resume' }, closeThisTab); });
  document.getElementById('deny').addEventListener('click', e => { if (e.isTrusted) chrome.runtime.sendMessage({ type: 'oc-stop' }, closeThisTab); });
} else {
  document.getElementById('host').textContent = host || '(not a web address)';
  if (target) document.getElementById('url').textContent = target;
  else {
    document.querySelector('h1').textContent = `OpenCode wants to use ${host || '(not a web address)'}`;
    document.getElementById('url').remove();
  }
  for (const id of ['once', 'always', 'deny']) document.getElementById(id).addEventListener('click', e => { if (e.isTrusted) decide(id); });
}
