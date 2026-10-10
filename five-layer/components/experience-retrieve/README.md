# experience-retrieve —— EXPERIENCE 检索推送 + 一次性减速带

把 EXPERIENCE 层从"指望模型自觉去查"变成"命中即推送到眼前";对高代价踩坑模式,再从"报错后的提示"前移为"执行前的门"。

## 防止的已观察失败（准入依据）

1. 经验条目沉淀后，同类问题复发时模型不会主动查 INDEX（USERPROFILE 幽灵路径坑已在库中仍原样踩中，2026-08-09）；
2. Claude 侧静态审计确认：无推送机制时检索概率 ≈ 0，加推送 hook 后当场实弹命中；
3. **注入了也不遵守**（2026-08-11 H3 实证）：remote-long-task-polling 条目注入后，模型仍连续两次重走 ssh 内嵌轮询死路（exit 124 ×2）。根因：注入时机在报错后；且旧版会话级去重导致复发时刻恰好零强化。

## 机制（三层递进）

| 事件 | 行为 |
|---|---|
| `tool_call`（仅 bash） | 命令**输入**命中未减速条目 → `block:true` 一次，reason 即条目全文 + 放行指引（"一次性减速带"），埋点记命令指纹（cmd=）。原样重发即放行；被拦条目的下一条命中命令放行时记 `PASS resend=verbatim/rewritten`（改写率/误伤率数据源） |
| `tool_result` | **输入**（成功结果）/ 输入+报错文本（`isError`）命中未注入条目 → 追加条目全文；**已注入条目在报错结果中再命中 → 判定复发（RECUR），升级标头重注 + 重新武装减速带（仅一次，见下）**。成功输出不参与匹配（2026-09-17 起）：Claude 侧 387 条裁决回溯，只在输出命中的注入无关率 98%、只在输入命中的 77%；pi 侧 INJECT 47% 来自 `read`（文件内容撞词）。工具输出是「世界在说话」，输入才是 agent 的意图。**唯一例外（2026-10-10）**：`bash` 成功结果里**行首**的 `命令名: 报错` 行（`ls: unknown option`、`bash: x: command not found` 等，见 `shellErrorLines`）当报错文本匹配——管道尾段/分号链会吞掉退出码，使失败结果 `isError=false`（pi 会话 18602 条 bash 结果里 166 条如此）；只取该行、不放整份输出，所以不重开撞词口子 |
| `agent_settled` | 报错 ≥2 次提醒沉淀；有 RECUR 条目时提醒按 five-layer-governance 评估提升（AGENTS 层或 INDEX 加拦截模式） |
| `session_start` | 重置全部会话态（去重集/减速带 ack/复发计数）与索引缓存 |

### 减速带设计原则（为什么是"一次性"）

- 关键词是**召回精度**，撑不起**门禁精度**（hits.log 实证：无关条目经常搭车命中）。硬阻断误伤 = 工作中断；一次性拦截误伤 = 一次重发（几秒），代价有上界，因此可以放心复用 INDEX 关键词，零逐条维护。
- hook 只保证"**知情后行动**"（执行前确实读到条目），不替模型决定（经验是启发式，允许被有意识地推翻）。
- 只拦 `bash`（即时执行且代价高）；edit/write 里出现关键词 ≠ 要执行该模式。
- **只读搜索段不参与匹配**（2026-09-23，`intentInputText`，tool_call 与 tool_result 同口径）：bash 命令按未加引号的 `; & | && || ( )` 与换行拆段，`rg/grep/ls/cat/jq/git log|grep|show|diff…` 这类纯读段剔除后再匹配——`rg "nohup|ssh" ~/…` 是在搜关键词，不是要执行它；grep 无匹配 exit 1 还会被判 isError，历史上造成假 RECUR（hf-download 的 RECUR≥2 信号里 3 次全是治理 rg）。保守边界：含 `$(`/反引号、非 /dev/null 重定向、`sed -i`、`find -exec/-delete`、`xargs <非只读>`、纯赋值段一律视为非只读；命令含 heredoc `<<` 整体不剔（正文行会被误拆成段）。命令指纹与防自触发仍用完整输入。回放 7 581 条历史 bash：剔掉 4 次（3 次治理 rg + 1 次 `tailscale ping | tail` 只剩单词），13 次真实执行全部保留。
- 报错复发（RECUR）说明上次 ack 无效 → 重新武装，再拦一次。**重武装上限 1 次（单会话每条目至多拦 2 次）**：2026-08-10 上线首日实测，evidence-contract 条目的单长关键词撞上同名业务功能的开发流量，90 秒内 BLOCK→RECUR→BLOCK 三连拦——无上限重武装会让"误伤上界 = 一次重发"的承诺失效。n≥2 后不再拦，仅靠 RECUR 升级重注 + settled 提醒走升层评估。
- 数据侧配套规则（INDEX 维护规则已登记）：**禁止业务功能名/项目名做单长关键词**。

### 防御铁律

- SDK `emitToolResult` 对 handler 异常有 catch，但 **`emitToolCall` 没有**（throw 会顶掉所有工具结果，v0.2.26 theme 桩事故）→ `tool_call` handler 全程自兜底 try/catch，异常一律 return undefined（最坏退化为没有减速带，绝不误 block）。
- SDK 对 blocked 调用直接合成 isError 工具结果、**不触发 `tool_result` 钩子**（agent-loop "immediate" 路径，0.82.1 源码核实）→ 无自触发环，block 不污染 errorCount/RECUR。
- 命中门槛：≥2 个关键词，或单个 ≥8 字符长关键词；ASCII 词边界匹配（`pi` 不命中 `npm/pip`），含 CJK 子串匹配；纯数字关键词带 IP/版本号守卫（`127` 不命中 `127.0.0.1`，实测 corepack 条目大量假命中 `NO_PROXY=127.0.0.1`）。
- 单次调用最多注入/拦截 2 条；操作经验库自身的调用不匹配（防自触发）。
- **校准参数环境变量可配**（2026-08-17 五层审计整改，「校准型参数永不写死」原则）：`PI_EXP_MAX_INJECT_PER_CALL`（默认 2）、`PI_EXP_REARM_LIMIT`（减速带重武装上限，默认 1，0=复发不再拦纯注入）、`PI_EXP_SINGLE_KW_MIN_LEN`（单长关键词门槛，默认 8）、`PI_EXP_DIR`（经验库目录覆盖，测试 fixture 用）。

## 经验库来源与可移植性

- **主库** `~/.pi/agent/experience/`：由扩展自身位置反推（`../../experience`），不依赖 HOME/USERPROFILE 环境变量（本机 USERPROFILE 指向 Python/Node 子进程打不开的幽灵路径）。
- ~~副库 `~/.claude/experience/`（只读跨查）~~ **2026-08-12 已移除跨查，两库彻底隔离**（用户决策：各自维护各自调用）。动因：跨库命中噪声实证——claude 库 websearch-webfetch 条目的模型名关键词 `claude-haiku-4-5` 被 pi 侧 scout 报告引用源码反复误触（pi 侧 4/4 次 INJECT 全为无关命中）；且两套 INDEX 的关键词卫生规则演进不同步，跨库治理成本大于跨库召回收益。历史 hits.log 中的 `claude:` 前缀行保留为史料。

## 埋点与升级闭环

`~/.pi/agent/experience/hits.log`：`本地时间 \t INJECT|BLOCK|RECUR|PASS|READ \t 库:条目 \t tool=X kw=命中词 [cmd=指纹|resend=形态|n=次数]`。

- `INJECT` 注入 / `BLOCK` 减速带拦截（cmd=命令指纹）/ `RECUR` 注入后报错复发（n=次数）/ `PASS` 被拦条目的下一条命中命令放行（resend=verbatim 原样重发 | rewritten 改写重发）/ `READ` 主动读库。
- **项目库 READ**（2026-09-28）：read 目标落在任一 `<项目根>/.pi/experience/*.md`（相对路径按会话 cwd 解析）→ 记 `READ \t proj:<项目根>/.pi/experience/<x>.md`，与主库同理不做匹配。本扩展不向项目库推送（召回靠项目 AGENTS 路由），此前项目库零观测：五层审计时 hits.log 1101 条事件无一条项目路径，会话实测单个项目库被读 47 次/12 会话。只认 read 工具（bash cat 不计，与主库口径一致）。
- **评测态不落盘**（2026-09-23）：`FIVE_LAYER_EVAL=1`（skill-trigger-eval 等批跑）时注入/减速带行为不变、只不写 hits.log，与 Claude 侧 hook 同约定——批跑的命中不是真实工作流，混进来会污染 INJECT 计数。
- **退休条目只计数不出信号**（2026-09-23）：stats.mjs 读 hits.log 同目录的 INDEX.md，不在现行 INDEX 的条目（已退休/改名/08-12 前的 `claude:*` 跨库行）在表里标「（已退休）」排到末尾、不进治理信号，页脚报条目数与事件数。此前 pi 侧全期 23 条信号里 15 条指向这类条目，每次审计人工排除。
- **旧关键词事件只进历史**（2026-09-28 五层审计 M1）：主表与治理信号只算 `kw=` 全部仍在该条目现行 INDEX 关键词里的事件（PASS 随其前一条 BLOCK 归类）；关键词改过之后的旧词事件单列末尾「历史（旧关键词）」节，附旧词组合计数、不出信号。此前从头累计：5 条信号 3 条是旧词残留（tailscale-ssh-browser-reauth 的 31 次 RECUR 全来自已删的 `Tailscale,SSH`），08-16 与 09-28 两轮审计都靠手工按 `kw=` 归因。
- **疑似误伤两类**（同上）：`疑似误伤`（≥2 次原样重发放行）与 `疑似误伤(改写)`（≥2 次被拦后改写放行），都要求该次 PASS 之后该条目无 RECUR（旧口径是全期 RECUR=0，一次早期真复发会永久遮住后来的误拦——hf-download 08-19 真复发、09-26/27 两次误拦即此形态）。改写类可能是按结论改对了，信号附被拦 kw，需对照 hits.log 人工核。
- **`C-1 日落读数` 行每次必打**：近 30 天与前 30 天的 BLOCK/RECUR 总量（全部 pi 条目，含退休与旧词事件，不受 `--since` 影响）。08-17 审计 C-1 日落条件「减速带触发趋零即降级为纯注入」由读数召回，不再靠人记得模型换代。
- **项目库主动 READ 节**：按项目根聚合 `proj:` READ，按该项目自己的 INDEX.md 判条目现行（文件名不在 INDEX 里 → 列为已退休/改名），无 INDEX 标 ⚠。
- 统计入口：`node stats.mjs`（同目录，仅统计 pi 库 hits.log；历史 `claude:` 前缀行仍可识别；传入的 hits.log 同目录若有 `verdicts.log` 自动合并），输出按条目聚合 + 三指标（注入后复发率 RECUR/INJECT、减速带改写率 rewritten/PASS、疑似误伤原样/改写两类）+ 治理信号（RECUR≥2 / INJECT≥10 / 疑似误伤；有裁决的条目改用无关率/冗余率/救场/过时/未采纳信号）。`--since YYYY-MM-DD` 只算该日起的注入及其裁决（JUDGE/SKIP 行按 `inj=` 归期）：INDEX 关键词重写后必传上次重写日期，否则重写前的无关裁决会继续算在条目头上、信号指向早已删掉的关键词（2026-09-15 实证：全期 90.7% 无关率里 359/387 来自 09-12 重写前，重写后仅 28 次裁决）。
- 升级闭环：RECUR ≥2 → 按 five-layer-governance 评估提升 AGENTS 层，或在 INDEX 为其加精确拦截模式（数据字段，非逐条代码——预留的 Phase 3，暂未实现，等数据说话）；INJECT ≥10 → 升层常驻或收紧关键词。
- **Claude 侧离线裁判 `judge.mjs`**（2026-09-12，仅 Claude Code 库；pi 侧有减速带的 PASS/RECUR 当结果信号暂不需要）：Claude hook 纯注入无结果信号，INJECT 计数分不清救场与噪声。judge.mjs 对每条带 sid 的 INJECT 回读 `~/.claude/projects/<proj>/<sid>.jsonl`（锚点 `attachment.type=hook_success` 且 stdout 含 `[条目]`），切触发调用 + 前 2 / 后 ≤6 条 assistant 消息，`claude -p --bare --tools "" --json-schema` 五分类（IRRELEVANT / REDUNDANT / USED / RELEVANT_IGNORED / FOLLOWED_FAILED），追加到 `~/.claude/experience/verdicts.log`（独立文件：单写者、可带 judge=vN 重裁）。每条目每注入月份 ≤10 抽样；`/hits` 前置增量跑 ≤15 条。子代理内注入 transcript 不留痕（INJECT 行 `agent=`）→ SKIP subagent；30 天保留期外 → SKIP no_transcript。首轮 backlog（2026-08-13～09-12，n=359，平均 3.6K in / 0.36K out 每条）：无关 90.5%、冗余 5.0%、救场 3.1%、未采纳 4、过时 1；不可裁 76（全为子代理来源）。见 pi-web PROGRESS.md 当日记录。
- INDEX 的「最近命中」列以此为数据源（人工或治理任务定期回填）。

## 退出条件

- 若 pi 未来原生支持经验检索，本扩展退役。
- hits.log 长期零 INJECT 且库无增长时，视为死重，连同检索规则一起下线。
- 若 BLOCK 误伤率过高（大量 BLOCK 后原样重发且后续无 RECUR），收紧 BUMP_TOOLS 或提高门槛。

## 测试

- `test-retrieve.mjs`：纯函数（INDEX 解析/词边界/数字 IP 守卫/门槛/复发判定/命令指纹）+ 合成事件走真实 handler（注入/去重/复发重注/减速带 block-放行-重新武装上限/PASS 埋点/防自触发/零误报/只读段剥离/评测态静音/项目库 READ 埋点），30 项。运行方式见文件头注释。
- `test-stats.mjs`：stats 口径（fixture hits.log + INDEX）——旧关键词进历史不出信号、疑似误伤原样/改写两类与「其后无复发」、C-1 日落读数、项目库 READ 判现行，4 项。`node test-stats.mjs`。
- 冒烟（2026-08-11 已过）：pi 0.82.1 真实 `loadExtensions` 编译加载 + runner 聚合语义驱动，隔离 fake agent 树验证全链路。活体首日数据（2026-08-10）：BLOCK/RECUR 路径真实触发，并暴露 evidence-contract 误伤循环 → 促成重武装上限 + PASS 埋点。
- 唯一事实源：pi-web 仓库 `pi-extensions/experience-retrieve/`（2026-08-11 回灌），改动走仓库再 `bash pi-extensions/install.sh`（install.sh 装机副本与仓库有差异即拒装并列出差异，确认装机侧只是落后才加 `--force`；只改本扩展时手拷本目录文件并 `diff -rq` 核对即可）。
- **Claude 侧部署位 `~/.claude/hooks/experience-judge.mjs` + `experience-stats.mjs`**（2026-09-13）：`/hits` 与 compass 调的是这两份，零 pi 依赖——卸载 pi/Qika 后 Claude 侧闭环照常。改 `judge.mjs`/`stats.mjs` 后**两处部署位都要拷**（`~/.pi/agent/extensions/experience-retrieve/` 与 `~/.claude/hooks/`，文件名不同）。stats.mjs 不传参时按自身位置认两种布局（`../../experience` 或 `../experience`）。同目录还有 `~/.claude/hooks/knowledge-stats.mjs`（knowledge-pointer 扩展的 stats.mjs 副本，该扩展无仓库源，两处互为备份）。
