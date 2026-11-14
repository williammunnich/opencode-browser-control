#!/usr/bin/env python3
# @file config-entries.py
# Looks after the few entries this project needs inside OpenCode's config file
# (~/.config/opencode/opencode.json): the tool server `chrome`, the agents `chrome` and
# `chrome-panel`, the rule that switches the chrome_* tools off everywhere else, and the line
# that gives them to the everyday `build` agent. install.sh and uninstall.sh call it; it can
# also be run by hand. The wanted entries are kept in ../opencode-config-snippet.json, where
# the text {{REPO}} stands for the folder of this checkout. It changes only the config file it
# is given, and only after copying it to a dated backup beside it.
# @project opencode-browser-control
# @author Claude (Anthropic), written for and prompted by William Munnich
# @date Last edited 2026-11-14
"""config-entries.py: this project's entries in OpenCode's opencode.json.

  config-entries.py status   CONFIG   report which entries are missing or point elsewhere
  config-entries.py add      CONFIG   add the missing ones from the snippet (dated backup first)
  config-entries.py remove   CONFIG [--dry-run]   take them out again (dated backup first)

CONFIG is the path of opencode.json. Exit codes: 0 nothing to do / done; 1 something is
missing (status) or was not found (remove); 2 the config file is absent or is not valid JSON. Only this project's entries are touched; everything else is written back as read.
"""
import datetime
import json
import os
import shutil
import sys

# Folder of this checkout (this file is in bin/).
REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
# The wanted entries, with {{REPO}} in place of the checkout folder.
SNIPPET = os.path.join(REPO, "opencode-config-snippet.json")
# Stands for the checkout folder inside the snippet, so the snippet works wherever the repo is.
PLACEHOLDER = "{{REPO}}"
# The entries this project owns, as paths into opencode.json. Each path is a list of keys.
ENTRIES = [
    ["mcp", "chrome"],
    ["agent", "chrome"],
    ["agent", "chrome-panel"],
    ["permission", "chrome_*"],
    ["agent", "build", "permission", "chrome_*"],
]


def name(path):
    """Write a path the way a person would say it.

    @param path: list of keys, for example ["agent", "chrome"]
    @return: text such as 'agent "chrome"' or 'permission "chrome_*" under agent "build"'
    """
    if len(path) == 2:
        return f'{path[0]} "{path[1]}"'
    return f'{path[2]} "{path[3]}" under {path[0]} "{path[1]}"'


def get(tree, path):
    """Look one entry up.

    @param tree: the parsed JSON (a dict)
    @param path: list of keys
    @return: the value, or None when any key on the way is absent
    """
    for key in path:
        if not isinstance(tree, dict) or key not in tree:
            return None
        tree = tree[key]
    return tree


def put(tree, path, value):
    """Set one entry, creating the dicts on the way. New keys go at the end of their dict.

    @param tree: the parsed JSON (a dict), changed in place
    @param path: list of keys
    @param value: what to store
    @return: None
    """
    for key in path[:-1]:
        tree = tree.setdefault(key, {})
    tree[path[-1]] = value


def drop(tree, path):
    """Remove one entry if it is there. Parents are left alone, even when they end up empty.

    @param tree: the parsed JSON (a dict), changed in place
    @param path: list of keys
    @return: True when something was removed
    """
    parent = get(tree, path[:-1])
    if isinstance(parent, dict) and path[-1] in parent:
        del parent[path[-1]]
        return True
    return False


def load(config):
    """Read opencode.json.

    @param config: path of the file
    @return: (parsed dict, True when the file ends with a newline)
    @raise SystemExit: code 2 when the file is absent or not valid JSON
    """
    try:
        text = open(config, encoding="utf-8").read()
        return json.loads(text), text.endswith("\n")
    except FileNotFoundError:
        print(f"{config} does not exist")
        sys.exit(2)
    except ValueError as e:
        print(f"{config} is not valid JSON: {e}")
        sys.exit(2)


def save(config, tree, newline):
    """Back the file up beside itself (name.bak-YYYY-MM-DD-HHMMSS), then write it with a 2-space
    indent, the way it is kept. The backup comes first so a failed write loses nothing.

    @param config: path of the file
    @param tree: the dict to write
    @param newline: True to end the file with a newline (kept as it was)
    @return: path of the backup
    """
    backup = config + ".bak-" + datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    n = 1
    while os.path.exists(backup):  # two saves in the same second must not overwrite each other's backup
        n += 1
        backup = backup.split("~")[0] + f"~{n}"
    shutil.copy2(config, backup)
    text = json.dumps(tree, indent=2, ensure_ascii=False) + ("\n" if newline else "")
    with open(config, "w", encoding="utf-8") as f:
        f.write(text)
    return backup


def wanted():
    """Read the snippet and put this checkout's folder in place of {{REPO}}.

    @return: dict shaped like opencode.json, holding only this project's entries
    @raise SystemExit: code 2 when the snippet is absent or broken
    """
    try:
        text = open(SNIPPET, encoding="utf-8").read()
    except FileNotFoundError:
        print(f"{SNIPPET} is missing; it belongs to this project (get it back with: git checkout opencode-config-snippet.json)")
        sys.exit(2)
    # json.dumps(REPO)[1:-1] = the folder written as it must appear inside a JSON string.
    return json.loads(text.replace(PLACEHOLDER, json.dumps(REPO)[1:-1]))


def problems(tree):
    """List what is missing from the config or points at another checkout.

    @param tree: the parsed opencode.json
    @return: list of (path, reason) pairs; empty when everything is in place
    """
    want = wanted()
    found = []
    for path in ENTRIES:
        have = get(tree, path)
        if path == ["agent", "build", "permission", "chrome_*"] and get(tree, ["agent", "build"]) is None:
            continue  # no `build` agent in this config: nothing to attach the line to
        if have is None:
            found.append((path, "missing"))
        elif path == ["mcp", "chrome"] and have.get("command") != get(want, path).get("command"):
            found.append((path, f"points at {' '.join(have.get('command') or [])}, not at this checkout"))
        elif path == ["mcp", "chrome"] and have.get("enabled") is False:
            found.append((path, "is switched off (enabled: false)"))
        elif path == ["permission", "chrome_*"] and have != "deny":
            found.append((path, f'is "{have}", expected "deny"'))
    return found


def cmd_status(config):
    """Print one line per problem.

    @param config: path of opencode.json
    @return: exit code: 0 all entries in place, 1 otherwise
    """
    tree, _ = load(config)
    found = problems(tree)
    for path, reason in found:
        print(f"{name(path)}: {reason}")
    return 1 if found else 0


def cmd_add(config):
    """Add or correct the entries that `status` complains about; leave the others as they are, so
    the user's own later edits to the agents are never overwritten by an install.

    @param config: path of opencode.json
    @return: exit code 0
    """
    tree, newline = load(config)
    found = problems(tree)
    if not found:
        print("nothing to add")
        return 0
    want = wanted()
    for path, _ in found:
        put(tree, path, get(want, path))
    backup = save(config, tree, newline)
    print("added " + ", ".join(name(p) for p, _ in found) + f" (backup: {backup})")
    return 0


def cmd_remove(config, dry_run):
    """Take this project's entries out of the config.

    @param config: path of opencode.json
    @param dry_run: True to only say what would be removed
    @return: exit code: 0 removed (or would be), 1 none of the entries was there
    """
    tree, newline = load(config)
    present = [p for p in ENTRIES if get(tree, p) is not None]
    if not present:
        print("none of the entries is in the config")
        return 1
    listed = ", ".join(name(p) for p in present)
    if dry_run:
        print(f"would remove {listed} (after a dated backup of the file)")
        return 0
    for path in present:
        drop(tree, path)
    backup = save(config, tree, newline)
    print(f"removed {listed} (backup: {backup})")
    return 0


def main():
    """Read the command line and run one command.

    @return: None (ends the program with the command's exit code; 64 for a wrong command line)
    """
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry_run = "--dry-run" in sys.argv[1:]
    if len(args) != 2 or args[0] not in ("status", "add", "remove"):
        print(__doc__)
        sys.exit(64)
    command, config = args
    if command == "status":
        sys.exit(cmd_status(config))
    if command == "add":
        sys.exit(cmd_add(config))
    sys.exit(cmd_remove(config, dry_run))


if __name__ == "__main__":
    main()
