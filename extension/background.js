/**
 * @file background.js
 * The extension's background worker. It connects this Chrome to OpenCode running on this computer and
 * carries out the browser commands OpenCode sends: open a tab, read a page, click, type, screenshot.
 *
 * How the pieces talk:
 *   OpenCode  --(tool call)-->  server/chrome-mcp.mjs  (a small local server, 127.0.0.1 only)
 *   this worker asks that server "any commands?" (POST /poll), runs them, and posts the answer
 *   (POST /result). The extension always calls out; nothing can call into the extension.
 *
 * Safety rules enforced here (not left to the model):
 *   1. Each OpenCode session (every terminal session, and the chat panel) gets its own new
 *      tab group and only touches tabs inside it. Tabs it opens go into that group; you hand over
 *      one of your own tabs by dragging it into the group.
 *   2. It only reads or acts on a site after you approved that site (once, or always). A site
 *      can only be approved from this extension's own pages (the approval page, the chat
 *      panel), never from inside a web page, because a page can hide or imitate anything
 *      drawn inside it.
 *   3. It does not type into fields that look like password, one-time-code, payment-card or
 *      other secret fields (a best-effort check, see SECRET_AUTOCOMPLETE and SECRET_NAME).
 *   4. Browser control is a switch that is OFF when Chrome starts: the first command asks you to
 *      allow it. It goes off again when the chat panel's task finishes, after three minutes
 *      without a task, when you press Stop on a page, or when you flip the switch.
 *   5. The coloured frame and Stop button are on a tab only while a task is running.
 *
 * What this worker cannot know is WHO runs the local server it polls: any program on this
 * computer that listens on one of the ports below can send commands. The rules above apply to
 * it all the same. See SECURITY.md.
 *
 * Project: opencode-browser-control
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

/* ----------------------------------------------------------------------------------------------
 * Colours used outside the pages' style sheets. Change them here; the pages' own colours are
 * the CSS variables at the top of sidepanel.html, approve.html and overlay.js.
 * -------------------------------------------------------------------------------------------- */

/** Colour of the tab groups this extension makes: one of Chrome's group colour names. */
const GROUP_COLOR = 'blue';
/** Toolbar badge background while browser control is on. */
const BADGE_ON = '#15803d';
/** Toolbar badge background while something waits for the user ("?" or "!"). */
const BADGE_WAITING = '#2563eb';

/** Ports the local server may listen on (one per running OpenCode). Must match chrome-mcp.mjs. */
const PORTS = [17300, 17301, 17302, 17303, 17304, 17305, 17306, 17307, 17308, 17309];
/** Start of the title of every tab group this extension makes ("OpenCode", "OpenCode 14:05"). */
const GROUP_TITLE = 'OpenCode';
/**
 * A field is treated as secret, and never typed into or shown, when one of the words of its
 * `autocomplete` attribute matches this (source of a regular expression). Sites use several
 * words there, for example "section-pay billing cc-number", so each word is tested by itself.
 */
const SECRET_AUTOCOMPLETE = '^(cc-.*|current-password|new-password|one-time-code)$';
/**
 * ...or when its name, id, label or placeholder matches this (case is ignored). This catches a
 * password box switched to "show password" (then it is an ordinary text field) and card or
 * code fields that carry no autocomplete hint. It is a guess from words: it can miss a field
 * with an unusual name and can refuse a harmless one.
 */
const SECRET_NAME = 'passw|passcode|passphrase|\\bpin\\b|\\botp\\b|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code|\\bcvv|\\bcvc|\\bcsc\\b|card[-_ ]?(number|num|no)\\b|\\bssn\\b|social[-_ ]?security|api[-_ ]?key|\\bsecret\\b';
/** Element kinds listed in a page snapshot, as a CSS selector. */
const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[contenteditable=""],[contenteditable=true],[onclick]';

/** Ports with a poll loop currently running, so a wake-up never starts a second loop for the same port. */
const running = new Set();

/* ----------------------------------------------------------------------------------------------
 * Stored state: approved sites (kept), one-time approvals and the stopped flag (until Chrome quits)
 * -------------------------------------------------------------------------------------------- */

/**
 * Reads the browser-control switch. It is OFF when Chrome starts, so the first use in every
 * Chrome session needs the user's yes; Stop switches it off again.
 * @returns {Promise<boolean>} true when OpenCode may NOT act (switch off or Stop pressed)
 */
async function isStopped() {
  return !(await chrome.storage.session.get('enabled')).enabled;
}

/**
 * Asks the user to switch browser control on, without nagging: in the chat panel when it is
 * open (it shows an Allow card), otherwise in one small tab that is reused while it is open.
 * @returns {Promise<void>}
 */
async function askForControl() {
  await chrome.storage.session.set({ controlWanted: true });
  await updateBadge();
  const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
  if (panels.length) return;
  const { controlTab } = await chrome.storage.session.get('controlTab');
  if (controlTab && (await chrome.tabs.get(controlTab).catch(() => null))) return;
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('approve.html') + '?control=1', active: true });
  await chrome.storage.session.set({ controlTab: tab.id });
}

/**
 * Tells whether a site may be read and acted on.
 * @param {string} host - host name, for example "en.wikipedia.org"
 * @returns {Promise<boolean>} true when approved always or for this Chrome session
 */
async function isApproved(host) {
  const always = (await chrome.storage.local.get('allowedHosts')).allowedHosts || {};
  const once = (await chrome.storage.session.get('onceHosts')).onceHosts || {};
  return Boolean(always[host] || once[host]);
}

/**
 * Records the user's answer for a site, and takes the "waiting for your answer" bar off the
 * tabs that were asking about it.
 * @param {string} host - host name
 * @param {'once'|'always'|'deny'} choice - what they clicked
 * @returns {Promise<void>}
 */
async function setApproval(host, choice) {
  if (choice === 'always') {
    const always = (await chrome.storage.local.get('allowedHosts')).allowedHosts || {};
    always[host] = true;
    await chrome.storage.local.set({ allowedHosts: always });
  } else if (choice === 'once') {
    const once = (await chrome.storage.session.get('onceHosts')).onceHosts || {};
    once[host] = true;
    await chrome.storage.session.set({ onceHosts: once });
  }
  const pending = (await chrome.storage.session.get('pendingHosts')).pendingHosts || {};
  delete pending[host];
  await chrome.storage.session.set({ pendingHosts: pending });
  const asks = await askMap();
  for (const [tabId, asked] of Object.entries(asks)) {
    if (asked !== host) continue;
    delete asks[tabId];
    // Deny: the bar goes away. Allow: it turns back into the normal "controlling" pill.
    chrome.tabs.sendMessage(Number(tabId), choice === 'deny' ? { type: 'oc-overlay-hide' } : { type: 'oc-overlay', clearAsk: true }).catch(() => {});
  }
  await chrome.storage.session.set({ asks });
  await updateBadge();
}

/**
 * Reads which site each tab's bar is currently asking about: tab id -> host name. Kept here,
 * in the worker, so the answer never depends on what a web page claims.
 * @returns {Promise<Record<string, string>>} the map (kept until Chrome quits)
 */
async function askMap() {
  return (await chrome.storage.session.get('asks')).asks || {};
}

/**
 * Marks a site as waiting for the user's answer and shows the bar about it on a tab.
 * @param {number} tabId - the tab that needs the site
 * @param {string} host - the site that is not approved yet
 * @returns {Promise<void>}
 */
async function askFor(tabId, host) {
  await markPending(host);
  const asks = await askMap();
  asks[tabId] = host;
  await chrome.storage.session.set({ asks });
  await showOverlay(tabId, host);
}

/**
 * Adds a site to the "waiting for your answer" list shown in the chat panel and on the badge.
 * @param {string} host - host name
 * @returns {Promise<void>}
 */
async function markPending(host) {
  const pending = (await chrome.storage.session.get('pendingHosts')).pendingHosts || {};
  pending[host] = true;
  await chrome.storage.session.set({ pendingHosts: pending });
  await updateBadge();
}

/**
 * Toolbar badge: "on" while browser control is on, "!" while a site waits for approval,
 * "?" while OpenCode is asking for control to be switched on, nothing while it is off.
 * @returns {Promise<void>}
 */
async function updateBadge() {
  const pending = (await chrome.storage.session.get('pendingHosts')).pendingHosts || {};
  const wanted = (await chrome.storage.session.get('controlWanted')).controlWanted;
  const text = (await isStopped()) ? (wanted ? '?' : '') : Object.keys(pending).length ? '!' : 'on';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: text === 'on' ? BADGE_ON : BADGE_WAITING });
}

/* ----------------------------------------------------------------------------------------------
 * The "OpenCode" tab group
 * -------------------------------------------------------------------------------------------- */

/**
 * Every OpenCode that connects (each terminal session, and the chat panel) gets its own tab
 * group, so one session never works in another's tabs. This reads the list of
 * session key -> tab group id, kept until Chrome quits.
 * @returns {Promise<Record<string, number>>} the map
 */
async function groupMap() {
  return (await chrome.storage.session.get('groups')).groups || {};
}

/**
 * Finds the tab group of one OpenCode session, if it still exists (the user may have closed it).
 * A group the user started with "Add this tab" before any command is adopted by the
 * first session that asks.
 * @param {string} session - session key sent by the local server with every command
 * @returns {Promise<chrome.tabGroups.TabGroup|undefined>} the group, or undefined when it has none
 */
async function findGroup(session) {
  const map = await groupMap();
  let g = map[session] !== undefined ? await chrome.tabGroups.get(map[session]).catch(() => null) : null;
  if (!g) {
    const { adoptGroup } = await chrome.storage.session.get('adoptGroup');
    g = adoptGroup !== undefined ? await chrome.tabGroups.get(adoptGroup).catch(() => null) : null;
    if (g) { map[session] = g.id; await chrome.storage.session.set({ groups: map, adoptGroup: null }); }
  }
  return g || undefined;
}

/**
 * Tells whether a tab is inside any OpenCode group (used for the overlay and for keeping
 * links that open new tabs inside the group).
 * @param {chrome.tabs.Tab} tab - the tab
 * @returns {Promise<boolean>} true when its group's title starts with "OpenCode"
 */
async function inGroup(tab) {
  if (!tab || tab.groupId === undefined || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return false;
  const g = await chrome.tabGroups.get(tab.groupId).catch(() => null);
  return Boolean(g && (g.title || '').startsWith(GROUP_TITLE));
}

/**
 * Puts a tab into a session's group. When the session has no group yet (first tab, or the user
 * closed the old one) a NEW group is made: coloured, titled "OpenCode" for the chat panel and
 * "OpenCode HH:MM" (the time it was made) for a terminal session. It never joins a group that
 * belongs to another session.
 * @param {number} tabId - the tab to add
 * @param {string|null} session - session key; null = the user's own "Add this tab" before any session
 * @param {boolean} [panel] - true when the command comes from the chat panel
 * @returns {Promise<void>}
 */
async function addToGroup(tabId, session, panel) {
  const tab = await chrome.tabs.get(tabId);
  const g = session ? await findGroup(session) : undefined;
  if (g && g.windowId === tab.windowId) { await chrome.tabs.group({ tabIds: [tabId], groupId: g.id }); return; }
  const id = await chrome.tabs.group({ tabIds: [tabId] });
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  await chrome.tabGroups.update(id, { title: panel || !session ? GROUP_TITLE : `${GROUP_TITLE} ${time}`, color: GROUP_COLOR });
  if (session) { const map = await groupMap(); map[session] = id; await chrome.storage.session.set({ groups: map }); }
  else await chrome.storage.session.set({ adoptGroup: id });
}

/**
 * Looks a tab up and refuses it unless it is in this session's own group.
 * @param {number} tabId - id given by the model
 * @param {string} session - session key of the OpenCode that sent the command
 * @returns {Promise<chrome.tabs.Tab>} the tab
 * @throws {Error} when the tab does not exist or belongs to no group or another session's group
 */
async function groupTab(tabId, session) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab) throw new Error(`No tab with id ${tabId}. Call tabs to list the tabs you may use.`);
  const g = await findGroup(session);
  if (!g || tab.groupId !== g.id) throw new Error(`Tab ${tabId} is not in your tab group, so it is off limits. Use tabs to list yours, or open to make a new one.`);
  return tab;
}

/**
 * Host name of a URL, or "" for pages without one (new tab page, chrome:// pages).
 * @param {string} url - the address
 * @returns {string} lower-case host name
 */
function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch { return ''; }
}

/**
 * Refuses to go on unless the tab shows an approved site; otherwise asks the user.
 * @param {chrome.tabs.Tab} tab - the tab about to be read or acted on
 * @returns {Promise<void>}
 * @throws {Error} with a "needs approval" message the model is told to relay
 */
async function requireApproved(tab) {
  const host = hostOf(tab.url || '');
  if (!host) throw new Error('This tab shows a browser page (new tab or settings) that cannot be read. Use navigate to open a website first.');
  if (await isApproved(host)) return;
  await askFor(tab.id, host);
  throw new Error(`NEEDS APPROVAL: the user has not approved ${host} yet. A bar at the bottom of that tab (and the controls of the chat panel) asks them to allow it. Tell them, wait for their answer, then try again. Do not try another route.`);
}

/* ----------------------------------------------------------------------------------------------
 * Page overlay (overlay.js runs inside the page; these start it and listen to its buttons)
 * -------------------------------------------------------------------------------------------- */

/**
 * Makes sure the control overlay is on a tab and tells it what to show.
 * @param {number} tabId - the tab
 * @param {string} [askHost] - when set, the overlay says this site is waiting for the user's answer
 * @param {{x:number,y:number,click:boolean}} [cursor] - where to draw the cursor
 * @returns {Promise<void>} never rejects: a page that refuses scripts simply has no overlay
 */
async function showOverlay(tabId, askHost, cursor) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'oc-overlay', askHost: askHost || null, cursor: cursor || null });
  } catch { /* chrome:// pages, the web store and PDFs cannot be scripted */ }
}

/** A task counts as "running" for this long after its last command or heartbeat, in milliseconds. */
const ACTIVE_MS = 40000;
/** Browser control switches itself off after this long with no task running, in milliseconds. */
const IDLE_OFF_MS = 180000;

/**
 * Notes that a task is running right now (a command arrived, or the chat panel says it is
 * still working). The overlay is shown only while this is recent.
 * @returns {Promise<void>}
 */
async function markActive() {
  await chrome.storage.session.set({ lastActive: Date.now() });
}

/**
 * Tells whether a task was running within the last ACTIVE_MS.
 * @returns {Promise<boolean>} true while the overlay should stay on group tabs
 */
async function isActive() {
  const { lastActive } = await chrome.storage.session.get('lastActive');
  return Boolean(lastActive && Date.now() - lastActive < ACTIVE_MS);
}

/**
 * Removes the overlay from every tab of the OpenCode group (also overlays left behind by an
 * older copy of the extension). The overlay is only ever put up by a running command.
 * @returns {Promise<void>}
 */
async function hideOverlays() {
  for (const g of (await chrome.tabGroups.query({})).filter(x => (x.title || '').startsWith(GROUP_TITLE))) {
    for (const tab of await chrome.tabs.query({ groupId: g.id })) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] }); // loading it removes stale copies
        await chrome.tabs.sendMessage(tab.id, { type: 'oc-overlay-hide' });
      } catch { /* pages that cannot be scripted have no overlay */ }
    }
  }
}

/**
 * Housekeeping, run every 30 seconds and when the worker starts: take the overlay down when no
 * task is running, and switch browser control off after IDLE_OFF_MS without one, so it never
 * stays on by accident.
 * @returns {Promise<void>}
 */
async function tidy() {
  if (await isActive()) return;
  await hideOverlays();
  const { lastActive, enabled } = await chrome.storage.session.get(['lastActive', 'enabled']);
  if (enabled && (!lastActive || Date.now() - lastActive > IDLE_OFF_MS)) {
    await chrome.storage.session.set({ enabled: false, controlWanted: false });
    await updateBadge();
  }
}

/** Messages a web page's overlay may send. Everything else is accepted from this extension's own pages only. */
const PAGE_MESSAGES = ['oc-stop', 'oc-approve', 'oc-review'];

/**
 * Tells whether a message comes from one of this extension's own pages (the chat panel or the
 * approval page) and not from the overlay script inside a web page. Only those pages may
 * switch control on, approve a site, or change the lists: a web page shares a process with the
 * overlay script running in it, so a message from there is treated as possibly forged.
 * @param {chrome.runtime.MessageSender} sender - who sent the message
 * @returns {boolean} true for the extension's own pages
 */
function fromOwnPage(sender) {
  const base = chrome.runtime.getURL('');
  return Boolean(sender && sender.id === chrome.runtime.id
    && ((sender.origin && base.startsWith(sender.origin + '/')) || (sender.url && sender.url.startsWith(base))));
}

/**
 * Handles one message from the chat panel, the approval page or a page overlay.
 * @param {{type:string, host?:string, choice?:string}} msg - the message
 * @param {chrome.runtime.MessageSender} sender - who sent it
 * @returns {Promise<object>} the reply: {ok:true}, the context for 'oc-context', or {ok:false} when refused
 */
async function onMessage(msg, sender) {
  const type = msg && msg.type;
  const ownPage = fromOwnPage(sender);
  if (!ownPage && !PAGE_MESSAGES.includes(type)) return { ok: false };
  if (type === 'oc-stop') {          // Stop on a page, or the switch turned off, or "Deny"
    await chrome.storage.session.set({ enabled: false, controlWanted: false });
    await hideOverlays();
  } else if (type === 'oc-resume') { // the switch turned on, or "Allow"
    await chrome.storage.session.set({ enabled: true, controlWanted: false });
    await markActive(); // starts the idle clock; no overlay until a command actually runs
  } else if (type === 'oc-active') { // the chat panel is still working on an answer
    await markActive();
  } else if (type === 'oc-done') {   // the chat panel finished its task: control off, overlay down
    await chrome.storage.session.set({ enabled: false, controlWanted: false, lastActive: 0 });
    await hideOverlays();
  } else if (type === 'oc-approve') {
    // Who is asking decides what is possible:
    //  - one of this extension's own pages (approve.html, the chat panel) names the site and
    //    may allow or deny it;
    //  - the overlay inside a web page may only DENY, and only the site this worker asked
    //    about on that tab (or the tab's own site). Allowing from inside a page is not
    //    possible, because the page could trick the user into the click.
    const choice = msg.choice;
    const asked = sender.tab ? (await askMap())[sender.tab.id] : '';
    const host = ownPage ? String(msg.host || '').toLowerCase() : asked || hostOf((sender.tab && sender.tab.url) || '');
    const valid = host && hostOf('http://' + host) === host && ['once', 'always', 'deny'].includes(choice);
    if (valid && (ownPage || choice === 'deny')) await setApproval(host, choice);
    else return { ok: false };
  } else if (type === 'oc-review') {
    // The bar inside a page was clicked: show the question on this extension's own approval
    // page, in a new tab, where the web page cannot reach it. The site comes from this
    // worker's record of what it asked on that tab, not from the message.
    const host = sender.tab ? (await askMap())[sender.tab.id] : '';
    if (!host) return { ok: false };
    await chrome.tabs.create({ url: `${chrome.runtime.getURL('approve.html')}?host=${encodeURIComponent(host)}&from=${sender.tab.id}`, windowId: sender.tab.windowId, active: true });
  } else if (type === 'oc-add-tab' || type === 'oc-remove-tab') {
    // The user hands the tab in front over to OpenCode, or takes it back.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && type === 'oc-add-tab') { const { panelSession } = await chrome.storage.session.get('panelSession'); await addToGroup(tab.id, panelSession || null, true); } // no overlay: it appears when a task acts on the tab
    if (tab && type === 'oc-remove-tab') await chrome.tabs.ungroup(tab.id);
  } else if (type === 'oc-context') {
    // The side panel asks which tabs OpenCode may use, to tell the model with each chat message.
    // The panel's own group: the one its OpenCode uses, or one the user started with "Add this tab".
    const st = await chrome.storage.session.get(['panelSession', 'adoptGroup']);
    let g = st.panelSession ? await findGroup(st.panelSession) : undefined;
    if (!g && st.adoptGroup != null) g = await chrome.tabGroups.get(st.adoptGroup).catch(() => undefined);
    const tabs = g ? await chrome.tabs.query({ groupId: g.id }) : [];
    const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const shown = [];
    for (const t of tabs) {
      // The model is told a tab's title and address only for approved sites: both come from
      // the page, and an unapproved page must not be able to say anything to the model.
      const host = hostOf(t.url || '');
      const approved = Boolean(host) && (await isApproved(host));
      shown.push({ id: t.id, title: approved ? t.title : host || '(browser page)', url: approved ? t.url : '', approved, front: Boolean(front && t.id === front.id) });
    }
    // frontShared/frontOpen say whether there is a tab in front and whether it is shared. Its
    // title is deliberately not passed on: a tab outside the group is none of the model's business.
    return { ok: true, stopped: await isStopped(), controlWanted: Boolean((await chrome.storage.session.get('controlWanted')).controlWanted),
      frontInGroup: Boolean(front && tabs.some(t => t.id === front.id)), frontOpen: Boolean(front), tabs: shown };
  } else if (type === 'oc-new-chat') { // a new chat in the panel starts with a new tab group
    const { panelSession } = await chrome.storage.session.get('panelSession');
    if (panelSession) { const map = await groupMap(); delete map[panelSession]; await chrome.storage.session.set({ groups: map }); }
    await chrome.storage.session.set({ adoptGroup: null });
  } else if (type === 'oc-forget') {
    const always = (await chrome.storage.local.get('allowedHosts')).allowedHosts || {};
    delete always[msg.host];
    await chrome.storage.local.set({ allowedHosts: always });
  } else {
    return { ok: false };
  }
  await updateBadge();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  onMessage(msg, sender).then(reply, () => reply({ ok: false }));
  return true; // keep the channel open for the async reply
});

// A tab that goes to another page or closes no longer shows a question bar.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const asks = await askMap();
  if (asks[tabId]) { delete asks[tabId]; await chrome.storage.session.set({ asks }); }
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const asks = await askMap();
  if (asks[tabId]) { delete asks[tabId]; await chrome.storage.session.set({ asks }); }
});

// A link that opens a new tab from a group tab stays in the group, so the model can follow it.
chrome.tabs.onCreated.addListener(async tab => {
  if (!tab.openerTabId) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  if (opener && (await inGroup(opener))) await chrome.tabs.group({ tabIds: [tab.id], groupId: opener.groupId }).catch(() => {});
});

// Keep the overlay on group tabs as they load new pages.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'complete' && !(await isStopped()) && (await isActive()) && (await inGroup(tab))) await showOverlay(tabId);
});

/* ----------------------------------------------------------------------------------------------
 * Functions that run inside the page (passed to chrome.scripting.executeScript)
 * -------------------------------------------------------------------------------------------- */

/**
 * Runs in the page: lists what can be clicked or typed into and returns the readable text.
 * Each listed element gets a number (stored on it as data-oc-ref) that click and type refer to.
 * A function passed to executeScript is copied into the page by itself, so it cannot use
 * anything defined elsewhere in this file: what it needs comes in as arguments, and the small
 * secretField helper is written out again in pageAct.
 * @param {string} selector - CSS selector of interactive elements
 * @param {string} secretAuto - SECRET_AUTOCOMPLETE
 * @param {string} secretName - SECRET_NAME
 * @returns {{title:string,url:string,elements:string[],text:string,more:number}} the snapshot
 */
function pageSnapshot(selector, secretAuto, secretName) {
  // True for a field whose content is a secret: its value is not shown to the model.
  const secretField = el => {
    if (el.tagName === 'INPUT' && el.type === 'password') return true;
    if ((el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).some(word => new RegExp(secretAuto).test(word))) return true;
    const words = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), ...[...(el.labels || [])].map(l => l.textContent)].join(' ');
    return new RegExp(secretName, 'i').test(words);
  };
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (t, n) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  document.querySelectorAll('[data-oc-ref]').forEach(e => e.removeAttribute('data-oc-ref'));
  const lines = [];
  let n = 0, more = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el) || el.closest('oc-control-overlay')) continue;
    if (n >= 250) { more++; continue; }
    n++;
    el.setAttribute('data-oc-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let kind = role || tag;
    let label = clean(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name'), 90);
    let extra = '';
    if (tag === 'a') { kind = 'link'; try { const u = new URL(el.href); extra = ' -> ' + (u.host === location.host ? u.pathname + u.search : u.host + u.pathname).slice(0, 80); } catch {} }
    if (tag === 'input') {
      kind = 'input:' + (el.type || 'text');
      label = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id, 60);
      if (el.type === 'checkbox' || el.type === 'radio') extra = el.checked ? ' [checked]' : ' [not checked]';
      else if (secretField(el)) extra = ' (secret field: you may not type here, and its content is not shown)';
      else extra = ` value="${clean(el.value, 40)}"`;
    }
    if (tag === 'textarea') extra = secretField(el) ? ' (secret field: you may not type here, and its content is not shown)' : ` value="${clean(el.value, 40)}"`;
    if (tag === 'select') extra = ` selected="${clean(el.selectedOptions[0] && el.selectedOptions[0].text, 40)}" options: ${[...el.options].slice(0, 12).map(o => clean(o.text, 25)).join(' | ')}`;
    lines.push(`[${n}] ${kind} "${label}"${extra}`);
  }
  return { title: document.title, url: location.href, elements: lines, more, text: clean(document.body ? document.body.innerText : '', 6000) };
}

/**
 * Runs in the page: clicks, types into, or scrolls to one numbered element.
 * @param {string} action - "click", "type", "select" or "locate"
 * @param {number} ref - element number from the last snapshot
 * @param {string} [text] - text to type or option to select
 * @param {boolean} [submit] - after typing, submit the form (or press Enter)
 * @param {string} [secretAuto] - SECRET_AUTOCOMPLETE (needed for "type" and "select")
 * @param {string} [secretName] - SECRET_NAME (needed for "type" and "select")
 * @returns {{ok:boolean,error?:string,x?:number,y?:number,info?:string}} result and the element's centre
 */
function pageAct(action, ref, text, submit, secretAuto, secretName) {
  const el = document.querySelector(`[data-oc-ref="${ref}"]`);
  if (!el) return { ok: false, error: `No element [${ref}] on this page. The page changed: take a new snapshot and use the new numbers.` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const at = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  if (action === 'locate') return { ok: true, ...at };
  if (action === 'click') {
    el.focus({ preventScroll: true });
    el.click();
    return { ok: true, ...at };
  }
  const tag = el.tagName.toLowerCase();
  // True for a field whose content is a secret (the same test as in pageSnapshot, see there).
  const secretField = () => {
    if (tag === 'input' && el.type === 'password') return true;
    if ((el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).some(word => new RegExp(secretAuto).test(word))) return true;
    const words = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), ...[...(el.labels || [])].map(l => l.textContent)].join(' ');
    return new RegExp(secretName, 'i').test(words);
  };
  if (secretField()) {
    return { ok: false, error: 'Refused: this looks like a password, one-time-code, payment-card or other secret field. Ask the user to type it themselves.' };
  }
  if (action === 'select') {
    if (tag !== 'select') return { ok: false, error: `[${ref}] is not a drop-down list.` };
    const opt = [...el.options].find(o => o.text.trim().toLowerCase() === String(text).trim().toLowerCase() || o.value === text);
    if (!opt) return { ok: false, error: `No option "${text}". Options: ${[...el.options].map(o => o.text.trim()).slice(0, 30).join(' | ')}` };
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, ...at };
  }
  // action === 'type'
  el.focus({ preventScroll: true });
  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  } else if (tag === 'input' || tag === 'textarea') {
    // Use the browser's own value setter so pages built with React or Vue notice the change.
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    return { ok: false, error: `[${ref}] is not a text field.` };
  }
  if (submit) {
    const form = el.form || el.closest('form');
    if (form && form.requestSubmit) form.requestSubmit();
    else for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
  return { ok: true, ...at };
}

/**
 * Runs in the page: tells where a click on a numbered element, or submitting a field's form,
 * would send the browser. Used to keep data from being sent to a site the user has not
 * approved: a link to it, or a form that posts to it.
 * @param {number} ref - element number from the last snapshot
 * @param {boolean} submitting - true: the element is a field whose form is about to be
 *        submitted; false: the element is about to be clicked
 * @returns {string} the full address, or "" when the element is neither a link nor a way to submit a form
 */
function pageDestination(ref, submitting) {
  const el = document.querySelector(`[data-oc-ref="${ref}"]`);
  if (!el) return '';
  // A form field named "action" or "getAttribute" hides the form's own property of that name,
  // so the attribute is read with the method taken from Element itself.
  const attr = (node, name) => Element.prototype.getAttribute.call(node, name) || '';
  const actionOf = form => new URL(attr(form, 'action'), location.href).href;
  if (submitting) { const form = el.form || el.closest('form'); return form ? actionOf(form) : ''; }
  const link = el.closest('a[href]');
  if (link) return link.href;
  const control = el.closest('button,input');
  if (!control || !control.form) return '';
  const type = (attr(control, 'type') || (control.tagName === 'BUTTON' ? 'submit' : 'text')).toLowerCase();
  if (type !== 'submit' && type !== 'image') return '';
  return attr(control, 'formaction') ? new URL(attr(control, 'formaction'), location.href).href : actionOf(control.form);
}

/**
 * Runs in the page: scrolls it.
 * @param {string} direction - "down", "up", "top" or "bottom"
 * @returns {{y:number,max:number}} scroll position and the page's scrollable height
 */
function pageScroll(direction) {
  const h = window.innerHeight * 0.85;
  if (direction === 'top') window.scrollTo(0, 0);
  else if (direction === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
  else window.scrollBy(0, direction === 'up' ? -h : h);
  return { y: Math.round(window.scrollY), max: Math.round(document.documentElement.scrollHeight - window.innerHeight) };
}

/**
 * Runs a function inside a tab's page and returns what it returned.
 * @param {number} tabId - the tab
 * @param {Function} func - one of the page* functions above
 * @param {Array} args - its arguments
 * @returns {Promise<any>} the function's return value
 * @throws {Error} when the page cannot be scripted
 */
async function inPage(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res ? res.result : undefined;
}

/**
 * Waits until a tab has finished loading, at most 15 seconds.
 * @param {number} tabId - the tab
 * @returns {Promise<chrome.tabs.Tab>} the tab as it is afterwards
 */
async function settled(tabId) {
  for (let i = 0; i < 60; i++) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return t;
    await new Promise(r => setTimeout(r, 250));
  }
  return chrome.tabs.get(tabId);
}

/**
 * Turns a snapshot into the text handed to the model.
 * @param {number} tabId - the tab it came from
 * @param {ReturnType<typeof pageSnapshot>} s - the snapshot
 * @returns {string} readable snapshot
 */
function snapshotText(tabId, s) {
  return [`Tab ${tabId}: ${s.title}`, s.url, '', 'Things you can click or type into (use the number as ref):',
    ...(s.elements.length ? s.elements : ['(none found)']),
    ...(s.more ? [`(${s.more} more not listed; scroll and take a new snapshot)`] : []),
    '', 'Page text:', s.text].join('\n');
}

/* ----------------------------------------------------------------------------------------------
 * The commands OpenCode can send. Each returns text for the model, or throws an Error.
 * -------------------------------------------------------------------------------------------- */

/** @type {Record<string, (a: any) => Promise<any>>} */
const COMMANDS = {
  /** Lists the tabs in the OpenCode group. */
  async tabs({ _s }) {
    const g = await findGroup(_s);
    if (!g) return 'You have no tab group yet. Use open: it makes a new tab in a new group of your own.';
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const lines = [];
    for (const t of tabs) {
      // Title and address come from the page, so they are given only for approved sites.
      const host = hostOf(t.url || '');
      const what = !host ? '(a browser page, not a website)'
        : (await isApproved(host)) ? `${t.title || '(no title)'} | ${t.url}`
        : `${host} (not approved by the user yet, so its title and address are not shown)`;
      lines.push(`tab ${t.id}${t.active ? ' (in front)' : ''}: ${what}`);
    }
    return lines.join('\n') || 'The group is empty. Use open.';
  },

  /** Opens a new tab in the group. An unapproved site loads only after the user allows it. */
  async open({ url, _s, _panel }) {
    const host = hostOf(url);
    if (!host) throw new Error('Give a full http or https address.');
    const approved = await isApproved(host);
    const target = approved ? url : chrome.runtime.getURL('approve.html') + '?url=' + encodeURIComponent(url);
    const tab = await chrome.tabs.create({ url: target, active: true });
    await addToGroup(tab.id, _s, _panel);
    if (!approved) {
      await markPending(host);
      throw new Error(`NEEDS APPROVAL: opened tab ${tab.id}, which is asking the user to allow ${host}. Tell them, wait for their answer, then call snapshot on tab ${tab.id}. Do not try another route.`);
    }
    await settled(tab.id);
    return `Opened tab ${tab.id}. Call snapshot to read it.`;
  },

  /** Sends an existing group tab to another address (same approval rule as open). */
  async navigate({ tabId, url, _s }) {
    const tab = await groupTab(tabId, _s);
    const host = hostOf(url);
    if (!host) throw new Error('Give a full http or https address.');
    if (!(await isApproved(host))) {
      await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('approve.html') + '?url=' + encodeURIComponent(url) });
      await markPending(host);
      throw new Error(`NEEDS APPROVAL: tab ${tab.id} is asking the user to allow ${host}. Tell them, wait for their answer, then call snapshot. Do not try another route.`);
    }
    await chrome.tabs.update(tab.id, { url });
    await settled(tab.id);
    return `Tab ${tab.id} is now at ${url}. Call snapshot to read it.`;
  },

  /** Reads a page: numbered clickable things plus the text. */
  async snapshot({ tabId, _s }) {
    const tab = await settled((await groupTab(tabId, _s)).id);
    await requireApproved(tab);
    await showOverlay(tab.id);
    return snapshotText(tab.id, await inPage(tab.id, pageSnapshot, [INTERACTIVE, SECRET_AUTOCOMPLETE, SECRET_NAME]));
  },

  /** Clicks a numbered element, then returns a fresh snapshot. */
  async click({ tabId, ref, _s }) {
    const tab = await groupTab(tabId, _s);
    await requireApproved(tab);
    const at = await inPage(tab.id, pageAct, ['locate', Number(ref)]);
    // A link to another site is not followed, and a form that posts to another site is not
    // submitted, until the user approved that site: nothing is sent to an unapproved site
    // through the address or the form. (A page's own script can still send the browser
    // elsewhere after a click; that is caught below, after the fact.)
    const linkHost = hostOf((await inPage(tab.id, pageDestination, [Number(ref), false])) || '');
    if (linkHost && !(await isApproved(linkHost))) {
      await askFor(tab.id, linkHost);
      throw new Error(`NEEDS APPROVAL: that link or form goes to ${linkHost}, which the user has not approved, so it was not used. A bar at the bottom of the tab asks them. Tell them, wait for their answer, then click again. Do not try another route.`);
    }
    if (at && at.ok) await showOverlay(tab.id, null, { x: at.x, y: at.y, click: true });
    const r = await inPage(tab.id, pageAct, ['click', Number(ref)]);
    if (!r || !r.ok) throw new Error(r ? r.error : 'The page did not answer.');
    await new Promise(res => setTimeout(res, 700));
    const after = await settled(tab.id);
    if (!(await isApproved(hostOf(after.url || '')))) await requireApproved(after);
    return 'Clicked.\n\n' + snapshotText(tab.id, await inPage(tab.id, pageSnapshot, [INTERACTIVE, SECRET_AUTOCOMPLETE, SECRET_NAME]));
  },

  /** Types into a numbered field (not into secret-looking ones); optionally submits. */
  async type({ tabId, ref, text, submit, _s }) {
    const tab = await groupTab(tabId, _s);
    await requireApproved(tab);
    if (submit) { // the form must not carry the text to a site the user has not approved
      const formHost = hostOf((await inPage(tab.id, pageDestination, [Number(ref), true])) || '');
      if (formHost && !(await isApproved(formHost))) {
        await askFor(tab.id, formHost);
        throw new Error(`NEEDS APPROVAL: that form sends its content to ${formHost}, which the user has not approved, so nothing was typed or sent. A bar at the bottom of the tab asks them. Tell them, wait for their answer, then try again. Do not try another route.`);
      }
    }
    const r = await inPage(tab.id, pageAct, ['type', Number(ref), String(text), Boolean(submit), SECRET_AUTOCOMPLETE, SECRET_NAME]);
    if (!r || !r.ok) throw new Error(r ? r.error : 'The page did not answer.');
    await showOverlay(tab.id, null, { x: r.x, y: r.y, click: false });
    if (!submit) return 'Typed.';
    await new Promise(res => setTimeout(res, 900));
    const after = await settled(tab.id);
    if (!(await isApproved(hostOf(after.url || '')))) await requireApproved(after);
    return 'Typed and submitted.\n\n' + snapshotText(tab.id, await inPage(tab.id, pageSnapshot, [INTERACTIVE, SECRET_AUTOCOMPLETE, SECRET_NAME]));
  },

  /** Chooses an option in a drop-down list. */
  async select({ tabId, ref, option, _s }) {
    const tab = await groupTab(tabId, _s);
    await requireApproved(tab);
    const r = await inPage(tab.id, pageAct, ['select', Number(ref), String(option), false, SECRET_AUTOCOMPLETE, SECRET_NAME]);
    if (!r || !r.ok) throw new Error(r ? r.error : 'The page did not answer.');
    return 'Selected.';
  },

  /** Scrolls the page. */
  async scroll({ tabId, direction, _s }) {
    const tab = await groupTab(tabId, _s);
    await requireApproved(tab);
    const r = await inPage(tab.id, pageScroll, [direction || 'down']);
    return `Scrolled ${direction || 'down'} (position ${r.y} of ${r.max}). Take a new snapshot to see what is listed now.`;
  },

  /** Goes back one page in the tab's history. */
  async back({ tabId, _s }) {
    const tab = await groupTab(tabId, _s);
    await chrome.tabs.goBack(tab.id);
    await settled(tab.id);
    return 'Went back. Call snapshot.';
  },

  /** Captures the visible part of the tab; the local server saves the picture to a file. */
  async screenshot({ tabId, _s }) {
    const tab = await groupTab(tabId, _s);
    await requireApproved(tab);
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(res => setTimeout(res, 350));
    // The picture is of whatever tab is in front of that window. Look again just before taking
    // it: the user may have switched to another tab meanwhile, or the page may have moved to a
    // site that is not approved.
    const now = await chrome.tabs.get(tab.id);
    if (!now.active) throw new Error('The tab is no longer in front, so no picture was taken. Try again.');
    await requireApproved(now);
    return { png: await chrome.tabs.captureVisibleTab(now.windowId, { format: 'png' }) };
  },

  /**
   * Downloads the file a numbered link points to, the way clicking "save link as" would: Chrome
   * itself fetches it into the Downloads folder and shows it in its downloads list.
   */
  async download({ tabId, ref, _s }) {
    const tab = await groupTab(tabId, _s);
    await requireApproved(tab);
    const at = await inPage(tab.id, pageAct, ['locate', Number(ref)]);
    if (!at || !at.ok) throw new Error(at ? at.error : 'The page did not answer.');
    await showOverlay(tab.id, null, { x: at.x, y: at.y, click: true });
    const url = await inPage(tab.id, n => { const el = document.querySelector(`[data-oc-ref="${n}"]`); return el && (el.href || el.src) || ''; }, [Number(ref)]);
    const host = hostOf(url);
    if (!host) throw new Error(`[${ref}] is not a link to a file. Pick the link that points at the file (for example "pdf").`);
    if (!(await isApproved(host))) { // the file may live on another site than the page
      await askFor(tab.id, host);
      throw new Error(`NEEDS APPROVAL: the file is on ${host}, which the user has not approved. They are being asked in that tab. Tell them, wait, then try again.`);
    }
    const id = await chrome.downloads.download({ url, saveAs: false, conflictAction: 'uniquify' });
    for (let i = 0; i < 120; i++) { // wait up to a minute for it to finish
      const [d] = await chrome.downloads.search({ id });
      if (d && d.state === 'complete') return `Download complete and verified by Chrome: ${d.filename} (${d.fileSize} bytes) from ${url}. No further check is needed.`;
      if (d && d.state === 'interrupted') throw new Error(`The download failed (${d.error || 'interrupted'}) for ${url}`);
      await new Promise(r => setTimeout(r, 500));
    }
    return `The download of ${url} is still running; it will appear in Chrome's Downloads folder.`;
  },

  /** Closes a tab the model no longer needs. */
  async close({ tabId, _s }) {
    const tab = await groupTab(tabId, _s);
    await chrome.tabs.remove(tab.id);
    return `Closed tab ${tabId}.`;
  },
};

/**
 * Runs one command from OpenCode.
 * @param {{id:string,tool:string,args:object}} cmd - the command
 * @returns {Promise<{id:string,ok:boolean,data?:any,error?:string}>} the answer to post back
 */
async function execute(cmd) {
  try {
    if (await isStopped()) {
      await askForControl();
      throw new Error('BROWSER CONTROL IS OFF. The user has to switch it on first; they are being asked in the browser right now (an Allow button in the OpenCode chat panel or in a small tab). Tell them you are waiting for that, and try again only after they say they allowed it. If they pressed Stop or Deny, stop.');
    }
    await markActive();
    const fn = COMMANDS[cmd.tool];
    if (!fn) throw new Error(`Unknown command ${cmd.tool}`);
    // _s: which OpenCode sent this (each has its own tab group); _panel: it is the chat panel's.
    const session = String(cmd.session || 'default');
    if (cmd.panel) await chrome.storage.session.set({ panelSession: session });
    return { id: cmd.id, ok: true, data: await fn({ ...(cmd.args || {}), _s: session, _panel: Boolean(cmd.panel) }) };
  } catch (e) {
    return { id: cmd.id, ok: false, error: String((e && e.message) || e) };
  }
}

/* ----------------------------------------------------------------------------------------------
 * Talking to the local server
 * -------------------------------------------------------------------------------------------- */

/**
 * Sends JSON to the local server on one port.
 * @param {number} port - the port
 * @param {string} path - "/poll" or "/result"
 * @param {object} body - what to send
 * @returns {Promise<any>} the parsed reply
 * @throws {Error} when no server is listening there
 */
async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('server said ' + res.status);
  return res.json();
}

/**
 * Keeps asking one port for commands until the worker is put to sleep. If no OpenCode is
 * listening on that port the request fails at once and it tries again a few seconds later.
 * @param {number} port - the port to serve
 * @returns {Promise<void>} never resolves in normal use
 */
async function pollLoop(port) {
  if (running.has(port)) return;
  running.add(port);
  try {
    for (;;) {
      try {
        const { commands } = await post(port, '/poll', { version: chrome.runtime.getManifest().version });
        for (const cmd of commands || []) {
          const result = await execute(cmd);
          await post(port, '/result', result);
        }
      } catch {
        await new Promise(r => setTimeout(r, 4000));
      }
      await chrome.runtime.getPlatformInfo(); // an extension call resets Chrome's idle timer for this worker
    }
  } finally {
    running.delete(port);
  }
}

/** Starts (or restarts after sleep) one poll loop per port, and makes the toolbar icon open the chat panel. */
function start() {
  for (const p of PORTS) pollLoop(p);
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  tidy();
  updateBadge();
}

// Chrome puts background workers to sleep; this alarm wakes it every 30 seconds to resume polling.
chrome.alarms.create('oc-wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
start();
