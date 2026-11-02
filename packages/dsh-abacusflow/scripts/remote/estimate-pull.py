#!/usr/bin/env python3
"""Report the size of exactly the files a band/QSGW plot needs inside a remote run."""
import os
import subprocess
import sys

RUN = sys.argv[1] if len(sys.argv) > 1 else ""

# Directories whose contents matter for plotting, relative to the run root.
TARGETS = [
    "producer/DZP/01_scf",
    "producer/DZP/02_export",
    "producer/DZP/03_bands",
    "producer/TZDP/01_scf",
    "producer/TZDP/02_export",
    "producer/TZDP/03_bands",
    "qsgw",
]

# Files worth taking. Everything else (csr, wfk, vxck, chg cubes, restart dumps) is
# megabytes of matrix data that no plot touches.
KEEP = {
    "INPUT", "STRU", "KPT", "librpa.in", "librpa.out",
    "qsgw_iterations.dat", "qsgw_eigenvalues.dat",
    "band.txt", "bands1.txt", "bands2.txt",
    "energy_qp", "dielecfunc_out",
}
KEEP_PREFIX = ("QSGW_band_spin_", "KS_band_spin_", "EXX_band_spin_")
KEEP_LOG = ("running_scf.log", "running_nscf.log", "warning.log", "INPUT.info", "KPT.info")

total = 0
rows = []
for rel in TARGETS:
    full = os.path.join(RUN, rel)
    if not os.path.isdir(full):
        continue
    for root, dirs, files in os.walk(full):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name in KEEP or name.startswith(KEEP_PREFIX) or name in KEEP_LOG:
                path = os.path.join(root, name)
                try:
                    size = os.path.getsize(path)
                except OSError:
                    continue
                total += size
                rows.append((size, os.path.relpath(path, RUN)))

rows.sort(key=lambda r: r[1])
for size, rel in rows:
    print(f"{size:>10}  {rel}")
print(f"{'=' * 10}")
print(f"{total:>10}  TOTAL ({total / 1024 / 1024:.1f} MiB, {len(rows)} files)")
