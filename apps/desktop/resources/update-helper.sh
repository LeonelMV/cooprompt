#!/bin/bash
# Installs a CooPrompt update. CooPrompt starts it detached right before quitting.
# Usage: update-helper.sh <pid> <staged.app> <target.app> <current.app> <confirm-file> <status-file>
#   Waits for <pid> to exit, puts <staged.app> at <target.app> (keeping what was there until the new
#   version creates <confirm-file>) and opens it. When the new version does not confirm in time it
#   is stopped, the previous app is put back and <current.app> is reopened. <target.app> differs
#   from <current.app> when the current folder is not writable; if replacing <target.app> fails,
#   ~/Applications is tried. The first line of <status-file> is the outcome: "updated",
#   "rolled-back: …" or "aborted: …".
# COOPROMPT_SWAP_EXIT_TIMEOUT and COOPROMPT_SWAP_CONFIRM_TIMEOUT (seconds) shorten the waits in tests.
set -u
pid=$1 staged=$2 target=$3 current=$4 confirm=$5 status=$6
exit_timeout=${COOPROMPT_SWAP_EXIT_TIMEOUT:-60}
confirm_timeout=${COOPROMPT_SWAP_CONFIRM_TIMEOUT:-120}
incoming='' previous=''

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
# The outcome is written before reopening anything, so the app that opens can read it.
finish() {
  printf '%s\n' "$1" > "$status"
  log "$1"
  [ -n "${3:-}" ] && { open "$3" || log "could not open $3"; }
  exit "$2"
}
# ps reports resolved paths (/tmp is /private/tmp).
running_from() { ps -axo pid=,comm= | while read -r p c; do case "$c" in "$1"/*) echo "$p" ;; esac; done; }

# Puts the staged app at $1, keeping what was there as .<name>.previous; on failure nothing moves.
place() {
  local dest=$1 dir name moved=1
  dir=$(dirname "$dest")
  name=$(basename "$dest")
  incoming="$dir/.$name.incoming"
  previous="$dir/.$name.previous"
  mkdir -p "$dir" 2>/dev/null || return 1
  rm -rf "$incoming" "$previous" 2>/dev/null
  # A rename on the same volume, a copy otherwise.
  if ! mv "$staged" "$incoming" 2>/dev/null; then
    moved=0
    ditto "$staged" "$incoming" 2>/dev/null || { rm -rf "$incoming"; return 1; }
  fi
  xattr -cr "$incoming" 2>/dev/null
  if { [ -e "$dest" ] && ! mv "$dest" "$previous" 2>/dev/null; } || ! mv "$incoming" "$dest" 2>/dev/null; then
    [ -e "$previous" ] && [ ! -e "$dest" ] && mv "$previous" "$dest"
    if [ "$moved" = 1 ]; then mv "$incoming" "$staged" 2>/dev/null; else rm -rf "$incoming"; fi
    return 1
  fi
  [ "$moved" = 0 ] && rm -rf "$staged"
  return 0
}

rm -f "$status"
for ((i = 0; i < exit_timeout * 10; i++)); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
done
kill -0 "$pid" 2>/dev/null && finish "aborted: CooPrompt did not quit" 1

fallback="$HOME/Applications/$(basename "$target")"
if place "$target"; then
  installed=$target
elif [ "$target" != "$fallback" ] && place "$fallback"; then
  installed=$fallback
else
  finish "aborted: could not write to $(dirname "$target")" 1 "$current"
fi
log "installed $installed"

rm -f "$confirm"
open "$installed" || log "could not open $installed"
for ((i = 0; i < confirm_timeout * 10; i++)); do
  [ -e "$confirm" ] && break
  sleep 0.1
done
if [ -e "$confirm" ]; then
  rm -rf "$previous"
  finish "updated" 0
fi

# `open` only activates a copy that is still running, so the new one has to be gone first.
real="$(cd "$(dirname "$installed")" && pwd -P)/$(basename "$installed")"
pids=$(running_from "$real")
[ -n "$pids" ] && kill $pids 2>/dev/null
for ((i = 0; i < 100; i++)); do
  [ -z "$(running_from "$real")" ] && break
  sleep 0.1
done
pids=$(running_from "$real")
[ -n "$pids" ] && kill -9 $pids 2>/dev/null
rm -rf "$installed"
[ -e "$previous" ] && mv "$previous" "$installed"
finish "rolled-back: the new version did not start" 1 "$current"
