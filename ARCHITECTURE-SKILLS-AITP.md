# ABACUS + LibRPA 工作台的架构建议

这份文档回答两个问题：**怎么让 ABACUS+LibRPA 自动跑起来（结合 skill 知识库）**，以及**怎么组织成像某个课题那样有序、便于以后并进 AITP**。

结论基于对现有 DSH / AITP 代码结构的实测，不是设想。

---

## 一、先看清已有的东西，不要另起炉灶

我查了本机实际存在的结构，有三个决定性发现：

### 发现 1：skill 的形态已经固定

AITP 的 skill 就是 `skills/<name>/SKILL.md` + `references/`（知识）+ `scripts/`（可执行校验），前面是两行 frontmatter：

```
---
name: aitp-research
description: ...
---
```

DSH 从 `C:\Users\samur\.dsh\skills\` 和 profile 里发现 skill。**不需要发明新格式**。

### 发现 2：`aitp-research` 里已经有 LibRPA 方法库

```
skills/aitp-research/methods/
├── librpa/
│   ├── README.md                    ← 方法索引
│   ├── developing-librpa/           ← 改 LibRPA 源码
│   ├── ren-gw-notation/             ← GW 推导与记号
│   └── ren-gw-writing/              ← 写论文
└── quantum-chaos/
```

而 `methods/librpa/README.md` 里已经**外链**了一个独立 skill：

> **ABACUS–LibRPA basis preparation** (`abacus-librpa-gw-basis`)：准备/审查匹配的赝势、NAO、辅助基组时用。

**这就是缺口所在**：现有覆盖「推导」「改源码」「写论文」「选基组」，**没有覆盖「跑一次完整计算」**——怎么设 SCF/NSCF/export、怎么喂给 LibRPA、QSGW 怎么迭代、失败怎么诊断。

### 发现 3：AITP 的课题结构很简单，但要求严格

真实的课题目录长这样：

```
gw/abacus-librpa-audit/
├── research.md          ← 唯一主笔记（研究问题的答案与当前状态）
├── data/                ← 数据
└── soc-density-exchange.md
```

`research.md` 的章节是固定的：`Current work`（带日期的进展）、`Curated materials`（材料清单）、然后是各个论断章节。

课题 = 含 `research.md` 的目录。顶层只允许 `notes/ references/ code/ calculations/ manuscripts/ data/ figures/ reports/`。

---

## 二、架构建议：三层，各管各的

```
┌─────────────────────────────────────────────────────────────┐
│  第 3 层  AITP 课题（知识在哪、结论是什么）                    │
│  topics/gw/<课题>/research.md + data/ + notes/               │
│  由 agent 用 research_* 工具维护                             │
└───────────────────────▲─────────────────────────────────────┘
                        │ agent 写结论、链证据
┌───────────────────────┴─────────────────────────────────────┐
│  第 2 层  Skill 知识库（怎么算才对）                          │
│  methods/librpa/running-abacus-librpa/SKILL.md               │
│  + references/（参数、判据、失败模式）+ scripts/（校验）       │
│  由 agent 读，不执行                                          │
└───────────────────────▲─────────────────────────────────────┘
                        │ agent 按知识决定下一步
┌───────────────────────┴─────────────────────────────────────┐
│  第 1 层  dsh-abacusflow 插件（看到什么、怎么发起）            │
│  只读可视化 + 状态诊断 + 组消息给 agent                        │
│  不跑计算、不写输入、不提交作业                                │
└─────────────────────────────────────────────────────────────┘
```

**关键分工，一句话**：

| 层 | 回答 | 谁执行 |
|---|---|---|
| 插件 | 「现在算出什么了？哪里不对？」 | 它自己，只读 |
| Skill | 「这种情况该怎么算？」 | agent 读，作为判断依据 |
| AITP 课题 | 「我们知道什么？证据在哪？」 | agent 写 `research.md` |

**插件永远不执行计算。** 这是它现在最重要的性质，也是它能安全留在界面里的原因。计算由 agent（可以是 VASPilot 那类外部工具，也可以是 DSH 里的 shell）执行。

---

## 三、要新建的 skill：`running-abacus-librpa`

放在 `methods/librpa/running-abacus-librpa/`，与现有三个方法并列。这是**当前最大的缺口**。

### 建议的 SKILL.md 骨架

```markdown
---
name: running-abacus-librpa
description: Run and diagnose a complete ABACUS → LibRPA GW/QSGW workflow:
  SCF, NSCF/export, band path, LibRPA G0W0 or QSGW with iteration control,
  and the failure modes that make a step silently produce nothing.
---

## Read when
跑或诊断一次 ABACUS→LibRPA 计算时；判断某步输出是否可信时。

## The pipeline and its file contract
（每步的输入、输出、决定"成功了"的证据）

  ABACUS SCF        → 密度          证据：#SCF IS CONVERGED#、Total Time
  ABACUS NSCF/export→ WFK/CSR/matrix 证据：OUT.<suffix>/ 下对应文件存在
  LibRPA G0W0/QSGW  → 自能、QP      证据：librpa.out 或 qsgw_iterations.dat
  能带              → KS 与 QSGW 同 k 路径

## Checks before trusting a result
- 占据数是否为 0/1 或 0/2（决定能否从占据数推带边）
- k 路径是否与 KPT 一致（决定能否叠加）
- QSGW 是否真收敛（max ΔE 趋势，不是单点）
- 两个来源的能量零点（ABACUS 绝对 eV vs LibRPA 内部零点）

## Failure modes（每种都写：症状 → 判据 → 下一步）
- 目录有输入无输出          → 该步没跑，不是插件漏读
- 有产物无 librpa.out        → 结果在，日志没留（FINISHED_NO_LOG）
- QSGW 不收敛               → 看 max ΔE 是否单调下降
- 空态低于占据态            → 未收敛或标记错，能隙不可用
- k 路径不一致              → 只能比标量，不能逐点比曲线

## What not to conclude
（不许从索引推能隙、不许外推收敛、不许强行对齐两条曲线）
```

### references/ 里放什么

| 文件 | 内容 | 来源 |
|---|---|---|
| `abacus-inputs.md` | 每个 INPUT 关键字的含义与推荐值 | 从你的实算 INPUT 反推 + ABACUS 文档 |
| `librpa-inputs.md` | `librpa.in` 各组参数 | 现有 `lib/host/librpa/input.js` 已解析 |
| `kpoint-and-path.md` | KPT Line 模式、高对称点、路径长度 | 现有 `kpt.js` 已实现 |
| `diagnostics.md` | 失败签名表 | 现有 `log.js` / `output.js` 已有部分 |
| `convergence-criteria.md` | 怎么判断收敛 | 你的 k444–k888 实测数据 |

**重要**：这些内容很多已经写在插件的解析代码里了（`lib/host/abacus/input-params.js` 就有 50 KB 的参数知识）。skill 不必重写，**从代码里提炼成人能读的判据**即可。

### scripts/ 里放什么

现有 skill 的 `scripts/` 是可执行校验（如 `check_lartree_derivation.py`）。建议：

- `check_run_completeness.py` — 给一个 run 目录，报告每步是否完整（复用插件已有的判断）
- `compare_gaps.py` — 给多个 run，算相邻网格差（对应 `kconvergence.js`）

这两个正是把插件的能力**暴露给 agent 的 CLI 形式**，让 agent 不必通过界面。

---

## 四、让"某个课题"变有序：一个课题该有的样子

你说希望"对于某个课题很有序的架构"。建议每个 ABACUS+LibRPA 课题都用同一套骨架：

```
topics/gw/<课题名>/
├── research.md                    ← 唯一主笔记
│   ## Current work                ← 带日期的进展（用 research_log 写）
│   ## Curated materials           ← 材料清单（链接到具体数据）
│   ## 各论断章节                   ← 结论 + 证据链接
├── data/
│   └── runs/                      ← 计算本体（或 symlink 到别处）
│       ├── <run-id>/
│       └── README.md              ← 每批从哪来、怎么重拉
├── notes/
│   ├── method.md                  ← 这个课题用的方法（链接到 skill）
│   └── <专题>.md
├── calculations/                  ← 自己的脚本与运行记录
└── figures/                       ← 出图
```

**三条硬约定**（避免以后混乱）：

1. **一个课题一个 `research.md`，`Current work` 永远是最新的**。这是 AITP 的核心，也是以后别人接手时唯一该先读的东西。
2. **数据只放 `data/` 或 `calculations/`**，文件名带来源（`from-dongfang` 好过 `data1`）。每批数据配一个 README 说明远端 run 名和重拉方法。
3. **结论必链证据**：`research.md` 里每个数字都要能点到具体文件。模型/命令产出不复制进笔记，只写链接。

这些正是 `aitp-memory` / `aitp-desk-writing` 已经规定的东西，**直接沿用，不要另立规矩**。

---

## 五、自动跑起来：具体怎么串

你说要"自动跑起来"。现实中它是一条链，每一环都要有人负责：

```
用户: "算 MoS2 的 QSGW 能带，k666"
  │
  ├─▶ 插件：组一条结构化请求（材料、方法、k 网格、要算什么）
  │        ← 这是 §4.4，尚未实现
  │
  ├─▶ Agent：读 skill `running-abacus-librpa`
  │        决定：先 SCF → NSCF/export → LibRPA → 能带
  │        查 references/abacus-inputs.md 定参数
  │
  ├─▶ Agent 执行：写输入、提交 Slurm（用已有脚本/工具）
  │        ← 不是插件做的
  │
  ├─▶ 插件：轮询该目录，显示各阶段状态、诊断异常
  │        ← 已有能力，只需指向新 run
  │
  └─▶ Agent：把结论写进 research.md（research_log）
           链接到 data/runs/<run-id>
```

**这条链里唯一缺的是两端**：插件侧的"请求构造"（§4.4）和 skill 侧的"该怎么算"。

中间的执行环节 DSH 已经有了（agent 能跑 shell、提交作业），不需要我们再造一个 MCP 服务——除非你发现 DSH 的 shell 权限不够。

> **不要照搬 VASPilot 的架构**。它是 CrewAI + MCP + Flask，四层进程，因为它在做**独立产品**。你在 DSH 里，agent、对话、界面都有了，再造一套 MCP 服务只是重复。**要学的是它的知识组织方式（RAG 知识库 + 强制不编造），不是它的进程架构。**

---

## 六、落地顺序（建议）

| 步骤 | 做什么 | 为什么先做这个 |
|---|---|---|
| 1 | 修好插件的两个 bug（图不显示、发送不了）| 不修则一切无从验证 |
| 2 | 建 `running-abacus-librpa` skill 的 SKILL.md 骨架 + `diagnostics.md` | 立刻让 agent 有据可依；诊断知识已经存在 |
| 3 | 插件加 §4.4「计算请求」构造 → agent | 这是自动跑的入口 |
| 4 | 插件 §4.1 诊断页（症状 → 判据 → 下一步）| 和 skill 的 diagnostics 互为表里 |
| 5 | 建第一个"示范课题"，跑通整条链 | 有一个真实样板，之后照抄 |
| 6 | `references/` 补全（参数、收敛判据）| 可以边用边补 |
| 7 | 上传数据库（§4.3）| 最后做，因为它会写文件 |

**第 5 步最重要**：先做一个**完整的示范课题**，从 `research_init` 建课题 → 跑一次 ABACUS+LibRPA → 写 `research.md` → 用插件看结果 → 和数据库对比。这个样板跑通后，"有序"就不再是设计，而是可复制的流程。

---

## 七、需要你决定的

1. **skill 放哪**：`aitp-research/methods/librpa/running-abacus-librpa/`（跟现有 LibRPA 方法一起，推荐），还是独立成 `skills/abacus-librpa-running/`（像 `abacus-librpa-gw-basis` 那样被外链）？

2. **示范课题选哪个材料**：MoS2（你有 strict-2d 数据）、NiO（有 QSGW 全流程）、还是 Bi2Se3（有 SOC 与 220 带）？

3. **谁来执行计算**：DSH agent 直接跑 shell（简单，但要注意长时间作业），还是接你超算的 Slurm（真实，但要处理排队与轮询）？
