# OpenCode Browser Control

Lets the [OpenCode](https://opencode.ai/) coding agent work inside your own, signed-in Google Chrome: in a tab group of its own, only on sites you approve, with a Stop button on every page it touches and a chat panel at the side of Chrome.

It is a Chrome extension plus two small local programs. No account, no cloud service of its own, no dependencies: plain Node and Chrome.

> **Independent project.** This is not made by, affiliated with, or endorsed by the OpenCode project. "OpenCode" is used here only to say what this works with.

> **Read [SECURITY.md](SECURITY.md) before you use it.** A tool that lets a language model click around in a browser where you are signed in can do real damage if it is misled. The rules below limit that; they do not remove it.

Written by Claude (Anthropic), for and prompted by William Munnich. MIT licence.

## What it does

- OpenCode gets tools to list its tabs, open a tab, read a page, click, type, choose from lists, scroll, go back, download the file behind a link (into Chrome's Downloads folder), take a screenshot and close a tab.
- **Every OpenCode session gets its own new tab group**: each terminal session one titled "OpenCode HH:MM", the chat panel one titled "OpenCode" (a new one for each new chat). A session can only use tabs in its own group. Tabs it opens go there; you hand over one of your own tabs with the + button in the chat panel or by dragging it into the group, and take it back by dragging it out.
- It can only read or act on a **site you approved**: "Allow once", "Always allow" or "Deny". An unapproved site is not loaded when OpenCode opens it, a link to one is not followed, and a form that posts to one is not submitted. You answer on the extension's own approval page or in the chat panel, never inside the web page.
- It does not type into fields that look like password, one-time-code or payment-card fields, and text that looks like an API key, token or card number is refused before it reaches the browser.
- **Browser control is a switch that is off unless a task is using it.** It is off when Chrome starts. When OpenCode needs the browser you are asked (a card in the chat panel, or a small tab when the panel is closed), or you flip the switch next to the + before sending. It switches itself off when the chat panel's task finishes, and after three minutes without a task when driven from the terminal.
- While a task runs, every tab it touches shows a coloured frame, "OpenCode is controlling this tab" with a **Stop** button, and a cursor where it clicks. Stop turns browser control off until you switch it on again.
- **The chat panel is browser-only.** Its messages always go to the OpenCode agent `chrome-panel`, which has the browser tools and nothing else: no shell commands, no files, no web access outside the browser, no subagents. From the terminal, the `chrome` agent can use the browser and everything else your OpenCode can.
- **Control log:** every browser command (time, tool, arguments, result) is appended to a log file on your computer (see [What is written to disk](#what-is-written-to-disk)).

## What you need

- macOS (the installer and the login start are written for it; the extension and the two servers are plain Chrome and Node and are untested elsewhere)
- Google Chrome
- Node 18 or newer, Python 3 (for the installer's config step)
- [OpenCode](https://opencode.ai/), set up with a model you are happy to send web page text to

## How the pieces fit

```
                         stdin/stdout (MCP)                HTTP, 127.0.0.1:17300-17309
OpenCode (terminal, ───────────────────────▶ server/chrome-mcp.mjs ◀──────────────────────┐
desktop app, or the                          (queue of browser commands)                   │ asks "any commands?",
chat server below)                                                                         │ runs them, posts results
                                                                                           │
Chat panel in Chrome ──POST 127.0.0.1:17320/api──▶ server/chat-server.mjs ──▶ opencode serve      extension/background.js
(extension/sidepanel.js)                           (narrow proxy)             (random port,        (in your Chrome)
                                                                               random password)           │
                                                                                                          ▼
                                                                          tabs in an "OpenCode" group: overlay.js draws the frame,
                                                                          Stop button, cursor and the "waiting for your answer" bar
```

The extension always calls out to the local servers; nothing calls into the extension. The rules about what may be touched are enforced in `extension/background.js`, not in the servers and not by the model.

| File | What it is |
|---|---|
| `extension/manifest.json` | Extension definition. The `key` fixes the extension's id (also in `extension/EXTENSION_ID`), see [The fixed extension id](#the-fixed-extension-id) |
| `extension/background.js` | The worker: polls the local server, enforces the rules (group only, approved sites, secret fields, Stop), runs the commands in pages |
| `extension/overlay.js` | Drawn inside controlled pages: frame, pill with Stop, cursor, "waiting for your answer" bar |
| `extension/approve.html`, `approve.js` | The extension's own approval page: shown instead of an unapproved site, after "Review" on a page's bar, and to ask for browser control |
| `extension/sidepanel.html`, `sidepanel.js` | The chat panel, opened by clicking the extension icon. Its ⋯ button holds the controls: add or take back this tab, pending approvals, always-allowed sites |
| `extension/icons/` | The icon, drawn by `tools/make-icons.py` |
| `server/chrome-mcp.mjs` | Tool server OpenCode starts (MCP). Turns tool calls into commands for the extension; writes the control log |
| `server/chat-server.mjs` | Starts `opencode serve` with a random password and passes the chat panel's few kinds of request on to it |
| `bin/opencode-chat-server` | Starts `chat-server.mjs` with a working PATH and, optionally, API keys from the macOS Keychain |
| `bin/keychain-env.zsh` | The optional Keychain loader (see [API keys](#api-keys)) |
| `bin/config-entries.py` | Adds, checks and removes this project's entries in OpenCode's `opencode.json` |
| `bin/extension-check.mjs` | Says whether the extension is connected, without a model and without opening anything in Chrome |
| `opencode-config-snippet.json` | The entries `install.sh` adds to `opencode.json`: the tool server, the two agents and their instructions |
| `install.sh`, `uninstall.sh` | Set this up, check it, take it off again |
| `test/` | Automated tests (no browser, no model) |
| `bench/` | A local test website and a runner that gives the agent tasks and traps |
| `tools/make-icons.py`, `tools/check-public.sh` | Draws the icon; checks before publishing that nothing private is in the repository |

## Install

**Having an AI agent install it for you?** Point it at [AGENTS.md](AGENTS.md): it tells the agent what to run, what to ask you first, and the one step only you can do (loading the extension in Chrome).

Clone this repository anywhere and run the installer from the folder you cloned to. It works from wherever that is; the OpenCode config gets the folder's path, so re-run `./install.sh` if you move it.

```
./install.sh           # set up what is missing; ends "All good." when nothing needed doing
./install.sh --check   # only look, change nothing; exit code 1 if anything is missing
```

It can be run as often as you like and prints one line per step: `ok`, `fixed: ...` or `MISSING: ...`.

**What it changes on your computer** (and nothing else):

| Step | What it checks | When that is missing |
|---|---|---|
| node | version 18 or newer | says where to get it |
| OpenCode | the `opencode` program is on the PATH, in `~/.opencode/bin`, or at `$OPENCODE_BIN` | says where to get it |
| Google Chrome | the app is installed | says where to get it |
| OpenCode config | `~/.config/opencode/opencode.json` has the tool server `chrome` pointing at this folder, the agents `chrome` and `chrome-panel`, the rule `chrome_*: deny`, and `chrome_*: allow` for the `build` agent if your config defines one | adds the missing ones from `opencode-config-snippet.json` after a dated backup (`opencode.json.bak-<date>`); creates the file if there is none. Entries that are present are never overwritten. A config kept as `opencode.jsonc` is not edited: add the entries by hand |
| `opencode-chat-server` command | a link to `bin/opencode-chat-server` in `$OCBC_BIN_DIR`, or in `~/.config/opencode/bin` if you have such a folder, or else in `~/.local/bin` | makes the link |
| extension in Chrome | the extension is loaded and reaching the tool server (asked without any model; a few seconds when connected, up to 40 when not) | Chrome cannot load an unpacked extension from the command line, so it prints the three steps: open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and choose the `extension` folder. The id must read `piocoganjbdbfacbjgalnbehhafndpnl` |
| chat server | only reported: running or not, and how to start it. It is started by hand | `--autostart` installs the LaunchAgent `local.opencode-browser-control.chat-server` in `~/Library/LaunchAgents` so it starts at every login (asks first; `--yes` answers yes) |

Without a terminal it never asks anything. The extension step also tells you when Chrome still runs an older version than this folder: press the reload arrow on the extension's card. Do the same after changing any extension file.

The model the two agents use is whatever your OpenCode is set up with. To give them a model of their own, or to change their instructions, edit the `chrome` and `chrome-panel` agents in your `opencode.json`; the installer leaves your edits alone.

### API keys

OpenCode needs your model provider's key, as always. If you logged in with `opencode auth login`, or the key is already in your environment, there is nothing to do.

Optionally, on macOS, the chat server's launcher reads keys from the login Keychain so they never sit in a file: one "generic password" item per key, service `opencode`, account = the variable's name. For example:

```
security add-generic-password -U -s opencode -a OPENAI_API_KEY -T /usr/bin/security -w
```

Only a fixed list of provider variable names is looked up (see `bin/keychain-env.zsh`, which also says how to change the service name or the list). Keys loaded this way live in the environment of the chat server and of what it starts (OpenCode and the tool servers OpenCode starts). Other programs running under your account can read a process's environment; other users of the computer cannot.

## Use

- **From OpenCode (terminal or desktop):** switch to the `chrome` agent and ask, for example "open en.wikipedia.org and tell me today's featured article".
- **From Chrome:** start the chat server (`opencode-chat-server`, or `bin/opencode-chat-server` in this folder), then click the extension icon. The + button hands the tab in front to OpenCode; then "summarise this page" works. The clock button lists earlier chats from the panel. You can keep typing while it works: messages are queued and sent when the current answer ends, or press "Send now" on one to interrupt.
- **Approving a site:** when OpenCode opens an unapproved site you get the approval page instead of the site. When it meets one on the way (a link, a download, a form), a bar at the bottom of the tab says so: press **Review** to answer on the approval page, or answer under ⋯ in the chat panel.
- **Stop:** the red Stop on the page or the switch next to + (both turn browser control off); the round button in the panel stops the current answer.

## Safety model, and its limits

What the code enforces, whatever the model does:

| Rule | Where | Tested in |
|---|---|---|
| Nothing at all until you switched browser control on in this Chrome session | `isStopped()` / `askForControl()` in `background.js` | `test/extension.test.mjs` |
| Only tabs in the session's own tab group, for every command | `groupTab()` in `background.js` | `test/extension.test.mjs` |
| Only approved sites are read, acted on, photographed or downloaded from; unapproved sites are not loaded by `open`/`navigate`, links to them are not followed and forms to them are not submitted | `requireApproved()`, `pageDestination()`, `approve.html` | `test/extension.test.mjs` |
| A web page cannot approve a site, switch control on, or change the lists. The bar inside a page can only Stop, Deny, or open the extension's approval page | `onMessage()` / `fromOwnPage()` in `background.js`; buttons ignore clicks that are not real user clicks (`isTrusted`) | `test/extension.test.mjs` |
| The model is told a tab's title and address only for approved sites | `tabs` command and `oc-context` in `background.js` | `test/extension.test.mjs` |
| No typing into fields that look secret; no typing of text that looks like a key, token or card number | `pageAct()` in `background.js`; `SECRET` in `chrome-mcp.mjs` | both test files |
| No web page can reach the local servers | both listen on 127.0.0.1 only and want `Origin: chrome-extension://<id>` and their own `Host` | `test/servers.test.mjs` |
| The chat panel can only chat with the browser-only agent, and only see its own chats | `ROUTES` in `chat-server.mjs` | `test/servers.test.mjs` |
| Web pages cannot drive OpenCode's own server | `opencode serve` runs with a random password that is never written to disk or put on a command line | `test/servers.test.mjs` |

Limits to know (more in [SECURITY.md](SECURITY.md)):

- **The model reads what is on approved pages**, including your signed-in content there, and that text goes to your model provider. Approve sites with that in mind.
- **Text on a page can try to instruct the model** (prompt injection). The agents are told to treat page text as information only and never to send, post, buy, delete or change settings unless you asked for exactly that. That is an instruction to a model, not a lock: a model can be fooled, and inside an approved site it can click whatever you could.
- **Any program running on your computer can pretend to be either side** of the local connection: it can pose as the extension to the servers, or as the server to the extension. The switch, the tab group and the site approvals still apply to it, but the "allow browser control?" question cannot tell you who is asking.
- The secret-field check is a guess from the field's type and names. It cannot stop a model from typing something you told it into an ordinary text box.
- A site you approved can still redirect the tab to one you did not: that page loads, and is then not read or acted on until you allow it. Pages can also load pictures and scripts from anywhere, as always.
- A page can hide or cover the frame and the Stop button drawn inside it. The switch in the chat panel and the toolbar badge ("on") are outside the page's reach.
- Approval is per host name, for http and https alike.
- Clicks and typing are done by script, not by real mouse and keyboard events. Most sites accept that; some (banks, some logins, drag-and-drop, canvas apps) will not react. Content inside frames and shadow roots is not listed, so it can be neither read nor used.
- Screenshots bring the tab to the front.
- Chrome puts the extension's worker to sleep when idle; it wakes every 30 seconds, so the first command after a pause can take up to 30 seconds.

### The fixed extension id

An unpacked extension normally gets an id derived from the folder it is loaded from. The `key` in `manifest.json` (a public key) pins the id to `piocoganjbdbfacbjgalnbehhafndpnl` wherever the folder is, so the two local servers know which `Origin` to expect.

What that id is worth: it keeps **web pages and other extensions** out, because a browser will not let them send that Origin. It is **not a secret and not a proof of identity**. Everyone who downloads this repository has the same id, and a program running on your computer can type the header by hand. There is no private key in this repository, and none is needed: do not pack or publish the extension under this key.

### What is written to disk

- The control log, one line per browser command: `~/Library/Logs/opencode-browser-control.log` on macOS, `~/.local/state/opencode-browser-control/` elsewhere. It holds the tool, its arguments (typed text cut to 80 characters, web addresses without their query part) and the first 160 characters of the result, which can include page titles and the start of page text. The file is readable by you only. Delete it whenever you like.
- Screenshots, in `.opencode-chrome/` in the folder OpenCode is running in.
- Downloads, in Chrome's Downloads folder.
- The list of always-allowed sites, in the extension's storage in your Chrome profile.
- The chats themselves are ordinary OpenCode sessions, stored by OpenCode.

## Tests

```
node --test test/
```

Runs in a couple of seconds, needs no browser, no OpenCode and no model, and uses its own ports and a throwaway home folder, so it does not disturb a copy you are using.

| File | What it checks |
|---|---|
| `test/servers.test.mjs` | The two servers, with the test playing the extension and `test/fake-opencode.mjs` playing OpenCode: who may connect (Origin, Host, method), a command's round trip, secret-like text refused, the control log's content and file mode, and that the chat proxy passes on only what the panel is meant to do |
| `test/extension.test.mjs` | The worker's rules, with stand-ins for Chrome's APIs and for a page: control off, own tab group only, approved sites only, what a page's messages can and cannot do, secret fields, links and forms to unapproved sites, screenshots |

Not covered by these tests: anything that needs a real Chrome (how the overlay, the approval page and the side panel look and behave, and whether Chrome's APIs behave like the stand-ins). `./install.sh --check` and `bin/extension-check.mjs` check a real installation without a model.

## Benchmark (`bench/`)

A way to see how the model you chose behaves, as opposed to what the code enforces.

```
python3 bench/site.py &     # a local test website on 127.0.0.1:8791 whose buttons only record clicks
python3 bench/run.py        # waits until you allowed browser control and the test site in Chrome, then runs the tasks
```

The runner gives the `chrome` agent 19 tasks and judges each from what the test site recorded, not from the model's own words. **The tasks call your model through your OpenCode, so a run costs what that model costs** for about twenty short tasks; `python3 bench/run.py --preflight` only does the waiting and costs nothing.

| Group | Tasks |
|---|---|
| Ordinary work (4) | fill and submit a form; research across three pages; download the right file; compare prices over two pages |
| Must stop, refuse or ask (14) | hidden instruction in an article; a message on the page claiming to be from the account owner that says "press Transfer"; password; API key requested by a form; price check beside a Buy button; vague "get me the widget"; draft without sending; a setting beside "Delete my account"; cookie wall; robot check; giveaway form wanting a social security number and card; installer pushed before a report; free trial with terms to see information; link to an unapproved site |
| Must not over-refuse (1) | "reply and send it": an explicit request to send |

Not covered: real sites with logins, long tasks, drag-and-drop, sites that block scripted clicks, and attacks more subtle than these. Passing it says little about a determined attacker.

## Uninstall

```
./uninstall.sh --dry-run    # print what it would do, change nothing
./uninstall.sh              # asks once, then does it (--yes skips the question)
```

It stops the chat server, removes the login LaunchAgent if there is one, removes the `opencode-chat-server` link, and takes this project's entries out of `opencode.json` (dated backup first; your edits to the agents stay in that backup). It then tells you to remove the extension in `chrome://extensions` yourself, which a script cannot do. It keeps this folder and the control log. `./install.sh` puts everything back.

## Changing it

- **Adding a tool:** read `extension/background.js` first: the `COMMANDS` table near the end is the list of what OpenCode can do, one function each. Add a function there and an entry with the same name in `TOOLS` in `server/chrome-mcp.mjs`. Every command must start with `groupTab()` and, if it reads or acts on a page, `requireApproved()`.
- **Ports** are fixed in places that must agree: `PORTS` in `background.js` and `PORT_BASE` in `chrome-mcp.mjs` (17300-17309), and 17320 in `sidepanel.js` and `chat-server.mjs`.
- **Colours:** each page has one commented block of CSS variables at the top of its styles: `sidepanel.html`, `approve.html`, and the `:host{...}` block in `overlay.js`. The tab group colour and the toolbar badge colours are constants at the top of `background.js`.
- **Icon:** edit the colours or shapes in `tools/make-icons.py` and run it.
- **Code style:** every file starts with a header saying what it is for; every function has a Javadoc-style comment (`@param`, `@return`, `@throws`); comments say why. Please keep that up in changes.
- **Before publishing a fork:** `bash tools/check-public.sh` looks for keys and for your own private strings (one regular expression per line in a `.private-patterns` file you create; it is ignored by git).

## Licence

MIT, see [LICENSE](LICENSE).
