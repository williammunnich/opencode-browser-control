# Security

This tool lets a language model read pages and click, type and download in a Chrome where you are signed in. This page says, in plain words, what protects you, what does not, and how to report a problem.

## Reporting a vulnerability

Please report it privately: on this repository's GitHub page open **Security → Report a vulnerability** (GitHub's private vulnerability reporting). Do not open a public issue for something that could be used against people running this.

Say what you did, what happened, and what you expected. A small example page or a few lines of script help a lot. This is a one-person project without guaranteed response times; reports are read and fixes are published in this repository.

## What is being protected

- Your signed-in sessions in Chrome: mail, bank, shops, work tools.
- Your computer: the chat panel must not become a way to run commands or read files.
- Your model-provider keys.

## Who might attack, and what stops them

**A web page you never approved.** It cannot talk to the local servers: both listen on 127.0.0.1 only and answer only requests that carry this extension's `Origin` and the server's own `Host`, which a page cannot fake (this also covers DNS rebinding). It cannot message the extension: the extension accepts no outside connections and exposes none of its pages to the web. The model is not shown it: unapproved sites are not loaded by the agent, links to them are not followed, forms to them are not submitted, and even their title and address are withheld from the model if such a tab ends up in the group.

**A web page you approved, or text on it.** This is the main risk and it is only partly solvable. Anything written on an approved page reaches the model and can try to talk it into something (prompt injection). The agents' instructions tell the model to treat page text as information and not to send, buy, delete or change settings unless you asked. **Those instructions are not enforcement.** What is enforced, whatever the model decides:
- it cannot leave its tab group or act on a site you have not approved, so it cannot carry what it read to an unapproved site by opening an address, following a link or submitting a form there;
- it cannot approve a site or switch control on: only your real click on the extension's own page or panel can. The bar drawn inside a page has no Allow button for this reason, since a page can hide, cover or imitate anything inside it and trick a click;
- it does not type into fields that look secret, and text shaped like a key, token or card number is refused;
- from the chat panel, it has no shell, no file access and no other tools.

What is not enforced: inside an approved site it can click anything you could, including Send, Buy and Delete. A hostile approved page can also mislead it about what a button does, load pictures or scripts from anywhere (which can carry data out), redirect the tab elsewhere (the new site loads, but is not read), and hide the Stop button drawn on it (the switch in the chat panel still works). **Approve a site only if you would let the model act there as you, and switch control off when you are done.**

**Another program on your computer.** The two local connections have no password, and cannot easily have one that such a program could not also read:
- A program that sends the extension's `Origin` header by hand can use the local servers. On the tool server it can see commands meant for the extension and answer them with made-up page content. On the chat server it can chat with the browser-only agent and read chats started from the panel; it cannot choose another agent, reach other OpenCode sessions, run commands, or answer a permission request with "always".
- A program that listens on one of the ports 17300-17309 can send the extension commands, as if it were OpenCode. It is held to the same rules as OpenCode: you must have switched control on (the question you are shown cannot tell you who is asking), only its own tab group, only sites you approved. If you have always-allowed a site and control is on, such a program can read and act on that site.
- On a computer shared with other user accounts, "another program" includes programs run by those accounts, because 127.0.0.1 is shared between them.

A program already running as you can usually do worse in other ways, but keep the list of always-allowed sites short, and do not rely on this tool on a computer you share with people you do not trust.

**Someone with your files.** The control log records what the agent did (see the README, "What is written to disk"): it is readable by your account only, keeps typed text to 80 characters and drops the query part of addresses, but it does hold page titles and the beginnings of pages. Screenshots are saved as files. OpenCode stores the chats.

## Secrets

- The password of the `opencode serve` process that the chat server starts is random, new on every start, kept in memory, and handed over in the environment, never on a command line and never written to a file or log. Programs running as you can read a process's environment; other users cannot.
- Model-provider keys are whatever you gave OpenCode. If you use the optional Keychain loader, they are in the environment of the chat server, of OpenCode, and of the tool servers OpenCode starts.
- The `key` in `extension/manifest.json` is a public key that fixes the extension's id. It is not a secret, the id proves nothing about who is calling (see above), and no private key exists in this repository.

## Permissions the extension asks for

`<all_urls>` and `scripting` (it must be able to read and act on whichever sites you approve; the per-site approval is this extension's own rule, not Chrome's), `tabs` and `tabGroups` (its tab group), `downloads` (the download tool), `storage` (approved sites, the switch), `alarms` (waking up to poll), `sidePanel` (the chat). It has no remote code, no `eval`, and inserts page or model text only as text, never as HTML.

## Known gaps, stated plainly

- The two local connections are not authenticated beyond the `Origin` header (see "Another program on your computer").
- The extension has access to all sites as far as Chrome is concerned; a bug in its own approval rule would not be caught by Chrome.
- The secret-field check is a guess from field types and names.
- Approval is per host name and covers http as well as https.
- The automated tests cover the servers and the worker's rules with stand-ins for Chrome; behaviour in a real browser is checked by hand.
