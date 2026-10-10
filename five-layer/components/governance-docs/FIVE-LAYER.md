# Pi Agent 五层体系

这是 Pi Agent 的治理骨架，只定义职责、路径、召回与生命周期，不包含具体业务 skills、知识、经验或门禁规则。

## 1. 设计目标

- 让长期上下文各归其位，避免所有规则都塞进常驻提示。
- 使用 Pi 原生机制：context files、Agent Skills、TypeScript extensions 与 project trust。
- 用渐进披露控制上下文：AGENTS 常驻，其余按需读取或事件触发。
- 允许全局与项目两级并存，但不自动搬运现有内容。

## 2. 五层映射

| 层 | 职责 | 全局入口 | 项目入口 | Pi 加载方式 |
|---|---|---|---|---|
| AGENTS | 跨多数任务适用的原则与薄路由 | `~/.pi/agent/AGENTS.md` | `<project>/AGENTS.md` | 启动时自动拼接 |
| SKILL | 某类任务的完整工作流 | `~/.pi/agent/skills/*/SKILL.md`；另有 `~/.agents/skills/*/SKILL.md`（经 `settings.json` 的 `skills` 过滤，如 `!某家族-*`） | `<project>/.pi/skills/*/SKILL.md` | 描述常驻，正文按需加载 |
| KNOWLEDGE | 可复查事实、参考与决策依据 | `~/.pi/agent/knowledge/index.md` | `<project>/.pi/knowledge/index.md` | `knowledge-pointer` 扩展按索引触发词每轮推送页面指针（主库 + `<cwd>/.pi/knowledge`）；Agent 也可主动查索引 |
| EXPERIENCE | 带试错链、尚未归位的短期教训 | `~/.pi/agent/experience/INDEX.md` | `<project>/.pi/experience/INDEX.md` | 全局库由 `experience-retrieve` 扩展按关键词注入正文；项目库不注入，靠项目 AGENTS 路由主动读 |
| HOOK | 确定性门禁、注入和提醒 | `~/.pi/agent/extensions/`（全部扩展清单：`extensions/README.md`） | `<project>/.pi/extensions/` | extension 事件自动触发 |

注意：KNOWLEDGE 与 EXPERIENCE 是本框架的约定层，不是 Pi 内建资源类型，召回靠上表两个扩展的推送加索引/其他层的显式引用。**扩展只能解析约定格式的索引**（见 §5），格式不合的库等于没有推送召回。项目 `.pi` 下的动态资源只有在项目受信任后才加载；项目 `AGENTS.md` 仍是 context file。

## 3. 边界判断

依次提问：

1. 是否跨大多数任务都适用？是 → AGENTS。
2. 是否描述某类任务从输入到验证的完整流程？是 → SKILL。
3. 是否能从文档、源码、配置或稳定事实源复查？是 → KNOWLEDGE。
4. 是否包含至少一次清晰的“方案 A 失败 / 方案 B 成功”试错链，且尚未流程化？是 → EXPERIENCE。
5. 是否能仅凭命令、路径、状态文件或事件字段确定性判断，而且遗漏代价高？是 → HOOK。
6. 都不是 → 留在当前 task、报告或会话，不进入五层。

辅助边界：

- 通用原则 vs 工作流：只有高频跨任务规则进入 AGENTS。
- KNOWLEDGE vs EXPERIENCE：反直觉不等于经验；没有试错链仍归 KNOWLEDGE。
- SKILL vs HOOK：需要理解意图的步骤归 SKILL；脚本可机械判断的兜底归 HOOK。
- EXPERIENCE 不是最佳实践库，只是待提升或淘汰的缓冲区。

## 4. 新增长期内容的六项门禁

每次新增前回答：

1. **失败模式**：防止哪个已观察到的失败？必须附**可重放样本**：一句能在新会话里原样发出的任务措辞 + 一句期望不再出现的行为（HOOK 用正例/反例即可）。没有可重放样本的条目日后无法消融（拔掉后无从验证是否复发），只能凭印象留着。
2. **查重**：是否已有同义、冲突或更权威的主源？同类候选是否已在 `knowledge/governance-decisions.md` 被拒绝或撤销过？
3. **归属**：为什么是这一层而不是其他层？
4. **召回**：谁在何时通过哪个入口读取或触发？
5. **验证**：怎样证明内容可用、hook 不误伤？SKILL 层还要答"**不误触发**"：先按爆炸半径分类——只读参考型（漏触发只损失质量，描述把「里面有什么模型自己不知道的」写清、求召回）还是会动工作区/起浏览器/调外部接口花钱型（误触发有真实代价，描述必须带"不用于→去哪"的负向边界，求精确）；再写 2–3 条应触发 + 2–3 条**近邻**不该触发的自然措辞（同关键词、相邻 skill 的地盘，明显无关的不算），存 `<skill>/evals/trigger.json`，用 `five-layer-governance/scripts/skill-trigger-eval.mjs` 批跑看实际路由。读结果：误触发是硬失败，改描述边界；漏触发先看模型实际走了什么——等价基础工具且能办成不算错，不为此加「务必使用」类命令词（那是按今天模型的行为画圈）。SKILL 是五层里唯一没有生产侧命中埋点的层，这份文件是它唯一的回归证据。
6. **退出**：何时提升、废弃、删除或移出运行索引？

任何一项答不上来，先写入 task 的“候选”区，不进入五层。

## 5. 召回规则

### AGENTS

- 只放常驻原则和到其他层的路由。
- 全局文件保持短；项目细节写在离代码最近的项目 `AGENTS.md`。
- Pi 会拼接全局、父目录和当前目录的 context files；冲突时按最新用户指令与更具体项目事实处理。

### SKILL

- `description` 必须同时写“做什么”和“何时使用”。
- `SKILL.md` 只保留工作流，长参考放 `references/` 或 KNOWLEDGE。
- 使用相对 skill 目录的路径引用脚本和资料。
- 无明确触发条件的 skill 视为召回失效。
- 使用 skill 后仍需手工修正的输出，或发现它该触发没触发/不该触发却触发了，**第一动作是把当次任务措辞落成 `evals/trigger.json`（或该 skill 自己的 evals）的一行，不是往 SKILL.md 加规则**：规则占常驻上下文、按今天模型的行为画圈；样本模型看不见、零 token、可以随意严格。同一处反复手改（样本攒出模式）才说明 skill 缺行，那时再改正文，改完重发全部样本确认没把别的路由改坏。

### KNOWLEDGE

- 先扫 `index.md` 的摘要与 `read_when`，只读命中的页面。
- 索引必须是 `knowledge-pointer` 可解析的 7 列表格：`| 页面 | 摘要 | read_when | used_by | 状态 | 更新日期 | 触发词 |`（列序固定，页面列带链接，触发词用 `、` 分隔）；状态为 `verified` 或 `active` 的行才推送，其他状态（draft/partial…）不推。两列式、列表式索引整库零推送（stats「索引可解析性」节会报）。
- 每页标出来源、状态、更新时间、召回条件和使用者。
- 动态事实必须记录复核条件；可廉价重查且易变的值（计数、报价、版本号等）优先存查法——来源与查询方式——而非值本身。
- 过时页面从索引移除或标记 deprecated。

### EXPERIENCE

- 先扫 `INDEX.md` 的关键词，不全量加载正文。
- 正文保留现象、失败方案、成功方案和适用边界。
- 多次命中或已能稳定流程化时，提升到 AGENTS / SKILL / KNOWLEDGE / HOOK，并从运行索引移除。
- **提升前先对齐召回通道**：各层看的信号不同——EXPERIENCE 匹配工具调用的输入与报错，KNOWLEDGE 指针只匹配用户输入，AGENTS 常驻，HOOK 看事件。原条目的触发信号若只出现在工具报错里（报错码、命令输出），提升到 KNOWLEDGE 后指针永远推不出去。看不到就三选一：消根因（首选）／保留 EXPERIENCE 索引行指向新页／改由 HOOK 承接。实例：一条环境坑条目提升为知识页后 0 次推送、坑照踩 43 次，靠跨会话复发体检第 ② 节才发现。
- 已过时且可能误导的经验直接删除；需要历史脉络时由 task 或版本控制承担。

### HOOK

- Pi 原生事件入口是 extension，例如 `tool_call`、`before_agent_start`、`agent_settled`。全部全局扩展（类型、事实源、测试、观测入口）登记在 `extensions/README.md`，新增/退役同步改它。
- 默认先 `warn`，只有高损失、低误判且恢复路径清晰的规则使用 `block`。
- 新规则必须有正例、反例和回滚方式。
- `agent_settled` 发生在 Agent 已停止自动运行之后，只适合事后提醒，不等价于可阻止结束的 Stop hook。
- 长任务连续性由 `task-tracker`（阶段 checkpoint）与 `task-continuity` extension（compaction 后 read 门禁）协作；task 文件是主源，摘要只作线索。

## 6. 生命周期

```text
任务记录 / 候选
  ├─ 可复查事实 ─────────────→ KNOWLEDGE
  ├─ 带试错链、尚不稳定 ─────→ EXPERIENCE
  ├─ 稳定的任务流程 ─────────→ SKILL
  ├─ 高频通用原则 ───────────→ AGENTS
  └─ 可机械检测的高价值兜底 ─→ HOOK

EXPERIENCE 命中或成熟
  └─ 提升到其他层 → 从 EXPERIENCE 运行索引移除
```

历史脉络由版本控制承担：`~/.pi/agent` 应是 git 仓库（`.gitignore` 排除秘钥与 sessions/hits.log 等运行时数据），删除/退休条目可从历史恢复，不再留 `.bak` 副本；不是 git 仓库时退休即删不可恢复（`qika doctor` 第 12 节会报）。

存量内容不因框架建立而自动迁移。迁移必须先查重、指定主源，并验证原召回入口已清理。

## 7. 项目级最小骨架

仅在项目确实需要对应层时按需创建，不要预建空目录：

```text
<project>/
├── AGENTS.md
└── .pi/
    ├── skills/<name>/SKILL.md
    ├── knowledge/index.md
    ├── experience/INDEX.md
    └── extensions/<name>/index.ts
```

项目级 knowledge 与 experience 的召回**不对称**：

- 项目 knowledge：`knowledge-pointer` 会扫 `<cwd>/.pi/knowledge/index.md` 并按触发词推送（前提是 §5 的 7 列格式）。
- 项目 experience：`experience-retrieve` 只注入全局库，项目库**不注入**，必须由项目 `AGENTS.md` 写一行路由（「踩坑前先查 `.pi/experience/INDEX.md`」）才有召回；READ 埋点会记主动读取。
- 两者都没有 AGENTS 路由又不可解析的库是孤岛。项目级 skill 与 extension 受 project trust 约束。

## 8. 审计清单

- **第 0 步**：先跑 `qika doctor` 拿真实加载集（上下文文件、技能含 `~/.agents/skills`、扩展），再按入口审——只顺着入口文档走会漏掉没有入口的东西。
- AGENTS 是否仍是薄路由，是否混入低频业务步骤？
- 每个 skill 的 description 是否可准确触发（存疑时开新会话用自然任务措辞实测是否加载），是否与其他 skill 重叠？带 `evals/trigger.json` 的 skill 直接重跑触发回归，正负样本任一不过关即为重叠证据；没有的按爆炸半径排序补样本，列为"无回归证据"。
- 每个 knowledge / experience 页面是否在索引中，且有召回方？
- EXPERIENCE 是否缺少试错链、长期滞留或已被其他层吸收？
- 每个 hook 是否只用确定性信号，是否有正反例与恢复路径？
- 是否存在同一规则多层复制、冲突主源、断链或过时内容？
- **跨层契约**：生产方的产出格式是否等于消费方的解析口径（例：写索引的 skill ↔ 推送扩展的解析器；统计口径 ↔ 现行 INDEX 关键词）？改配置名（provider、模型 id）是否 rg 过全部引用方？doctor「配置契约」节兜底模型引用。
- **退出条件可执行**：条目的退出/复核条件写成 frontmatter `exit_check`（命令）+ `exit_expect`（期望输出），由 `skills/five-layer-governance/scripts/exit-check.mjs` 执行、发版清单召回；只写散文的退出条件没人会执行。
- **从失败出发看漏报**：以上各项都以已有条目为锚，看不见从没进库的坑和进了库但召回断掉的坑。`skills/five-layer-governance/scripts/recurrence-probe.mjs` 从工具报错出发扫会话记录，报三类：反复出现却没人记过的报错、召回断开的知识页、只有另一个宿主的库记过的坑；每条判一次记进账本 `experience/recurrence-ledger.json`，之后只报新增、加剧和修复无效的。发版清单与 exit-check 一起召回。
- **消融**：补认知类条目（教模型怎么做、怎么想的行）逐条拔掉重放其可重放样本，不复发即删；无可重放样本的单独标出"不可消融"，不删也不视为已验证。补信息类条目（路径、端口、协议真源、权限边界）不消融——删了必坏，与模型强弱无关。

治理执行入口：`~/.pi/agent/skills/five-layer-governance/SKILL.md`。
