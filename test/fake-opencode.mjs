#!/usr/bin/env node
/**
 * @file fake-opencode.mjs
 * A stand-in for the real `opencode` program, used only by servers.test.mjs. The chat server
 * starts it as `opencode serve --hostname 127.0.0.1 --port N`; it then answers the handful of
 * requests the chat server passes on, from made-up data, and remembers what it was sent so
 * the test can see exactly what got through the proxy. No model, no network, no cost.
 *
 * Like the real one it wants the password from the OPENCODE_SERVER_PASSWORD environment
 * variable as HTTP basic auth (user "opencode") and answers 401 without it.
 *
 * Project: opencode-browser-control
 * @env OCBC_FAKE_STATE  path of a JSON file to write once at start: whether the password
 *      showed up on the command line (it must not)
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const password = process.env.OPENCODE_SERVER_PASSWORD || '';
const AUTH = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
if (process.env.OCBC_FAKE_STATE) writeFileSync(process.env.OCBC_FAKE_STATE, JSON.stringify({ passwordOnCommandLine: password !== '' && process.argv.join(' ').includes(password), hasPassword: password !== '' }));

/** Made-up sessions: one chat from the panel and one from the terminal that the panel must never see. */
const sessions = [
  { id: 'ses_panel1', title: 'Chrome chat: earlier chat', time: { updated: 2 } },
  { id: 'ses_terminal1', title: 'Refactor the billing code', time: { updated: 3 } },
];
/** Made-up pending permission requests: one for each of the sessions above. */
const permissions = [
  { id: 'per_panel', sessionID: 'ses_panel1', permission: 'chrome_open' },
  { id: 'per_terminal', sessionID: 'ses_terminal1', permission: 'bash', patterns: ['rm -rf /'] },
];
/** Every request received, oldest first: {method, path, body}. Returned by GET /session/<id>/message. */
const received = [];

createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    /**
     * Sends a JSON answer.
     * @param {number} status - HTTP status
     * @param {any} value - the body
     */
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== AUTH) return send(401, { error: 'unauthorized' });
    const body = raw ? JSON.parse(raw) : undefined;
    received.push({ method: req.method, path: req.url, body });
    if (req.method === 'GET' && req.url === '/agent') return send(200, [{ name: 'build', prompt: 'secret build prompt', model: { modelID: 'big' } }, { name: 'chrome-panel', prompt: 'panel prompt', model: { modelID: 'small-model' } }]);
    if (req.method === 'GET' && req.url === '/session') return send(200, sessions);
    if (req.method === 'POST' && req.url === '/session') { const s = { id: 'ses_new' + sessions.length, title: body.title, time: { updated: 9 } }; sessions.push(s); return send(200, s); }
    if (req.method === 'GET' && req.url === '/permission') return send(200, permissions);
    // Everything else answers with the full record of what arrived, so the test can inspect it.
    return send(200, { received });
  });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
