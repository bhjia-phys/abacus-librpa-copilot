#!/usr/bin/env python3
"""
Pack only the plot-relevant files of a run, following the actual sub-layouts.

The run roots differ (producer/work/..., consumer-one-update-r1/run/..., qsgw/...), so
this walks the whole run for the few file types a band/QSGW plot needs rather than
assuming one fixed tree.

Run ON the remote host. Prints the archive path on stdout.

Usage: python3 pack-plot-anyrun.py <run-dir> <out.tar.gz> [--with-eigenvalues]
"""
import fnmatch
import os
import sys
import tarfile

# Files a plot or the panel genuinely reads.
KEEP_EXACT = {
    "INPUT", "STRU", "KPT", "librpa.in", "librpa.out", "librpa.err", "librpa.exitcode",
    "qsgw_iterations.dat", "band.txt", "bands1.txt", "bands2.txt",
    "energy_qp", "dielecfunc_out", "INPUT.info", "KPT.info",
    "running_scf.log", "running_nscf.log", "running_relax.log", "warning.log",
    "STRU.cif", "README.md",
}
KEEP_GLOB = (
    "QSGW_band_spin_*.dat", "KS_band_spin_*.dat", "EXX_band_spin_*.dat",
    "*_bands_*.contract", "qsgw_input*.contract",
)
# Opt-in only: a 20 MB long table that no plot reads.
OPTIONAL_EXACT = {"qsgw_eigenvalues.dat"}

# Never descend into these. The last few matter for real runs: a run directory often
# contains an extracted copy of the LibRPA source tree, whose `regression_tests/refs/`
# holds dozens of unrelated `librpa.out` files that would otherwise be packed as if they
# were this run's own output.
SKIP_DIRS = {
    ".git", "__pycache__", "build", "source", "bin", "CMakeFiles", ".cache",
    "thirdparty", "node_modules",
    "regression_tests", "refs", "testcases", "workspace", "workspace-vxc-check",
    "source-extraction-attempt1", "source-extraction-attempt2", "Source", ".mamba",
}
MAX_DEPTH = 8

# A run's own outputs sit within a few levels of the run root (e.g.
# `consumer-one-update-r1/run/librpa.d/`). Deeper matches are vendored copies inside an
# extracted source tree, not this run's output — but the bound must be loose enough for the
# deepest legitimate layout seen in practice.
MAX_OUTPUT_DEPTH = 7


def main() -> int:
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    run = os.path.expanduser(argv[0])
    out = argv[1]
    with_eig = "--with-eigenvalues" in sys.argv
    if not os.path.isdir(run):
        print(f"not a directory: {run}", file=sys.stderr)
        return 1

    root_name = os.path.basename(run.rstrip("/"))
    count = 0
    total = 0

    def wanted(name: str) -> bool:
        if name in KEEP_EXACT:
            return True
        if with_eig and name in OPTIONAL_EXACT:
            return True
        return any(fnmatch.fnmatch(name, pat) for pat in KEEP_GLOB)

    with tarfile.open(out, "w:gz") as tar:
        base_depth = run.rstrip("/").count(os.sep)
        for root, dirs, files in os.walk(run):
            depth = root.count(os.sep) - base_depth
            if depth >= MAX_DEPTH:
                dirs[:] = []
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            # Only take band/log inputs from shallow directories; a deep match is a
            # vendored copy, not this run's output.
            if depth > MAX_OUTPUT_DEPTH:
                continue
            for name in files:
                if not wanted(name):
                    continue
                path = os.path.join(root, name)
                # Dereference symlinks: real runs link inputs across stages
                # (`run/librpa.in -> ../librpa.in`), and a link is useless in the archive
                # because the target lives outside it.
                real = path
                try:
                    if os.path.islink(path):
                        real = os.path.realpath(path)
                        if not os.path.isfile(real):
                            print(f"skip dangling link {path} -> {os.readlink(path)}",
                                  file=sys.stderr)
                            continue
                except OSError:
                    continue
                arc = os.path.join(root_name, os.path.relpath(path, run))
                try:
                    size = os.path.getsize(real)
                    info = tar.gettarinfo(real, arcname=arc)
                    info.name = arc
                    info.mode = 0o644
                    with open(real, "rb") as handle:
                        tar.addfile(info, handle)
                    count += 1
                    total += size
                except OSError as exc:
                    print(f"skip {path}: {exc}", file=sys.stderr)

    print(f"packed {count} files, {total / 1024 / 1024:.1f} MiB raw "
          f"-> {os.path.getsize(out) / 1024 / 1024:.1f} MiB gz", file=sys.stderr)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
