#!/usr/bin/env python3
"""
Build a tar of only the files a band/QSGW plot needs, inside one remote run.

Run this ON the remote host. It prints the archive path on stdout.

Why: the run directory is tens of gigabytes of RI coefficients, Coulomb matrices,
wavefunctions and charge densities. None of that is needed to draw bands or a QSGW
convergence curve, and the producer inputs plus the band files are ~30 MiB.

Usage: python3 pack-plot-subset.py <run-dir> <out.tar>
"""
import os
import sys
import tarfile

def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    run = os.path.expanduser(sys.argv[1])
    out = sys.argv[2]
    if not os.path.isdir(run):
        print(f"not a directory: {run}", file=sys.stderr)
        return 1

    targets = [
        "producer/DZP/01_scf",
        "producer/DZP/02_export",
        "producer/DZP/03_bands",
        "producer/TZDP/01_scf",
        "producer/TZDP/02_export",
        "producer/TZDP/03_bands",
        "qsgw",
        "README.md",
    ]

    keep = {
        "INPUT", "STRU", "KPT", "librpa.in", "librpa.out",
        "qsgw_iterations.dat",
        "band.txt", "bands1.txt", "bands2.txt",
        "energy_qp", "dielecfunc_out",
    }
    keep_prefix = ("QSGW_band_spin_", "KS_band_spin_", "EXX_band_spin_")
    keep_log = ("running_scf.log", "running_nscf.log", "warning.log",
                "INPUT.info", "KPT.info")

    # qsgw_eigenvalues.dat is deliberately excluded: it is a 20 MB long table of every
    # band at every k for every iteration. The panel plots band files, not this table;
    # pull it separately when a per-band numeric analysis needs it.

    count = 0
    with tarfile.open(out, "w:gz") as tar:
        for rel in targets:
            full = os.path.join(run, rel)
            if os.path.isfile(full):
                tar.add(full, arcname=os.path.join(os.path.basename(run.rstrip("/")), rel))
                count += 1
                continue
            if not os.path.isdir(full):
                continue
            for root, dirs, files in os.walk(full):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for name in files:
                    if not (name in keep or name.startswith(keep_prefix) or name in keep_log):
                        continue
                    path = os.path.join(root, name)
                    arc = os.path.join(os.path.basename(run.rstrip("/")),
                                       os.path.relpath(path, run))
                    try:
                        tar.add(path, arcname=arc)
                        count += 1
                    except OSError as exc:
                        print(f"skip {path}: {exc}", file=sys.stderr)

    size = os.path.getsize(out)
    print(f"packed {count} files -> {out} ({size / 1024 / 1024:.1f} MiB)", file=sys.stderr)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
