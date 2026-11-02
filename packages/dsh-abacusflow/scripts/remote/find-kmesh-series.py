#!/usr/bin/env python3
"""
Find remote run directories that hold a k-point convergence series.

A convergence study is a set of runs that differ only in the k mesh. This looks for
directories whose names encode a mesh (`k333`, `k444`, `k666`, `k888`, `k999`) and reports
which of them actually produced QSGW iterations or band files.

Run ON the remote host.
Usage: python3 find-kmesh-series.py <ai-runs-root> [substring]
"""
import os
import re
import sys

MESH = re.compile(r"[_-]k(\d)(\d)(\d)(?![0-9])", re.IGNORECASE)

def main() -> int:
    root = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/ai-runs")
    needle = sys.argv[2].lower() if len(sys.argv) > 2 else "si"

    by_base = {}
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isdir(path):
            continue
        if needle and needle not in name.lower():
            continue
        m = MESH.search(name)
        if not m:
            continue
        mesh = "k" + "".join(m.groups())
        # Group by the name with the mesh removed: that is the "same study" prefix.
        base = MESH.sub("-K-", name)
        by_base.setdefault(base, []).append((mesh, name, path))

    shown = 0
    for base, items in sorted(by_base.items()):
        meshes = sorted({mesh for mesh, _, _ in items})
        if len(meshes) < 2:
            continue
        shown += 1
        print(f"=== study: {base}")
        print(f"    meshes: {', '.join(meshes)}")
        for mesh, name, path in sorted(items):
            has_it = os.path.exists(os.path.join(path, "qsgw", "librpa.d", "qsgw_iterations.dat"))
            # Look a couple of levels down too; layouts differ.
            if not has_it:
                for sub in ("run", "consumer", "consumer-one-update-r1/run"):
                    if os.path.exists(os.path.join(path, sub, "librpa.d", "qsgw_iterations.dat")):
                        has_it = True
                        break
            flag = "qsgw" if has_it else "   -"
            print(f"    [{flag}] {mesh:5} {name}")
        print()

    if shown == 0:
        print("no multi-mesh series found under", root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
