#!/bin/bash
# @file uninstall.sh
# Takes OpenCode Browser Control off this computer again: the reverse of install.sh, and
# nothing more. It never deletes this folder or the control log.
#
# What it does, in this order:
#   1. stops the chat server if it is running
#   2. removes the LaunchAgent that starts it at login, if install.sh --autostart made one
#   3. removes the command `opencode-chat-server` (the link install.sh made)
#   4. takes this project's entries out of OpenCode's config ~/.config/opencode/opencode.json,
#      after a dated backup of that file beside it. If you edited the `chrome` agents there,
#      your version stays in that backup.
#   5. tells you to remove the extension in chrome://extensions yourself (Chrome does not let
#      a script do that)
#
# @project opencode-browser-control
# @usage ./uninstall.sh [--dry-run] [--yes] [-h]
#          --dry-run  print every action it would take and change nothing
#          --yes      do not ask for confirmation at the start
# @env HOME  everything is found relative to it
# @env OCBC_BIN_DIR  folder of the `opencode-chat-server` link, if you chose one at install
# @env OCBC_TEST_SKIP_LAUNCHCTL  tests only: remove the LaunchAgent file but do not unload it
# @env OCBC_TEST_CHAT_PORT  tests only: the port to look for a running chat server on
# @exit 0 done (or dry run finished); 1 not confirmed, or no terminal to ask in and no --yes;
#       64 unknown option
# @author Claude (Anthropic), written for and prompted by William Munnich
# @date Last edited 2026-11-14
set -u

REPO="$(cd "$(dirname "$0")" && pwd -P)"
CONFIG_DIR="$HOME/.config/opencode"
CONFIG="$CONFIG_DIR/opencode.json"
LINK_TARGET="$REPO/bin/opencode-chat-server"
AGENT_LABEL="local.opencode-browser-control.chat-server"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
CHAT_PORT="${OCBC_TEST_CHAT_PORT:-17320}"
LOG="$HOME/Library/Logs/opencode-browser-control.log"

DRY=0; YES=0

# usage: prints the help text, which is the header comment of this file.
usage() { sed -n '2,/^# @exit/p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg (see ./uninstall.sh -h)"; exit 64 ;;
  esac
done

# act: does one action, or in a dry run only says what it would do.
# @param $1  description of the action
# @param $2... the command to run
# @return the command's exit status (0 in a dry run)
act() {
  local what="$1"; shift
  if [ "$DRY" = 1 ]; then echo "  would: $what"; return 0; fi
  if "$@"; then echo "  done: $what"; else echo "  FAILED: $what"; return 1; fi
}

# skip: says that a step had nothing to do.
# @param $1  what was not there
skip() { echo "  nothing to do: $1"; }

# stop_chat_server: ends the chat server. Only a process that listens on the chat port AND is
# chat-server.mjs is stopped, so another program that happens to use the port is left alone.
# SIGTERM lets it shut down its own `opencode serve` child (see server/chat-server.mjs).
stop_chat_server() {
  local pid
  pid="$(lsof -nP -iTCP:"$CHAT_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q 'chat-server\.mjs'; then
    act "stop the chat server (pid $pid)" kill -TERM "$pid"
  else
    skip "the chat server is not running"
  fi
}

# remove_agent: unloads and removes the login LaunchAgent. The plist is a generated file
# (install.sh --autostart writes it again), so removing it loses nothing.
remove_agent() {
  if [ -f "$AGENT_PLIST" ]; then
    # bootout fails when the agent is not loaded right now; that is fine.
    if [ "$DRY" != 1 ] && [ -z "${OCBC_TEST_SKIP_LAUNCHCTL:-}" ]; then
      launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
    fi
    act "remove the LaunchAgent $AGENT_PLIST (chat server no longer starts at login)" rm -f "$AGENT_PLIST"
  else
    skip "no LaunchAgent for the chat server"
  fi
}

# remove_link: removes the command link from each folder install.sh may have put it in, but
# only a link that points into this checkout. A real file, or a link to somewhere else, is
# somebody else's and is left alone.
remove_link() {
  local dir link found=0
  for dir in "${OCBC_BIN_DIR:-}" "$CONFIG_DIR/bin" "$HOME/.local/bin"; do
    [ -n "$dir" ] || continue
    link="$dir/opencode-chat-server"
    if [ "$(readlink "$link" 2>/dev/null)" = "$LINK_TARGET" ]; then
      act "remove the link $link" rm -f "$link"; found=1
    elif [ -e "$link" ] || [ -L "$link" ]; then
      echo "  left alone: $link is not a link made by this checkout's install.sh"; found=1
    fi
  done
  [ "$found" = 1 ] || skip "no opencode-chat-server link"
}

# remove_config_entries: takes this project's entries out of OpenCode's config. The backup that
# bin/config-entries.py makes first keeps the user's own edits to the agents.
remove_config_entries() {
  local report
  if [ ! -f "$CONFIG" ]; then
    skip "$CONFIG does not exist"
    return
  fi
  if [ "$DRY" = 1 ]; then
    if report="$(python3 "$REPO/bin/config-entries.py" remove "$CONFIG" --dry-run 2>&1)"; then
      echo "  $report in $CONFIG"
    else
      skip "$report"
    fi
    return
  fi
  if report="$(python3 "$REPO/bin/config-entries.py" remove "$CONFIG" 2>&1)"; then
    echo "  done: $report"
    echo "        Restart OpenCode so it stops offering the chrome tools."
  else
    skip "$report"
  fi
}

echo "OpenCode Browser Control: uninstall$([ "$DRY" = 1 ] && echo " (dry run, nothing is changed)")"
if [ "$DRY" != 1 ] && [ "$YES" != 1 ]; then
  if [ ! -t 0 ]; then
    echo "No terminal to ask for confirmation in. Run it in a terminal, or add --yes (or --dry-run to only look)."
    exit 1
  fi
  read -r -p "Remove the chat server command, its login start, and the chrome entries in OpenCode's config? [y/N] " answer
  case "$answer" in y|Y|yes|Yes) ;; *) echo "Nothing changed."; exit 1 ;; esac
fi

stop_chat_server
remove_agent
remove_link
remove_config_entries

echo
echo "For you to do by hand: remove the extension in Chrome. Open chrome://extensions, find"
echo "\"OpenCode Browser Control\" (id $(tr -d '[:space:]' < "$REPO/extension/EXTENSION_ID")) and click Remove."
echo "That also deletes its list of always-allowed sites."
echo
echo "Left in place on purpose:"
echo "  $REPO   (this folder)"
[ -f "$LOG" ] && echo "  $LOG   (the control log: what OpenCode did in the browser)"
echo "  $CONFIG.bak-*   (backups of OpenCode's config)"
echo "  $HOME/Library/Logs/opencode-chat-server.log   (if the login start was ever used)"
echo "To put everything back: $REPO/install.sh"
