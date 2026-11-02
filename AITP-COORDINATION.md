# AITP 文件夹架构 与 dsh-abacusflow 的协调

这份文档记录两者的边界、当前实际状态，以及需要你决定的事。结论都来自实测，不是推测。

---

## 一、两者是什么关系

**dsh-abacusflow 不是 AITP 课题的一部分，而是一个观察 AITP 数据的工具。**

| | AITP 科研工作台 | dsh-abacusflow |
|---|---|---|
| 管什么 | **知识与证据**：research.md、笔记、文献、结论 | **计算产物**：INPUT/STRU、OUT.*、librpa.in、能带、QSGW 迭代 |
| 主笔记 | `research.md`（唯一权威） | 无 |
| 目录规则 | 顶层只允许 canonical/legacy 名单 | 无规则，任意目录都能扫 |
| 生命周期 | 长期，跨会话 | 随时重开，只读 |
| 位置 | `\\wsl$\...\physics\topics\` | 插件在 `F:\AI_Workspace\dsh-abacusflow` |

一句话：**AITP 记「我们知道了什么」，插件看「计算算出了什么」**。两者不该互相吞并。

---

## 二、实测的当前状态

### 2.1 AITP 的规则（权威，来自 placement-rules.json）

- 课题 = 含 `research.md` 的目录。实测 **`topics` 才是课题根**，`gw` 没有 research.md。
- 顶层只认这些名字：
  - canonical：`notes references code calculations manuscripts data figures reports`
  - legacy：`results workspace sources scripts theory manuscript development software plan analysis runs skills`
- 脚本/数据类扩展名有路由限制（`.dat` 只能进 data/results/figures/calculations/workspace 等）。

### 2.2 我这次放的数据在哪

```
\\wsl$\<distro>\home\<user>\physics\topics\gw\nio_calculation\from-dongfang
```

**105.8 MB / 661 个文件**（5 个从东方超算拉下来的数据集）。

判定结果：

| 检查 | 结果 |
|---|---|
| 会被 AITP 拒绝吗 | **不会**。AITP 只检查路径第一段，这里是 `gw`，在 legacy 名单里 |
| 符合 AITP 的规范意图吗 | **不完全**。规范意图是放在课题的 `data/` 或 `calculations/` 下 |
| AITP 面板能看到它吗 | **看不到**。`nio_calculation` 不在 scanDirs，也不是课题 |
| 插件能扫到吗 | 能（插件不依赖 AITP 规则）|

> 注：我曾用 `project=nio_calculation` 调 `research_write`，被明确拒绝（"from-dongfang/ 不是规范的顶层材料目录"）——那是因为把它当成了课题根。放在 `gw/` 下的实际路径不受影响。

### 2.3 还有个真实问题：工作区根散落文件

```
F:\AI_Workspace\abacus_io_inventory.md     54.5 KB   ← 我生成的审计报告
F:\AI_Workspace\librpa_format_inventory.md 58 KB     ← 同上
```

躺在工作区根，既不属于 AITP，也不属于插件包，没人会找到它们。

---

## 三、三种可选方案

### 方案 A：数据留在原处（零搬迁）

```
gw/nio_calculation/from-dongfang/        ← 现状
```

- ✅ 不动 105 MB，零风险
- ✅ 插件照常扫
- ❌ AITP 面板看不到，`research_check` 不统计
- ❌ 从 AITP 的 `data/` 下找不到溯源链接

**适合**：这些数据只是「临时看一眼」，用完可删。

### 方案 B：搬进课题的 data/，并用符号链接保持插件路径不变（推荐）

```
gw/abacus-librpa-audit/data/remote-subset/     ← research_path 指定的规范位置
gw/nio_calculation/from-dongfang -> ../abacus-librpa-audit/data/remote-subset   （链接）
```

- ✅ 符合 AITP 规范，`research_check` 能看到
- ✅ 插件原来填的路径仍然有效（符号链接透明）
- ✅ 在课题的 research.md 里可写相对链接指向具体数据
- ⚠️ 需要一次移动 + 建链接；Windows 上符号链接需要权限（可改用 junction）

**适合**：这批数据要长期保留、要能溯源。

### 方案 C：分成"索引 + 数据"两层

```
gw/abacus-librpa-audit/data/remote-subset/README.md    ← 只写索引：从哪拉、什么版本、怎么重拉
<大数据实际存放处，可以是 F: 盘或超算>                  ← 不搬
```

- ✅ 符合 AITP「大文件数据放这里；保留远程位置的精确说明」的原意
- ✅ 105 MB 不必进 topics 树
- ⚠️ 数据本身不在 AITP 视野内，靠 README 记录指针

**适合**：数据可随时从超算重拉，本地只是缓存。

---

## 四、需要你决定的三件事

1. **这 105 MB 留还是搬？** 决定选 A/B/C。
2. **两份审计报告**（`abacus_io_inventory.md`、`librpa_format_inventory.md`，共 112 KB）
   要不要移进 `gw/abacus-librpa-audit/references/`？它们现在是孤儿文件。
3. **插件的「从超算拉取」应该落到哪？** 现在是硬编码到 `from-dongfang`（插件配置
   `remoteLocalRoot`）。更合理的是每次拉取时指定目标，或默认落到课题的 `data/`。

---

## 五、无论选哪个，建议固定下来的约定

- **插件源码不进 topics 树**。它是工具，放 `F:\AI_Workspace\dsh-abacusflow`；
  AITP 的 `code/` 是给「属于某个课题的计算脚本」用的。
- **AITP 的 research.md 只写链接，不复制数据**。例如在 `gw/abacus-librpa-audit/research.md`
  里写 `[NiO/Bi2Se3/Si 超算数据子集](data/remote-subset/README.md)`。
- **每次拉取留一个 README**：远端 run 名、拉取时间、只取了哪些文件、怎么重拉
  （`abacus_remote_pull` 或 `scripts/remote/pull-plot-subset.ps1`）。
  否则三个月后没人能判断这堆文件是什么。
- **`from-dongfang` 这类名字带来源**。它说明数据来自哪台机器，比 `data1/` 有用。
