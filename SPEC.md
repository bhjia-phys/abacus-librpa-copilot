# dsh-abacusflow — verified I/O contract (source-of-truth for implementers)

All facts below were read out of the two live WSL checkouts on 2026-11-01. Cite them; do
not invent formats.

- ABACUS: `\\wsl$\<distro>\home\<user>\physics\repo\.slim\worktrees\abacus-master-ghj-20260724`
  (branch `integrate/librpa-pyatb-master-ghj-20260724`, ABACUS v3.9.0.25,
  commit `dd4216653`).
- LibRPA: `\\wsl$\<distro>\home\<user>\physics\repo\LibRPA`
  (branch `feature/spin-space-symmetry-20260726`).
- Real run to use as a **fixture**:
  `\\wsl$\<distro>\home\<user>\physics\repo\runs\h2-pr-master-ghj-20260724\serial`
  (ABACUS SCF) and
  `\\wsl$\<distro>\home\<user>\physics\repo\runs\librpa-qsgw-si-k333-1027891-20260724\testcases\qsgw_aims_Si_k333_headonly_libri`
  (LibRPA QSGW).

`wsl.exe` is broken on this machine (WslService access denied). Read WSL files through the
UNC path `\\wsl$\Ubuntu2204\...` from PowerShell / node. That UNC path is **not** a
stable user-facing contract — the plugin must work on plain Windows and Linux paths too.

---

## 0. Corrections from the ABACUS v3.9.0.25 source audit (authoritative)

A source-level audit (`ABACUS v3.9.0.25`, `source/source_main/version.h:2`) found that
the formats in §1 below — which were read off *one real run* — are a subset of what the
code can emit, and that the checked-in `examples/*/reference/*.log.ref` files were
produced by **v3.4.2** and contain line formats that **no longer exist** in v3.9.
Grep returns zero hits for `charge density convergence is achieved`; the
`final etot is … eV` and `EFERMI = … eV` printers are commented out
(`output_log.cpp:21,59`). Anything built from those `.ref` files matches nothing.

The full audit is at `F:\AI_Workspace\abacus_io_inventory.md`. **Where §1 and this
section disagree, this section wins.**

### 0.1 STRU coordinate flag — eight literals, not two

`validate_coordinate_system` (`read_atoms_helper.cpp:24-49`):

```
Direct   Cartesian   Cartesian_angstrom   Cartesian_au
Cartesian_angstrom_center_xy   _center_xz   _center_yz   _center_xyz
```

| flag | unit of the numbers on the line |
|---|---|
| `Direct` | fractional, used as written |
| `Cartesian` | units of `lat0` (= `LATTICE_CONSTANT`) |
| `Cartesian_angstrom` | Ångström |
| `Cartesian_au` | Bohr |
| `Cartesian_angstrom_center_*` | Ångström, origin shifted to the cell centre |

Anything else prints `Cartesian or Direct?` and aborts the run. Keep the flag verbatim in
`coordinateMode` and add a normalised `coordinateSystem` plus `originCentered`.

### 0.2 STRU per-species header

`read_atoms.cpp:59`, `read_atoms_helper.cpp:498-510`:

```
<label>       # must equal the ATOMIC_SPECIES label, in the same order
<start_mag>   # element-level starting magnetisation, μB
<natom>       # count for THIS species
<natom coordinate lines>
```

### 0.3 STRU coordinate-line trailing grammar

`parse_atom_properties` (`read_atoms_helper.cpp:349-486`). After `x y z`:

| token | meaning |
|---|---|
| bare `0`/`1` digits (3 ints) | mbl move flags — the common case |
| `m <3 ints>` | explicit move flags |
| `v` / `vel` / `velocity <3 reals>` | initial velocity |
| `mag` / `magmom` | scalar magnetisation, or `mx my mz` when 3 numbers follow |
| `angle1 <deg>` `angle2 <deg>` | polar / azimuth in degrees |
| `lambda <λ> [λy λz]` | spin-constraint λ (ABACUS divides by `Ry_to_eV`) |
| `sc <m> [my mz]` | spin-constraint target |

`fixed_atoms` in INPUT forces all mbl to 0 — report the file, do not apply it.

### 0.4 LATTICE_VECTORS is optional

If INPUT sets `latname` to anything but `user_defined_lattice`, `LATTICE_VECTORS` is
**forbidden** and the cell comes from `latname` + optional `LATTICE_PARAMETERS`
(`latname` ∈ `sc, fcc, bcc, hexagonal, trigonal, st, bct, so, baco, fco, bco, sm, bacm,
triclinic`). A STRU-only parser must return `latticeVectors: null` plus a warning and let
the scene degrade to a unit cube — never throw.

### 0.5 KPT — the real grammar has a mode keyword

`klist.cpp:280-404`. Header may be `K_POINTS`, `KPOINTS` or `K`.

```
K_POINTS
<nkstot>
```
- `nkstot == 0` → next line is `Gamma` (k_type 0) or `Monkhorst-Pack` / `MP` / `mp`
  (k_type 1); then `<nk1> <nk2> <nk3> [s1 s2 s3]`.
- `nkstot > 0` → next line is a mode keyword:
  - `Cartesian` / `C` → `nkstot` lines of `<kx> <ky> <kz> <weight>`
  - `Direct` / `D` → same
  - `Line_Cartesian`, `Line_Direct`, `L`, `Line` → segment pairs expanded by
    `interpolate_k_between`; keep the raw segments, do not interpolate.

Hard cap `nkstot > 100000` aborts. `gamma_only` and `kspacing > 0` **rewrite `KPT` on
disk** (`klist.cpp:218-253`), so KPT is not a static input.

### 0.6 Log file name is not fixed

`read_set_globalv.cpp:142-149` builds `running_<calculation>.log`: `running_scf.log`,
`running_nscf.log`, `running_relax.log`, `running_cell-relax.log`, `running_md.log`,
`running_tddft.log`. With `out_alllog=1` a `_<rank+1>` suffix is appended.

### 0.7 Force table — `#TOTAL-FORCE (eV/Angstrom)#`

`print_force` (`output_log.cpp:216-272`):

```
 #TOTAL-FORCE (eV/Angstrom)#
      Atoms            Force_x             Force_y             Force_z
   Fe1               0.0000000000        0.0000000000        0.0000000000
```

Lead space, `#`-wrapped title, a column-header line to skip, and the row label is
`<element><index>` (`Fe1`, `Si2`) with `%8s` + 3 × `%20.10f`. Variant:
`   TOTAL-FORCE (Ry/Bohr)` (PW, `forces.cpp:261`) — 1 Ry/Bohr = 25.71104309 eV/Å.
Values below 1e-8 are zeroed by ABACUS.

### 0.8 Stress — `#TOTAL-STRESS (kbar)#`

```
 #TOTAL-STRESS (kbar)#
          Stress_x            Stress_y            Stress_z
      -12.3456789012   ...
 #TOTAL-PRESSURE# (EXCLUDE KINETIC PART OF IONS): <pressure> kbar
```

Row labels are literally `Stress_x`/`Stress_y`/`Stress_z`. The title carries the unit
(`kbar` or `a.u.`).

### 0.9 Fermi / gap rows and their spin variants

`elecstate_print.cpp:319-334`: `E_Fermi`, `E_Fermi_up`, `E_Fermi_dw`, `E_gap(k)`,
`E_gap_up(k)`, `E_gap_dw(k)`, each `<Ry> <eV>`. `two_fermi` becomes true when
`nupdown != 0`. There is no standalone `EFERMI = … eV` line in v3.9.

### 0.10 Timing table title is `TIME STATISTICS`

`timer.cpp:317-328`:

```
TIME STATISTICS
 CLASS_NAME  NAME       TIME/s   CALLS  AVG/s  PER/%
```

Both name columns are `%-10s`, so they may contain spaces — take the trailing four
numeric fields. Total time appears as `Total  Time  :` in the log and `TOTAL  Time  :` on
stdout; accept either.

### 0.11 Verdicts and error signatures

```
 #SCF IS CONVERGED#                 output_log.cpp:20
 #TOTAL ENERGY# <E> eV              output_log.cpp:22
 !!SCF IS NOT CONVERGED!!           output_log.cpp:26
 Relaxation is converged!           relax_sync.cpp:276
 Relaxation is not converged yet!   relax_sync.cpp:280
 Ion relaxation is not converged yet (threshold is <x>)      ions_move_basic.cpp:180
 Geometry relaxation is converged!  lattice_change_basic.cpp:292,310
 !!EXX IS NOT CONVERGED!!           exx_helper.cpp:148-149
```

`WARNING_QUIT` prints a 57-dash banner with a centred `!NOTICE!` to both stdout and the
running log, then `CHECK IN FILE : …/warning.log`, then `MPI_Finalize()` + `exit()`
(`tool_quit.cpp:96,123`). **There is no `MPI_Abort` path in v3.9.** A `!NOTICE!` is the
in-band fatal signal; the message itself is on the following lines.

### 0.12 Documentation-vs-code traps (trust the code)

| documented | actually written | source |
|---|---|---|
| `OUT.ABACUS/eig.txt` | `band.txt` (nspin 1) / `bands1.txt`+`bands2.txt` (nspin 2) | `write_bands.cpp:25-36` |
| `OUT.ABACUS/pots1.cube` | `pot.cube` | `ctrl_output_fp.cpp:115-127` |
| `OUT.ABACUS/wfs1k1_nao.txt` | `wfk1s1_nao.txt` (k before s) | `filename.cpp:124-126` |

Also: four `examples/` directories store inputs as `INPUT1`/`INPUT2`/`INPUT3` with
`KPT1`/`KPT2`; every `tests/` fixture uses the plain names. A scanner that only matches
`INPUT` silently misses those.

### 0.13 `abacus.json` / `time.json` are optional fast paths

Both are gated on `ENABLE_RAPIDJSON`, **off by default** (`CMakeLists.txt:51`), and both
land in the working directory — **not** in `OUT.<suffix>/`. Never require them.

---

## 0b. Corrections from the LibRPA source audit (authoritative)

Source-level audit of `LibRPA` @ `feature/spin-space-symmetry-20260726`
(`7f98620137cc07fd4ca741f788ac53c3a8a596a7`), report at
`F:\AI_Workspace\librpa_format_inventory.md`. Where §2 disagrees with this, this wins.

### 0b.1 It is a flat `key = value` file, not YAML/JSON

Parser: `driver/input_parser.cpp` (separator `=`, comment identifiers `[#!]`,
case-insensitive, **last duplicate wins**). There is no YAML/JSON/protobuf/HDF5/npz
anywhere in `src/`, `driver/`, `include/`. Booleans accept `true|t|.t.` and
`false|f|.f.` (`input_parser.cpp:100-105`) — the Fortran spellings are real and must be
accepted.

### 0b.2 There is no `librpa_main` and no CLI flags

The one executable is `chi0_main.exe` (CMake `LIBRPA_DRIVER_NAME`, `CMakeLists.txt:18`),
built from `driver/main.cpp:138`. `argc/argv` go only to `MPI_Init_thread`; there is no
`--version`, no `--help`, no subcommands. Everything is driven by `librpa.in` in the
working directory.

### 0b.3 Implemented `task` values

`rpa`, `g0w0` (+ deprecated alias `g0w0_band`), `exx`, `exx_band`, `qsgw`, `qsgw_band`,
`print_minimax` (`driver/task.cpp:67-76`). `wc_rf`, `qsgwa`, `hf_band`, `scrpa`,
`scrpa_band`, `test` are recognised names that **throw** "requested task not implemented"
(`driver/task.cpp:78-86`) — their source files are dead code, so the panel must not
expect their outputs.

### 0b.4 Outputs are split between two directories

This is the trap that breaks naive viewers:

| written to the **working directory** | written to **`output_dir`** (default `librpa.d/`) |
|---|---|
| `energy_qp` (`task_helper.cpp:17`) | `qsgw_iterations.dat`, `qsgw_eigenvalues.dat`, `qsgw_matrices.dat` (`qsgw.cpp:847-851`) |
| `KS_band_spin_<n>.dat`, `EXX_band_spin_<n>.dat`, `GW_band_spin_<n>.dat` (`g0w0.cpp:1000-1006`) | `self_energy_omega*.dat`, `Sigc*`, `Wc_*`, `chi0*`, `eps*`, `spectral_function_*` |
| `librpa_para_nprocs_<N>_myid_<id>.out` (`global_io.cpp:48`) | `{KS,EXX,QSGW}_band_spin_<s>_<iter>.dat` for `qsgw_band` (`qsgw.cpp:1185-1196`) |

So `qsgw_band` writes its band files into `output_dir` while `g0w0` writes them into the
CWD. `task-bundle.js` reads both places and records which is which.

### 0b.5 `energy_qp` is in Hartree, and has a two-spin variant

`driver/tasks/task_helper.cpp:14-58`:

```
  state     occ_num        e_gs(Ha)        e_qp(Ha)
---------------------------------------------------------------------------------------------------
  K_point    1 :           0.0000          0.0000          0.0000
---------------------------------------------------------------------------------------------------
       1    2.0000   -1.8788617373E+01   -2.0337919716E+01
```

With `n_spins == 2` a `Spin Up` / `Spin Down` label line precedes each block. Units are
**Hartree** here, unlike the `*_band_spin_*.dat` files which are in eV.

### 0b.6 The real timing table header

`Entry  #calls  CPU time (s)  Wall time (s)` (`src/utils/profiler.cpp:282-284`), rows
indented by two spaces per hierarchy level and optionally prefixed by `|`. The QSGW
progress lines in the same log are
`QSGW iteration N: max_delta= ... eV gap= ... eV mixer= ...` and
`QSGW reached qsgw_max_iter=<n> without convergence` (`driver/tasks/qsgw.cpp:1235-1251`).

### 0b.7 Discovery is by prefix only

`src/io/fs.cpp:131-161` sorts files matching a prefix, ignoring the suffix. A scanner
must **ignore `._*` AppleDouble files**: the shipped `.tar.gz` fixtures contain
`._Cs_data_0.txt`, which sorts *before* `Cs_data_0.txt`.

### 0b.8 Version identity is the build banner

No version flag exists and no version string is written to any output; `src/version.h`
says `0.6.0` but is never printed. The only identity is the
`LibRPA CMake build info:` block with `Source code Git hash` / `Build type` /
`GreenX commit hash` / `Use LibRI` (`src/utils/utils_cmake.cpp:20-40`). Those two git
lines can be **blank** when LibRPA was not the top-level CMake project, so the panel must
treat them as optional.

### 0b.9 Inert options — do not surface them as meaningful

`output_abacus_gw_gf` and `n_bands_sigc` are parsed, defaulted and echoed but never
consumed. `output_hamgnn`'s only consumer is in a file that is not compiled.

### 0b.10 Error signature

`Error on MPI rank <n>: <what>` then `Error: libRPA failed`
(`driver/main.cpp:92-99,133`); success is the single line `libRPA finished successfully`
(`driver/main.cpp:129`). At `output_level = critical` or `silent` the success banner is
suppressed, so absence of the terminator does not by itself prove failure.

---

## 1. ABACUS task recognition

An **ABACUS task directory** is a directory that contains all three of `INPUT`, `STRU`,
`KPT`. (`INPUT` is mandatory and is the strongest single signal; `STRU` is nearly
mandatory; `KPT` is optional when `kspacing` is set in `INPUT` — see §1.3.)
Outputs land in `OUT.<suffix>/` where `<suffix>` defaults to `ABACUS`.

Severity ladder for the scanner:

| condition | code |
|---|---|
| `INPUT` present + `STRU` present | `TASK` |
| `INPUT` present, `STRU` missing | `TASK_INCOMPLETE` |
| only `STRU`+`KPT` (no `INPUT`) | `NOT_A_TASK` (report as plain directory) |

### 1.1 INPUT

`INPUT` is a flat keyword file. First non-comment line is literally `INPUT_PARAMETERS`.
Every later line is `keyword value [value ...]`; `#` and `!` start a comment; the value may
be missing (flag keywords such as `gamma_only`). Units are documented per keyword; energy
defaults to Ry in most legacy keywords, but `ecutwfc` is in Ry too.

Parsing rule used by the plugin: strip `#`/`!` comments, split on whitespace, keyword is
field 0, values are fields 1..n, keyword comparison is case-insensitive (ABACUS accepts
`BASIS_TYPE` and `basis_type`).

Keyword families actually defined in
`source/source_io/module_parameter/read_input_item_*.cpp` (grep `Input_Item item("...")`):

- **system**: `suffix`, `ntype`, `calculation`, `ecutwfc`, `scf_thr`, `scf_nmax`,
  `basis_type`, `kspacing`, `pseudo_dir`, `orbital_dir`, `dft_functional`, `nspin`,
  `symmetry`, `device`, `ks_solver`, `init_chg`, `init_wfc`, `chg_extrap`, `precision`,
  `out_level`, `out_chg`, `out_dos`, `out_band`, `out_proj_band`, `out_stru`,
  `out_mat_hs`, `out_mat_hs2`, `out_mat_xc`, `out_mat_dh`, `out_mat_t`, `out_wfc_lcao`,
  `out_elf`, `out_mul`, `out_pot`, `out_app_flag`, `calculation`.
- **elec_stru**: `ecutrho`, `nbands`, `nbnd`, `smearing_method`, `smearing_sigma`,
  `mixing_type`, `mixing_beta`, `mixing_ndim`, `mixing_gg0`, `nupdown`, `nelec`,
  `ocp`, `ocp_set`, `nspin`, `lspinorb`, `noncolin`, `dft_plus_u`, `orbital_corr`,
  `hubbard_u`, `hubbard_alpha`, `exx_hybrid_alpha`, `exx_hybrid_step`,
  `exx_ccp_rmesh_times`, `exx_separate_loop`, `exx_mpi_processor`, `vdw_method`,
  `vdw_s6`, `vdw_s8`, `vdw_a1`, `vdw_a2`, `vdw_d`, `vdw_abc`, `berry_phase`.
- **relax**: `relax_method`, `relax_nmax`, `force_thr`, `force_thr_ev`, `stress_thr`,
  `press_thr`, `relax_new`, `relax_bfgs_w1`, `relax_bfgs_w2`, `relax_bfgs_rmax`,
  `relax_bfgs_rmin`, `relax_bfgs_init`, `relax_cg_thr`, `fixed_axes`, `cell_factor`.
- **md**: `md_type`, `md_nstep`, `md_dt`, `md_tfirst`, `md_tlast`, `md_nraise`,
  `md_thermostat`.
- **tddft**: `tddft`, `td_dt`, `td_stype`, `td_ttype`, `td_nstep`, `out_dipole`.
- **output**: the `out_*` family above plus `out_interval`, `out_freq_ion`,
  `out_freq_elec`, `out_bandgap`, `out_zmatrix`, `out_current`, `out_vecpot`.

The plugin does **not** need to validate every keyword. It needs: the value of the
keywords in `lib/host/abacus/input-params.js` `KEYWORDS`, and it must preserve every
other `keyword -> string` pair verbatim for display.

### 1.2 STRU

Block-structured text. Block headers (case-insensitive, order as listed):

```
ATOMIC_SPECIES
 <label> <mass> <pp_file> [<extra...>]

NUMERICAL_ORBITAL          # only for basis_type=lcao
 <orb_file_1>
 ...

LATTICE_CONSTANT
 <a0>                        # Bohr by default; a trailing "angstrom" on the line switches units

LATTICE_VECTORS
 <ax> <ay> <az>
 <bx> <by> <bz>
 <cx> <cy> <cz>

ATOMIC_POSITIONS
 <Direct | Cartesian>        # unit of Cartesian is LATTICE_CONSTANT
 <label>
 <magnetism>
 <natom_of_this_label>
 <x> <y> <z> [<move_x> <move_y> <move_z>] [<mag_x> <mag_y> <mag_z>]
 ...
 (repeat label/magnetism/natom/atoms for each species)
```

Cartesian coordinates are in units of `LATTICE_CONSTANT` (so multiply by `a0`). `Direct`
coordinates are fractional. The `move_*` triple is `0`/`1` (fixed/free). A trailing
magnetic-moment triple may appear for `nspin>=2` or noncollinear. Reference:
`source/source_cell/read_stru.cpp` (or the `ReadStru` unit under `source/source_cell`).

The structure parser must therefore produce: `latticeConstant` (+ unit), `latticeVectors`,
`species[{label,mass,pp,orbitals}]`, `atoms[{label,x,y,z,cartesian:boolean, move?, mag?}]`.

### 1.3 KPT

```
K_POINTS
0                 # 0 = automatic mesh (Monkhorst-Pack/Gamma-centred), 1 = explicit list
Gamma             # or MP
<nk1> <nk2> <nk3> <s1> <s2> <s3>     # nk* > 0; s*=0/1 for half-shift
```
and for mode 1:
```
K_POINTS
1
<nkpts>
<kx> <ky> <kz> <weight>
...
```
`kspacing` in `INPUT` overrides the KPT mesh when > 0.

### 1.4 Output directory and log files

`OUT.<suffix>/` (`suffix` from `INPUT`, default `ABACUS`). Inside:

| file | meaning |
|---|---|
| `running_scf.log` | main log for `calculation=scf/nscf`; also `running_relax.log`, `running_md.log`, `running_cell-relax.log`, `running_tddft.log`. With `out_alllog=1` there is `running_<type>_<rank>.log` per MPI rank |
| `running_<type>.log` (name built in `read_set_globalv.cpp:144-148` as `"running_" + cal_type + ".log"`, or with `_<myrank+1>` suffix when `out_alllog`) | verbatim |
| `warning.log` | warnings, `AUTO_SET NBANDS`, charge-normalisation messages |
| `INPUT.info` | the fully resolved INPUT (every keyword with its final value) — **excellent machine-readable source for effective parameters** |
| `KPT.info` | resolved k-mesh |
| `STRU.cif` | the structure as CIF |
| `eig_occ.txt` | eigenvalues + occupations per spin/k-point/band |
| `band_out`, `istate.info`, `HR`/`SR` csr files, `*.cube`, `SPIN1_CHG`, `*.dat` | optional, keyword-gated |
| `abacus.json` (written to the *task* dir, not `OUT.*`) | structured summary; see §1.6 |

`abacus.json` in the real run sits beside `INPUT`/`STRU`/`KPT`, not inside `OUT.*`.

### 1.5 Log line grammar (exact, from the real log)

Per-SCF-iteration block, repeated for every electronic step of every ionic step:

```
 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 --> #ION MOVE#         1  #ELEC ITER#         3
 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 Electron density deviation 0.091088
 ----------------------------------------------------------
      Energy           Rydberg                 eV
 ----------------------------------------------------------
  E_KohnSham     -2.3189359026        -31.5507415719
  E_Harris       -2.0406348320        -27.7642612522
  E_Fermi        -0.2998687478        -4.0799236221
  E_gap(k)       1.2362915078         16.8206088956
 ----------------------------------------------------------
```

- `#ION MOVE#\s+(\d+)\s+#ELEC ITER#\s+(\d+)` → (ionicStep, scfIter), 1-based.
- `Electron density deviation\s+([-\d.Ee+]+)` → the SCF residual Δρ.
- `E_KohnSham\s+([-\d.]+)\s+([-\d.]+)` → (Ry, eV).
- `E_Harris`, `E_Fermi`, `E_gap(k)` have the same two-column shape.
- The ionic index restarts at 1 for `scf` (single ionic step) and increments for relax/md.

Terminators (from `source/source_io/module_output/output_log.cpp:16-29`):

| message | meaning |
|---|---|
| ` #SCF IS CONVERGED#` | electronic loop converged |
| ` #TOTAL ENERGY# <E> eV` | final energy of that ionic step (printed only on convergence) |
| ` !!SCF IS NOT CONVERGED!!` | electronic loop failed |
| ` Relaxation is converged, but the SCF is unconverged!` | ionic ok, electronic not — results unreliable |
| ` Total  Time  : <h> h <m> mins <s> secs ` | last line of a completed run (`print_info.cpp:188-196`) |
| ` SETUP UNITCELL` / ` Setup Unitcell` banners, ` RELAX STEP: N`, ` STEP OF MOLECULAR DYNAMICS: N` | step markers (`print_info.cpp:351-387`) |

Forces: `print_force(..., "TOTAL-FORCE (eV/Angstrom)", ..., false)` →
`source/source_lcao/FORCE_STRESS.cpp:654`, `source/source_esolver/esolver_nep.cpp:144`.
The table is `TOTAL-FORCE (eV/Angstrom)` followed by atom rows
`<label> <x> <y> <z> <fx> <fy> <fz>` and a `total drift` line.

Stresses: `print_stress("TOTAL-STRESS (KBAR)", ...)`.

Timing table: a `CLASS_NAME NAME TIME/s CALLS AVG/s PER/%` block near the end, framed by
dashes. Memory table: `NAME----|MEMORY(MB)----`.

Error/warning signatures worth detecting:

- `!!SCF IS NOT CONVERGED!!`
- `Relaxation is converged, but the SCF is unconverged`
- `forrtl: severe`, `Segmentation fault`, `MPI_ABORT`, `Abort(`, `BAD TERMINATION`
- `STOP`, `NOTICE`, `WARNING`, `Warning:` in `warning.log`
- `charge density convergence is not achieved`
- missing `Total  Time  :` in a non-empty log ⇒ run did not finish (running or killed)

### 1.6 abacus.json

A pretty-printed JSON produced by ABACUS with `init` (element/orb/pp/coordinate/mag/label/
cell/point_group/natom/nband/...), `output` and timing sections; energy in eV, length in
Ångström (stated in its own `comment` field). Treat as optional enrichment: read
`init.coordinate`, `init.cell`, `init.label`, `init.natom` if present.

---

## 2. LibRPA task recognition

A **LibRPA task directory** contains `librpa.in`. Its outputs live in `output_dir` (default
`./`), typically `librpa.d/`, plus the per-rank logs in the task directory.

### 2.1 librpa.in

`key = value` lines, one per line, `#` comments. Verified keys from the real run
(`.../qsgw_aims_Si_k333_headonly_libri/librpa/in`):

```
task = qsgw                    # qsgw | g0w0 | rpa | exx
input_dir = ../dataset
output_dir = ./librpa.d/
restart_from_dir = ../dataset/sigcrf/
output_level = info
constants_choice = aims
version_coul_reader = 1
prefix_coul_full = coulomb_full_iq
prefix_coul_cut = coulomb_cut_iq
nfreq = 6
tfgrid_type = minimax
n_params_anacon = 6
n_params_anacon_resample = -1
anacon_nfreq = -1
replace_w_head = true
option_dielect_func = 4
parallel_routing = libri
vq_threshold = 0
sqrt_coulomb_threshold = 0
use_scalapack_gw_wc = true
use_shrink_abfs / use_shrink_chi / use_pyatb = false
use_fullcoul_exx / use_fullcoul_eps / use_fullcoul_wc = bool
use_symmetry_exx / use_symmetry_gw / use_symmetry_rpa = bool
use_kpara_scf_eigvec = false
output_energy_qp = false
read_sigc_mat_rf = true
qsgw_input_contract = qsgw_input.head-only.contract
qsgw_mixer = none
qsgw_min_iter = 1
qsgw_max_iter = 1
qsgw_band0_cut_mode = 0
qsgw_write_iteration_matrices = true
qsgw_update_hartree = false
```

Parsed by `src/api/options.cpp` (`librpa_set_*` setters) and `driver/` (`driver/main.cpp`
reads the key=value file).

### 2.2 Input dataset handed over by ABACUS

Files inside `input_dir`, named by the `prefix_*` keys (all confirmed present in the real
run's `dataset/`):

| file | shape |
|---|---|
| `stru_out` | lattice + atom positions (Bohr) |
| `bz_sampling_out` | k-points + weights |
| `basis_out` | basis metadata: `natom nbasis naux aims` |
| `basis_wfc_out`, `basis_aux_out`, `basis_aux_shrink_out` | basis shell tables |
| `band_out` | `nspin nkpts nbands nelec?` then `E_Fermi` then per-k blocks |
| `KS_eigenvector_<k>.txt` | real/complex KS coefficients per k |
| `Cs_data_<k>.txt` | RI 3-centre coefficients |
| `coulomb_full_iq_<iq>.dat`, `coulomb_cut_iq_<iq>.dat` | Coulomb matrices per q |
| `xc_matr_spin_<s>_kpt_<k>.csc` | sparse Vxc |
| `mommat_ks_kpt_<k>.dat` | momentum/velocity matrices |
| `dielecfunc_out` | `<omega> <eps_real> <eps_imag>` rows |
| `qsgw_input*.contract` | QSGW input contract descriptor |

### 2.3 Outputs

| file | content |
|---|---|
| `librpa.out` | main log; header block `| Key : value`, `========= Begin driver parameters =========`, progress, then a timing table, and final marker `libRPA finished successfully` |
| `librpa_para_nprocs_<N>_myid_<rank>.out` | per-rank log |
| `librpa.err`, `librpa.exitcode` | stderr and exit code |
| `librpa.d/qsgw_eigenvalues.dat` | header `# key value` comment lines, then `# iter channel spin kpoint kx ky kz band energy_eV`, then data rows, one per band |
| `librpa.d/qsgw_iterations.dat` | header comments, then `# iter max_delta_eV residual_l2_Ha residual_max_Ha efermi_eV gap_eV electron_count requested_mode applied_mode beta fallback rcond coefficient_l1 coefficient_count converged coefficients fallback_reason` |
| `librpa.d/qsgw_matrices.dat` | same header, then large matrix dumps |

**Critical**: `librpa.out` embeds the build provenance (`Source code Git hash`,
`Build type`, `GreenX commit hash`, `Use LibRI`) and the resolved driver parameters —
that is the version identification mechanism.

The last line of a successful run is exactly `libRPA finished successfully`
(real file: `.../librpa/librpa.out`). Failure ⇒ no such line.

---

## 3. Plugin architecture (mirrors VASPFlow, adapted to DSH 0.2.1-rc.5)

VASPFlow's design has three layers. We keep the split, drop everything VASP-specific.

```
Browser (DSH Web GUI)        Host (Node, this plugin)          Agent layer
┌────────────────────┐    ┌──────────────────────────┐   ┌──────────────────────┐
│ sidebar entry      │───▶│ /abacusflow/api/* routes │──▶│ abacusflow preset     │
│ right-dock panel   │◀───│  scanner + parsers       │◀──│ persona + abacus_*    │
│ tree/curves/3D     │    │  task store (in-memory)  │   │ librpa_* tools        │
└────────────────────┘    └──────────────────────────┘   └──────────────────────┘
```

Differences forced by the DSH 0.2 baseline (verified against the installed
`@local/aitp-research-desk` plugin, which runs on this exact DSH):

1. **Client half**: `client.js` is a **pre-bundled plain-JS** file loaded through
   `window.__ModuleLoader__.load({ id, factory(require) {...} })`. It exports
   `{ inject: ['slots'], apply(ctx) {} }`. It may `require('react')` only; **no antd, no
   three.js, no recharts** — the profile's node_modules has none of them and the
   pnpm store must not be touched. Use plain React + CSS strings injected via
   `styles.insert` (or a `<style>` element) + hand-written SVG for charts and a
   hand-written canvas/SVG 3D renderer.
2. **Client slots**: `ctx.slots.inject(name, () => ctx.slots.register({...}, Component))`
   for `sidebar.panellist`, `main`, `sidebar.right.pane.tab`, `tool.call.toolview`.
   Sidebar right-pane tabs additionally need `ctx.get('sidebarRightTabs').register({...})`.
3. **Host half**: `export const inject = ['tools', 'systemPrompt', 'webServer']`,
   `export function apply(ctx, config)`. Register tools with
   `ctx.effect(() => ctx.tools.register(definition))`; register HTTP routes with
   `ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))`.
   Tool `definition` shape: `{ name, description, parameters: JSON-Schema,
   output: { schema, render }, async execute(args, exec) }`.
4. **Config**: `export const Config = z.object({...})` from
   `@deepseek-ai/schemastery` (available in the profile). Keep the schema tiny:
   `defaultScanRoot`, `maxDepth`, `maxTasks`.
5. **Preset**: a DSH 0.2 agent preset is declared in the bundle patch as a
   `@deepseek-ai/dsh-agent-preset` row with `config: { id, name, description,
   order, plugins: [...] }`. Reference implementation: the compat branch of VASPFlow
   (`plugins/dsh-vaspflow/preset/vasp/agent.patch.yml`) and the shipped `preset-standard`
   row. Declaring the preset can be deferred to phase 2; the tools are also usable from
   the standard preset if the row is mounted in the host composition.

### Non-negotiable engineering constraints

- **Zero third-party runtime dependencies.** Only `node:` builtins,
  `@deepseek-ai/schemastery`, and (client) `react`.
- No build step is required for the client: write plain ESM-authored JS in the
  `__ModuleLoader__` wrapper, hand-written (no JSX/tsx compile). Keep it readable.
- Everything must run on Windows paths and Linux paths. Never assume `\\wsl$`.
- Tests: `node --test test/*.test.mjs` using only `node:assert` and `node:test`.
  Fixtures live under `test/fixtures/` as *small hand-written* copies of the real
  formats shown above (do not copy multi-MB real data).
