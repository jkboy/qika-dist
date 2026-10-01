---
name: doctor
description: 配置面体检（/doctor）：先跑 qika doctor 拿账本（每请求 token 预算、技能/扩展使用率、审批与成本统计），再审 AGENTS.md/技能是否臃肿重复失效，出分组可撤销提案，批准后才动。用户说体检、审计/精简 agent 配置、/doctor 时使用。
---

# 配置面体检

目的：上下文文件、技能目录、扩展注入是**每次请求都在付费的固定开销**，只会单向膨胀。
本技能把「花了多少、用了多少」算成账本摆出来，再按 rubric 判断哪些该清，**只提案不自动执行**。

## 步骤 0：拿账本（只读，不需要 server 在跑）

按顺序尝试，成功一个即止：

```bash
qika doctor --json --project "<当前项目根>"               # 全局安装包
pnpm -s qika-doctor -- --json --project "<当前项目根>"    # 在 Qika 源码仓库里（`pnpm doctor` 是 pnpm 自带命令，别用）
```

都不可用则退回 `wc -l AGENTS.md ~/.pi/agent/AGENTS.md ~/.pi/agent/skills/*/SKILL.md`，并在报告开头声明「无遥测」。
账本字段：`budget`（预算与实测锚点）、`contextFiles`、`skills`、`tools`、`extensions`、`cost`、`settings`、`disk`（受管目录磁盘占用 + 阈值信号：git 包 node_modules 混进 devDependencies / 子代理记录超标 / 单会话文件过大，`signals` 里已带处置命令，照抄即可）、`streamWatchdog`（流停摆看门狗误杀面，见步骤 5）、`outputBudget`（单次回复输出预算余量与截停，见步骤 5）、`todoMirror`（update_todos 镜像结局；同会话同原因反复 = 处方无效）、`taskHealth`（活动 task 体检：体积、当前状态日志化、恢复门拦截/降级、没读全比例——task 内容归所在项目的会话按 task-tracker「长期运营」整理，这里只报告不改）、`contracts`（配置契约：模型引用能否解析，见步骤 5）、`fiveLayer`（五层体系 starter 组件状态与索引可解析性，见步骤 5）、`caveats`。
**先读 `caveats`**——它写明了哪些数字不可信（审批只含弹过门的、技能调用是启发式、token 是估算）。

## 步骤 1：预算总览

列一张表：每请求固定开销合计 est.、首轮实测锚点（按模型，`ratio` >1 的部分是上游 system prompt 与内置工具）、
`budget.components` 逐项 est. 与占比。占比最大的组件就是后面几步的重点。
锚点只取 `budget.configChangedAt`（配置面文件最新 mtime）之后开始的会话；`staleFirstTurn` 是旧配置的对照，
**ratio 明显偏低的旧样本说明当时配置更瘦，不是 tokenizer 差异**。`calibrationSource: 'recent-stale'` 表示配置刚改、
校准取的是改动前 7 天样本，报告里要写明。`window.foreignSessions` >0 说明有其他机器同步来的会话混在统计里。

## 步骤 2：上下文文件逐条审（五问）

对每个 `contextFiles` 文件里的每条规则/段落问：

1. 这条防止**哪个具体失败**？说不出来 → 删。
2. 那个失败**现在还会发生吗**？相关代码/流程已不存在 → 删。
3. 能不能**砍半**还保留同样约束力？→ 压缩。
4. 和其他条目/技能**重复**吗？→ 合并。
5. **能不能迁成 skill？** pi 的按需加载机制是技能正文——系统提示里每个技能只占 name/description/location 三行，
   正文只在 `/skill:名` 或模型 read 时才进上下文。只在特定任务才需要的长段落迁成 skill，原处留一行指针。

危险信号：`通常`/`一般来说`/`尽量` 式软措辞（约束力为零，占字数）；同一规则在用户级 AGENTS.md 与项目级文件各写一遍。
**不删守护不可逆操作的硬规则**（如"禁止 force push"、"杀进程前先确认 PID"），哪怕它看起来啰嗦。

## 步骤 3：技能

- **先看 `skills.items[].invocationsByProject`**：全局技能的调用 ≥90% 来自单一项目 → 首选**项目作用域化**
  （全局 `settings.json` 加 `"skills": ["!名字"]`，该项目 `.pi/settings.json` 用普通路径加回），其他项目省掉它的常驻三行，
  该项目里一切不变。`skills.signals` 会自动给出这类提示。一个技能家族（同前缀）一起迁。
- `skills.items[].realPath` 非空或 signals 提到"真身在 .agents/skills"：这些 SKILL.md 被 Claude Code/Codex 等宿主同读，
  **不要改它们的 frontmatter**（`disable-model-invocation` 会跨宿主生效，安装器重装还会覆盖）——用上面的 settings 过滤代替。
- **隐藏必须留指针**：`skills.hidden` 列出当前项目模型看不到的技能（settings 排除 / frontmatter 禁用）及 `pointedBy`
  ——哪些可见技能提到了它。`pointedBy` 为空 = 模型无从发现，只能靠用户点名（用户自己也会忘）。凡提案隐藏/作用域化一族
  技能，同一提案里必须配一个路由技能（`~/.pi/agent/skills/<族名>-router/`，description 列全关键词，正文给
  `~/.agents/skills/<名字>/SKILL.md` 路径表 + 消歧规则，约 200 est.），或明确写「确认不再需要」。
- `skills.neverInvoked`（窗口内零调用）且 description 模糊或与他人重叠 → 建议 `disable-model-invocation`（可逆，仅限非共享文件）。
  注意调用检测是启发式：模型直接照 description 行事不会被计入，判断前看 description 是否本就是"读了才会用"的类型。
  零调用也可能只是该类任务近期没出现（如逆向/飞书），隐藏前问用户还做不做。
- `skills.signals` 里 description 偏长（>300 字符）→ 建议压缩（正文不动）。中英双写的只砍英文复写段；
  description 本身就是行动指南（读了描述就能照做，read 次数低估使用）的不要压成一句。
- 同名冲突 → 指出哪个生效、另一个是死文件。
- 技能目录块占比高（常见 >50%）时，优先做上面几条，比删上下文文件省得多。

## 步骤 4：工具与审批

- `tools.approvals` 里某工具「单次允许 N 次、拒绝 0」→ 建议在会话里点「总是允许」；说明当前白名单是**会话级**。
- 拒绝理由聚类 → 常被拒的一类操作可能该写成上下文文件里的一条硬规则（这是少数"加规则"的正当理由）。
- 审批等待中位过长 → 属注意力路由问题，指出即可。
- `extensions.automode` 非空且审批零弹窗 → 审批统计对本机不具代表性，改看 automode 的放行/拒绝数。
- `tools.usage` 错误率高的工具（错/次 >20%）→ 点名，看 `errorKinds` 分布：
  - `network` 占大头：先看 `settings.proxies` **三个开关一起**——`researchProxy` 与进程 `HTTPS_PROXY` 二者有一个就算代理已接
    （空 `researchProxy` 走环境变量，是同一条出口），**两个都无**才提「代理没接上」。都有仍 `network` 高且 `settings.version`
    < 0.2.97 → 是 researchProxy 与内置 fetch 的 dispatcher 协议 bug（一设即全挂「fetch failed」，v0.2.97 修），建议
    先清空 `researchProxy` 再升级；版本 ≥0.2.97 且集中在少数域名 → 目标站不可达，不是配置问题。
  - `http-401/403` 多 → 目标站拒爬，走 spawn_researcher/镜像；`content`（二进制/无正文）→ 模型选错了工具。

## 步骤 5：扩展与设置

- `extensions.loaded` 里 `shippedWithQika: false` 的用户级扩展逐个问「窗口内还在用吗」：
  判据是它的工具/命令/`customEntries`/`injections` 在窗口内出现次数。
- `extensions.injections` 每次 est. × 次数 → 哪个扩展在往上下文里灌最多字。
- `contracts`（旧版可缺）：`modelRefs` 逐条核对配置里引用的 `provider/modelId`（settings 默认模型、项目 settings、
  pi-automode `classifierModel`、设置页各辅助角色）能否被解析——models.json 改 provider 名或删模型后引用方全是**静默**落回
  （默认模型落回第一个可用模型、分类器取不到模型、角色落回默认），`resolvable: false` 的逐条点名，`signals` 里带该改哪个文件；
  `resolvable: null` 是环境变量代理渠道的精选模型，离线核对不了，不当问题报。`staleSessionModels` 是会话存的模型键失效数
  （按 provider，`likelyRenamedTo` = 同名模型现在挂在哪个 provider 下）。`healable` 是其中宿主 resume 时会自动改接并写回的
  部分（provider 已不存在、同名模型只在一个已配置可用的 provider 下）——这部分不用处置；信号只按「窗口内活跃 − 可自愈」出，
  那些会话 resume 时落回默认模型并在会话里提示。处置只报告——用户在会话里重选模型，或把 models.json 删掉的模型加回，
  **不要去改 app-data.json**。
- `fiveLayer`（旧版可缺）：`mode` = on（已启用 starter）/ off（未启用）/ maintainer（源码仓库 install.sh 维护）。
  `components` 里 `modified` 是用户改过、上游新版（`pendingVersion`）放在 `upstreamDir` 未应用——报告里列出并给 diff 命令，
  **不要替用户合并或覆盖**（放弃本地改动是 `qika five-layer add <id> --force`，要用户明确同意）；`indexes` 里 `rows > 0` 而
  `pushable = 0` 的索引整库零推送（表格格式不对），按 `signals` 指出该改成什么格式。`agentDirIsGit: false` 时提醒纳入 git。
- `permissionModes` 里 bypass 占比高的，点名。
- `cost.cacheHitRate.worst` 命中率异常低的会话 → 多半是模型切换或长时间空闲导致缓存失效，指出即可。
  `window.foreignSessions` >0 时先看最差会话是不是其他机器的（cwd 路径风格不同），那不是本机配置的问题。
- `cost.byModel` / `cost.cacheRewrites` 都按 **provider/model** 分行：同名模型挂在不同渠道下缓存表现可能天差地别
  （实例：同一模型经两个中转站，一个命中 94%、另一个的 chat-completions 端点只有 54%——中转站按上游账号轮换，
  只有带 `prompt_cache_key` 的 responses 路径能钉住账号）。同名模型一行好一行差 → 提「把差的那条改成 responses 格式或换渠道」，
  撤销 = 改回 models.json 里该模型的 `api` 字段。
- `cost.cacheRewrites` 给整段重写的钱花在哪：`blockedTtl`（审批/ask_question/wait 等人超 5 分钟）与 `idleTtl`
  （run 之间空闲 5~60 分钟）是 1h TTL 能救的部分——`longTtlWorth: true` 而 `settings.envGuards.cacheRetention` 不是 `long`
  → 提「开 1h TTL」（撤销 = 去掉环境变量）；`longTtlWorth: true` 且已是 `long` 但 `cacheWrite1h` 恒 0 且窗口内有新会话
  → 中转站剥掉了 ttl，白付 2× 写价，提「设 `PI_WEB_CACHE_RETENTION=short`」。`inRunOther` 占大头（run 内 ≤5min 却整段 miss）
  是渠道自身不缓存/前缀不稳，与 TTL 无关，指出即可；`modelSwitch` 是用户主动切模型的必然代价，不当问题报。
- `streamWatchdog`（旧版可缺）：`kills` 里 `phase: thinking` 的停摆多是不回传思考内容的渠道上思考超长被误杀；
  `silentThinking` 的 `maxS` 对照 `settings.envGuards.streamIdleThinkingTimeoutS`，`signals` 出现即提「调大
  `PI_WEB_STREAM_IDLE_THINKING_TIMEOUT_S`」（撤销 = 去掉环境变量；生效需重启 server）。`awaiting` 阶段的停摆是真渠道问题，指出即可。
- `outputBudget`（旧版可缺）：`models` 是各模型单次回复输出的 p99 / 最大值与 `stopReason=length` 截停数；`zeroOutputStops`
  是思考吃光预算、没产出正文或工具调用的截停（主会话会自动接续，但每次都是一整份输出的费用）。`topStopAt.count ≥ 2`
  = 反复停在同一数值，撞的是固定上限：先看 models.json 里该模型的 `maxTokens` 与 `contextWindow`——声明超过窗口一半
  会被当误配钳到 32K，真实上限照实填（撤销 = 改回原值）；数值不固定、且多发生在上下文快满时，是剩余窗口压低了上限，
  指出即可，不提案。

## 步骤 6：报告与提案（先批准再动）

输出**分组提案表**，每行必须有「撤销方式」：

| 组 | 提案 | 省多少（est. token/请求 或 次数） | 执行 | 撤销方式 |
|---|---|---|---|---|

撤销词典（只许用这几种可逆动作）：

- 技能项目作用域化 → 全局 `~/.pi/agent/settings.json` 的 `skills` 加 `"!名字"`（或 `"!前缀-*"`），该项目 `.pi/settings.json`
  的 `skills` 用普通路径加回（`~/.agents/skills/名字` 或绝对路径）；项目需在 trust.json 里为 true。撤销 = 删这两处条目。
  改前先复制 `settings.json.bak-<日期>`。**同一提案必须附路由技能**（见步骤 3）。路由技能约定（docs/doctor-design.md §7.1）：
  名字不能匹配家族排除 glob；frontmatter 加 `metadata.routes: "<家族 glob>"` 声明所路由的家族；正文成员路径写
  `~/.agents/skills/<名>/SKILL.md` 形态；description 必须覆盖全部成员 description 的触发词（是并集，不是按用户近期措辞挑）。
- 禁用技能 → 改 SKILL.md frontmatter `disable-model-invocation: true` / 技能面板开关；撤销 = 翻回。**仅限非共享文件**
  （`realPath` 为空且不在 `.agents/skills` 下）。
- 精简/合并上下文文件 → `edit` 工具；git 管理的文件（`gitTracked: true`）diff 可见、`git checkout` 还原；
  非 git 文件改前先复制一份 `<文件>.bak-<日期>`。
- 段落迁成 skill → 新建 skill 目录 + 原处留一行指针；撤销 = 删 skill 目录 + 还原段落（原文完整在 skill 正文里）。
- 停用扩展 → `mv ~/.pi/agent/extensions/<x> ~/.pi/agent/extensions.disabled/`；撤销 = mv 回来（新会话生效）。
- 角色模型/探测/代理设置 → 只报告，让用户在设置页改。

表后问用户三选：**全部执行 / 让我选 / 不动**。**没拿到明确批准之前不修改任何文件。**
执行后逐条回报做了什么、怎么撤销。
