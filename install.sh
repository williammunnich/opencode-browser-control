#!/bin/bash
# @file install.sh
# Sets up OpenCode Browser Control on this computer (macOS), or checks that it is set up. It is
# safe to run again and again: each step first looks at what is there and only acts when
# something is missing. When nothing needed doing the last line is exactly "All good."
# It works from wherever this folder is; nothing is copied out of it.
#
# What it can change on the computer (nothing else, and nothing at all with --check):
#   - OpenCode's config file ~/.config/opencode/opencode.json: adds this project's entries
#     (from opencode-config-snippet.json) after a dated backup of the file beside it; creates
#     the file when there is none. Entries that are already there are never overwritten.
#   - one link named `opencode-chat-server` in a bin folder (see step 5), pointing into this folder.
#   - only with --autostart: one LaunchAgent file in ~/Library/LaunchAgents, so the chat
#     server starts at login.
# uninstall.sh takes all of it back.
#
# Steps (one line of output each: "ok", "fixed: ..." or "MISSING: ..."):
#   1. node 18 or newer
#   2. OpenCode itself (the `opencode` program)
#   3. Google Chrome
#   4. OpenCode's config has this project's entries: the tool server `chrome` pointing at this
#      folder, the agents `chrome` and `chrome-panel`, and the chrome_* rules.
#   5. the command `opencode-chat-server`: a link to bin/opencode-chat-server here, placed in
#      $OCBC_BIN_DIR, or else in ~/.config/opencode/bin when you have such a folder, or else
#      in ~/.local/bin (created when missing).
#   6. the extension is loaded in Chrome and connected (asked without any model, see
#      bin/extension-check.mjs). Chrome cannot load an unpacked extension from the command line,
#      so when it is not connected the three manual steps are printed.
#   7. the chat server: only reported, because it is started by hand. With --autostart a
#      LaunchAgent is installed that starts it at login.
#
# @project opencode-browser-control
# @usage ./install.sh [--check] [--autostart] [--yes] [-h]
#          --check      look only, change nothing; exit 1 when something is missing
#          --autostart  also start the chat server at every login (asks first)
#          --yes        answer yes to that question (for use without a terminal)
# @env HOME  everything is found relative to it (tests point it at an empty folder)
# @env OCBC_BIN_DIR  folder for the `opencode-chat-server` link (see step 5)
# @env OPENCODE_BIN  full path of the `opencode` program, when it is not on the PATH
# @env OCBC_TEST_SKIP_LAUNCHCTL  tests only: write the LaunchAgent file but do not load it
# @env OCBC_TEST_CHAT_PORT  tests only: the port to look for a running chat server on
# @exit 0 everything in place (also after fixing); 1 something is missing or needs you;
#       64 unknown option
# @author Claude (Anthropic), written for and prompted by William Munnich
# @date Last edited 2026-11-14
set -u

# Folder of this checkout, with links resolved, so the config gets a path that stays valid.
REPO="$(cd "$(dirname "$0")" && pwd -P)"
CONFIG_DIR="$HOME/.config/opencode"
CONFIG="$CONFIG_DIR/opencode.json"
LINK_TARGET="$REPO/bin/opencode-chat-server"
# Where the command link goes: your choice, else OpenCode's own bin folder if you keep one,
# else the usual per-user bin folder.
if [ -n "${OCBC_BIN_DIR:-}" ]; then BIN_DIR="$OCBC_BIN_DIR"
elif [ -d "$CONFIG_DIR/bin" ]; then BIN_DIR="$CONFIG_DIR/bin"
else BIN_DIR="$HOME/.local/bin"; fi
LINK="$BIN_DIR/opencode-chat-server"
# Name of the login item. "local." marks it as made on this computer, not by a company.
AGENT_LABEL="local.opencode-browser-control.chat-server"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
CHAT_PORT="${OCBC_TEST_CHAT_PORT:-17320}"
# node from Homebrew, and opencode from its own installer, are not on the PATH of every shell
# (for example one started by launchd). These are added behind nothing: your PATH still wins
# for everything it already has.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.opencode/bin"

CHECK=0; AUTOSTART=0; YES=0
FIXED=0      # how many things this run changed
PROBLEMS=0   # how many things are still missing

# usage: prints the help text, which is the header comment of this file.
usage() { sed -n '2,/^# @exit/p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --autostart) AUTOSTART=1 ;;
    --yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg (see ./install.sh -h)"; exit 64 ;;
  esac
done

# ok: prints a step's line when nothing needed doing.
# @param $1  step name
# @param $2  detail (optional)
ok() { echo "  $1: ok${2:+ ($2)}"; }

# fixed: prints a step's line when this run changed something, and counts it.
# @param $1  step name
# @param $2  what was done
fixed() { echo "  $1: fixed: $2"; FIXED=$((FIXED + 1)); }

# missing: prints a step's line when something is absent and was not (or could not be) fixed.
# @param $1  step name
# @param $2  what is missing and what to do about it
missing() { echo "  $1: MISSING: $2"; PROBLEMS=$((PROBLEMS + 1)); }

# confirm: asks a yes/no question. Never asks without a terminal: then the answer is no,
# unless --yes was given.
# @param $1  the question
# @return 0 for yes, 1 for no
confirm() {
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  local answer
  read -r -p "$1 [y/N] " answer
  case "$answer" in y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac
}

# xml_escape: makes a text safe to put inside an XML file (the LaunchAgent), so a folder name
# containing & or < cannot break it.
# @param $1  the text
# @return prints the escaped text
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# step_node: node must exist and be version 18 or newer (the servers use built-in fetch).
# Sets HAVE_NODE for the later steps that need it.
step_node() {
  HAVE_NODE=0
  if ! command -v node >/dev/null 2>&1; then
    missing "node" "not installed. Get it from https://nodejs.org/ (or: brew install node)"
    return
  fi
  local version major
  version="$(node --version 2>/dev/null)"          # for example v22.3.0
  major="${version#v}"; major="${major%%.*}"
  if [ "${major:-0}" -ge 18 ] 2>/dev/null; then
    HAVE_NODE=1; ok "node" "$version"
  else
    missing "node" "version $version is too old, 18 or newer is needed"
  fi
}

# step_opencode: OpenCode itself must be installed; this project only adds to it.
step_opencode() {
  if [ -n "${OPENCODE_BIN:-}" ] && [ -x "$OPENCODE_BIN" ]; then ok "OpenCode" "$OPENCODE_BIN"
  elif command -v opencode >/dev/null 2>&1; then ok "OpenCode" "$(command -v opencode)"
  else missing "OpenCode" "the opencode program was not found. Install it from https://opencode.ai/ , or set OPENCODE_BIN to its path"; fi
}

# step_chrome: Google Chrome must be installed; the extension only runs there.
step_chrome() {
  if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
    ok "Google Chrome"
  else
    missing "Google Chrome" "not in /Applications. Download it from https://www.google.com/chrome/"
  fi
}

# step_config: this project's entries in OpenCode's config. The work is done by
# bin/config-entries.py (Python's json module), which adds only what is missing.
step_config() {
  local report code
  if [ ! -f "$CONFIG" ]; then
    if [ -f "$CONFIG_DIR/opencode.jsonc" ]; then
      # A config with comments cannot be edited safely by a script.
      missing "OpenCode config" "your config is $CONFIG_DIR/opencode.jsonc (with comments), which this script does not edit. Add the entries of $REPO/opencode-config-snippet.json to it by hand, writing $REPO where it says {{REPO}}"
      return
    elif [ "$CHECK" = 1 ]; then
      missing "OpenCode config" "$CONFIG does not exist. Run ./install.sh to create it with this project's entries"
      return
    fi
    mkdir -p "$CONFIG_DIR" && printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$CONFIG" || { missing "OpenCode config" "could not create $CONFIG"; return; }
  fi
  report="$(python3 "$REPO/bin/config-entries.py" status "$CONFIG" 2>&1)"; code=$?
  if [ $code = 0 ]; then
    ok "OpenCode config" "tool server, two agents and rules present"
  elif [ $code = 2 ]; then
    missing "OpenCode config" "$report"
  elif [ "$CHECK" = 1 ]; then
    missing "OpenCode config" "$(echo "$report" | tr '\n' ';' | sed 's/;$//; s/;/; /g'). Run ./install.sh to add them"
  else
    if report="$(python3 "$REPO/bin/config-entries.py" add "$CONFIG" 2>&1)"; then
      fixed "OpenCode config" "$report. Restart OpenCode to load it"
    else
      missing "OpenCode config" "could not add the entries: $report"
    fi
  fi
}

# on_path: tells whether a folder is on the PATH this script was started with.
# @param $1  the folder
# @return 0 when it is
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }

# step_link: the command `opencode-chat-server`, a link from a bin folder to the script in this
# checkout. A real file of that name is never replaced.
step_link() {
  local hint=""
  on_path "$BIN_DIR" || hint="; $BIN_DIR is not on your PATH, so start it as $LINK or as $LINK_TARGET"
  if [ "$(readlink "$LINK" 2>/dev/null)" = "$LINK_TARGET" ]; then
    ok "opencode-chat-server command" "$LINK$hint"
  elif [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    missing "opencode-chat-server command" "$LINK exists and is not a link; left alone. Move it away and run again"
  elif [ "$CHECK" = 1 ]; then
    missing "opencode-chat-server command" "no link at $LINK to $LINK_TARGET. Run ./install.sh"
  else
    # -n: replace a link that points elsewhere instead of following it; -f: overwrite that link.
    if mkdir -p "$BIN_DIR" && ln -sfn "$LINK_TARGET" "$LINK"; then fixed "opencode-chat-server command" "linked $LINK to $LINK_TARGET$hint"
    else missing "opencode-chat-server command" "could not create the link $LINK"; fi
  fi
}

# step_extension: is the extension loaded in Chrome and reaching the tool server? Takes a few
# seconds when it is, up to 40 seconds when it is not (Chrome wakes a sleeping extension only
# every 30 seconds).
step_extension() {
  local expected_id answer code folder_version
  expected_id="$(tr -d '[:space:]' < "$REPO/extension/EXTENSION_ID")"
  if [ "$HAVE_NODE" != 1 ]; then
    missing "extension in Chrome" "not checked: node is needed for the check"
    return
  fi
  answer="$(node "$REPO/bin/extension-check.mjs" 2>&1)"; code=$?
  if [ $code = 0 ]; then
    folder_version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/extension/manifest.json" | head -1)"
    if [ "${answer#connected }" = "$folder_version" ]; then
      ok "extension in Chrome" "connected, version $folder_version"
    else
      ok "extension in Chrome" "connected, but Chrome runs version ${answer#connected } and this folder has $folder_version: press the reload arrow on its card in chrome://extensions"
    fi
  elif [ $code = 1 ]; then
    missing "extension in Chrome" "not connected. Chrome cannot load it from the command line; do this once by hand:"
    echo "        1. In Chrome open  chrome://extensions"
    echo "        2. Switch on  Developer mode  (top right)"
    echo "        3. Click  Load unpacked  and choose the folder  $REPO/extension"
    echo "      Its id must read $expected_id. If it is already loaded, Chrome may be closed or the"
    echo "      extension switched off there; open Chrome, wait half a minute and run this again."
  else
    missing "extension in Chrome" "could not check ($answer)"
  fi
}

# write_agent_plist: writes the LaunchAgent that starts the chat server at login. It runs the
# same script you start by hand, so API keys still come from the Keychain at that moment and
# are not written into this file.
# @param $1  path of the plist file to write
write_agent_plist() {
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$AGENT_LABEL</string>
<key>ProgramArguments</key><array><string>$(xml_escape "$LINK_TARGET")</string></array>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>$(xml_escape "$HOME/Library/Logs/opencode-chat-server.log")</string>
<key>StandardErrorPath</key><string>$(xml_escape "$HOME/Library/Logs/opencode-chat-server.log")</string>
</dict></plist>
PLIST
}

# step_chat_server: says whether the chat server is running and how to start it; with
# --autostart also installs the LaunchAgent. A stopped chat server is not a fault (it is
# started by hand by design), so it never counts as MISSING.
step_chat_server() {
  local pid state
  pid="$(lsof -nP -iTCP:"$CHAT_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$pid" ]; then state="running, pid $pid"
  else state="not running; start it with: $LINK   (needed only for the chat panel in Chrome)"; fi

  if [ -f "$AGENT_PLIST" ]; then
    if grep -qF "<string>$(xml_escape "$LINK_TARGET")</string>" "$AGENT_PLIST"; then
      ok "chat server" "$state; starts at login (LaunchAgent $AGENT_LABEL)"
    elif [ "$CHECK" = 1 ]; then
      missing "chat server" "the LaunchAgent $AGENT_PLIST starts a different copy. Run ./install.sh --autostart"
    else
      write_agent_plist "$AGENT_PLIST"
      fixed "chat server" "LaunchAgent now starts $LINK_TARGET (takes effect at the next login)"
    fi
  elif [ "$AUTOSTART" != 1 ]; then
    ok "chat server" "$state. Not started at login; ./install.sh --autostart adds that"
  elif [ "$(uname)" != "Darwin" ]; then
    ok "chat server" "$state. --autostart uses a macOS LaunchAgent and does nothing on this system"
  elif [ "$CHECK" = 1 ]; then
    missing "chat server" "no LaunchAgent for starting at login. Run ./install.sh --autostart"
  elif confirm "Start the chat server at every login (adds $AGENT_PLIST)?"; then
    write_agent_plist "$AGENT_PLIST"
    # bootstrap = load it now, which also starts it. If the server already runs, the new copy
    # sees the busy port and exits by itself; that is harmless.
    if [ -z "${OCBC_TEST_SKIP_LAUNCHCTL:-}" ]; then
      launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" 2>/dev/null || true
    fi
    fixed "chat server" "LaunchAgent $AGENT_LABEL installed; the chat server now starts at login. Log: $HOME/Library/Logs/opencode-chat-server.log. Remove with ./uninstall.sh"
  else
    ok "chat server" "$state. Start at login not installed (no terminal to ask in, or you answered no; add --yes to skip the question)"
  fi
}

echo "OpenCode Browser Control: $([ "$CHECK" = 1 ] && echo "checking" || echo "installing") ($REPO)"
step_node
step_opencode
step_chrome
step_config
step_link
step_extension
step_chat_server

if [ "$PROBLEMS" -gt 0 ]; then
  echo "$PROBLEMS thing(s) need attention (the MISSING lines above)."
  exit 1
elif [ "$FIXED" -gt 0 ]; then
  echo "Done: $FIXED thing(s) set up, nothing missing."
else
  echo "All good."
fi
