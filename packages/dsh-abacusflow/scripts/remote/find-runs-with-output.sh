#!/bin/bash
# Report which Bi2Se3 (or any prefix) runs actually produced plottable output.
# Usage: bash find-runs-with-output.sh <prefix>
set -u
PREFIX="${1:-bi2se3}"
for d in ~/ai-runs/"${PREFIX}"*; do
  [ -d "$d" ] || continue
  hits=$(find "$d" -maxdepth 6 \
    \( -name 'qsgw_iterations.dat' -o -name 'band.txt' -o -name 'bands1.txt' \) \
    -print 2>/dev/null | head -4)
  if [ -n "$hits" ]; then
    echo "=== $(basename "$d")"
    echo "$hits" | sed "s|$HOME/ai-runs/||"
  fi
done
