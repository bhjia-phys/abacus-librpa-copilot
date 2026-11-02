#!/bin/bash
# Locate the files a band/QSGW plot actually needs, inside one remote run directory.
# Usage: bash find-plot-files.sh <run-dir>
set -u
RUN="$1"
if [ -z "${RUN:-}" ]; then
  echo "usage: $0 <run-dir>" >&2
  exit 2
fi

echo "=== $RUN"
find "$RUN" -maxdepth 6 \
  \( -name 'band.txt' -o -name 'bands1.txt' -o -name 'bands2.txt' \
     -o -name 'qsgw_iterations.dat' -o -name 'qsgw_eigenvalues.dat' \
     -o -name 'QSGW_band_spin_*.dat' -o -name 'KS_band_spin_*.dat' \
     -o -name 'librpa.out' -o -name 'librpa.in' \
     -o -name 'running_*.log' -o -name 'INPUT' -o -name 'STRU' -o -name 'KPT' \) \
  -printf '%10s  %p\n' 2>/dev/null | sort -k2 | head -60

echo "=== band-file count per name"
find "$RUN" -maxdepth 6 -name '*band_spin_*.dat' 2>/dev/null | wc -l
