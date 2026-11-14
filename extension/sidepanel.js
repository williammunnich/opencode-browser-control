/**
 * @file sidepanel.js
 * Logic of the chat panel (sidepanel.html). It talks to OpenCode through the local chat server
 * (server/chat-server.mjs, started with bin/opencode-chat-server), which no web page can
 * reach. One chat = one OpenCode session using the `chrome-panel` agent, which can use the
 * tabs of the "OpenCode" tab group and nothing else: it cannot run commands or touch files.
 * The chat server sends every message to that agent whatever this file asks for, so the limit
 * does not depend on this file.
 * Its thinking, its words and every browser step are shown as they happen.
 *
 * While OpenCode works on an answer, the panel checks every 1.5 seconds for:
 *   - the model's text as it is written and new steps (tool calls, small grey lines), so you
 *     can see what it is doing; the status line names the tool running right now; and
 *   - permission requests (for example "start a subagent"), shown as a card with Allow / Deny.
 *
 * You can keep typing while it works: a message sent then is queued (grey bubble) and goes out
 * when the current answer ends, or at once with "Send now", which interrupts the answer so
 * OpenCode reconsiders with the new message. Pressing Enter never stops it; the round button
 * stops it only while the text box is empty.
 *
 * The clock button lists earlier chats from this panel; picking one loads it so it can be
 * continued.
 *
 * The switch next to + turns browser control on and off. It is off when Chrome starts and goes
 * off again when a task finishes, so every task needs a yes (flip the switch before sending, or
 * press Allow when OpenCode asks). The coloured frame on a tab shows only while a task is
 * running. The "..." controls hold the rest: add or take back the tab in front, sites waiting
 * for approval, always-allowed sites.
 *
 * Model text is never inserted as HTML: replies are built from text nodes (see render), so a
 * reply cannot inject markup or scripts into this panel.
 *
 * Project: opencode-browser-control
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

/** Address of the local chat server. Must match PROXY_PORT in chat-server.mjs. */
const API = 'http://127.0.0.1:17320/api';
/**
 * OpenCode agent used for every chat here. `chrome-panel` has only the browser tools: no shell,
 * no files, no web access outside the browser, no subagents (set in OpenCode's opencode.json,
 * see opencode-config-snippet.json). The terminal's `chrome` agent keeps all tools.
 */
const AGENT = 'chrome-panel';
/** Square "stop" and arrow "send" icons for the round button. */
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';

/**
 * Shorthand for document.getElementById.
 * @param {string} id - element id
 * @returns {HTMLElement} the element
 */
const $ = id => document.getElementById(id);
const log = $('log'), statusEl = $('status'), costEl = $('cost'), textEl = $('text'), sendBtn = $('send'), modelEl = $('model');

/** Id of the current OpenCode session, or null before the first message. */
let sessionId = null;
/** True while OpenCode is working on an answer. */
let busy = false;
/** Estimated cost of this chat in dollars, summed from each reply. */
let chatCost = 0;
/** Ids of steps and permission requests already shown, so they are not drawn twice. */
const shown = new Set();
/** Messages typed while OpenCode was busy, waiting their turn: {text, el} (el = the grey bubble shown for it). */
const queue = [];
/** True while we are interrupting the current answer on purpose, so its "Aborted" error is not shown. */
let interrupting = false;
/** True while the watch loop is running, so a second one is never started. */
let watching = false;
/** Name of the tool OpenCode is running right now, for the status line ("" when none). */
let activity = '';

/**
 * Calls OpenCode through the local chat server.
 * @param {string} method - "GET" or "POST"
 * @param {string} path - OpenCode server path, e.g. "/session"
 * @param {object} [body] - JSON body for POST
 * @returns {Promise<any>} the parsed reply
 * @throws {Error} when the chat server is not running or OpenCode answered with an error
 */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, path, body }) });
  } catch {
    throw new Error('The chat server is not running. In a terminal run:  opencode-chat-server');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (data.data && data.data.message) || `OpenCode answered ${res.status}`);
  return data;
}

/**
 * Asks the background worker something (which tabs are in the group, add a tab, stop, ...).
 * @param {object} message - e.g. {type: 'oc-context'}
 * @returns {Promise<any>} its reply
 */
function ask(message) {
  return new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
}

/**
 * Adds an element to the conversation, removes the empty-state picture, and scrolls down.
 * @param {HTMLElement} el - the element to add
 * @returns {HTMLElement} the same element
 */
function push(el) {
  const empty = $('empty');
  if (empty) empty.remove();
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

/**
 * Adds a plain-text block (the user's message, a progress line or an error).
 * @param {string} cls - CSS classes: "me", "step", "step err"
 * @param {string} text - what to show
 * @returns {HTMLElement} the new element
 */
function add(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return push(el);
}

/**
 * Builds a reply from the model's text with light formatting: paragraphs, ``` code blocks,
 * `inline code` and **bold**. Everything is created as elements and text nodes, never as HTML.
 * @param {string} text - the model's reply
 * @returns {HTMLElement} a div.ai ready to be added
 */
function render(text) {
  const box = document.createElement('div');
  box.className = 'ai';
  text.split(/```/).forEach((chunk, i) => {
    if (i % 2) { // inside a code fence; drop the language name on its first line
      const pre = document.createElement('pre');
      pre.textContent = chunk.replace(/^[\w+-]*\n/, '').replace(/\n$/, '');
      box.appendChild(pre);
      return;
    }
    for (const para of chunk.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      for (const piece of para.trim().split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
        if (/^`[^`]+`$/.test(piece)) { const c = document.createElement('code'); c.textContent = piece.slice(1, -1); p.appendChild(c); }
        else if (/^\*\*[^*]+\*\*$/.test(piece)) { const b = document.createElement('strong'); b.textContent = piece.slice(2, -2); p.appendChild(b); }
        else if (piece) p.appendChild(document.createTextNode(piece));
      }
      box.appendChild(p);
    }
  });
  return box;
}

/**
 * Adds one row with a label and buttons to a list in the controls.
 * @param {HTMLElement} list - the <ul>
 * @param {string} label - text on the left
 * @param {Array<[string, string, object]>} buttons - [text, extra css class, message for the background worker]
 */
function row(list, label, buttons) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = label;
  const box = document.createElement('span');
  box.className = 'rowbtns';
  for (const [text, cls, message] of buttons) {
    const b = document.createElement('button');
    b.className = 'pill ' + cls; b.textContent = text;
    b.addEventListener('click', async () => { await ask(message); refresh(); });
    box.appendChild(b);
  }
  li.append(span, box);
  list.appendChild(li);
}

/**
 * Fills a list in the controls, or shows a grey placeholder when it is empty.
 * @param {string} id - id of the <ul>
 * @param {string[]} items - what to list
 * @param {string} none - placeholder text
 * @param {(item: string) => Array<[string, string, object]>} buttons - buttons for one item
 */
function fill(id, items, none, buttons) {
  const list = $(id);
  list.textContent = '';
  for (const item of items) row(list, item, buttons(item));
  if (!items.length) { const li = document.createElement('li'); li.textContent = none; li.style.color = 'var(--muted)'; list.appendChild(li); }
}

/** Redraws the status line, the model label and the controls. Runs every few seconds. */
async function refresh() {
  const ctx = (await ask({ type: 'oc-context' })) || {};
  const tabs = ctx.tabs || [];
  const { pendingHosts } = await chrome.storage.session.get('pendingHosts');
  const { allowedHosts } = await chrome.storage.local.get('allowedHosts');
  const waiting = Object.keys(pendingHosts || {});

  // The switch next to +: browser control starts off in every Chrome session.
  const on = !ctx.stopped;
  $('control').setAttribute('aria-checked', String(on));
  $('controlLabel').textContent = on ? 'Browser control on' : 'Browser control off';
  $('control').onclick = async () => { await ask({ type: on ? 'oc-stop' : 'oc-resume' }); refresh(); };
  // OpenCode tried to use the browser while the switch was off: ask once, here in the chat.
  if (ctx.controlWanted && !on && !$('wantcard')) showControlRequest();
  if ((on || !ctx.controlWanted) && $('wantcard')) $('wantcard').remove();
  fill('tabs', tabs.map(t => (t.front ? '▸ ' : '') + (t.title || t.url)), 'None yet. Press + below, or just ask and it opens one.', () => []);
  fill('pending', waiting, 'Nothing waiting.', h => [['Once', '', { type: 'oc-approve', host: h, choice: 'once' }], ['Always', '', { type: 'oc-approve', host: h, choice: 'always' }], ['Deny', 'red', { type: 'oc-approve', host: h, choice: 'deny' }]]);
  fill('allowed', Object.keys(allowedHosts || {}).sort(), 'None yet.', h => [['Remove', 'ghost', { type: 'oc-forget', host: h }]]);

  let line = '', bad = false;
  try {
    const agents = await api('GET', '/agent');
    const me = agents.find(a => a.name === AGENT);
    const id = me && me.model && (me.model.modelID || me.model.id);
    if (id && !modelEl.dataset.fixed) setModel(id);
    if (ctx.stopped) line = ctx.controlWanted ? 'OpenCode is asking to control the browser.' : 'Browser control is off. OpenCode can chat but cannot use tabs.';
    else if (waiting.length) line = `Waiting for you to allow ${waiting.join(', ')} (in that tab, or under ⋯).`;
    else if (busy) line = activity ? `Working… (${activity})` : 'Working…';
    else if (!tabs.length) line = ctx.frontOpen ? 'The tab in front is not shared with OpenCode. Press + to share it.' : '';
    else line = `${tabs.length} tab${tabs.length > 1 ? 's' : ''} shared with OpenCode.`;
  } catch (e) { line = e.message; bad = true; }
  statusEl.textContent = line;
  statusEl.className = bad ? 'bad' : '';
}

/**
 * Shows a card in the chat asking the user to switch browser control on (or refuse).
 * Used when OpenCode tried a browser tool while the switch was off.
 */
function showControlRequest() {
  const card = document.createElement('div');
  card.className = 'askcard';
  card.id = 'wantcard';
  const what = document.createElement('div');
  what.textContent = 'OpenCode wants to control the browser (only tabs in the OpenCode group, only sites you approve).';
  const btns = document.createElement('div');
  btns.className = 'rowbtns';
  for (const [label, type, cls] of [['Allow browser control', 'oc-resume', ''], ['Deny', 'oc-stop', 'red']]) {
    const b = document.createElement('button');
    b.className = 'pill ' + cls; b.textContent = label;
    b.addEventListener('click', async () => { await ask({ type }); card.remove(); refresh(); });
    btns.appendChild(b);
  }
  card.append(what, btns);
  push(card);
}

/**
 * Shows which model answers, in the composer.
 * @param {string} id - model id from OpenCode, e.g. "provider/some-model-1234"
 */
function setModel(id) {
  const name = id.split('/').pop().replace(/-\d{4}$/, '').replace(/-/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bV(\d)/, 'V$1');
  modelEl.textContent = '';
  const b = document.createElement('b');
  b.textContent = name;
  modelEl.append(b, ' browser only');
  modelEl.title = id;
}

/**
 * One line describing a tool call, for the progress list.
 * @param {object} part - a message part of type "tool" from OpenCode
 * @returns {string} e.g. "✓ click  ref 12"
 */
function stepLine(part) {
  const st = part.state || {};
  const mark = st.status === 'completed' ? '✓' : st.status === 'error' ? '✗' : '…';
  const input = st.input ? Object.entries(st.input).map(([k, v]) => `${k} ${String(v).slice(0, 60)}`).join(', ') : '';
  return `${mark} ${String(part.tool).replace(/^chrome_/, '')}  ${input}`;
}

/**
 * Draws one message from OpenCode into the conversation, or updates what is already drawn.
 * Every text and tool part gets an element whose id contains the part's id, so calling this
 * again for the same message only fills in what changed (text grows while the model writes,
 * a tool line goes from "…" to "✓"). This is the only place assistant text is drawn.
 * @param {{info:object, parts:object[]}} m - a message as returned by GET /session/<id>/message
 * @param {boolean} withUser - also draw the user's own messages (true when loading an earlier chat;
 *        false while chatting, because the panel already drew what they typed)
 */
function drawMessage(m, withUser) {
  const role = m.info && m.info.role;
  for (const p of m.parts || []) {
    if (p.type === 'tool') {
      const line = stepLine(p);
      const old = $('step-' + p.id);
      if (old) { if (old.textContent !== line) old.textContent = line; }
      else add('step', line).id = 'step-' + p.id;
    } else if (p.type === 'reasoning' && role === 'assistant') {
      // The model's thinking, shown in full so the user can follow why it does what it does.
      const text = (p.text || '').trim();
      if (!text) continue;
      const old = $('think-' + p.id);
      if (old) { if (old.dataset.text !== text) { old.dataset.text = text; old.lastChild.textContent = text; } continue; }
      const box = document.createElement('details');
      box.className = 'think';
      box.id = 'think-' + p.id;
      box.open = true;
      box.dataset.text = text;
      const sum = document.createElement('summary');
      sum.textContent = 'Thinking';
      const body = document.createElement('div');
      body.textContent = text;
      box.append(sum, body);
      push(box);
    } else if (p.type === 'text' && role === 'assistant') {
      const text = (p.text || '').trim();
      if (!text) continue;
      const old = $('txt-' + p.id);
      if (old && old.dataset.text === text) continue;
      const el = render(text);
      el.id = 'txt-' + p.id;
      el.dataset.text = text;
      if (old) old.replaceWith(el); else push(el);
    } else if (p.type === 'text' && role === 'user' && withUser && !$('txt-' + p.id)) {
      // Drop the "[Browser state, added automatically: ...]" note the panel appended when sending.
      const t = p.text.replace(/\n\n\[Browser state, added automatically:[\s\S]*\]$/, '').trim();
      if (t) add('me', t).id = 'txt-' + p.id;
    }
  }
}

/**
 * Fetches the chat from OpenCode and draws whatever is new: the model's text as it is written
 * and each tool step. Also notes what is running right now for the status line.
 * @returns {Promise<void>}
 */
async function syncChat() {
  const msgs = await api('GET', `/session/${sessionId}/message`);
  let running = '';
  for (const m of msgs) {
    if (!m.info || m.info.role !== 'assistant') continue;
    drawMessage(m, false);
    for (const p of m.parts || []) if (p.type === 'tool' && p.state && p.state.status === 'running') running = String(p.tool).replace(/^chrome_/, '');
  }
  activity = running;
}

/** While busy: every 1.5 seconds draw new text and steps, and show any permission request. */
async function watch() {
  if (watching) return; // one watcher is enough, however many messages are queued
  watching = true;
  while (busy && sessionId) {
    try {
      await syncChat();
      ask({ type: 'oc-active' }); // tell the extension the task is still running, so the overlay stays up
      statusEl.textContent = activity ? `Working… (${activity})` : 'Working…';
      for (const req of await api('GET', '/permission')) {
        if (shown.has('perm:' + req.id)) continue;
        shown.add('perm:' + req.id);
        showPermission(req);
      }
    } catch { /* the status line reports connection problems */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  watching = false;
}

/**
 * Shows a permission request (start a subagent, run a command, ...) with Allow once / Deny.
 * "Always allow" is left out on purpose: the panel asks every time (the chat server refuses
 * "always" too).
 * @param {{id:string, permission?:string, patterns?:string[], metadata?:object}} req - the request from OpenCode
 */
function showPermission(req) {
  const card = document.createElement('div');
  card.className = 'askcard';
  const what = document.createElement('div');
  const detail = (req.patterns || []).join(', ') || (req.metadata && (req.metadata.description || req.metadata.subagent_type || req.metadata.command)) || '';
  what.textContent = `OpenCode asks permission: ${req.permission || 'action'}${detail ? ' — ' + detail : ''}`;
  const btns = document.createElement('div');
  btns.className = 'rowbtns';
  for (const [label, reply, cls] of [['Allow once', 'once', ''], ['Deny', 'reject', 'red']]) {
    const b = document.createElement('button');
    b.className = 'pill ' + cls; b.textContent = label;
    b.addEventListener('click', async () => {
      btns.querySelectorAll('button').forEach(x => { x.disabled = true; });
      try { await api('POST', `/permission/${req.id}/reply`, { reply }); what.textContent += reply === 'once' ? '  → allowed' : '  → denied'; }
      catch (e) { what.textContent += '  → ' + e.message; }
    });
    btns.appendChild(b);
  }
  card.append(what, btns);
  push(card);
}

/**
 * Fills the "Earlier chats" list with the chats started from this panel, newest first.
 * They are ordinary OpenCode sessions whose title starts with "Chrome chat:".
 */
async function drawHistory() {
  const list = $('pastlist');
  list.textContent = '';
  let sessions = [];
  try { sessions = await api('GET', '/session'); } catch (e) { const li = document.createElement('li'); li.textContent = e.message; list.appendChild(li); return; }
  const mine = sessions.filter(x => (x.title || '').startsWith('Chrome chat:')).sort((a, b) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0)).slice(0, 60);
  if (!mine.length) { const li = document.createElement('li'); li.textContent = 'No earlier chats yet.'; li.style.color = 'var(--muted)'; list.appendChild(li); return; }
  for (const x of mine) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    const title = document.createElement('span');
    title.textContent = x.title.replace(/^Chrome chat:\s*/, '') || '(untitled)';
    const when = document.createElement('small');
    when.textContent = new Date((x.time && (x.time.updated || x.time.created)) || Date.now()).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + (x.id === sessionId ? '  ·  open now' : '');
    li.append(title, when);
    const open = () => { if (!busy) openChat(x.id); };
    li.addEventListener('click', open);
    li.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    list.appendChild(li);
  }
}

/**
 * Loads an earlier chat into the panel so it can be read and continued.
 * @param {string} id - OpenCode session id
 */
async function openChat(id) {
  let msgs;
  try { msgs = await api('GET', `/session/${id}/message`); } catch (e) { add('step err', e.message); return; }
  sessionId = id;
  chatCost = 0;
  shown.clear();
  log.textContent = '';
  for (const m of msgs) {
    drawMessage(m, true);
    if (m.info && m.info.role === 'assistant') chatCost += m.info.cost || 0;
  }
  costEl.textContent = `This chat: $${chatCost.toFixed(4)} (OpenCode's estimate)`;
  $('past').classList.remove('open');
  $('history').setAttribute('aria-expanded', 'false');
  textEl.focus();
}

/**
 * Sets the round button for the current state. While OpenCode is answering it is "stop" when
 * the text box is empty and "send" (which queues the message) when you have typed something.
 * @param {boolean} [working] - pass true/false to change the busy state; leave out to only redraw
 */
function setBusy(working) {
  if (working !== undefined) busy = working;
  const hasText = Boolean(textEl.value.trim());
  const stop = busy && !hasText;
  sendBtn.innerHTML = stop ? ICON_STOP : ICON_SEND; // fixed icons defined above, not model text
  sendBtn.className = stop ? 'stop' : '';
  sendBtn.title = stop ? 'Stop' : busy ? 'Queue this message' : 'Send';
  sendBtn.setAttribute('aria-label', sendBtn.title);
  sendBtn.disabled = !busy && !hasText;
}

/**
 * Keeps a message typed while OpenCode is busy. It is shown greyed out with two choices:
 * "Send now" interrupts the current answer so OpenCode reconsiders with this message added;
 * "✕" drops it. Left alone, queued messages are sent together when the current answer ends.
 * @param {string} text - what the user typed
 */
function enqueue(text) {
  const el = document.createElement('div');
  el.className = 'me queued';
  const body = document.createElement('div');
  body.textContent = text;
  const bar = document.createElement('div');
  bar.className = 'qbar';
  const label = document.createElement('span');
  label.textContent = 'Queued';
  const now = document.createElement('button');
  now.className = 'link'; now.textContent = 'Send now';
  now.title = 'Interrupt the current answer and add this message';
  const drop = document.createElement('button');
  drop.className = 'link'; drop.textContent = '✕'; drop.title = 'Remove from the queue';
  bar.append(label, now, drop);
  el.append(body, bar);
  push(el);
  const item = { text, el };
  queue.push(item);
  drop.addEventListener('click', () => { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); el.remove(); });
  now.addEventListener('click', async () => {
    // Stop the running answer; sendMessage's loop then picks up the whole queue straight away.
    interrupting = true;
    if (sessionId) await api('POST', `/session/${sessionId}/abort`, {}).catch(() => {});
  });
}

/**
 * Takes every queued message out of the queue and turns its grey bubble into a normal one.
 * @returns {string} the queued texts joined into one message, or "" when the queue is empty
 */
function drainQueue() {
  const items = queue.splice(0);
  for (const it of items) { it.el.className = 'me'; it.el.querySelector('.qbar').remove(); }
  return items.map(it => it.text).join('\n\n');
}

/**
 * Sends a chat message and shows the answer; then, as long as messages were queued meanwhile,
 * sends those too. Only one copy of this runs at a time (it is started only when not busy).
 * @param {string} first - what the user typed
 */
async function sendMessage(first) {
  setBusy(true);
  add('me', first);
  let text = first;
  while (text) {
    try {
      if (!sessionId) sessionId = (await api('POST', '/session', { title: 'Chrome chat: ' + text.slice(0, 40) })).id;
      // Tell the model which tabs it may use right now, so "this page" means the tab in front.
      const ctx = (await ask({ type: 'oc-context' })) || {};
      const tabs = ctx.tabs || [];
      const note = tabs.length
        // Title and address are given for approved sites only (the background worker blanks the
        // rest), and nothing at all about a tab that is not in the group.
        ? `[Browser state, added automatically: tabs in the OpenCode group: ${tabs.map(t => `tab ${t.id}${t.front ? ' (in front, "this page")' : ''}: ${t.approved ? `${t.title} | ${t.url}` : `${t.title} (not approved by the user yet)`}`).join('; ')}]`
        : `[Browser state, added automatically: the OpenCode tab group has no tabs yet${ctx.frontOpen ? '; the tab in front is NOT in the group, so you cannot read it until the user presses + to share it' : ''}.]`;
      watch();
      const reply = await api('POST', `/session/${sessionId}/message`, { agent: AGENT, parts: [{ type: 'text', text: `${text}\n\n${note}` }] });
      const answer = (reply.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
      const err = reply.info && reply.info.error;
      const aborted = err && /abort/i.test((err.data && err.data.message) || err.name || '');
      await syncChat().catch(() => {}); // draw the final text and steps (the watcher may be between polls)
      if (aborted && interrupting) add('step', '(interrupted to add your next message)');
      else if (aborted) add('step', 'Stopped.');
      else if (err) add('step err', 'Error: ' + ((err.data && err.data.message) || err.name || JSON.stringify(err)));
      if (!answer && !err) add('step', '(no text in the reply)');
      chatCost += (reply.info && reply.info.cost) || 0;
      costEl.textContent = `This chat: $${chatCost.toFixed(4)} (OpenCode's estimate)`;
      if (reply.info && reply.info.modelID) { setModel(reply.info.modelID); modelEl.dataset.fixed = '1'; }
    } catch (e) {
      if (!(interrupting && /abort/i.test(e.message))) add('step err', e.message);
    }
    interrupting = false;
    text = drainQueue(); // anything typed meanwhile goes out as the next message
  }
  setBusy(false);
  await ask({ type: 'oc-done' }); // task finished: browser control off and the overlay down, until the next yes
  refresh();
}

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const text = textEl.value.trim();
  if (!text) { // empty box: the button is "stop" while working
    if (busy && sessionId) await api('POST', `/session/${sessionId}/abort`, {}).catch(() => {});
    return;
  }
  textEl.value = '';
  textEl.style.height = '';
  if (busy) { enqueue(text); setBusy(); } else sendMessage(text);
});
// Enter sends, Shift+Enter makes a new line; the box grows with the text.
textEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); } });
textEl.addEventListener('input', () => { setBusy(); textEl.style.height = 'auto'; textEl.style.height = Math.min(textEl.scrollHeight, 180) + 'px'; });
$('new').addEventListener('click', async () => { if (busy) return; await ask({ type: 'oc-new-chat' }); location.reload(); }); // a new chat gets a new tab group
$('history').addEventListener('click', () => {
  const open = $('past').classList.toggle('open');
  $('history').setAttribute('aria-expanded', String(open));
  if (open) drawHistory();
});
$('menu').addEventListener('click', () => { const open = $('controls').classList.toggle('open'); $('menu').setAttribute('aria-expanded', String(open)); });
for (const id of ['plus', 'add']) $(id).addEventListener('click', async () => { await ask({ type: 'oc-add-tab' }); refresh(); });
$('remove').addEventListener('click', async () => { await ask({ type: 'oc-remove-tab' }); refresh(); });

refresh();
setInterval(refresh, 4000);
textEl.focus();
