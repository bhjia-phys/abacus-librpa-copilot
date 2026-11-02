#!/bin/bash
# Pack several runs in one connection (each becomes its own tar in $HOME).
# Usage: bash pack-many.sh <run-name> [<run-name> ...]
set -u
for r in "$@"; do
  echo "--- $r"
  python3 ~/pack-plot-anyrun.py "$HOME/ai-runs/$r" "$HOME/$r-plot.tar.gz" 2>&1 | tail -2
done
echo "=== archives:"
ls -la "$HOME"/*-plot.tar.gz 2>/dev/null | awk '{print "  "$5"  "$9}'
