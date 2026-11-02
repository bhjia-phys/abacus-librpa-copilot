# dsh-abacusflow — panel UI architecture

This document is the design of record for the panel in `packages/dsh-abacusflow/lib/client.js`.
It explains *what the panel is organised around*, *how the three kinds of comparison map onto
concrete UI*, and the design foundation (tokens, type, spacing, components) every pane uses.

UI labels are quoted in Chinese exactly as the panel shows them (the plugin contract fixes the
panel language as Chinese); everything else here is English.

---

## 1. What the panel is (and is not)

- **An inspector.** It reads calculation output on disk and draws it. It never writes inputs,
  submits jobs, or deletes anything.
- **The agent is the actor.** Anything that computes (re-running a stage, a convergence study,
  writing `research.md`) happens in the conversation: the panel only *composes a message* for
  the agent. That boundary is stated in the UI wherever a button talks to the agent.
- **Provenance is the product.** Every curve and every number names the code that produced it
  (ABACUS / LibRPA / database), the stage it came from, and — for LibRPA — the iteration.
  Nothing is merged into an anonymous "result".

## 2. The model: run → stages → lineage

A production calculation is a pipeline, not a directory listing:

```
ABACUS SCF           → density
ABACUS NSCF/export   → wave functions, matrices, band path          (producer)
LibRPA G0W0 / QSGW   → self-energy, QP energies, gaps                (consumer)
   ↺ QSGW iterations feed an updated Hamiltonian back
Band structure       → ABACUS KS path  +  LibRPA KS/EXX/QSGW on the same path
```

The panel derives three levels from the scan, without new host data shapes:

| Level | What it is | How it is derived |
|---|---|---|
| **Run** (运行) | One calculation campaign, e.g. `nio-matched-dzp-k666-20261016-r1` | First path segment under the scan root. If the scan root *is* a run (its children are `producer/`, `qsgw/`, `01_scf` …), the whole root is one run. |
| **Stage** (阶段) | One scanned task inside the run | `task.kind`: `abacus` → producer, `librpa` → consumer, `coupled` → both in one directory. Producers are grouped into **branches** by parent directory (`producer/DZP`, `producer/TZDP`) and ordered naturally (`01_scf` → `02_export` → `03_bands`). |
| **Lineage edge** (数据来源) | "this consumer read that producer" | Evidence, strongest first — see below. |

Lineage evidence, and how each kind is drawn:

| Evidence | Example | Drawn as |
|---|---|---|
| `input_dir` in `librpa.in` resolves into a producer branch of the same run (remote cluster paths are mapped by the run directory name) | NiO `qsgw`: `…/nio-matched-dzp-k666-20261016-r1/producer/DZP/librpa/input` → `producer/DZP` | solid arrow, label 「input_dir → producer/DZP」 |
| Same directory (`coupled`) | Si `frozen` | inline arrow inside the stage card, 「同目录」 |
| `input_dir` present but not resolvable locally (not pulled) | Bi2Se3 `consumer-one-update-r1/input` | dashed arrow, label shows the raw path and 「本地无此目录」 |
| No `input_dir`, inferred from layout only | — | dashed arrow, 「按目录布局推断」 |

When band files are loaded, a second, independent check runs: if LibRPA's KS eigenvalues equal
an ABACUS band stage's eigenvalues point for point (NiO: 364 k × 80 bands, max |Δ| = 0.001 eV;
Bi2Se3: 101 k × 220 bands, max |Δ| = 0.001 eV), the overlay says so. That is the strongest
evidence the panel has that the consumer read that producer.

## 3. Navigation

Eight flat tabs (概览 / 能带 / 收敛 / k 收敛 / 数据库 / 结构 / 文件 / LibRPA) mixed three
different things: views of *one task*, a *cross-run study*, and a *reference catalogue*. They are
replaced by four **places**, a two-view **run page**, and per-stage tabs that only appear when
you look at one stage:

```
places:   运行 (runs) · k 收敛研究 (studies) · 对比篮 (basket, with count) · 数据库 (library)

运行 → run page
        header        run name · material · method chips · folder
        pipeline      ABACUS branches ──input_dir──▶ LibRPA consumers   (click a stage)
        结果 (results, default)
            能带对比   ABACUS KS vs LibRPA QSGW, default on; iteration + spin controls
            关键数值   gap ledger, every row with its producer and source file,
                      plus the matched database records (comparison c)
            收敛       ABACUS SCF and LibRPA QSGW side by side; iteration synced with the plot
        阶段 · <stage>  概览 / 输入 / 收敛 / 结构 / 文件   (LibRPA: 概览 / 输入 / QSGW / 文件)
        Agent dock    ask box + 「交给 Agent…」 handoff (pinned, outside the scroller)
```

Why four places: each answers a different question and has a different unit of data —
*what did this run compute* (a run), *does the answer move with the k mesh* (a series of runs),
*how do arbitrary channels compare* (a hand-picked set), *what is published* (the database).
Folding any two together re-creates the old ambiguity.

**Results first.** On open the panel re-opens the run you last looked at; with no memory it
opens the most recently modified run that has output. The run page starts on 结果 with the band
overlay already loading — no tab to pick, no basket to assemble.

**Wide vs narrow.** The panel measures its own width. ≥ 760 px (main page): a run rail on the
left (runs with a pipeline fingerprint; the open run expands into its stages) and the run page
on the right. < 760 px (right-dock tab): one column — a run picker on top, the same run page
below, the agent dock pinned at the bottom.

## 4. The three comparisons

| | Question | Where | Mechanism |
|---|---|---|---|
| **(a) ABACUS vs LibRPA within one run** | What did GW do to the KS bands of *this* run? | 运行 → 结果 → 能带对比 | Default on. The band source pair (ABACUS band stage, LibRPA consumer) is chosen from the lineage and can be switched. QSGW iteration and spin are first-class controls on the plot. |
| **(b) Same material across k meshes** | Does the gap still move when the mesh gets finer? | k 收敛研究 | A *study*, not a task. Auto-detected from run names that differ only by a mesh token (`si-qsgw-k444-…`, `si-qsgw-k666-…`), plus analysis snapshots (`snapshot.json`) or `<material>/k444…` trees. Shows gap vs mesh, gap vs QSGW update per mesh, adjacent-mesh differences (flagged when the two meshes stopped at different iterations), the band overlay across meshes (only when the k paths are identical), and the study's own recorded limitation. Never declares "converged". |
| **(c) This run vs the published database** | Is my number in line with what was published? | 运行 → 结果 → 关键数值 (zero clicks for the top match) and 「数据库对照」 (one click for all matches); 数据库 place for browsing | Auto-matched from the STRU composition (high confidence) or the directory name (medium/low, labelled). The run's own gaps sit next to the record's DFT / EXX / GW gaps, each row with its source. |

The **对比篮** (basket) is the fourth, explicitly *ad hoc* mechanism: hand-pick channels from any
runs (two materials, two variants) into one plot. It is no longer needed for (a).

Alignment rules (all overlays, including the basket):

1. Identical k paths (same point count, cumulative lengths equal within tolerance) → drawn as is.
2. Same point count, different path-length convention (ABACUS and LibRPA measure path length
   differently: up to 4.6 % of the axis apart on NiO) → drawn **by k-point index on the ABACUS
   axis only if** LibRPA's KS eigenvalues reproduce the ABACUS ones (max |Δ| ≤ 0.01 eV). The plot
   says which rule was used.
3. Otherwise → **not overlaid**; the channel is listed with the reason (「k 路径不同（364 vs 201 点）」).
   Nothing is interpolated, resampled or shifted.

The energy-zero note is always shown on mixed plots: 「ABACUS 用绝对 eV，LibRPA 用它自己的内部零点；
曲线形状可比，绝对位置不一定对齐」. Reference lines (E_F) are drawn per producer with their source
(「E_F · ABACUS 03_bands 日志」), and the default energy window is centred on that reference
(± 6 eV) instead of on 0 eV — ABACUS energies are absolute (NiO E_F ≈ 15.4 eV), so a window
centred on 0 cut the conduction bands off.

## 5. State language

One function (`stageState`) derives a stage's display state from the host status and, once the
stage bundle is loaded, the convergence evidence. Every pane uses it, so a stage never shows two
different states. Colour is never the only carrier: each state has its own glyph shape and a
short label.

| State | Glyph | Label | Derived from |
|---|---|---|---|
| ok | filled circle + check | 已收敛 / 已完成 | `FINISHED`; 已收敛 when there is a positive verdict (ABACUS `scf` converged, QSGW `convergedIter`), 已完成 when convergence does not apply (`nscf`, G0W0) |
| unconverged | filled triangle + bar | 未收敛 | `FINISHED_UNCONVERGED`, or a finished QSGW run whose iteration table never converged |
| running | ring with filled half | 运行中 | `RUNNING`; adds 「N 天无更新」 when the log is stale |
| no output | hollow ring | 无输出 | `NO_OUTPUT` and nothing on disk contradicts it |
| error | filled square + × | 出错 | `ERROR` |
| evidence mismatch | dashed ring + dot | 证据不全 | the status says one thing and the files another (e.g. no `librpa.out` but `librpa.d` holds QSGW iterations and band files — NiO `qsgw`) |

## 6. Agent handoff and AITP

AITP exposes agent tools only, so the seam is the conversation:

```
panel (inspect) → composed message → agent → research_* / abacus_* tools → files change → panel rescans
```

- The **Agent dock** (pinned at the bottom) has the quick ask box and 「交给 Agent…」, which opens a
  handoff sheet: pick what you are trying to settle (e.g. 「QSGW 为什么没收敛」, 「补算缺失的阶段」,
  「做 k 收敛研究」, 「与数据库对照」), read and edit the composed message, then send. The message
  carries: run folder, every stage with its state and output directory, key numbers with their
  source files, what is missing or suspicious, and a request to confirm before submitting jobs or
  editing inputs.
- The dock says, every time, that the panel is read-only and the agent does the computing.
- **AITP context is derived, never assumed.** A small read-only host route walks up from the run
  to the nearest `research.md`. If one is found the handoff shows 「最近的 research.md（按目录向上查找）」
  with its path and title, and the message includes it; if not, nothing about AITP is claimed.
  The section is self-contained: without AITP, or without the route, the dock still works.

## 7. Design foundation

### 7.1 Tokens

Every colour goes through DSH's own tokens. Two facts about DSH's theme (read from its theme
package, `@deepseek-ai/dsh-client-ui-theme`) shaped this:

- DSH declares its `--dsw-alias-*` tokens on **`body`**, and switches dark mode with
  **`body[data-ds-dark-theme]`** (its theme service resolves light / dark / system itself).
  The old stylesheet declared its aliases on `:root`, where the body-scoped tokens do not exist
  yet, so in light mode the panel silently used its hard-coded fallbacks. The aliases now live on
  `.af-root`. A `prefers-color-scheme` block was deliberately *not* added: it would fight a user
  who chose "light" on a dark OS.
- DSH's `--dsw-alias-brand-primary` is near-black in light and near-white in dark (a neutral
  brand). The old primary button painted white text on it, which was invisible in dark mode.
  Primary buttons now use `--dsw-alias-button-primary-fill` with
  `--dsw-alias-label-primary-foreground`, as DSH's own buttons do; the accent blue is
  `--dsw-alias-state-business-primary`, the same colour DSH uses for focus rings.

| Panel token | DSH token | Used for |
|---|---|---|
| `--af-bg`, `--af-surface` | `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1` | page, cards |
| `--af-fg`, `--af-fg-2`, `--af-fg-3` | `--dsw-alias-label-primary / -secondary / -tertiary` | text, secondary text, captions and axis text |
| `--af-line-soft`, `--af-line`, `--af-line-strong` | `--dsw-alias-border-l1 / -l2 / -l3` | hairlines, node borders, axes |
| `--af-hover`, `--af-pressed` | `--dsw-alias-interactive-bg-hover / -active` | hover and press fills |
| `--af-accent` | `--dsw-alias-state-business-primary` | selection, focus, LibRPA, QSGW curves |
| `--af-primary`, `--af-on-primary` | `--dsw-alias-button-primary-fill`, `--dsw-alias-label-primary-foreground` | primary buttons |
| `--af-ok`, `--af-warn`, `--af-warn-text`, `--af-err` | `--dsw-alias-state-success-primary`, `-warn-primary`, `-warn-label`, `-error-primary` | state glyphs |
| `--af-font`, `--af-mono` | `--dsw-font-family`, `--ds-font-family-code` | follows the user's DSH font settings |
| `--af-r2`, `--af-r3` | `--dsw-radius-sm` (8), `--dsw-radius-md` (12) | nodes and notes, pipeline band and plots |

Derived tokens are `color-mix()` of the above, so they follow the theme without new colours:
`--af-fill` / `--af-fill-2` (text colour at 4 % / 8 %, the quiet surfaces), the `*-soft` state
fills, `--af-db` (accent mixed with success: the database's blue-green), `--af-c-exx` (accent
mixed with error), `--af-c-ks` (accent mixed with background). Fallback values in `var(…, x)`
only matter outside DSH and mirror DSH's own light and dark values.

### 7.2 Type scale

| Role | Value | Where |
|---|---|---|
| title | 600 16/24 | run name, place title |
| section | 600 13/20 | section headings, node names |
| body | 400 13/20 | default |
| caption | 400 12/18 | meta, notes, table cells, badges |
| micro | 500 11/14 | lane heads, table headers, tags |
| numbers | 400 12/18 mono (values in the ledger: 600 13/20 mono) | every number, tabular figures |
| chart | ticks 400 11 mono · axis titles 500 11 · high-symmetry labels 600 12 | all SVG charts |

Four text sizes (16 / 13 / 12 / 11 px) replace the old mix of 9.5–14 px.

### 7.3 Spacing and shape

Spacing steps 4 / 8 / 12 / 16 / 24 / 32 px (`--af-s1…s6`). Sections are separated by 24 px and a
heading, not by boxes; the only bordered elements are pipeline nodes, controls and the handoff
sheet. Nothing nests more than one level of surface. Radii 6 (controls), 8 (nodes, notes),
12 (pipeline band, plot panel).

### 7.4 Charts

- Charts measure their container; the SVG viewBox equals the real pixel width. (The old charts
  used a fixed 760-px viewBox with `preserveAspectRatio="none"`, which stretched all tick text
  horizontally.)
- Plot area on a 4 % fill, hairline grid at "nice" steps (1 / 2 / 2.5 / 5 × 10ⁿ), unit title
  above the y axis (`E / eV`, `log₁₀ Δρ`).
- High-symmetry labels are drawn as written in the KPT file (`G` stays `G`); labels closer than
  18 px merge into `B1|B`, `X|Q`, each keeping its own grid line.
- Each band channel is one `<path>` (all bands as sub-paths) clipped to the plot, so 80 bands ×
  several channels redraw instantly when the window changes.
- Line identity is carried by shape as well as colour: ABACUS solid ink, LibRPA KS dashed, EXX
  dotted, QSGW solid accent; spin 2 is a lighter shade of the same style; k-mesh series run pale
  → full accent (ordinal), incomplete meshes dashed.
- Reference lines (E_F) are dashed, labelled with their producer and file, with a background halo
  so the label stays legible over curves.

## 8. Component inventory

All in `lib/client.js`, in this order:

| Layer | Components / functions |
|---|---|
| pure logic (tested directly) | `groupRuns`, `lanesOf`, `stageState`, `lineageOf`, `detectSeries`, `meshToken`, `samePath`, `eigenIdentity`, `alignChannel`, `defaultWindow`, `ticksFor`, `rankBandSources`, `buildBandChannels`, `bandStyle`, `gapLedger`, `collapseLedger`, `buildAskContext`, `tailPath`, `handoffIntents`, `buildHandoffMessage` |
| io | `api`, per-browser UI memory (`abacusflow:ui`), `askAgent` / `prefillComposer` (unchanged), request caches, comparison basket store, hooks (`useWidth`, `useApi`, `useStageBundles`, `useBandRequests`, `usePrefetchedStates`) |
| primitives | `Icon16`, `StateGlyph`, `StateBadge`, `ProducerGlyph`, `ProducerTag`, `Section`, `Empty`, `Note`, `Seg`, `Btn`, `KV`, `LineSwatch`, `Spinner` / `Loading` |
| charts | `LineChart`, `BandChart`, `StructureViewer` (unchanged canvas projection) |
| runs | `RunList` + `RunFingerprint` (rail), `RunPicker` (narrow), `RunHeader`, `Pipeline` + `StageNode` / `StageChip` |
| results | `BandOverlay` (+ `IterationControl`, `RangeInputs`), `KeyNumbers`, `ConvergenceStrip` |
| stage | `StageView` → `StageOverview`, `InputsPane`, `ScfPane`, `QsgwPane`, `StructurePane`, `FilesPane` |
| places | `StudiesPlace` (`SeriesView`, `KStudyView`), `BasketPlace`, `LibraryPlace` |
| agent (AITP-facing, self-contained) | `AgentDock`, `HandoffSheet`, `useResearchContext` |
| shell | `RunScope`, `Panel`, `PanelRoot`, `Boundary`, `Icon`, `apply` |

What the old panes became: `OverviewPane` → `StageOverview`; `BandsPane` + the in-run use of
`CompareTray` → `BandOverlay`; cross-run `CompareTray` → `BasketPlace`; `ConvergencePane` +
`QsgwConvergenceCard` → `ConvergenceStrip` (run) and `ScfPane` / `QsgwPane` (stage);
`LibrpaPane` → `QsgwPane` + `StageOverview`; `KStudyPane` → `StudiesPlace`; `LibraryPane` →
`LibraryPlace` + the database rows of `KeyNumbers`; `AskBox` → `AgentDock`.

## 9. Host additions (read-only, additive)

No existing route or field changed. Two routes were added for the redesign:

| Route | Backed by | Why |
|---|---|---|
| `GET /abacusflow/api/kcompare?ids=a,b&kind=QSGW&spin=1[&iter=]` | existing `lib/host/kconvergence.js` `compareRuns` (previously not reachable from the panel) | comparison (b) for scanned runs: occupation-based band edges per mesh and the k-path identity check; scalars only (curves come from `/bands`) |
| `GET /abacusflow/api/research-context?id=` | new `lib/host/research-context.js` | nearest `research.md` above a run, at most 9 stats; the only AITP link the panel claims |

The scan path is untouched (no per-entry stat). Stage bundles for an opened run are fetched
three at a time; after a scan of ≤ 80 stages, the remaining runs' bundles are prefetched two at a
time so every run's fingerprint shows its refined state. Larger scans refine runs as they open.

## 10. Verification tooling and screenshots

| Script | What it does |
|---|---|
| `scripts/preview-server.mjs` | The real host routes over the real data + a harness that loads the real `client.js` (React 19 CommonJS builds from `$ABACUSFLOW_REACT_DIR` or the local pnpm store — never downloaded) and DSH's real theme sheets from the installed app. Fake session: posted messages appear in a fake chat column. |
| `scripts/screenshots.mjs [outDir] [--only x]` | Headless Chrome over CDP: seeds the panel's remembered state, clicks where needed, waits until no request is in flight, captures, and fails on any console error or page exception. |
| `scripts/render-preview.mjs <out.html>` | Static snapshot of the real rendered panel with all CSS inlined (replaces the old hand-written mock, whose classes no longer exist). |
| `scripts/render-band-preview.mjs <task> <OUT.x> <out.html>` | Standalone chart from the real band reader, mirroring the new chart geometry. |

Screenshots (`screenshots/`, all from real data, 0 console errors):

| File | Shows |
|---|---|
| `01` / `02` main, NiO, light / dark | pipeline (DZP read via `input_dir`, TZDP no output, consumer 证据不全), KS-vs-QSGW overlay aligned by index with G…P ticks, ledger, database rows, convergence |
| `03` / `04` dock, NiO, light / dark | narrow layout: run picker, chip pipeline, stacked ledger |
| `05` main, Bi2Se3 | unresolved `input_dir` *and* the KS-identity proof; errored consumer still plotted |
| `06` main, Si k666 | eight same-directory variants (no false sequence), series chip |
| `07` / `08` stage views | LibRPA QSGW tab (light), ABACUS SCF tab (dark) |
| `09` / `10` k 收敛研究 | k444 vs k666 series with `/kcompare` gaps; the Si snapshot (−198.2 / +110.3 / −163.8 / +26.2 meV) |
| `11` 数据库 | catalogue + match for the open run |
| `12` / `13` handoff | intents, derived research.md line, editable draft (main light, dock dark) |
| `14` dock picker | run list with fingerprints |
| `15` / `16` first screen | what a 1000-px-tall main page (dark) and dock (light) show without scrolling |

## 11. Deliberately left for later

- No hover read-out on the band plot (crosshair with E and nearest high-symmetry label).
- Lineage is drawn from `input_dir` and checked with KS eigenvalues; other evidence visible in the
  ledger (e.g. LibRPA's iteration-0 gap equalling an ABACUS SCF gap) is not yet drawn as an edge.
- In coupled-only runs the default plotted variant is the first by name (`base_iter1`), not the
  one with the most QSGW iterations; switch it with the source selector.
- In a short dock the plot starts near the fold; a collapsible pipeline would lift it further.
- The remote list/pull routes stay agent-only (no panel UI).
- AITP integration is one derived fact (nearest `research.md`) plus the composed message; no AITP
  state is read.
- ~~Host finding, not changed here (data layer was out of scope)~~ — **fixed after the redesign**
  (see §11a). Three defects in `lib/host/task-bundle.js` made a completed LibRPA run invisible:
  1. `hasOutput` counted only `librpa.out`, `qsgw_eigenvalues.dat` and `energy_qp`, so a run with
     `qsgw_iterations.dat` and band files but no log (NiO `qsgw`) read as 「未开始」, and the agent
     tools inherited that verdict;
  2. band files were listed only in the task directory, missing `librpa.d/`;
  3. the band-file pattern was `/^(GW|EXX|KS)_band_spin_\d+\.dat$/`, which never matches `QSGW_*`
     because `QSGW` does not start with `GW` — so every QSGW band file was skipped.

## 11a. Data-layer fix: LibRPA runs that kept no log

Applied after the redesign was reviewed, because the panel was correctly flagging a real host bug
and the agent tools were exposing the wrong answer.

| Aspect | Before | After |
|---|---|---|
| NiO `qsgw` status | `NO_OUTPUT` / 未开始 | `FINISHED_NO_LOG` / 已完成（无日志） |
| Band files found | 0 | 6 (`KS`/`EXX`/`QSGW` × 2 spins) |
| `bandEnergies` | `{}` | all six, 364 k-points × 80 bands each |
| Evidence | none | `qsgw_iterations.dat 2 行 · 6 个能带文件 · 缺少 librpa.out` |

A new status code `FINISHED_NO_LOG` exists because the previous fallback for "output but no log"
was `RUNNING`, which is a claim about the present that cannot be supported: the run may have
finished hours ago and simply not kept its log. Saying "finished, log not retained" is the only
honest option, and it keeps the missing log visible instead of hiding it.

Behaviour deliberately unchanged: a log file that exists but cannot be read still yields
`RUNNING` (genuinely inconclusive), and a directory with nothing at all still yields `NO_OUTPUT`.

Covered by `test/librpa-status.test.mjs` (6 tests, real temp directories through the real
scanner).

## 12. Checks that need a real DSH session

The preview harness fakes the session and the slots, so these can only be confirmed in DSH
(after a **full restart** — the client bundle is not hot-reloaded):

1. The sidebar entry, the main page and the right-dock tab all mount; the dock switches to the
   narrow layout below 760 px and back when widened.
2. 「发送」 in the agent dock posts a real user message into the current conversation
   (`session.beginSubmission`, mode `queue`) carrying the context block; with no session bound it
   pre-fills the composer instead.
3. 「交给 Agent…」 → 「发送到对话」 posts the edited draft; the agent can act on it (`abacus_*`,
   AITP `research_*`) and asks before submitting jobs.
4. Switching DSH between light, dark and system re-themes the panel live; the user's text and code
   font settings apply.
5. Keyboard: Tab reaches places, run rows, stage nodes, plot controls and the dock; focus rings use
   DSH's accent.
6. A stage that is genuinely running is re-read every 10 s while its run is open.

## 13. Known-broken, with diagnosed root causes (next round)

Both were reported by the user after the redesign shipped. The causes are established by
measurement, not guessed; fix these before adding features.

### 13.1 Database figures do not render

`LibraryAssets` chooses displayable figures by testing the **label** for `.png`:

```js
const pngs = figures.filter((f) => /\.png$/i.test(f.label));
```

In the real data the label is a *description* and the type is only in the URL. Inventory across
all 122 records, by **URL extension**:

| extension | count |
|---|---|
| svg | 214 |
| json | 119 |
| png | 46 |
| pdf | 46 |

So the filter discards most figures. The record matching NiO (`nio-aims-gw-int`) has three
entries whose labels are `EXX occupation-separated frontier`, `GW occupation-separated frontier`
and `Frontier display mappings, raw audit and provenance` — two SVGs and one JSON audit; all are
dropped, and the panel shows nothing for it.

Fix by deciding type from the URL, rendering SVG/PNG, linking PDF, and showing JSON as data
rather than as an image. Keep the description as the caption.

### 13.2 The ask-the-agent box cannot submit

Architectural: the panel occupies the `main` slot, and the Client reports for that slot

- `standardProps` without `sessionId`
- description: *"other keys receive no Session binding"*

so `props.sessionId` is `undefined`, no session is ever resolved, and the composer fallback finds
no textarea while the plugin's main panel is open. The `sidebar.right.pane.tab` slot *does* receive
`sessionId`, so dock and main can differ.

Resolve the session from the Client services (`useSessions` / `useSessionStatus` hook props, or
`sessions.binding(id)`), post via `ISession.beginSubmission`, and report a late rejection through
`onRetire`. Never fail silently.
