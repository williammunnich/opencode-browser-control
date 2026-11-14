# @file keychain-env.zsh
# Optional convenience for macOS: loads model-provider API keys from the login Keychain into
# the environment of the shell that sources this file, so the keys need not sit in a file or in
# your shell profile. It is sourced by bin/opencode-chat-server and by bench/run.py just before
# they start OpenCode. If you gave OpenCode your keys another way (`opencode auth login`, or
# variables already exported), this file does nothing and can be ignored.
#
# Convention: one Keychain item per key, kind "generic password", service "opencode" (change
# with OCBC_KEYCHAIN_SERVICE), account = the variable's name. To store one:
#     security add-generic-password -U -s opencode -a OPENAI_API_KEY -T /usr/bin/security -w
# (it asks for the key; `-T /usr/bin/security` lets the `security` tool read it back without a
# dialog). A variable that is already set is left alone. Nothing is printed and nothing is
# written anywhere.
#
# Who can see the keys afterwards: the process that sourced this file and everything it starts
# (OpenCode, and the tool servers OpenCode starts). On macOS a process's environment can be
# read by other programs running as the same user and by root, not by other users.
#
# @project opencode-browser-control
# @usage source bin/keychain-env.zsh        (zsh; does nothing where there is no `security` command)
# @env OCBC_KEYCHAIN_SERVICE  Keychain service name to look under (default: opencode)
# @env OCBC_KEYCHAIN_VARS     space-separated variable names to look for (default: the list below)
# @author Claude (Anthropic), written for and prompted by William Munnich
# @date Last edited 2026-11-14

# ocbc_keychain_env: exports each listed variable that is not set yet and has a Keychain item.
# A function so that its helper variables stay local to it and do not leak into the caller.
ocbc_keychain_env() {
  command -v security >/dev/null 2>&1 || return 0   # not macOS: nothing to do
  local service="${OCBC_KEYCHAIN_SERVICE:-opencode}" name value
  local -a names
  # Names OpenCode's built-in providers read. Only these are looked up, so other items you keep
  # under the same service (for example an account-management key) never reach a model process.
  names=(${=OCBC_KEYCHAIN_VARS:-ANTHROPIC_API_KEY CEREBRAS_API_KEY DEEPINFRA_API_KEY DEEPSEEK_API_KEY FIREWORKS_API_KEY GEMINI_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GROQ_API_KEY MISTRAL_API_KEY MOONSHOT_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY PERPLEXITY_API_KEY TOGETHER_API_KEY XAI_API_KEY})
  for name in $names; do
    [[ -n "${(P)name:-}" ]] && continue                                   # already set: keep it
    value="$(security find-generic-password -s "$service" -a "$name" -w 2>/dev/null)" || continue
    [[ -n "$value" ]] && export "$name=$value"
  done
  # OpenCode's Google provider reads GOOGLE_GENERATIVE_AI_API_KEY; many people store the same
  # key as GEMINI_API_KEY only.
  if [[ -z "${GOOGLE_GENERATIVE_AI_API_KEY:-}" && -n "${GEMINI_API_KEY:-}" ]]; then
    export GOOGLE_GENERATIVE_AI_API_KEY="$GEMINI_API_KEY"
  fi
  return 0
}
ocbc_keychain_env
unfunction ocbc_keychain_env
