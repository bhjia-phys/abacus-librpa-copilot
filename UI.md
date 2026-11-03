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
            与已发表记录对照   (only when the database has a candidate; §15)
                      gaps side by side with sources · 能否直接比较 table · band curves
            收敛       ABACUS SCF and LibRPA QSGW side by side; iteration synced with the plot
        阶段 · <stage>  概览 / 诊断 / 输入 / 收敛 / 结构 / 文件   (LibRPA: 概览 / 诊断 / 输入 / QSGW / 文件)
                      a stage that is not ok shows 「为什么？」 next to its state → 诊断 (§14)
        Agent dock    ask box + 「交给 Agent…」 handoff + diagnosis drafts (pinned, outside the scroller)

数据库 → record → 已发表图 (tabs by quantity: KS / EXX / GW / 对比 / 其他) · 图的审计与来源 (JSON
          outline, closed) · 能带数据 (the record's band tables, closed)
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
| **(c) This run vs the published database** | Is my number in line with what was published — and *can* it be? | 运行 → 结果 → 关键数值 (zero clicks for the top match), 「与已发表记录对照」 (§15), 数据库 place for browsing | Auto-matched from the STRU composition (high confidence) or the directory name (medium/low, labelled). Gaps side by side with sources, every comparability field as each side states it (same / differs / cannot tell), and band curves on one axis only when the k paths are provably the same. |

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
| evidence mismatch | dashed ring + dot | 证据不全 / 已完成（无日志） | the status says one thing and the files another (no `librpa.out` but `librpa.d` holds QSGW iterations and band files), or the host's `FINISHED_NO_LOG`: results exist but the log that would show a clean end was not kept. A `FINISHED_NO_LOG` run whose QSGW table never converged is **unconverged** instead (NiO `qsgw`). |

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
- The dock says, every time, that the panel is read-only and the agent does the computing, and
  where a message will go: 「发往「<session title>」」, or 「无法发送：<reason>」.
- **Which session.** The right-dock tab is given `sessionId` by DSH; the main page is not (the
  `main` slot is root-scoped). Both resolve through the Client's `sessions` service: the slot's
  `sessionId` when there is one, else the session the workspace retains as `mainView` — the
  rule DSH's own title bar and Cordis panel use, and a retain the workspace keeps while a global
  panel covers the conversation. `sessions.binding(id).session` is the `ISession` face.
- **How a message is posted.** Exactly as DSH's composer does it: `beginSubmission({ mode:
  'queue', text, attachments: [], onRetire })` paints the echo, then `prompt([{type:'text', text}],
  'queue', undefined, requestId)` sends it. The status line follows what DSH reports back —
  正在发往… → 「…」已接收 (queued behind a running turn when it is) → 已出现在「…」里, or
  没有送达：<host reason> — including a withdrawal that arrives after acceptance. A rejection stays
  on screen until the next send.
- **No session.** Nothing is sent; the reason is shown on its own line (no conversation open, the
  service is missing, the session is not retained, a DSH without `prompt`), the send button
  becomes 「复制」 and the text is copied for pasting. The old fallback that typed into the first
  `textarea` on the page is gone (§13.2).
- **Diagnosable.** Every resolution is logged once with `console.info('[abacusflow] ask box
  (main|dock): …', { tried, 'props.sessionId', "ctx.get('sessions')", 'sessions.list →
  retainedBy.mainView', 'sessions.binding(id)', … })`, so a failure in a live DSH names the
  accessor that returned nothing.
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
| pure logic (tested directly) | `groupRuns`, `lanesOf`, `stageState`, `lineageOf`, `detectSeries`, `meshToken`, `samePath`, `eigenIdentity`, `alignChannel`, `defaultWindow`, `ticksFor`, `rankBandSources`, `buildBandChannels`, `bandStyle`, `gapLedger`, `collapseLedger`, `buildAskContext`, `tailPath`, `handoffIntents`, `buildHandoffMessage`; **new:** `buildDiagnosisMessage`, `DIAGNOSIS_GLYPH` (§14) · `baseName`, `methodFamily`, `recordSpinFacts`, `localCompareFacts`, `compareWithRecord`, `gapComparison` (§15) · `groupFigures`, `jsonOutline`, `fmtBytes` (§13.1) · `mainViewSessionId`, `describeSessionLink`, `describeRemoteError`, `submissionStep`, `submissionLabel`, `postToSession` (§13.2) |
| io | `api`, per-browser UI memory (`abacusflow:ui`), `copyText`, request caches, comparison basket store, hooks (`useWidth`, `useApi` — now reports *loading* until the response for the current key arrives, `useStageBundles`, `useBandRequests`, `usePrefetchedStates`, `useSessionService`, `useSessionLink`) |
| primitives | `Icon16`, `StateGlyph`, `StateBadge`, `ProducerGlyph`, `ProducerTag`, `Section`, `Empty`, `Note`, `Seg`, `Btn`, `KV`, `LineSwatch`, `Spinner` / `Loading` |
| charts | `LineChart`, `BandChart`, `StructureViewer` (unchanged canvas projection) |
| runs | `RunList` + `RunFingerprint` (rail), `RunPicker` (narrow), `RunHeader`, `Pipeline` + `StageNode` / `StageChip` |
| results | `BandOverlay` (+ `IterationControl`, `RangeInputs`), `KeyNumbers`, `PublishedComparison` + `PublishedBandCompare` (§15), `ConvergenceStrip` |
| stage | `StageView` → `StageOverview`, `DiagnosisPane` (§14), `InputsPane`, `ScfPane`, `QsgwPane`, `StructurePane`, `FilesPane` |
| places | `StudiesPlace` (`SeriesView`, `KStudyView`), `BasketPlace`, `LibraryPlace` → `LibraryRecord` → `LibraryAssets` (`LibraryFigure`, `LibraryAudit` + `JsonTree`, `ExternalLink`) |
| agent (AITP-facing, self-contained) | `AgentDock`, `HandoffSheet`, `DraftSheet` (a message composed elsewhere on the page, e.g. a diagnosis), `useResearchContext` |
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

Added in the workbench round (all read-only, all on demand for one stage or one record):

| Route / tool | Backed by | Why |
|---|---|---|
| `GET /abacusflow/api/diagnose?id=` and agent tool `abacus_diagnose` | new `lib/host/diagnose.js` | §14: decisive log lines with line numbers, asked-vs-found checks, absent files, verdict. The panel and the agent read the same function. |
| `GET /abacusflow/api/library/band?id=&url=` | `publishedBandChannel` in `lib/host/library-assets.js` (reuses `parseLibrpaBand`, `cumulativePathLength`, `describeChannel`) | §15: a published band table as a channel; only a URL the record itself lists as band data |
| `/library/assets` now returns `audits` and per-item `kind` / `quantity` / `stem` / `spin` / `primary` | `assetKind`, `assetQuantity`, `listAssets` | §13.1 |
| `/library/asset` serves the extension's content type, `X-Content-Type-Options: nosniff`, and a sandbox CSP for SVG/JSON/text | `lib/index.js` | an SVG `<img>` needs `image/svg+xml` on a cache hit too; an SVG opened directly must not run script in DSH's origin |
| `summarizeRecord` gains `gapDefinition`, `frontend`, `workflowTask`, `software[]`, `species[].abf`, `atomCount`, `pathKpoints`, `gapProperties[]` | `lib/host/library.js` | §15; additive, existing fields unchanged |
| `ABACUS_LOG_MARKERS`, `LIBRPA_LOG_SIGNATURES` exported | `abacus/log.js`, `librpa/output.js` | the diagnosis quotes the lines the classifiers decide on, with the classifiers' own patterns |

The scan path is untouched (no per-entry stat). Stage bundles for an opened run are fetched
three at a time; after a scan of ≤ 80 stages, the remaining runs' bundles are prefetched two at a
time so every run's fingerprint shows its refined state. Larger scans refine runs as they open.

## 10. Verification tooling and screenshots

| Script | What it does |
|---|---|
| `scripts/preview-server.mjs` | The real host routes over the real data + a harness that loads the real `client.js` (React 19 CommonJS builds from `$ABACUSFLOW_REACT_DIR` or the local pnpm store — never downloaded) and DSH's real theme sheets from the installed app. The harness models DSH's slots faithfully: the main slot gets the standard hooks and **no** `sessionId`, the dock gets `sessionId`, and a stand-in `sessions` service mirrors DSH's session controller (`list` with `retainedBy`, `binding(id)`, `beginSubmission` that only paints, `prompt` that sends). `?session=ok|running|refuse|late|none|noservice` picks its behaviour. The old harness passed `sessionId` to the main slot, which DSH never does — that is how §13.2 went unnoticed. |
| `scripts/check-ask-box.mjs` | Types a question and presses 发送 on the main page and in the dock, for every stand-in behaviour; reports the status line, whether the message reached the session, and the `console.info` trace. 12/12 pass. |
| `scripts/check-library-figures.mjs [outDir] [--ids …]` | Expands database records in the real panel, walks every quantity tab, waits until each `<img>` has decoded, opens an audit's outline; light and dark. Defaults to the four §13.1 verification records. |
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
| `17` / `18` / `19` main, 诊断 | NiO `qsgw` (QSGW table unconverged, no `librpa.out`); Bi2Se3 option5 `run` cancelled by Slurm (dark); NiO `01_scf` finished, with the `out_*` outputs not pulled back |
| `20` / `21` dock, 诊断 | the diagnosis handed to the agent as an editable draft (dark); the Slurm-cancelled run at dock width (light) |
| `22` – `25` 数据库 | NiO SVG figures + audit outline; CuInP2Se6 PNG + PDF (dark); Bi2Se3 SVG tabs in the dock; a record with no figures (dock, dark) |
| `26` – `29` ask box | delivered (main light, dock dark); no conversation open — reason + 复制 (main dark); refused by the host (dock light) |
| `30` – `33` 与已发表记录对照 | Bi2Se3 vs `bi2se3-abacus-gw-dzp` — same 101-point path, so one axis (main light, dock light); NiO vs `nio-aims-gw-int` — 364 vs 126 points, side by side (main dark, dock dark) |
| `34` / `35` older host | the panel against the first release's host (`?host=old`, §13.3): database still works, with the banner (main light); 诊断 says it needs the new host (dock dark) |

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
2. **The ask box, on the main page and in the dock separately** (not verified live — see the
   handoff note). Open a conversation, open the panel's main page, type a question, press 发送:
   the message must appear in that conversation and the status line must go 正在发往… →
   已接收 → 已出现在「…」里. Repeat from the right-dock tab. Then open the panel with no
   conversation selected: the dock must say 「无法发送：工作区里没有打开的对话…」 and the button
   must read 复制. In each case the devtools console shows one
   `[abacusflow] ask box (main|dock): …` line naming the accessor used and what it returned;
   if a send fails, that line is the first thing to read.
3. 「交给 Agent…」 → 「发送到对话」 posts the edited draft, and 诊断 → 「交给 Agent…」 → the draft
   sheet → 「发送到对话」 posts the diagnosis; the agent can act on it (`abacus_*`, including the
   new `abacus_diagnose`, AITP `research_*`) and asks before submitting jobs.
4. Switching DSH between light, dark and system re-themes the panel live; the user's text and code
   font settings apply.
5. Keyboard: Tab reaches places, run rows, stage nodes, plot controls and the dock; focus rings use
   DSH's accent.
6. A stage that is genuinely running is re-read every 10 s while its run is open.
7. Database figures load through DSH's own web server (the host proxy) in the desktop app; a
   「PDF ↗」 / 「原图 ↗」 link opens the dataset mirror outside the panel (whether DSH opens it in
   the system browser or a new window is DSH's choice).

## 13. Two defects, fixed in the workbench round

Both were reported after the redesign shipped. The causes below were established by
measurement; each fix carries its root cause in a code comment where it lives. The original
diagnosis is kept under each heading, followed by what changed.

### 13.1 Database figures did not render — fixed

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

**What changed.**

- Host (`lib/host/library-assets.js`): each item gets `kind` from the URL's extension (the record
  `path` as fallback) and `quantity` from caption and file-name words — split on every
  non-alphanumeric, underscores included, so `cuinp2se6_ks.png` reads KS; the record directory
  (`…/cuinp2se6-table-gw/…`) is never consulted. JSON filed under figures goes to a separate
  `audits` group. Band tables are found by file name (`GW_band_spin_1.dat`, `GW_bands.dat`), not
  by the old `_(KS|EXX|GW)\.dat$` caption test that missed NiO's.
- A second, latent bug: on a **cache hit** `fetchAsset` derived the content type from a table
  that had no SVG entry, so an SVG came back as `application/octet-stream` and the `<img>` broke
  the second time it was viewed. Known extensions now decide the type on every path.
- Client (`LibraryAssets`, root cause in its comment): 已发表图 with a segmented control by
  quantity (KS / EXX / GW / 对比 / 其他, physics order; opens on the record's `primary` figure,
  else GW); one card per plot, with a PNG and its PDF paired by file stem (image shown, PDF a
  link); figures sit on `--af-paper` (DSH's static white) in both themes. 图的审计与来源 lists the
  JSON audits apart, closed; opening one fetches it and shows a one-level-at-a-time outline
  (keys, types, sizes, previews) with a 原文 toggle capped at 60 000 characters. A record with no
  figures says so. The physically wrong `parsePublishedBandCurve` / `PublishedBandChart` (which
  read LibRPA's `ik kx ky kz` columns as "k + energies") are gone; band tables are listed, and
  plotted through §15.
- Verified on the four records: NiO 2 SVG (1080×740) + 1 audit; Bi2Se3 3 SVG + 1 audit;
  CuInP2Se6 3 PNG (2946×1906) each with its PDF; `c-delta-st-rpa-20260824` 「这条记录没有上传图」.
  Across all 122 records every figure entry lands in figures or audits (a test asserts it).

### 13.2 The ask-the-agent box could not submit — fixed

Architectural: the panel occupies the `main` slot, and the Client reports for that slot

- `standardProps` without `sessionId`
- description: *"other keys receive no Session binding"*

so `props.sessionId` is `undefined`, no session is ever resolved, and the composer fallback finds
no textarea while the plugin's main panel is open. The `sidebar.right.pane.tab` slot *does* receive
`sessionId`, so dock and main can differ.

Resolve the session from the Client services (`useSessions` / `useSessionStatus` hook props, or
`sessions.binding(id)`), post via `ISession.beginSubmission`, and report a late rejection through
`onRetire`. Never fail silently.

**What changed.** Two root causes, both named in `lib/client.js` comments (`useSessionLink`,
`postToSession`):

1. *No session on the main page* — as diagnosed. The id now comes from `ctx.get('sessions').list`
   (the `mainView` retain; DSH's own title bar and Cordis panel use the same rule), the dock keeps
   its slot `sessionId`, and the binding is re-read whenever the list changes.
2. *Nothing was ever sent, even in the dock.* Reading DSH's session controller showed that
   `ISession.beginSubmission` **only registers the local echo** and mints a request id; the call
   that reaches the Host is `session.prompt(content, mode, signal, requestId)`, which DSH's
   composer makes right after. The old `askAgent` stopped after `beginSubmission`, so a message
   painted a pending bubble and never left the browser. `postToSession` now makes both calls with
   the same request id and reads every report back (§6).

The `textarea:not(.af-textarea)` fallback is removed: on the main page it could only find the
wrong textarea. Verified with `scripts/check-ask-box.mjs` against a stand-in that mirrors DSH's
controller (12/12: main and dock × delivered / queued / refused / withdrawn late / no
conversation / no service). **Not verified in a live DSH session** — see §12 item 2.

### 13.3 A panel newer than its host — found in live use, fixed

DSH hot-reloads the plugin's **client** bundle when its files change (`dsh-client-hmr`), but
the **host** half keeps running the code it started with until DSH is fully quit. In the user's
DSH the reloaded panel met the first release's host: its `/library/assets` items carry no
`kind`, so `f.kind.toUpperCase()` threw and the error boundary replaced the whole panel
(「Cannot read properties of undefined (reading 'toUpperCase')」). Confirmed on the running host
(`dsh-desktop-host`, started before the change): no `kind` in the listing, `/diagnose` → 404.

- `/ping` now announces `features` (`HOST_FEATURES` in `lib/index.js`); the panel compares them
  with `HOST_FEATURES_NEEDED` (`hostLag`). A test keeps the two lists in step.
- The database view no longer needs the new fields: `assetKindOf` / `assetQuantityOf` /
  `assetStemOf` / `assetSpinOf` apply the host's rules when the host is silent, and audit JSON
  is split from the figures in the panel when the host does not do it.
- With an older host, a banner names what is unavailable (阶段诊断, 已发表能带对照) and the one
  fix — quit DSH completely (window, taskbar and tray) and reopen; the 诊断 tab and the band part
  of 与已发表记录对照 say the same where they would have shown data.
- The preview harness can impersonate that host (`?host=old`); screenshots `34` (database, main,
  light) and `35` (诊断, dock, dark) show the panel against it.

## 14. Per-stage diagnosis (诊断)

*"Why is this stage in this state?"* — a tab on every stage, and a 「为什么？」 button beside any
state that is not ok. Backed by `lib/host/diagnose.js` (`/diagnose?id=`, agent tool
`abacus_diagnose`), which extends the classifiers rather than duplicating them: it quotes the
lines that matched the classifiers' own patterns.

| Part | What it shows | Real example |
|---|---|---|
| verdict | one line, from the evidence below and nothing else | 「运行被终止：作业被调度器取消（CANCELLED）（librpa.err 第 1 行）」 |
| 关键日志行 | the decisive lines, quoted with file and 1-based line: fatal signatures (incl. ABACUS's `!NOTICE!` abort with its message), the convergence verdict, the terminator, LibRPA's last QSGW iteration, `librpa.exitcode`; with no terminator, the last line written. Scheduler output (`slurm-*.out`, `librpa.err`) is scanned for time-limit, OOM, preemption and cancel banners; identical banners are quoted once (「另有 16 行同类」) | NiO `01_scf`: `#SCF IS CONVERGED#` at line 1826, `Total Time` at 1918 |
| 输入要求 vs 输出 | `scf_nmax`/`scf_thr` vs the last SCF step and drho (converging calculations only; nscf is one step by design); `nbands` vs the band files' band count; `nspin = 2` vs band files for both spins; every `out_*` flag vs its files (names of several ABACUS versions accepted); `rpa 1` vs export files; `init_chg file` vs a charge density at `read_file_dir`; LibRPA `qsgw_max_iter` / tolerance vs the iteration table (or the log's own iteration lines when the table was not pulled); `fn_band_kpath_info` vs the band files | NiO `03_bands`: 「nbands = 80 → bands1.txt 364 k × 80 带、bands2.txt 364 k × 80 带」 |
| 缺少的文件 | what a stage of this kind needs (INPUT, STRU, KPT unless `kspacing`/`gamma_only`, the main log, `librpa.in`, every `fn_*` / `prefix_*` input in a local `input_dir`) or normally leaves (`OUT.<suffix>/`, `librpa.out`, `qsgw_iterations.dat`), marked 必需 / 通常会有 | NiO `qsgw`: `librpa.out` 通常会有 |
| 注 | what cannot be checked and why: an `input_dir` that is a cluster path, a `pseudo_dir` absent locally, pseudopotentials of a finished run that were not pulled back, and — when the scheduler cancelled a run whose log just stops — why the list still says 运行中 | |
| 交给 Agent… | composes the whole diagnosis (`buildDiagnosisMessage`) into an editable `DraftSheet` in the dock; nothing is sent until the user presses 发送到对话 | |

Honesty rules: an output INPUT asked for and that is not here is 「本地没有：没有产出，或没有拉回
本地」 (shown as "?"), never "not produced" — most local copies are partial pulls. The stage
state badge is unchanged (it is the classifiers'); where the diagnosis finds more (a Slurm cancel
behind a log that just stops), it says so in a note instead of overriding the state.

## 15. Published vs local (与已发表记录对照)

A results section, present only when the database has a candidate for the run (closed by
default, remembered). For the chosen record (up to four candidates, labelled by match
confidence):

1. **One-line summary** — how many fields differ, how many cannot be checked, and that the gap
   differences below *contain* those differences.
2. **能隙** — local KS gap (ABACUS log), local GW-family gap (`qsgw_iterations.dat`, the picked
   iteration) next to the record's `dft_gap_ev` / `exx_gap_ev` / `gw_gap_ev`, each with its
   source (`<stage> · <file>`, `<record> · summary.<key>`); the difference is printed, followed by
   the fields that differ or cannot be checked for that pair. No local value is invented (the
   run's EXX gap is not in its files, so that cell says so).
3. **能否直接比较** — one row per field, each value as its source states it, and a verdict
   相同 / 不同 / 无法核对: method (QSGW vs G0W0 …, read conservatively — an unspecified "GW" is
   not assumed to be G0W0), program, versions (commits by prefix; LibRPA's `GITDIR-NO*`
   placeholder is "no commit"), NAO and PP per element (by file name), ABF (record only), SCF k
   mesh (the record has no such field — it is said, with its band-path point count), atom
   count, spin and SOC (the record states these only in prose, so they are read from its notes
   and labelled 「据记录说明文字」; `nspin = 4` is never matched against prose), gap definition
   (a mesh KS gap vs a band-path record → 不同; anything the files do not state → 无法核对).
   Local facts come from the SCF producer, or else the producer on the consumer's branch with a
   Monkhorst–Pack mesh.
4. **能带** — the record's band tables (KS / EXX / GW per spin) against the matching local LibRPA
   channel (GW ↔ QSGW, at the run's selected iteration). The host parses the published table
   exactly as a local one, so `alignChannel` decides: **identical k path → one axis**; anything
   else → two plots side by side with the reason (「k 点数不同（364 vs 126）」). Each curve is drawn
   as E − E_VBM of its own file (band edges from occupations, as in the record's own figures)
   when both VBMs are known; otherwise both stay absolute and the plot says the zeros differ.
   Inverted k-points in a published table are counted, not hidden.

Real outcomes: Bi2Se3 vs `bi2se3-abacus-gw-dzp` — same NAO and PP files, same 101-point path
(overlaid), but QSGW vs G0W0 and SOC vs 「no SOC」 → 2 differences, 5 cannot be checked. NiO vs
`nio-aims-gw-int` (FHI-aims) — method, program and gap definition differ; atom count and spin
match; 364 vs 126 k-points → side by side.

## 16. Designed, not built

Each of these needs decisions or permissions beyond an inspector. They are specified here so
the next iteration starts from a plan; none of it exists in the code.

### 16.1 Contribute a run to the database (§4.3 of the brief) — the only part that would write

Place: a 「整理成数据库记录…」 action on a run's results, opening a full-page flow in four steps.
Nothing is written before step 4, and nothing leaves the machine without a separate step 5.

1. **Derive** (read-only, shown as a draft). From the bundles the panel already has: `material`,
   `formula` (Hill formula from STRU counts — `speciesCountsFromStru` / `hillFormula`),
   `dimension` (asked, not guessed), `species[]` with `asset_aliases.pp` / `.nao` from STRU and
   `pseudo_dir` / `orbital_dir`, ABF from the export stage if local; `software` from the ABACUS
   log banner and LibRPA build block (commits only when they are commits); `workflow.frontend`
   = `abacus`, `task` from `librpa.in`; `computational_scale` from STRU and the band files.
2. **Gaps with sources.** The gap ledger rows, each becoming a `properties[]` entry with
   `evidence` = the file it came from and the stage; the user picks which become
   `summary.*_gap_ev` and must write `summary.gap_definition` themselves (the panel offers the
   sampling it can see — mesh or explicit path — and nothing more).
3. **Figures.** The run's own band figures are not files today (the panel draws SVG live), so the
   flow would export the current band plot as SVG plus the band tables themselves; the user can
   add files. Every file is listed with size and SHA-256.
4. **Preview and stage.** The complete `record.json` is shown as the outline viewer used for
   audits, with every field the user must confirm highlighted (dimension, gap definition, scope,
   scientific status). 「写入暂存目录」 writes `record.json` + files into a staging directory under
   the plugin's data folder (configurable), shows the exact paths, and offers 「撤销」 (delete the
   staging folder). This is the only write in the panel and is opt-in per run.
5. **Upload** is a separate, explicit confirmation naming the destination (dataset, branch, file
   list, total size) — and it would be performed by the agent through a tool, never by the panel.
   Host additions it needs: `POST /stage-record` (write into the staging dir only, refusing any
   other path) and an agent tool for the upload. Not built because writing and publishing need
   the researcher's decisions on the record schema version, staging location and credentials.

### 16.2 Drive a calculation from the panel (§4.4) — the agent computes

Place: a 「请 Agent 计算…」 button in the 运行 place header, visually distinct from inspection
controls (outlined, with the agent icon, and the sentence 「面板不运行计算；它写一条请求，Agent 去做」
next to it). It opens a request form:

- **What**: material / structure (pick a scanned STRU, or a database record's structure),
  method (DFT / G0W0 / QSGW), what to compute (band structure / gap / spectral function /
  topology), k mesh, basis (NAO set; ABF), spin and SOC, cluster (from the configured remotes).
- **Output**: a structured message (like the handoff) with a fenced YAML block the agent's skill
  can parse, plus the free-text intent; reviewable and editable before sending, sent through the
  same `postToSession` path.
- **Afterwards**: the panel asks the agent to reply with the run directory; once that folder
  appears under the scan root, the run gets a 「由请求创建」 chip and the panel's normal polling of
  running stages shows progress. The panel never submits, never writes inputs.

Not built: the request vocabulary has to match the skills the researcher will supply, and those
do not exist yet; building the form first would fix a schema the agent cannot honour.

### 16.3 Spectral function A(k, ω) (§4.5)

- **View**: a heat map, k path on x (with the same ticks as the band plot), ω on y, colour =
  A(k, ω) on a perceptually uniform sequential scale with a legend and a log/linear toggle;
  optional QP bands overlaid as thin lines when the k paths match (same `alignChannel` rule).
- **Renderer**: a `<canvas>` (an `ImageData` per frame), not SVG rects — 364 k × ~2 000 ω points
  would be 728 000 elements; SVG keeps only the axes and labels.
- **Data**: only from files on disk. None of the sample runs contains a spectral-function file
  (626 entries searched by name for `spectral|akw|a_kw|spec_func|spectra`, `OUT.*` excluded), so
  the view would show 「这个运行没有谱函数输出」 with the file names it looked for. The reader (host)
  and the file format are the missing piece — they should come from the LibRPA output the
  researcher actually produces; the panel must not synthesise A(k, ω) from QP energies and an
  assumed broadening.

## 17. Not done in this round, and why

- **Live DSH verification of the ask box** — not possible from this environment (no driver for
  the desktop app; restarting the user's DSH is theirs to do). The harness mirrors DSH's
  controller as read from its bundle; §12 item 2 is the check that remains.
- **§4.3 / §4.4 / §4.5** — designed in §16, not built (reasons there).
- **Diagnosis**: does not check k-point counts against KPT line-mode expansions, nor LibRPA's
  inputs on a cluster path; does not re-classify a stage when it finds a scheduler cancel (it
  explains the difference instead). `out_*` file-name patterns cover the ABACUS versions in the
  sample data; another version's names may read as 「本地没有」.
- **Comparison**: no published high-symmetry tick labels (a record's KPT files use inclusive
  segments the tick expander does not handle, and a wrong label is worse than none); the record
  picker shows at most four candidates; spin/SOC are read from record prose.
- **Database figures**: PDFs are links to the dataset mirror, not an embedded viewer (the brief
  allowed either; every PDF in the database has a PNG twin that is shown inline, and an embedded
  viewer inside DSH's Electron shell could not be tested here).
