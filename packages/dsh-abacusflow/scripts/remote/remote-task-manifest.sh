#!/bin/bash
# Emit a full task listing in ONE connection, in a format the panel can consume directly.
# Usage: bash remote-task-manifest.sh <run-dir>
set -u
RUN="${1:?usage: $0 <run-dir>}"

printf '#RUN\t%s\n' "$RUN"

# Every directory that could be a task, with the marker files it holds.
find "$RUN" -maxdepth 6 -type d \
  \( -name '.git' -o -name '__pycache__' -o -name 'build' -o -name 'source' \
     -o -name 'CMakeFiles' -o -name 'thirdparty' \) -prune \
  -o -type d -print 2>/dev/null | while IFS= read -r d; do
    rel="${d#$RUN/}"
    [ "$rel" = "$d" ] && rel="."
    markers=""
    for f in INPUT STRU KPT librpa.in; do
      [ -e "$d/$f" ] && markers="$markers $f"
    done
    [ -z "$markers" ] && continue
    outdirs=$(cd "$d" 2>/dev/null && ls -d OUT.* 2>/dev/null | tr '\n' ',' | sed 's/,$//')
    printf 'TASK\t%s\t%s\t%s\n' "$rel" "${markers# }" "${outdirs:-}"
  done
