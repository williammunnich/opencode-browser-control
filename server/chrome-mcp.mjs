#!/usr/bin/env node
/**
 * @file chrome-mcp.mjs
 * The bridge between OpenCode and the "OpenCode Browser Control" Chrome extension
 * (../extension). OpenCode starts this program as a tool server (MCP,
 * spoken over stdin/stdout) and gets tools like chrome_open, chrome_snapshot and chrome_click.
 * Each tool call is put in a queue; the extension, running in the user's normal signed-in Chrome,
 * collects it over a local HTTP connection, does it, and posts the answer back.
 *
 *   OpenCode  <--stdin/stdout (MCP)-->  this file  <--HTTP on 127.0.0.1-->  extension in Chrome
 *
 * Safety: the HTTP side listens on 127.0.0.1 only and answers only POST requests whose Origin
 * header is this extension's id and whose Host header is this server's own loopback address.
 * A web page cannot set the Origin header, so no web page (and no other extension) can feed it
 * commands or read results, also not through DNS rebinding. What that check does NOT stop:
 * any program running on this computer can send whatever headers it likes, so it can pretend
 * to be the extension here. See SECURITY.md. What the model may touch is enforced inside the
 * extension (tab group, approved sites, no password fields, Stop), not here.
 *
 * No dependencies: the small part of MCP that is needed is implemented below.
 *
 * Project: opencode-browser-control
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/** Folder of this file, used to find the extension's id. */
const here = dirname(fileURLToPath(import.meta.url));
/** The only Origin allowed to talk to the HTTP side. */
const EXT_ORIGIN = 'chrome-extension://' + readFileSync(join(here, '..', 'extension', 'EXTENSION_ID'), 'utf8').trim();
/**
 * First of the ten ports to try. The extension only ever asks 17300-17309, so the real value is
 * fixed; the tests set OCBC_TEST_PORT_BASE to run a copy that a real extension cannot reach.
 */
const PORT_BASE = Number(process.env.OCBC_TEST_PORT_BASE) || 17300;
/** Ports to try, first free one wins (several OpenCode windows can run at once). Must match background.js. */
const PORTS = Array.from({ length: 10 }, (_, i) => PORT_BASE + i);
/** Largest request body accepted from the extension, in characters (a screenshot is a few megabytes). */
const MAX_BODY = 30e6;
/** How long a tool call waits for the extension before giving up, in milliseconds. */
const CALL_TIMEOUT = 45000;

/** Identifies this OpenCode to the extension, which gives every session its own tab group. New on every start. */
const SESSION = randomBytes(6).toString('hex');
/** True when this server was started by the chat panel's OpenCode (set by chat-server.mjs). */
const PANEL = process.env.OPENCODE_CHROME_PANEL === '1';

/** Commands waiting for the extension to collect: {id, tool, args}. */
const queue = [];
/** Calls waiting for an answer: id -> {resolve, timer}. */
const waiting = new Map();
/** The extension's open "any commands?" request, if it is currently waiting: {res, timer}. */
let parked = null;
/** When the extension last asked for commands (ms since 1970); 0 = never. */
let lastPoll = 0;
/** The extension's version, as it reports with every "any commands?" request; '' until it has asked once. */
let extVersion = '';
/** The port this server ended up listening on; 0 until it listens (or when none of PORTS was free). */
let listenPort = 0;

/**
 * Writes one line to stderr (OpenCode shows it in its logs; stdout is reserved for MCP).
 * @param {string} msg - the message
 */
const log = msg => process.stderr.write(`chrome-mcp: ${msg}\n`);

/* ------------------------------------------------------------------------------------------
 * HTTP side: the extension polls for commands and posts results
 * ---------------------------------------------------------------------------------------- */

/**
 * Hands queued commands to the extension's waiting request, if there is one.
 */
function flush() {
  if (!parked || !queue.length) return;
  clearTimeout(parked.timer);
  parked.res.end(JSON.stringify({ commands: queue.splice(0) }));
  parked = null;
}

/**
 * Decides whether an HTTP request may be answered: a POST, from this extension (Origin), sent
 * to this server's own loopback address (Host). Browsers always send Origin on a POST and a
 * page cannot change it, so this keeps every web page out. The Host check is a second lock
 * against DNS rebinding (a page reaching 127.0.0.1 under its own domain name): such a request
 * carries the page's domain as Host. A local program can forge both headers; see SECURITY.md.
 * @param {import('node:http').IncomingMessage} req - the request
 * @returns {boolean} true when the request may be answered
 */
function allowed(req) {
  const host = String(req.headers.host || '');
  return req.method === 'POST' && req.headers.origin === EXT_ORIGIN
    && (host === `127.0.0.1:${listenPort}` || host === `localhost:${listenPort}`);
}

const http = createServer((req, res) => {
  if (!allowed(req)) { res.writeHead(403); res.end(); return; }
  let body = '';
  req.on('data', c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': EXT_ORIGIN });
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch { /* treated as empty */ }
    if (req.url === '/poll') {
      lastPoll = Date.now();
      if (data.version) extVersion = String(data.version);
      if (parked) { clearTimeout(parked.timer); parked.res.end(JSON.stringify({ commands: [] })); }
      // Hold the request up to 20 s so a new command reaches the extension at once.
      parked = { res, timer: setTimeout(() => { if (parked && parked.res === res) { res.end(JSON.stringify({ commands: [] })); parked = null; } }, 20000) };
      flush();
    } else if (req.url === '/result') {
      const w = waiting.get(data.id);
      if (w) { clearTimeout(w.timer); waiting.delete(data.id); w.resolve(data); }
      res.end('{}');
    } else {
      res.end('{}');
    }
  });
});

/**
 * Starts listening on the first free port of PORTS.
 * @param {number} i - index into PORTS to try
 */
function listen(i) {
  if (i >= PORTS.length) { log(`no free port between ${PORTS[0]} and ${PORTS[9]}; the chrome tools will not work in this session`); return; }
  http.once('error', () => listen(i + 1));
  http.listen(PORTS[i], '127.0.0.1', () => { listenPort = PORTS[i]; log(`waiting for the Chrome extension on 127.0.0.1:${PORTS[i]}`); });
}
listen(0);

/**
 * Sends one command to the extension and waits for its answer.
 * @param {string} tool - command name understood by background.js (open, snapshot, click, ...)
 * @param {object} args - its arguments
 * @returns {Promise<{ok:boolean,data?:any,error?:string}>} the extension's answer, or an error
 *          explaining that the extension is not connected or took too long
 */
function callExtension(tool, args) {
  return new Promise(resolve => {
    const id = randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      waiting.delete(id);
      const i = queue.findIndex(c => c.id === id);
      if (i >= 0) queue.splice(i, 1);
      resolve({ ok: false, error: Date.now() - lastPoll > 60000
        ? 'The Chrome extension is not connected. The user must have Chrome open with the "OpenCode Browser Control" extension loaded and switched on (chrome://extensions). It can take up to 30 seconds to connect after Chrome starts. Tell the user; do not retry in a loop.'
        : 'The browser did not answer within 45 seconds (the page may be busy or showing a dialog). Try snapshot again once; if it fails again, tell the user.' });
    }, CALL_TIMEOUT);
    waiting.set(id, { resolve, timer });
    queue.push({ id, tool, args, session: SESSION, panel: PANEL });
    flush();
  });
}

/**
 * Tells whether the extension is talking to this server, without sending it a command. Used by
 * install.sh (through bin/extension-check.mjs) to check the extension is loaded. A real tool call
 * such as `tabs` would also show that, but when browser control is switched off it makes the
 * extension open an "allow browser control?" tab in the user's Chrome; this asks nothing of them.
 * @param {number} [waitMs=0] - how long to wait for the extension's first request, in milliseconds
 *        (it retries each port every 4 seconds, and Chrome may take 30 seconds to wake its worker)
 * @returns {Promise<{connected:boolean,version:string,port:number}>} connected = the extension
 *          asked this server for commands; version = the extension's version ('' if unknown);
 *          port = where this server listens (0 = no free port, so the extension cannot reach it)
 */
async function extensionStatus(waitMs = 0) {
  const until = Date.now() + Math.min(Number(waitMs) || 0, 60000);
  while (lastPoll === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 250));
  return { connected: lastPoll > 0, version: extVersion, port: listenPort };
}

/* ------------------------------------------------------------------------------------------
 * Tools offered to the model
 * ---------------------------------------------------------------------------------------- */

/**
 * Text that looks like a secret: common API key and token forms, private key blocks, and
 * 13-19 digit card numbers. Used to refuse `type` calls that would put a secret into a page.
 */
const SECRET = /\b(sk|pk|rk)[-_](live|test|proj|ant|or)[-_A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:\d[ -]?){13,19}\b/;

/** A tab id argument, shared by most tools. */
const TAB = { type: 'number', description: 'Tab id from tabs or open' };
/** A ref argument: the number in square brackets from the last snapshot. */
const REF = { type: 'number', description: 'Element number from the latest snapshot, e.g. 12 for [12]' };

/** Tool list: name, description for the model, and the JSON schema of its arguments. */
const TOOLS = [
  { name: 'tabs', description: 'List the tabs you may use: the ones in your own tab group in the user\'s Chrome (each OpenCode session has its own group). Start here.', inputSchema: { type: 'object', properties: {} } },
  { name: 'open', description: 'Open a new tab at a full https address, in your own tab group (a new group is made for this session on first use). If the user has not approved that site yet they are asked in the browser; you get NEEDS APPROVAL and must wait for them.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'navigate', description: 'Send one of your tabs to another address.', inputSchema: { type: 'object', properties: { tabId: TAB, url: { type: 'string' } }, required: ['tabId', 'url'] } },
  { name: 'snapshot', description: 'Read a tab: its title, address, a numbered list of things you can click or type into, and the page text. Numbers are only valid until the page changes; take a new snapshot after every click or navigation.', inputSchema: { type: 'object', properties: { tabId: TAB }, required: ['tabId'] } },
  { name: 'click', description: 'Click element [ref] from the latest snapshot. Returns a new snapshot.', inputSchema: { type: 'object', properties: { tabId: TAB, ref: REF }, required: ['tabId', 'ref'] } },
  { name: 'type', description: 'Replace the text of field [ref] with text. submit=true also submits its form (like pressing Enter). Password, one-time-code and card fields are refused.', inputSchema: { type: 'object', properties: { tabId: TAB, ref: REF, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['tabId', 'ref', 'text'] } },
  { name: 'select', description: 'Choose an option in drop-down list [ref] by its visible text.', inputSchema: { type: 'object', properties: { tabId: TAB, ref: REF, option: { type: 'string' } }, required: ['tabId', 'ref', 'option'] } },
  { name: 'scroll', description: 'Scroll a tab: down, up, top or bottom. Take a snapshot afterwards.', inputSchema: { type: 'object', properties: { tabId: TAB, direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } }, required: ['tabId'] } },
  { name: 'back', description: 'Go back one page in a tab.', inputSchema: { type: 'object', properties: { tabId: TAB }, required: ['tabId'] } },
  { name: 'screenshot', description: 'Save a picture of the visible part of a tab to a PNG file and return its path (the tab is brought to the front). Prefer snapshot for reading.', inputSchema: { type: 'object', properties: { tabId: TAB }, required: ['tabId'] } },
  { name: 'download', description: 'Download the file that link [ref] points to (for example a "pdf" link) into Chrome\'s Downloads folder, like "save link as". Use this instead of clicking when the user wants the file saved. Returns the saved file\'s path.', inputSchema: { type: 'object', properties: { tabId: TAB, ref: REF }, required: ['tabId', 'ref'] } },
  { name: 'close', description: 'Close one of your tabs when you are done with it.', inputSchema: { type: 'object', properties: { tabId: TAB }, required: ['tabId'] } },
];

/**
 * Folder of the control log: ~/Library/Logs on a Mac; elsewhere $XDG_STATE_HOME (or
 * ~/.local/state) /opencode-browser-control, which is created on first use.
 */
const LOG_DIR = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Logs')
  : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'opencode-browser-control');
/** Where every browser command is recorded, one line each. */
const LOG_FILE = join(LOG_DIR, 'opencode-browser-control.log');

/**
 * Cuts the part after "?" or "#" out of every web address in a text. Those parts often carry
 * sign-in tokens and search words, which do not belong in a log file that stays on disk.
 * @param {string} text - any text
 * @returns {string} the text with each address ending at its path, followed by "?…" where something was cut
 */
function withoutQueries(text) {
  return String(text).replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, '$1?…');
}

/**
 * Appends one line to the control log: time, tool, arguments, and how it ended. This is the
 * record of everything OpenCode did in the browser. To keep private things out of it, typed
 * text is cut to 80 characters, the answer to 160, and web addresses lose their query part.
 * The file is readable by its owner only.
 * @param {string} name - tool name
 * @param {object} args - its arguments
 * @param {boolean} ok - whether the extension carried it out
 * @param {string} result - first part of the answer or error
 */
function audit(name, args, ok, result) {
  try {
    const shown = Object.fromEntries(Object.entries(args || {}).map(([k, v]) => [k, typeof v === 'string' ? withoutQueries(v).slice(0, 80) : v]));
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()}\t${name}\t${JSON.stringify(shown)}\t${ok ? 'ok' : 'REFUSED/ERROR'}\t${withoutQueries(String(result).replace(/\s+/g, ' ')).slice(0, 160)}\n`, { mode: 0o600 });
    chmodSync(LOG_FILE, 0o600); // also tightens a log made by an older version, which was readable by everyone
  } catch { /* logging must never break a command */ }
}

/**
 * Runs one tool call from the model.
 * @param {string} name - tool name
 * @param {object} args - arguments from the model
 * @returns {Promise<{content:Array<{type:string,text:string}>,isError:boolean}>} MCP tool result
 */
async function runTool(name, args) {
  if (!TOOLS.some(t => t.name === name)) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  // Secrets never go into a web page, whatever the field is called. This runs here, before the
  // browser is involved, so it holds even with an older copy of the extension.
  if (name === 'type' && SECRET.test(String((args || {}).text || ''))) {
    audit(name, { ...args, text: '[looked like a secret, not sent]' }, false, 'refused: secret-like text');
    return { content: [{ type: 'text', text: 'Refused: that text looks like a password, API key, token or card number. Secrets are never typed into a page by you. Tell the user to type it themselves in the browser, and continue with the rest.' }], isError: true };
  }
  const r = await callExtension(name, args || {});
  audit(name, args, r.ok, r.ok ? (name === 'screenshot' ? 'picture taken' : r.data) : r.error);
  if (!r.ok) return { content: [{ type: 'text', text: r.error || 'failed' }], isError: true };
  if (name === 'screenshot' && r.data && r.data.png) {
    // The picture arrives as a data URL; save it next to where OpenCode is running.
    const dir = join(process.cwd(), '.opencode-chrome');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    writeFileSync(file, Buffer.from(String(r.data.png).split(',')[1] || '', 'base64'), { mode: 0o600 }); // a picture of a signed-in page: owner only
    return { content: [{ type: 'text', text: `Saved ${file}` }], isError: false };
  }
  return { content: [{ type: 'text', text: String(r.data) }], isError: false };
}

/* ------------------------------------------------------------------------------------------
 * MCP side: JSON-RPC 2.0, one JSON object per line on stdin/stdout
 * ---------------------------------------------------------------------------------------- */

/**
 * Sends one JSON-RPC message to OpenCode.
 * @param {object} msg - the message
 */
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

/**
 * Handles one JSON-RPC message from OpenCode.
 * @param {{id?:number|string,method?:string,params?:any}} msg - request or notification
 * @returns {Promise<void>}
 */
async function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'opencode-chrome', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: await runTool(msg.params.name, msg.params.arguments) });
  } else if (msg.method === 'extension/status') {
    // Not part of MCP: OpenCode never sends it. Only bin/extension-check.mjs does (see extensionStatus).
    send({ jsonrpc: '2.0', id: msg.id, result: await extensionStatus(msg.params && msg.params.waitMs) });
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  } // notifications (no id) need no answer
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    // handle() is async, so a broken message shows up as a rejected promise, not as a throw.
    try { handle(JSON.parse(line)).catch(e => log('bad message: ' + e.message)); } catch (e) { log('bad message: ' + e.message); }
  }
});
process.stdin.on('close', () => process.exit(0));
