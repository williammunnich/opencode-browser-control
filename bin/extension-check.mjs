#!/usr/bin/env node
/**
 * @file extension-check.mjs
 * Checks, without any model and without any cost, whether the "OpenCode Browser Control"
 * extension is loaded in Chrome and reaching the tool server. It starts its own copy of
 * ../server/chrome-mcp.mjs exactly as OpenCode would, does the MCP handshake over the copy's
 * stdin/stdout (`initialize`), then asks the extra question `extension/status`, which answers
 * as soon as the extension has asked that copy for commands. The copy is stopped before this
 * program ends, so nothing is left running.
 *
 * Why not call the `tabs` tool: when browser control is switched off, any tool call makes the
 * extension open an "allow browser control?" tab in the user's Chrome. A check must not do that.
 *
 * Project: opencode-browser-control (used by ../install.sh)
 * @usage node bin/extension-check.mjs [seconds]     seconds = how long to wait, default 40
 * @exit 0 connected (prints "connected <extension version>");
 *       1 not connected within the wait (prints "not-connected");
 *       2 the check itself could not run (prints "error: <reason>")
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folder of this file, used to find the tool server. */
const here = dirname(fileURLToPath(import.meta.url));
/** The tool server this check starts a private copy of. */
const SERVER = join(here, '..', 'server', 'chrome-mcp.mjs');
/** How long to wait for the extension, in milliseconds. The extension retries each port every
 *  4 seconds, and Chrome wakes a sleeping extension only every 30 seconds, hence 40 by default. */
const WAIT_MS = Math.max(1, Number(process.argv[2]) || 40) * 1000;

/** The private copy of the tool server. Its stderr (progress lines) is discarded. */
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });

/**
 * Prints the result, stops the tool server copy and ends this program.
 * @param {number} code - exit code (see the header)
 * @param {string} text - the one line to print
 */
function finish(code, text) {
  console.log(text);
  child.kill('SIGTERM'); // the copy would also stop by itself when its stdin closes; this makes sure
  process.exit(code);
}

/**
 * Sends one JSON-RPC request to the tool server copy.
 * @param {number} id - request number, repeated in the answer
 * @param {string} method - JSON-RPC method name
 * @param {object} params - its parameters
 */
function request(id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

/**
 * Handles one answer line from the tool server copy.
 * @param {{id?:number,result?:any,error?:any}} msg - the parsed answer
 */
function onAnswer(msg) {
  if (msg.id === 1) {
    // Handshake done; now the real question.
    request(2, 'extension/status', { waitMs: WAIT_MS });
  } else if (msg.id === 2) {
    if (msg.error) finish(2, 'error: this copy of server/chrome-mcp.mjs does not know extension/status');
    const s = msg.result || {};
    if (s.connected) finish(0, `connected ${s.version || 'unknown-version'}`);
    if (!s.port) finish(2, 'error: no free port between 17300 and 17309 (ten OpenCode sessions are already open)');
    finish(1, 'not-connected');
  }
}

let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try { onAnswer(JSON.parse(line)); } catch { /* not JSON: ignore */ }
  }
});
child.on('error', e => finish(2, 'error: could not start the tool server: ' + e.message));
child.on('exit', code => finish(2, `error: the tool server stopped by itself (code ${code})`));
// Safety net: never hang, even if the server never answers.
setTimeout(() => finish(2, 'error: no answer from the tool server'), WAIT_MS + 10000);

request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'extension-check', version: '1' } });
