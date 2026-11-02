#!/bin/bash
# Describe a k-point convergence pair: size, plottable files, and the QSGW iteration counts.
# Usage: bash describe-kconv.sh <run-dir> [<run-dir> ...]
set -u
for d in "$@"; do
  echo "=== $(basename "$d")"
  du -sh "$d" 2>/dev/null | awk '{print "    size: "$1}'

  echo "    plottable files:"
  find "$d" -maxdepth 5 \
    \( -name 'qsgw_iterations.dat' -o -name 'qsgw_eigenvalues.dat' \
       -o -name 'band.txt' -o -name 'bands1.txt' -o -name 'bands2.txt' \
       -o -name 'QSGW_band_spin_*.dat' -o -name 'KS_band_spin_*.dat' \
       -o -name 'librpa.out' -o -name 'energy_qp' \) \
    -printf '      %10s  %P\n' 2>/dev/null | sort -k2 | head -20

  it=$(find "$d" -maxdepth 5 -name 'qsgw_iterations.dat' 2>/dev/null | head -1)
  if [ -n "$it" ]; then
    echo "    qsgw iterations: $(($(wc -l < "$it") - 1)) data rows"
    echo "    last row: $(tail -1 "$it" | cut -c1-120)"
  else
    echo "    qsgw iterations: none"
  fi
  echo
done
