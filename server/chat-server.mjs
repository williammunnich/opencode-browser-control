#!/usr/bin/env node
/**
 * @file chat-server.mjs
 * Lets the Chrome extension's side panel chat with OpenCode. It does two things:
 *
 *   1. Starts OpenCode's own local server (`opencode serve`) on a random port with a random
 *      password that exists only in this program's memory and in that server's environment.
 *      The password matters: without one, any web page you visit could post a prompt to that
 *      server.
 *   2. Listens on 127.0.0.1:17320 and passes the side panel's requests on to that server,
 *      adding the password. It is deliberately narrow, because it is the one door from Chrome
 *      to a program that can run tools on this computer:
 *        - only POST /api, only with this extension's Origin and this server's own Host;
 *        - only the few request kinds the chat needs (ROUTES below);
 *        - every chat message is sent to the browser-only agent `chrome-panel`, whatever the
 *          request asked for, and only its text is passed on;
 *        - only chats started from the panel (title "Chrome chat: ...") can be listed, read,
 *          continued or stopped, and only their permission requests can be answered.
 *
 *   side panel (extension)  --POST http://127.0.0.1:17320/api-->  this file  -->  opencode serve
 *
 * Who can use it: a web page cannot (it cannot set the Origin header). A program running on
 * this computer can, by sending the same headers; the rules above are what limit it then.
 * See SECURITY.md.
 *
 * Start it with `bin/opencode-chat-server`. It keeps running until you stop it (Ctrl-C) or
 * log out.
 *
 * Project: opencode-browser-control
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/** Folder of this file, used to find the extension's id. */
const here = dirname(fileURLToPath(import.meta.url));
/** The only Origin allowed to use the proxy. */
const EXT_ORIGIN = 'chrome-extension://' + readFileSync(join(here, '..', 'extension', 'EXTENSION_ID'), 'utf8').trim();
/**
 * Port the side panel talks to. Must match sidepanel.js, so the real value is fixed; the tests
 * set OCBC_TEST_CHAT_PORT to run a copy next to a real one.
 */
const PROXY_PORT = Number(process.env.OCBC_TEST_CHAT_PORT) || 17320;
/** Port and password of the OpenCode server started below; both are new on every start. */
const servePort = randomInt(46000, 46999);
const password = randomBytes(24).toString('hex');
/** Basic-auth header the OpenCode server expects (user name "opencode"). */
const AUTH = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
/** The only OpenCode agent the panel's messages are given to: it has the browser tools and nothing else. */
const AGENT = 'chrome-panel';
/** Start of the title of every chat made through this proxy; this is how the panel's chats are told from all others. */
const TITLE_PREFIX = 'Chrome chat:';
/** Largest request body accepted from the panel, in characters. */
const MAX_BODY = 5e6;

/** Ids of the OpenCode sessions known to be panel chats (made here, or found by their title). */
const panelSessions = new Set();
/** Ids of the permission requests known to belong to panel chats. */
const panelPermissions = new Set();

/**
 * Writes one line to the terminal.
 * @param {string} msg - the message
 */
const log = msg => console.error(`opencode-chat-server: ${msg}`);

/**
 * Finds the `opencode` program: $OPENCODE_BIN when set, else OpenCode's usual install place
 * (~/.opencode/bin/opencode) when it is there, else whatever `opencode` the PATH has.
 * @returns {string} a path, or the bare name for a PATH lookup
 */
function findOpencode() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const usual = join(homedir(), '.opencode', 'bin', 'opencode');
  return existsSync(usual) ? usual : 'opencode';
}

// 1. OpenCode's server, in the home folder, with the password in its environment only (never
//    on its command line, where every user of this computer could read it with `ps`).
const serve = spawn(findOpencode(), ['serve', '--hostname', '127.0.0.1', '--port', String(servePort)], {
  cwd: homedir(),
  // OPENCODE_CHROME_PANEL reaches chrome-mcp.mjs, which marks its commands as the panel's.
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CHROME_PANEL: '1' },
  // Its output is not read here, so it must not be a pipe (a full pipe would stall it): only
  // its error messages are passed on to this program's terminal or log.
  stdio: ['ignore', 'ignore', 'inherit'],
});
serve.on('error', e => { log(`could not start opencode (${e.message}). Install OpenCode, or set OPENCODE_BIN to its path.`); process.exit(1); });
serve.on('exit', code => { log(`opencode serve stopped (code ${code}); stopping too`); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { serve.kill('SIGTERM'); process.exit(0); });

/**
 * A request the proxy refuses. Carries the HTTP status to answer with.
 */
class Refused extends Error {
  /**
   * @param {number} status - HTTP status, 400 or 403
   * @param {string} message - shown to the panel
   */
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Sends one request to the OpenCode server, with the password.
 * @param {string} method - "GET" or "POST"
 * @param {string} path - server path, e.g. "/session"
 * @param {object} [body] - JSON body for a POST
 * @returns {Promise<{status:number, text:string}>} the server's answer, unparsed
 * @throws {Error} when the server cannot be reached
 */
async function upstream(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${servePort}${path}`, {
    method, headers: { authorization: AUTH, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  return { status: r.status, text: await r.text() };
}

/**
 * Parses an answer from the OpenCode server that should be a JSON list.
 * @param {{status:number, text:string}} answer - from upstream()
 * @returns {object[]} the list, or [] when the answer was an error or not a list
 */
function listOf(answer) {
  try { const v = JSON.parse(answer.text); return answer.status < 300 && Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Fetches OpenCode's sessions and keeps those that are panel chats. OpenCode lists every
 * session of the user here, including work done in the terminal; those are none of the panel's
 * business and are left out.
 * @returns {Promise<object[]>} the panel's chats
 */
async function panelChats() {
  const mine = listOf(await upstream('GET', '/session')).filter(s => s && typeof s.id === 'string' && String(s.title || '').startsWith(TITLE_PREFIX));
  for (const s of mine) panelSessions.add(s.id);
  return mine;
}

/**
 * Refuses unless a session is one of the panel's chats.
 * @param {string} id - OpenCode session id from the request path
 * @returns {Promise<void>}
 * @throws {Refused} 403 when the session is not a panel chat
 */
async function requirePanelSession(id) {
  if (panelSessions.has(id)) return;
  await panelChats(); // not seen yet (for example a chat from before this server started): look it up once
  if (!panelSessions.has(id)) throw new Refused(403, 'not allowed: that session is not a chat from the browser panel');
}

/**
 * Fetches the pending permission requests and keeps those of panel chats.
 * @returns {Promise<object[]>} the requests the panel may show and answer
 */
async function panelPermissionRequests() {
  const out = [];
  for (const req of listOf(await upstream('GET', '/permission'))) {
    if (!req || typeof req.id !== 'string' || typeof req.sessionID !== 'string') continue;
    try { await requirePanelSession(req.sessionID); } catch { continue; }
    panelPermissions.add(req.id);
    out.push(req);
  }
  return out;
}

/**
 * Answers with a JSON value made here (not passed through from OpenCode).
 * @param {any} value - what to send
 * @returns {{status:number, text:string}} shaped like upstream()'s answer
 */
const json = value => ({ status: 200, text: JSON.stringify(value) });

/**
 * The requests the side panel may make: [method, path pattern, handler]. Everything else is
 * refused. Each handler builds the request to OpenCode itself from the few fields it accepts,
 * so nothing else in the panel's request (another agent, a model, extra tools, a system
 * prompt, permission rules) can reach OpenCode.
 * @type {Array<[string, RegExp, (m: RegExpMatchArray, body: any) => Promise<{status:number, text:string}>]>}
 */
const ROUTES = [
  // Which model the panel's agent uses, for the label in the panel. Other agents and all prompts are left out.
  ['GET', /^\/agent$/, async () => json(listOf(await upstream('GET', '/agent')).filter(a => a && a.name === AGENT).map(a => ({ name: a.name, model: a.model })))],
  // The list of earlier chats, for the history button.
  ['GET', /^\/session$/, async () => json(await panelChats())],
  // A new chat. The title always starts with the prefix that marks it as the panel's.
  ['POST', /^\/session$/, async (m, body) => {
    const wanted = String((body && body.title) || '').slice(0, 200);
    const title = wanted.startsWith(TITLE_PREFIX) ? wanted : `${TITLE_PREFIX} ${wanted}`;
    const answer = await upstream('POST', '/session', { title });
    try { const made = JSON.parse(answer.text); if (answer.status < 300 && made && typeof made.id === 'string') panelSessions.add(made.id); } catch { /* an error answer is passed on as it is */ }
    return answer;
  }],
  ['GET', /^\/session\/(ses[\w-]+)\/message$/, async m => { await requirePanelSession(m[1]); return upstream('GET', m[0]); }],
  // A chat message: text only, and always for the browser-only agent.
  ['POST', /^\/session\/(ses[\w-]+)\/message$/, async (m, body) => {
    await requirePanelSession(m[1]);
    const parts = (Array.isArray(body && body.parts) ? body.parts : []).filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => ({ type: 'text', text: p.text }));
    if (!parts.length) throw new Refused(400, 'bad request: a message needs text');
    return upstream('POST', m[0], { agent: AGENT, parts });
  }],
  ['POST', /^\/session\/(ses[\w-]+)\/abort$/, async m => { await requirePanelSession(m[1]); return upstream('POST', m[0], {}); }],
  ['GET', /^\/permission$/, async () => json(await panelPermissionRequests())],
  // An answer to a permission request: this time only, or no. "Always" cannot be given from here.
  ['POST', /^\/permission\/([\w-]+)\/reply$/, async (m, body) => {
    if (!panelPermissions.has(m[1])) await panelPermissionRequests();
    if (!panelPermissions.has(m[1])) throw new Refused(403, 'not allowed: that request does not belong to a chat from the browser panel');
    const reply = body && body.reply;
    if (reply !== 'once' && reply !== 'reject') throw new Refused(403, 'not allowed: the answer must be "once" or "reject"');
    return upstream('POST', m[0], { reply });
  }],
];

/**
 * Decides whether an HTTP request may be looked at at all: POST /api, from this extension
 * (Origin), sent to this server's own loopback address (Host). A page cannot change the Origin
 * a browser sends, which keeps every web page out; the Host check is a second lock against
 * DNS rebinding. A local program can forge both; ROUTES limits what it gets.
 * @param {import('node:http').IncomingMessage} req - the request
 * @returns {boolean} true when the request may be handled
 */
function allowed(req) {
  const host = String(req.headers.host || '');
  return req.method === 'POST' && req.url === '/api' && req.headers.origin === EXT_ORIGIN
    && (host === `127.0.0.1:${PROXY_PORT}` || host === `localhost:${PROXY_PORT}`);
}

// 2. The extension-only proxy.
const proxy = createServer((req, res) => {
  if (!allowed(req)) { res.writeHead(403); res.end(); return; }
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > MAX_BODY) req.destroy(); });
  req.on('end', async () => {
    const reply = (status, text) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(text || '{}'); };
    let call;
    try { call = JSON.parse(raw); } catch { return reply(400, JSON.stringify({ error: 'bad request' })); }
    const method = String((call && call.method) || 'GET').toUpperCase();
    const path = String((call && call.path) || '');
    try {
      for (const [m, pattern, handler] of ROUTES) {
        const match = m === method && path.match(pattern);
        if (match) { const answer = await handler(match, call.body); return reply(answer.status, answer.text); }
      }
      throw new Refused(403, `not allowed: ${method} ${path.slice(0, 200)}`);
    } catch (e) {
      if (e instanceof Refused) return reply(e.status, JSON.stringify({ error: e.message }));
      reply(502, JSON.stringify({ error: 'OpenCode server not reachable yet: ' + e.message }));
    }
  });
});
proxy.requestTimeout = 0; // a reply can take minutes while the model works
proxy.headersTimeout = 0;
proxy.on('error', e => { log(e.code === 'EADDRINUSE' ? `already running (port ${PROXY_PORT} is in use)` : e.message); serve.kill('SIGTERM'); process.exit(1); });
proxy.listen(PROXY_PORT, '127.0.0.1', () => log(`ready: chat proxy on 127.0.0.1:${PROXY_PORT}, OpenCode server on 127.0.0.1:${servePort} (password protected)`));
