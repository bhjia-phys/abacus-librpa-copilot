# dsh-abacusflow

ABACUS + LibRPA 的科研助手插件，面向 DeepSeek Harness（DSH）0.2。它是
[VASPFlow](https://github.com/21271122/VASPFlow) 架构在 ABACUS/LibRPA 上的移植：
**右侧任务看板 + 一份宿主数据服务 + 一组只由 ABACUS 预设暴露给 Agent 的工具**。

面板看到的数字和 Agent 工具读到的是同一份数据（同一个 TaskStore、同一套解析器），
所以"AI 说收敛了"和"图上看到的曲线"不会各说各话。

---

## 它解决什么问题

一次 ABACUS 计算散落在 `INPUT` / `STRU` / `KPT` 三个输入文件和一个
`OUT.<suffix>/running_scf.log` 里；一次 LibRPA GW 计算又叠加 `librpa.in`、
`dataset/` 目录下十几种矩阵文件、`librpa.out` 和 `librpa.d/qsgw_*.dat`。
判断"这个算完了吗、收敛了吗、用的什么参数、结构对不对"要反复翻文件。

这个插件把这几件事变成三个动作：

1. **扫描** —— 给一个项目根目录，自动找出所有 ABACUS 任务（含 `INPUT`）与 LibRPA
   任务（含 `librpa.in`），同目录两者都在的识别为"耦合任务"。
2. **看** —— SCF 收敛曲线（能量 + 电荷密度残差，按离子步分段）、可旋转的 3D 晶体结构、
   分类整理的有效输入参数、文件树。
3. **问** —— 在选择了本插件的会话里，Agent 可以调用 `abacus_scan` / `abacus_inspect` /
   `abacus_convergence` / `abacus_structure` / `abacus_inputs` / `librpa_inspect`
   直接读这些确定性解析结果，而不是让模型去猜日志。

**它不做什么**：不提交作业、不改输入文件、不判断参数在科学上是否正确。
"输入检查通过"与"计算可信"是两件事，工具只报告可观测事实。

---

## Panel structure (redesign, 2026-11-02)

*This section is in English; the panel's own labels are quoted in Chinese as they appear.
Full design record: [UI.md](../../UI.md). Screenshots: [screenshots/](../../screenshots).*

The panel is organised around the **pipeline** of a production calculation — ABACUS producer
stages feeding LibRPA consumer stages — and opens on **results**, not on a file tree.

**Four places** (top bar): 「运行」 runs · 「k 收敛研究」 k-mesh studies · 「对比篮」 ad-hoc
cross-run basket · 「数据库」 the LibRPA-database catalogue. They replace the eight flat tabs.

**A run** is a folder under the scan root (or the root itself when its children are
`producer/`, `qsgw/`, `01_scf` …). Its page shows, top to bottom:

1. **Header** — material from STRU, ABACUS version / basis / functional / nspin / SOC, the LibRPA
   task, stage counts, and a link to the k-mesh series the run belongs to.
2. **Pipeline** — ABACUS producer branches (`producer/DZP`, `producer/TZDP`) in step order,
   an edge stating *how* the consumer is linked (`input_dir → producer/DZP`, same directory, or a
   labelled layout guess), and the LibRPA consumers. Each stage carries one state glyph:
   已收敛 / 已完成 (✓ circle), 未收敛 (triangle), 运行中 (half ring), 无输出 (hollow ring),
   出错 (× square), 证据不全 (dashed ring — the files contradict the status). Click a stage for
   its own tabs: 概览 / 输入 / 收敛 / 结构 / 文件 (LibRPA: 概览 / 输入 / QSGW / 文件).
3. **结果** (default view):
   - **能带对比** — ABACUS KS bands and LibRPA QSGW bands of the run, overlaid by default. QSGW
     iteration and spin are controls on the plot. ABACUS and LibRPA measure k-path length
     differently, so their curves share an axis only after LibRPA's KS eigenvalues are shown to
     reproduce the ABACUS ones point by point (NiO: 364 × 80 values, max |Δ| = 0.001 eV); the
     plot says which rule it used and never shifts, interpolates or resamples. The window is
     centred on a Fermi level read from a file (±6 eV), and each producer's E_F is drawn and
     labelled.
   - **关键数值** — every gap the files state (ABACUS `E_gap(k)` log lines, LibRPA
     `qsgw_iterations.dat`), each with its producer and source file, then the matched
     LibRPA-database records. No gap is ever derived from band indices.
   - **收敛** — ABACUS SCF Δρ and LibRPA QSGW gap / max ΔE side by side; clicking an iteration
     changes the plotted iteration.
4. **Agent dock** (pinned) — a quick question that carries the focused stage's absolute path and
   state, and 「交给 Agent…」, which composes an editable run-level message (stages, states,
   numbers with source files, what is missing, the nearest `research.md` *if one is found on
   disk*, and a request to confirm before submitting jobs). The panel itself stays read-only.

**Comparisons**: (a) ABACUS vs LibRPA inside a run — default on, above; (b) one material across
k meshes — 「k 收敛研究」, auto-detected from run names that differ only by `k444`/`k666`…, or read
from a `snapshot.json`; (c) the run vs published records — in 关键数值 and 「数据库」; the
「对比篮」 holds hand-picked channels from any runs and applies the same alignment rules.

The panel measures its width: ≥ 760 px shows a run rail plus the run page (main page); narrower
shows a run picker and a single column (right-dock tab). Light and dark follow DSH's theme.

After updating the plugin, **restart DSH fully** — the client bundle is not hot-reloaded.

---

## 能识别的文件

| 输入 | 解析内容 |
|---|---|
| `INPUT` | 全部关键字（大小写不敏感、支持 `#`/`!` 注释、裸 flag），按 16 类分组，并标注未收录关键字 |
| `STRU` | `ATOMIC_SPECIES` / `NUMERICAL_ORBITAL` / `LATTICE_CONSTANT`（含 Bohr/Å 单位）/ `LATTICE_VECTORS` / `ATOMIC_POSITIONS`（Direct/Cartesian + move + mag），自动换算分数坐标与 Å 坐标 |
| `KPT` | 自动网格（Gamma/MP，含 half-shift）与显式点列两种模式 |
| `OUT.*/INPUT.info` | ABACUS 解析后的**最终**参数值（比 `INPUT` 更可靠） |
| `OUT.*/running_*.log` | 每个离子步/电子步的 `E_KohnSham`、`E_Harris`、`E_Fermi`、`E_gap(k)`、`Δρ`；收敛判据 `#SCF IS CONVERGED#` / `!!SCF IS NOT CONVERGED!!`；`#TOTAL ENERGY#`；`TOTAL-FORCE`；`TOTAL-STRESS`；计时与内存表；错误签名 |
| `OUT.*/warning.log` | 警告条目 |
| `librpa.in` | 全部 `key = value`（含 `t`/`.f.` 这两种 Fortran 布尔写法、重复键取末值），按 Task/Paths/Screening/Frequency/Parallel/Symmetry/Coulomb/QSGW/Output 分组 |
| `librpa.out` | MPI 规模、**构建出处（git hash / 编译器 / LibRI / GreenX）**、解析后的驱动参数、计时、QSGW 每步进度（`QSGW iteration N: max_delta=… gap=…`）、`libRPA finished successfully` 结束标记 |
| `librpa.d/qsgw_iterations.dat` | 迭代表（按表头把 `max_delta_eV`、残差、`gap_eV`、`converged` 等列映射成字段），并给出首个收敛迭代 |
| `librpa.d/qsgw_eigenvalues.dat` | `iter × channel × spin × kpoint × band` 的本征值长表与能量范围 |
| `energy_qp` | 准粒子能量表（**单位是 Hartree**，不是 eV），含自旋变体 |
| `{KS,EXX,GW}_band_spin_<n>.dat` | 每 k 点一行的能带（eV） |
| `librpa_para_nprocs_<N>_myid_<r>.out` / `librpa.err` / `librpa.exitcode` | 每 rank 日志、标准错误、退出码 |

**两个必须知道的输出分裂**（否则"算完了但看不到结果"）：

- LibRPA 的驱动产物（`energy_qp`、`*_band_spin_*.dat`、每 rank 日志）落在**运行工作目录**，
  而库产物（`qsgw_*.dat`、`Sigc*`、`Wc_*`）落在 `output_dir`（默认 `librpa.d/`）。
  插件两处都读，并标出各来自哪里。
- ABACUS 的主日志名不是固定的：它是 `running_<calculation>.log`（`scf`/`relax`/`md`/
  `cell-relax`/`tddft`…），插件按 INPUT 的 `calculation` 选择。

所有格式都对着本机真实仓库逐条核对过（ABACUS v3.9.0.25、LibRPA
`feature/spin-space-symmetry-20260726`），来源与行号见 [SPEC.md](SPEC.md)。
两份审计报告：[ABACUS 格式清单](../../abacus_io_inventory.md)、
[LibRPA 格式清单](../../librpa_format_inventory.md)。

---

## 扫描根目录：默认值从哪来

面板顶部那个路径框**会记住你上次用的路径**，所以重新打开就是上一次的内容。默认值按这个顺序
决定：

| 优先级 | 来源 | 怎么改 |
|---|---|---|
| 1 | **本浏览器记住的路径**（`localStorage`）| 点「设为默认」固定当前路径；点「用配置默认」取消 |
| 2 | **插件配置 `defaultScanRoot`** | 改 `cordis.patch.yml`（或插件页的配置） |
| 3 | 空 | 手动输入 |

面板侧栏顶部会显示当前生效的是哪一个（「默认（本浏览器记住）：…」或「默认（插件配置）：…」），
所以一条来路不明的预填路径不会再让人困惑。

- 想固定成你常用的目录 → 直接点「设为默认」，**不用改配置文件**。
- 换机器 / 换浏览器 / 清了缓存 → 落到插件配置的 `defaultScanRoot`。
- 团队或脚本化部署 → 设 `defaultScanRoot`，让所有人第一次打开就落在同一处。

当前默认指向 `gw/nio_calculation/from-dongfang`（从东方超算拉下来的那批数据）。

## 安装

本插件零第三方运行时依赖（宿主侧只用 `node:` 内置模块，浏览器侧只用 `react`），
因此不需要 `pnpm install`、不需要构建步骤。

```bash
# 在 DSH 里用插件管理器安装（推荐）
#   plugin_manager install_bundle  target = <本目录>/packages/dsh-abacusflow
```

安装后**完整重启** DSH 并刷新页面：侧边栏出现 **ABACUS** 入口，点击进入任务看板。

自检：

```bash
cd packages/dsh-abacusflow
node scripts/verify.mjs     # 清单/导入/客户端/图标/locale 一致性
node --test test/*.test.mjs # 解析器、面板逻辑与路由测试（251 项）
node scripts/screenshots.mjs # 真实面板截图到 ../../screenshots（需要 Chrome；有页面错误即失败）
```

---

## 结构

```
packages/dsh-abacusflow/
├── package.json            # exports / dsh.bundle.patch / dsh.client
├── cordis.patch.yml        # 挂载到 profile：id=abacusflow
├── locale/{zh,en}.json     # 插件页标题与描述
├── icon.svg                # 侧边栏与插件行图标
├── lib/
│   ├── index.js            # 宿主：/abacusflow/api/* 路由 + 6 个 Agent 工具
│   ├── client.js           # 浏览器：侧边栏入口 + 主页面 + 右侧 dock 标签
│   └── host/
│       ├── scanner.js      # 目录扫描与任务识别
│       ├── task-store.js   # 同一份内存态数据服务
│       ├── task-bundle.js  # 一个任务的完整装配（面板与工具共用）
│       ├── bands.js / kstudy.js / kconvergence.js / library.js / remote.js
│       ├── research-context.js  # 向上查找最近的 research.md（只读）
│       ├── shared/         # 路径与数值工具
│       ├── abacus/         # INPUT / STRU / KPT / INPUT.info / 日志 / 3D 场景
│       └── librpa/         # librpa.in / librpa.out / qsgw_*.dat
├── scripts/
│   ├── verify.mjs
│   ├── preview-server.mjs  # 真实宿主路由 + 真实 client.js 的本地预览
│   ├── screenshots.mjs     # 无头 Chrome 截图（亮/暗、主页面/右侧栏），有页面错误即失败
│   ├── render-preview.mjs  # 真实渲染结果的静态 HTML 快照
│   └── render-band-preview.mjs
└── test/                   # node:test，含真实格式的夹具；client-pure.test.mjs 直接测试面板逻辑
```

## HTTP 接口（面板数据服务）

| 方法/路径 | 说明 |
|---|---|
| `GET /abacusflow/api/ping` | 健康检查 |
| `GET /abacusflow/api/scan?rootPath=&maxDepth=&force=` | 扫描 → 任务树（每项已带 `status`） |
| `GET /abacusflow/api/task-bundle?id=` | 单任务完整数据（输入/结构/日志/QSGW/文件） |
| `GET /abacusflow/api/bands?id=&only=&iter=` | 能带，两步加载：`only=inventory`（约 2 KB 通道清单），再按通道取（约 200 KB） |
| `GET /abacusflow/api/kcompare?ids=a,b&kind=QSGW&spin=1` | k 网格系列：由占据数确定的带边与能隙、k 路径是否相同（只返回标量） |
| `GET /abacusflow/api/kstudy?path=` | k 收敛研究：`<材料>/k444…` 目录树或 `snapshot.json` |
| `GET /abacusflow/api/library/search?q=` / `library/match?id=` | LibRPA 数据库检索 / 按 STRU 组成匹配 |
| `GET /abacusflow/api/library/assets?id=` | 一条记录的资产：图（`kind` 取自 URL 扩展名，`quantity` 取自说明与文件名）、审计 JSON（`audits`，与图分开）、能带表 |
| `GET /abacusflow/api/library/asset?url=` | 代理取回一个资产（只允许 https + 已知数据集镜像；按扩展名给类型，`nosniff`，SVG/JSON 加沙箱 CSP） |
| `GET /abacusflow/api/library/band?id=&url=` | 把记录列出的一个能带表按本地 LibRPA 能带文件的同一套方式解析（k 路径长度、由占据数确定的带边） |
| `GET /abacusflow/api/diagnose?id=` | 阶段诊断：决定性日志行（文件 + 行号）、输入要求 vs 输出、缺失文件、一句结论 |
| `GET /abacusflow/api/research-context?id=` | 从任务目录向上找最近的 `research.md`（只读，最多 9 次 stat） |
| `GET /abacusflow/api/file-size?id=` | 文件大小（只在文件页请求，扫描路径不 stat） |
| `GET /abacusflow/api/file?id=&name=` | 文本预览 |
| `GET /abacusflow/api/open?rootPath=&relPath=` | 直接打开一个目录（不预先全量扫描） |

## Agent 工具

工具由宿主侧注册，**在所有会话里都可用，不需要新建或切换 Agent 预设**——这一点与
VASPFlow 不同（VASPFlow 把 `vasp_*` 限制在它自带的 `vasp` 预设里；DSH 0.2 的
`ctx.tools.register` 已经是全局可见的，本机 AITP 插件也采用同样的做法）。

| 工具 | 作用 |
|---|---|
| `abacus_scan` | 扫描项目，识别 ABACUS / LibRPA / 耦合任务并给出状态 |
| `abacus_inspect` | 1–20 个任务的状态与证据（计算类型、基组、结构摘要、k 点、日志收敛、错误签名、LibRPA 版本与结束标记） |
| `abacus_diagnose` | 一个阶段为什么处于当前状态：决定性日志行（文件与行号）、输入要求 vs 输出、缺失文件、一句结论。与面板「诊断」页是同一个函数 |
| `abacus_convergence` | 1–12 个任务的 SCF 序列（能量/Fermi/能隙/Δρ），面板画曲线 |
| `abacus_structure` | 1–12 个 `STRU` 的晶胞、原子、成键、分子式与 3D 场景 |
| `abacus_inputs` | 1–20 个 `INPUT` 的分组参数与未收录关键字 |
| `abacus_bands` | 1–8 个任务的能带（ABACUS `band.txt`/`bands1-2.txt` + 目录内已有的 LibRPA KS/EXX/QSGW），面板上可用滑杆调能量窗口 |
| `librpa_bands` | 1–8 个 LibRPA 任务的 QSGW 能带随迭代演化（KS/EXX/QSGW × 自旋 × 迭代），判断准粒子能带是否收敛 |
| `librpa_inspect` | 1–20 个 LibRPA 任务的参数、构建哈希、QSGW 迭代表与本征值范围 |

## 能带与收敛的数据处理（运行页「结果」里的能带对比与收敛）

界面结构见上方 *Panel structure*。真实的 ABACUS + LibRPA 数据有三处会让「直接画」失败的坑，插件都已处理：

1. **同一个 `band.txt` 可能装着两次计算。** `out_app_flag` 开启或续算时，ABACUS 会把新的
   k 路径**追加**到旧文件末尾，k 索引在中途重新从 1 开始。直接连成一条线会画出从 k=0
   突然跳回的一段。插件检测块边界、分开保存，默认显示最长的那一块，并在界面上说明。
   （本机 `Bi2Se3-r2/band_full/OUT.soc/band.txt` 就是这种情况：前面 64 行是旧 run，
   后面 364 行才是当前路径。）
2. **`nspin = 2` 的能带分成两个文件**（`bands1.txt` / `bands2.txt`），而 `band.txt` 只有
   单个通道。只读 `band.txt` 会悄悄少一半数据。
3. **LibRPA 每次 QSGW 迭代各写一套**（`{KS,EXX,QSGW}_band_spin_<s>_<iter>.dat`），
   一次 12 迭代的 QSGW 就有 72 个文件、约 61 MB。

面板上的可调项（运行页「结果 → 能带对比」）：

- **能量窗口**：以文件里的费米能为中心的 ±3 / ±6 / ±12 eV、「全部」，或直接输入上下限。
  数据已在浏览器里，改窗口**不会**重新读盘——只有切换迭代号才会重新请求。
- **通道开关**：ABACUS KS 与 LibRPA KS / EXX / QSGW 分别开关，自旋单独切换。
- **QSGW 迭代**：前后翻页或下拉选择第 N 次；在「收敛」图上点迭代点也会切换。

「收敛」把 ABACUS 的 SCF 残差与 LibRPA 的 **QSGW 自洽**（能隙、`max ΔE` 与残差随迭代）并排
画出；阶段视图的 QSGW 页另有完整迭代表，并标出「第 N 次迭代收敛」或「没有一行达到收敛判据」。
尾巴变平说明到达不动点，持续振荡说明没有。

传输体积按需控制：一个完整 QSGW 任务全量约 1.2 MB，面板先用 2 KB 的清单拿到通道列表，
勾选哪个才载入哪个（单通道约 200 KB）。

## 远程超算上的计算（东方 / dongfang）

本机的 `gw/` 目录里有些只是**输入模板**（例如 `nio_calculation/afm-pbe-nonsoc` 只有
INPUT/STRU/KPT，没有 `OUT.*`），真正跑完的输出在东方超算上。处理方式有两种，实测结论是
**拉取而不是挂载**：

| | 挂载（sshfs）| 拉取（本插件的做法）|
|---|---|---|
| 每次目录操作 | 每个 `readdir`/`stat` 一次往返 | 0（数据已在本地）|
| 一个 1473 文件的目录 | 上千次往返 | 一次 `tar` |
| 首次成本 | 连接建立 ~11.5 秒，之后仍逐个往返 | 一次连接 + 一次下载 |
| 之后每次看图 | 仍受网络延迟 | 130–400 毫秒 |

为什么不能挂载：在这台机器上**连 `ssh dongfang true` 都要 11.5 秒**，而且三次重复测都是
11.5–11.8 秒——瓶颈是连接建立（TCP + 认证 + 落到登录节点），不是命令本身。挂载会把每个
目录项变成独立操作，界面会假死。Windows 版 OpenSSH 的 `ControlMaster` 连接复用也不可用
（报 `getsockname failed: Not a socket`），所以无法靠复用把 11.5 秒摊掉。

插件的做法是**一次连接干尽可能多的事**：

- `abacus_remote_list` —— 一条远端 `find` 返回该 run 下**全部**任务及其输入文件、`OUT.*`
  目录。实测 13 个任务、12.2 秒（其中 11.5 秒是连接）。
- `abacus_remote_pull` —— 远端只打包绘图需要的文件再下载。实测一个 **37 GB** 的 NiO run
  打包后 **2.0 MiB / 45 个文件**；Bi2Se3 用 **0.8 MiB**。拉完后在本地看，速度和本地数据一样。

配置项（`cordis.patch.yml`）：`remoteHost: dongfang`、
`remoteLocalRoot: \\wsl$\...\gw\nio_calculation\from-dongfang`。也可以直接跑
`scripts/remote/pull-plot-subset.ps1 -Run <远端run名>`。

两个在 UNC 路径上真实踩到的坑，脚本里已处理：

1. **`tar.exe` 解不开**——它走 `\\?\UNC\...` 加元数据的代码路径，对某些成员名报
   `Invalid argument`（同一个路径直接写文件却成功）。改用 `scripts/remote/extract-tar.mjs`
   （Node 的 fs 走普通 Win32 路径）。
2. **符号链接**——真实 run 里 `run/librpa.in` 常是指向 `../librpa.in` 的软链，目标在打包
   范围之外。打包器现在**解引用**链接，把真实内容取进来，否则那个目录不会被识别成 LibRPA 任务。

已拉到本地可直接打开的三个数据集（都在 `from-dongfang/` 下）：

| 数据集 | 任务 | 能带 |
|---|---|---|
| `nio-matched-dzp-k666-20261016-r1` | 7（6 ABACUS + 1 LibRPA）| DZP 364k×80b 双自旋；qsgw 目录 KS/EXX/QSGW × 2 自旋 |
| `bi2se3-soc-abacus-reexport-20261025-r1` | 3 | band_full 101k×220b；QSGW KS/EXX/QSGW |
| `bi2se3-soc-qsgw-option5-20261016-r1` | 2 | 同上，另有 validation 副本 |

注意 `producer/TZDP/03_bands` 在远端**本来就没有 `OUT.*`**（波段那步没跑），所以它没有能带
不是插件漏读。

## k 点收敛研究（面板「k 收敛研究」）

扫描结果里名字只差网格记号的运行（`si-qsgw-k444-…` 与 `si-qsgw-k666-…`）会自动归为一个系列，
用 `/kcompare` 给出每个网格由占据数确定的能隙；也可以填 `snapshot.json` 或运行目录树。

一次 k 收敛研究不是「一个任务」，而是**一组只差响应网格的 QSGW 计算**。关键对象是
「网格 × 迭代」的一张面，而不是一条曲线——单看一个 run 的自洽收敛回答不了 k 收敛问题。

插件支持两种证据形态，按目录内容自动选择：

1. **活的 run 目录树**：`<材料>/k444`、`k555`…，各含 `librpa.d/qsgw_iterations.dat`。
2. **分析快照**：活动脚本产出的 `snapshot.json`（含每个 case 的 `native_rows`）以及相邻的
   `comparison.json`。**原始 run 被清理后，这是唯一幸存的记录**，所以插件直接读它，而不是
   要求原始目录还在。

面板给三样东西：每个网格的「能隙随更新次数」曲线（看该网格是否自洽）、相邻网格能隙差表
（这才是收敛判据）、以及活动记录的 `limitation`。**它不判定「收敛了」**——多少 meV 可接受
取决于你选的数量与容差。

### 实测：Si 的 k444 → k888（2026-10-18 的活动）

```
k444   9 iters  gap 0.7094 -> 1.6503 eV
k555   9 iters  gap 0.5688 -> 1.4521 eV
k666   9 iters  gap 0.7094 -> 1.5625 eV
k777   9 iters  gap 0.5617 -> 1.3987 eV
k888   9 iters  gap 0.6040 -> 1.4248 eV

相邻网格能隙差：k444→k555  -198.2 meV
                k555→k666  +110.3 meV
                k666→k777  -163.8 meV
                k777→k888   +26.2 meV
```

**这不是单调收敛**：能隙随网格来回振荡，只是最后一步（26 meV）明显小于第一步（198 meV）。
只看最后两点的差会误以为已经收敛——这正是要把整张面画出来的理由。

数据位置（可直接填进面板）：
`gw/workspace/qsgw/k-convergence-master-20261012/analysis/kmesh-convergence-20261018/snapshot.json`
同目录还有活动自己出的 `Si-bands-k666-k777-k888.png`、`Si-kmesh-convergence.png` 可对照。
命令行等价物：`node scripts/probe-kstudy.mjs <目录或snapshot.json> [--material Si]`、
Agent 工具 `abacus_kstudy`。

### 另一种输入：多个 run 同 k 路径并排

原始 run 还在时，`lib/host/kconvergence.js` 能把多个任务对齐到同一 k 路径逐点比较。本机
`si-qsgw-k*-headwing-kconv-*` 那一对（k444/k666）k 路径完全相同（201 点、长度 4.6324、
44 条带），实测：

| | QSGW 能隙 | KS 能隙 |
|---|---|---|
| k444 / frozen | 1.2178 eV | 0.5430 eV |
| k666 / frozen | 1.2247 eV | 0.5578 eV |
| 差 | **+6.9 meV** | +14.8 meV |

能隙按**每个 k 点**取 HOMO/LUMO 再取极值（不是全局 min/max）。这里踩过一个真坑：EXX 文件里
有空态落在 −45.5 eV，全局 min 会算出 −50 eV 的假能隙；现在这类「空态低于占据态」的 k 点
会被识别并排除，并报告排除了几个，而不是悄悄给个好看的数。

## 能带图的 k 路径刻度（Γ / Z / F …）

能带图的横轴是累积 k 路径长度，光有长度读不了——读者要知道路径在哪里拐弯。所以刻度必须
来自**定义这条路径的那个 `KPT` 文件**：

```
K_POINTS
 5
Line
   0.00000000   0.00000000   0.00000000   10     #Γ
   0.00000000   0.00000000   0.50000000   30 #Z
   0.50000000   0.50000000   0.00000000   30     #F
   0.00000000   0.00000000   0.00000000   30     #Γ
   0.50000000   0.00000000   0.00000000   1      #L
```

`#` 后面就是高对称点名字，每条线末尾的数字是该段的插值点数。知道这两样就能算出每个标签在
展开后的 k 点序列里的**下标**，再映射到路径长度，刻度就落在正确位置。

实测（Bi2Se3，101 个 k 点）：`Γ(0) Z(10) F(40) Γ(70) L(100)`，位置
`0 / 0.052 / 0.193 / 0.337 / 0.477`。NiO 的 13 个点（含 `B1`、`P1` 这种带数字后缀的）也
全部正确。

几个刻意保留的行为：

- **重复标签保留**：`Γ` 出现两次是真的（路径回到 Γ），删掉会让两侧段标错。
- **大小写原样**：`# G` 就是 `G`，不擅自改成 `Γ`。
- **索引越界就丢弃，不夹到边缘**：能带文件被截断/重导出时 k 点可能少于 KPT 声明，夹边会把
  标签放到错误位置。
- **没有标签就不画**：均匀网格的能带计算没有高对称路径，凭空造刻度比没有更糟。

## LibRPA 数据库（运行结果「关键数值」与「数据库」）

对应 <https://github.com/AroundPeking/LibRPA-database>：122 条记录、52 种材料。

### 自动匹配：你算的材料是什么

打开一个运行时，插件会**自动**判断它是什么材料，并把匹配到的记录的能隙直接列在「关键数值」
里本运行的能隙下方；「数据库」页列出全部匹配和整个目录。判据按可靠性排序：

| 优先级 | 来源 | 例子 |
|---|---|---|
| 高 | **STRU 的原子计数** | Ni₂O₂ → `NiO`；Bi₂Se₃ → `Bi2Se3` |
| 中 | 目录名 | `nio-matched-…` → `NiO` |
| 低 | 上级目录名 | `si-qsgw-…/frozen` → `Si` |

匹配到的记录会与本地任务并排显示（GW 能隙 / DFT 能隙 / 维度 / 适用范围 / 软件版本）。

三个踩过的坑，都在代码里留了注释：

1. **必须数 `atoms`，不能读 `ATOMIC_SPECIES`**。后者每种元素只列一次，Bi₂Se₃ 会被读成
   `BiSe`，匹配不到任何记录。
2. **化合物要约分**：NiO 的常规胞是 2+2，不约分就成了 `Ni2O2`，同样匹配不到。
3. **单元素不能约分**：数据库里 `Si2`、`C2`、`Li2`、`N2` 是与 `Si`/`C`/`Li`/`N` 并列的
   独立记录（分子有固定化学计量）。所以 `Si4` 不约成 `Si`；两原子的 Si 胞会**同时**给出
   `Si2` 和 `Si` 两个候选，因为块体原胞和二聚体在这个信息量下无法区分。

面板不会替你选一条。匹配不到就明说「没有匹配」，并按目录名给弱候选。

### 与已发表记录对照（运行结果「与已发表记录对照」）

有匹配时，结果页多一节（默认收起）：

- **能隙**：本地 KS 能隙（ABACUS 日志）、本地 GW 系能隙（`qsgw_iterations.dat`）与记录的
  `dft_gap_ev` / `exx_gap_ev` / `gw_gap_ev` 并排，各自写明来源；差值后面列出这一对数里哪些字段
  不同、哪些无法核对。本地没有的量不编造。
- **能否直接比较**：方法、程序、版本、数值原子轨道、赝势、辅助基、SCF k 网格、原子数、自旋、
  SOC、能隙定义逐项列出，各按来源原样写，判断为「相同 / 不同 / 无法核对」。记录里只有说明
  文字的（自旋、SOC）标注「据记录说明文字」；LibRPA 的 `GITDIR-NO*` 不当作提交号。
- **能带**：记录的能带表与本地对应的 LibRPA 通道（GW ↔ QSGW）。k 路径逐点相同才画在同一坐标
  上，否则分两张图并写明原因（例如「k 点数不同（364 vs 126）」）；纵轴是各自的 E − E_VBM（带边
  由占据数确定），缺占据数时保持绝对能量并说明零点不同。不插值、不重采样、不平移对齐。

### 记录里的图

「数据库」页展开一条记录：图按物理量分页（KS / EXX / GW / 对比 / 其他），类型看 URL 扩展名而
不是说明文字（库里有 214 张 SVG、46 张 PNG、46 张 PDF）；PNG 与同名 PDF 合成一张卡片，PDF 是
链接；审计/来源 JSON 单独列出，展开后按层级看结构，也可以看原文。没有图的记录直接说没有。

### 安装数据库

```powershell
git clone --depth 1 --filter=blob:none --sparse https://github.com/AroundPeking/LibRPA-database `
  F:\AI_Workspace\dsh-abacusflow\database\LibRPA-database
cd F:\AI_Workspace\dsh-abacusflow\database\LibRPA-database
git sparse-checkout set data/calculations README.md archive-completeness.json
```

约 190 MB。插件配置 `libraryRoot` 指向这个目录。

## 阶段诊断（阶段页「诊断」）

每个阶段多一个「诊断」页；状态不是「已收敛/已完成」时，状态旁有「为什么？」。内容来自
`/diagnose`（Agent 工具 `abacus_diagnose` 用同一个函数）：

- **一句结论**，只由下面的证据推出，例如「运行被终止：作业被调度器取消（CANCELLED）（librpa.err
  第 1 行）」。
- **关键日志行**：致命签名（含 ABACUS 的 `!NOTICE!` 中止及其消息）、收敛结论、结束标记、LibRPA
  最后一次 QSGW 迭代、`librpa.exitcode`；没有结束标记时引用最后一行。调度器输出（`slurm-*.out`、
  `librpa.err`）里的时限、OOM、抢占、取消也会被引用，相同的横幅只引一次。
- **输入要求 vs 输出**：`scf_nmax`/`scf_thr` 与最后一步、`nbands` 与能带文件的带数、`nspin = 2`
  与两个自旋的能带文件、各 `out_*` 与对应文件、`rpa 1` 与导出文件、`init_chg file` 与电荷密度、
  `qsgw_max_iter`/收敛判据与迭代表。
- **缺少的文件**（必需 / 通常会有）与**注**（无法核对的：集群路径的 `input_dir`、本地不存在的
  `pseudo_dir` 等）。
- 「交给 Agent…」把整份诊断放进对话栏里的草稿，看过、改过再发。

本地文件常常只是从集群拉回的一部分：INPUT 要求而本地没有的输出标为「本地没有：没有产出，或
没有拉回本地」，不会说成「没有产出」。

## 问 Agent（对话栏）

主页面（`main` 槽）拿不到 `sessionId`，右侧栏拿得到。两处都通过 DSH 的 `sessions` 服务找会话：
有槽给的 id 就用，否则用工作区保持为 `mainView` 的那个会话（DSH 自己的标题栏用同一规则）。
发送与 DSH 输入框完全一致：`beginSubmission`（画出待发气泡）之后 `prompt`（真正发出）。状态行
跟着 DSH 的回报走：正在发往… → 已接收（Agent 正忙时排在当前回合之后）→ 已出现在对话里，或
「没有送达：<原因>」，包括接收之后又被撤下的情况。找不到会话时不发送，原因单独一行显示，按钮
变成「复制」。每次解析在开发者工具里留一行 `[abacusflow] ask box …`，写明试了哪个访问路径、
返回了什么。

## 已知边界

- 只读：不写输入、不提交作业。「交给 Agent」只组织消息；计算由对话里的 Agent 执行。
- `wsl.exe` 在某些 Windows + WSL 组合下不可用（`WslService` 拒绝访问）；插件本身
  不依赖 WSL，WSL 内的路径通过 `\\wsl$\<distro>\...` 这类 UNC 路径同样可读。
- 大日志按上限读取（默认 24 MB/文件）；超出部分截断，并在 `logTruncated` 标注。
- 结构成键用周期最小像 + `1.2×(r_i+r_j)` 判据；原子数超过 2000 时跳过成键并标注
  `connectivityLimited`。
- 未实现 `abacus_build_inputs` 这类**写入**能力——ABACUS 的 `STRU` 物种/磁矩/约束
  语义比 VASP 的 POSCAR 复杂，写入路径必须先有明确的约束约定，不能靠推断。

## License

MIT
