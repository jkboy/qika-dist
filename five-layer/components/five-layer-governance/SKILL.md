---
name: five-layer-governance
description: 治理 Pi Agent 五层内容的归属和跨层生命周期。仅在明确涉及 AGENTS、SKILL、KNOWLEDGE、EXPERIENCE、HOOK 的搭建、归类、迁移、跨层查重或废弃时使用；只审计 AGENTS/skills 臃肿时用 doctor，普通编码任务不要使用。
---

# Pi 五层治理

先完整读取 [`../../FIVE-LAYER.md`](../../FIVE-LAYER.md)，再执行治理。此 skill 只管理结构与归属，不承载具体业务知识。

## 输入分类

- 新内容：判断是否值得持久化及所属层。
- 跨层审计：检查错位、重复主源、冲突、孤岛和召回失效。
- 迁移请求：指定唯一主源，更新召回入口后再清理旧位置。
- Hook 请求：先确认能否用确定性信号判断。

只检查 AGENTS / SKILL 的长度、软规则或描述重叠时改用 `doctor`；不同时承担两套审计流程。

## 执行步骤

0. **拿真实加载集**（跨层审计必做）：先跑 `qika doctor`，以它列出的上下文文件、技能（含 `~/.agents/skills`）、扩展为准和各层入口对账；入口没指到的就是孤岛。
1. **限定范围**：列出本次涉及的层、全局/项目作用域及目标文件；不顺手迁移无关存量。
2. **找失败证据**：写明要防止的已观察失败，并写成可重放样本（一句可原样重发的任务措辞 + 一句期望不再出现的行为）。没有证据时留在 task 候选区。
3. **查重与冲突**：检查对应 AGENTS、skill 描述、knowledge/experience 索引和 extension registry；并查 [`../../knowledge/governance-decisions.md`](../../knowledge/governance-decisions.md) 决定日志——命中已拒候选时，无新事实不重新评估，有新事实按该条“推翻条件”重新论证。
4. **判断归属**：按 FIVE-LAYER.md 的边界决策；不能为方便而复制到多层。
5. **设计召回**：至少接入一个入口：AGENTS 路由、skill 描述/引用、索引项或 extension 事件。
6. **定义退出**：写明提升、复核、deprecated 或删除条件；能机械判定的写成 frontmatter `exit_check`（命令）+ `exit_expect`（期望输出），由 [`scripts/exit-check.mjs`](scripts/exit-check.mjs) 执行（发版清单召回）——只写散文的退出条件满足了也没人执行。
7. **最小实现**：只创建当前需要的文件，不创建空业务目录或示例内容。
8. **验证**：检查链接、索引、skill frontmatter、extension 加载，以及 hook 正反例；新建 skill 或改动其触发条件后，开新会话用自然任务措辞（不点名 skill）实测是否被加载，未加载则修 description 或任务措辞假设。**同时实测近邻负样本不被误加载**（相邻 skill 地盘上的措辞：同关键词、邻居 skill 该管的请求）；正负措辞一并存 `<skill>/evals/trigger.json`（`[{"query","should_trigger","route?"}]`），跑 `node scripts/skill-trigger-eval.mjs <skill名>`（路径相对本 skill 目录；需要 `pi` 命令行在 PATH 上——没有就跳过这一步，报告里写明「无触发回归证据」；真实安装态 `pi -p --mode json`、空目录 cwd、只看第一条 assistant 消息路由到哪个 skill；约 7s / 6k token 一条，走 settings 默认模型，`--model/--provider` 可换；`Request timed out.` 多是网络出口抖动不是路由错，脚本自动重试一次）。下次改描述时全部重跑——只补正向会把描述越写越 pushy，直到吞掉邻居。基线以各 skill 的 `evals/trigger-results.json` 为准（脚本写回，含时间与实际模型），不在本文抄数字。全行「无效运行」且报 403/region 时是 settings 默认模型失效、pi 回落到了被封模型，用 `--provider/--model` 显式指定 models.json 里存在的模型。

## 消融（跨层审计的减法步骤）

审计时对补认知类条目逐条执行：拔掉该条 → 新会话原样重发其可重放样本 → 目标行为复发则留，不复发则删（HOOK 层等价于禁用规则后跑正例）。只删结构性条目，不删补信息条目（路径、端口、协议真源、边界——删了必坏，不用测）。无可重放样本的条目标"不可消融"列入报告，不删。删除记入 `knowledge/governance-decisions.md`（撤销类）。审计时顺带跑一次 `node scripts/exit-check.mjs`，退出条件已满足的条目直接按「废弃规则」处理。

## 跨会话复发体检（从失败出发找漏报）

```
node scripts/recurrence-probe.mjs            # 近 30 天，跨 ≥3 个会话；--days / --min-sessions / --all / --json
node scripts/recurrence-probe.mjs --judge <id> fixed|awaiting-release|recorded|tracked|ignore "<说明>"
```

命中统计、裁决、exit-check 都以已有条目为锚；本脚本从工具报错出发，报三类：① 反复出现却两侧经验库都没记过的报错；② 召回断开的知识页（触发词出现在报错里多于用户输入里——知识指针只看用户输入）；③ 只有另一个宿主的库记过的坑。处置按每条三选一，**先问根因在不在环境或工具**：
- 环境/工具缺陷（报错文案误导、配置失效、命令别名坏了）→ 修根因，记 `fixed`。判定时刻之后再出现即报「修复无效」。**用 `re:` 判一族 `fixed` 时，正则只能匹配旧文案**——若修复改的是报错文案本身，新文案也命中正则，下次体检必报假「修复无效」（2026-10-05 实例：browser_ctl 超时整族判 fixed，新文案同样以「browser_ctl … 超时」开头）。修复要发版或重启服务才生效（宿主代码、扩展）→ 先记 `awaiting-release`（每次体检列出、不判修复无效），装上新版、服务重启后改记 `fixed`——判定时刻要等于生效时刻。
- 只能靠踩坑得来的知识 → 按本 skill 流程写进库，记 `recorded`；② 类按 FIVE-LAYER §5「提升前先对齐召回通道」处置。③ 类（只有另一个宿主的库记过）：pi 与 Claude 两库 2026-08-12 起按用户决策隔离、不跨库注入，所以③不是「把条目抄过来」的提示，而是「这个坑在 pi 侧也在发生」——先看能不能在宿主/环境层消根因（如子进程编码）；不能再按本 skill 流程在 pi 侧独立成条。
- 已登记待办 → `tracked`；模型自身操作失误、场景内正常的报错（登录过期、远端本来就没开）、关键词碰巧撞上的杂合组 → `ignore`。
`tracked`/`ignore`/`recorded` 在会话数翻倍时重报「加剧」。同一工具同类文案的一族签名用 `re:<正则>` 一次判（键见 `--json` 的 `key`）。账本 `experience/recurrence-ledger.json` 随 agent 目录的 git 走。

## EXPERIENCE 命中数据

跨层审计或评估 EXPERIENCE 条目升降级时，先跑命中统计（数据源 `experience/hits.log`；2026-08-12 起两库隔离，仅 pi 库）：

```
node ../../extensions/experience-retrieve/stats.mjs   # 路径相对本 skill 目录（agent 目录默认 ~/.pi/agent）
```

信号 → 动作：

- **RECUR≥2**（注入后仍复发）：评估升层 AGENTS，或在 INDEX 收紧/精确化该条目关键词。
- **INJECT≥10**（跨会话高频命中）：内容属常驻候选则升层；否则是关键词过宽，按 INDEX 维护规则收紧。
- **疑似误伤**（BLOCK 后原样重发且无复发）：关键词撞正常业务流量；禁止业务功能名/项目名做单长关键词。
- **RECUR 语义限制**：环境持续型条目（故障需人工/授权解除，如要在浏览器里完成的登录复核）在条件解除前每次重试都命中，RECUR 不代表未遵守、不作升层依据。处理任何信号前先看 hits.log 的 `kw=` 归因（哪个关键词组合在命中）——2026-08-16 审计实证：仅凭聚合计数会把误伤读成复发、把等待读成失守。

## 新增决策卡

```markdown
- 失败模式：
- 可重放样本：（任务措辞 + 期望不再出现的行为；写不出则标"不可消融"）
- 建议层级：AGENTS / SKILL / KNOWLEDGE / EXPERIENCE / HOOK / 不持久化
- 作用域：全局 / 项目
- 主源路径：
- 召回入口：
- 验证方式：
- 退出条件：
- 重叠与优先级：
```

## 各层入口

- AGENTS：`../../AGENTS.md`；项目为 `<project>/AGENTS.md`
- SKILL：`../<name>/SKILL.md`；项目为 `<project>/.pi/skills/`
- KNOWLEDGE：[`../../knowledge/index.md`](../../knowledge/index.md)
- EXPERIENCE：[`../../experience/INDEX.md`](../../experience/INDEX.md)
- HOOK：[`../../extensions/README.md`](../../extensions/README.md)（全部扩展清单：类型/事实源/测试/观测入口）；five-layer 规则框架与准入卡见 [`../../extensions/five-layer/README.md`](../../extensions/five-layer/README.md)

## 决定日志

否定性治理结论追加到 [`../../knowledge/governance-decisions.md`](../../knowledge/governance-decisions.md)，仅两类：①门禁评估后明确拒绝的候选（留在 task 候选区观察的是未决，不记）；②因实测有害/误伤而撤销的已落地内容（自然过时走 `deprecated/`，不记）。每条一行：候选、决定、理由、推翻条件。接受的决定不记。

## 废弃规则

- SKILL / KNOWLEDGE：需要保留历史理由时移入同层 `deprecated/`，从运行索引或触发入口移除，并标明日期与原因。
- EXPERIENCE：过时或已提升后从运行索引移除；会误导时直接删除正文。
- HOOK：先禁用并验证无依赖，再删除注册；保留回滚说明。
- AGENTS：删除旧路由时同步检查被路由内容是否还有其他召回入口。

## 输出要求

报告改动路径、所属层、召回链、验证证据和未迁移的存量边界。没有召回链的文件不得标记为完成。

全局五层改动完成后，agent 目录是 git 仓库就 `git commit`（提交信息写动因+验证），退休/删除不再留 `.bak`——历史由 git 承担；不是 git 仓库时退休即删不可恢复，先提醒用户（`qika doctor` 第 12 节也会报）。装了 pi-automode 这类审批扩展时 `extensions/` 下文件可能被硬拒（视为安全控制面）：被拒时在临时副本改好并跑测试，产出补丁交用户应用，不绕过。随 Qika 分发的机制组件（`qika doctor` 第 12 节列出）改了就不再自动收到上游更新，优先改自己的内容文件或用开关（settings 的 `!技能名`、`PI_FIVE_LAYER_DISABLE`）。
