# Hook 准入卡：evidence-honesty（两条规则）

## 规则 1

- 规则 ID：`evidence-research-context`
- 已观察失败：会话 `2u6uZroU6W`（2026-08-05，pi-web，调研 czottmann/pi-automode）。模型开局正确加载了 evidence-contract skill，但发布时仍把未取证断言写成确定事实（"作者社区知名/主要贡献者"、"完整测试套件、CI/CD"——当时 GitHub API 全部限流失败，文件树从未取到）。契约作为纯静态 SKILL 被"读了但不执行"。
- 关联层与主源：SKILL `evidence-contract`（主源）；本规则只做任务开始时的确定性召回强化，不复制契约正文。
- 事件：`before_agent_start`
- 确定性检测信号：prompt 正则——强调研关键词（调研/选型/是否值得/最佳实践/技术评估/对比评估）单独命中，或 URL + 弱评估词（评估/引入/采用/推荐/靠谱…）同时命中。"评估"单独出现不触发。
- 策略：context（注入发布纪律 4 条，含校验器绝对路径）
- 选择该策略的理由：注入无阻断风险，误触发的代价只是几行额外上下文；召回时机（任务开始瞬间）优于静态 skill 描述。
- 正例：`调研这个项目，评估是否值得引入：https://github.com/...` → 注入。
- 反例：`评估一下这段代码的圈复杂度`、`打开 https://... 看看第 10 行` → 不注入。
- 错误策略：dispatcher 默认（出错警告、不阻断）。
- 恢复路径：注入内容有误时直接改 `evidence-honesty.ts` 后 `/reload`。
- 回滚方式：从 `rules/index.ts` 移除导入注册，`/reload`。
- 退出或复核条件：pi 原生提供等价证据门禁，或连续多次调研会话证明模型已稳定自觉执行契约。

## 规则 2

- 规则 ID：`evidence-settled-audit`
- 已观察失败：同上会话。另有半途而废取证被静默掩盖（git trees API 失败后声称"trying alternative"但从未执行，报告却包含依赖文件树的结论）。
- 关联层与主源：SKILL `evidence-contract`（校验器 `--session` 模式为实现主体，本规则只是触发器）。
- 事件：`agent_settled`
- 确定性检测信号：会话 jsonl 含 `[evidence-research-context]` 注入标记（即本会话确为调研任务）时，依次核验：① 是否出现过 `validate-evidence.mjs` 的 bash 调用；② manifest 中每条 evidence.url 是否在会话 bash 命令中真实请求过、且至少一次结果非错误/非失败样式（限流/404/超时/空响应，失败样式只在 ≤600 字符的短响应上判定，防止长文档正文误伤；带 `session_file` 章的历史条目改查其出处会话）。核验通过的条目盖章 `session_file`（出处会话），manifest 由此可跨会话续用。
- 策略：reminder（`agent_settled` 无法阻断，只能事后向用户点名警告）
- 选择该策略的理由：发布内容是最终文本，不经过 tool_call，无阻断点；能做到的最强动作 = 让违规必然留下用户可见的、指名道姓的警告。
- 正例：调研会话未跑校验器 → 提醒；manifest 引用从未抓取的 URL → 点名该 URL；引用抓取全部失败的 URL → 点名；伪造 `session_file` 出处（指向没有该抓取记录的会话）→ 仍按未抓取点名。
- 反例：非调研会话（无注入标记）→ 静默；来源真实抓取成功且校验通过 → 静默；长正文恰好含 "rate limit" 字样 → 不误判；续做会话引用带 `session_file` 章的历史证据 → 按出处会话回溯核验，不误报（均有单测覆盖）。
- 错误策略：dispatcher 捕获后降级为警告（fail-open，审计工具自身故障不干扰正常工作）。
- 恢复路径：误报时按警告中的 URL 人工核对会话记录即可判明；规则可单独 `enabled: false`。
- 回滚方式：从 `rules/index.ts` 移除导入注册，`/reload`。
- 退出或复核条件：同规则 1；或 pi 会话格式变化导致解析失效（此时先修 `validate-evidence.mjs` 的 `parseSessionCalls`）。

## 已知边界（两条共同）

- 检查的是"抓取/执行行为发生过"，不是"来源蕴含主张"；语义审查仍靠模型/人工。
- 决心作弊的模型可以用 `echo <url>` 伪造请求记录——本门禁把作弊成本从零提到需要主动构造假证据，不承诺杜绝。
- URL 经 shell 变量展开时（如 `for b in main master; …/$b/…`）字面匹配不到，会误报 unrequested；规避方式是在 manifest 用 `retrieved_via` 记字面出现过的 URL。
- 出处会话文件被清理/移动后，带章历史条目报"无法回溯核验"（提醒复查措辞，不按编造点名）；断言降 provisional 或在当前会话重新取证。
- v1.1（2026-08-05，deepseek 复跑会话实测后加固）：url 必须为裸 URL、`retrieved_via` 记转运、`local_command` 记本地取证并新增 `unexecuted` 类别。实战演示：旧记法 manifest 结构层点名 5 条打回；按新写法构造的 manifest 对同一真实会话结构+交叉核验双 PASS。
- v1.2（2026-08-10，会话 gah3MUsG1S 实测后规范化 manifest 保存/读取）：manifest 统一保存为 `<项目根>/.pi/tasks/evidence-<任务slug>-manifest.json`（写侧注入纪律 + SKILL.md 同步）；读侧审计不再只解析最后一条校验命令——跟踪命令内 `cd` 目标解析相对路径、从后往前取第一个存在的文件、全落空回退规范位置找最新 `evidence-*.json`。事故形态：`cd .pi/tasks && … node validate-evidence.mjs <裸文件名>` 被按项目根解析成不存在路径，agent 被迫把 manifest 复制到项目根应付审计。
- v1.3（2026-08-10，会话 eByLRzxUAE 实测后新增会话出处）：旧版把"跨会话取证误报为未抓取"列为可接受误报，实测续做会话被点名 5 URL + 1 grep（全部在上个会话真实取过证），误报噪声会稀释真警告的可信度，不再可接受。修法：审计对当前会话核验通过的证据条目自动盖章 `session_file`（出处会话 jsonl 路径，agent 不自知该路径、只能审计写入）；交叉核验对带章条目改查其出处会话，伪造出处会被出处会话的真实记录戳穿；出处文件缺失单列"无法核验"。同轮顺带收紧失败样式两处实测误判：裸 `404[:\s]` 撞正文（issue 标题含 "avoid 404 on…"）改为行首状态样式/明确错误短语；isError 但正文 >600 字符（复合命令尾段脚本失败、抓取内容在场）不再判失败。真实数据端到端：对原始取证会话重放收尾 → 静默 + 盖章 12/12；对事故续做会话重放 → 静默（原点名 6 项清零）。
- v1.4（2026-08-15，两起实测误报同日修复）：① 交叉核验补认 `web_fetch` 工具抓取——`parseSessionCalls` 原只解析 bash toolCall，全程用 web_fetch 取证的调研会话（qwen38 速度优化，24 次成功抓取）12 条 URL 证据被整体误报"从未抓取"；修法：web_fetch 的 url 参数并入 commands 语料（URL 即完整字面抓取记录），失败判定复用 `looksLikeFailedFetch`。② "未跑校验器"分支加纯本地会话豁免——"调研"关键词也覆盖本地诊断任务（实测：主机黑屏原因诊断，全程 ssh/journalctl 取证，无外部来源可登记），点名"未运行校验器"必然是噪声；修法：无 manifest 文件名提及、assistant 产出无外部 URL（内网/回环/Tailscale CGNAT 段不算）、且未调用 web_search 的会话静默豁免，三者任一出现仍警告（toolResult 里的 URL 不算 assistant 引用——读本地文档带出的引用不构成外部取证义务）。真实数据回归：黑屏诊断会话 → 静默；qwen38 调研会话（跑过校验器+外部取证）→ 静默且原行为不变。
- v1.5（2026-08-19，用户报告收尾频繁弹两类警告后排查）：新增只读重放工具 `replay-settled-audit.mjs`——settled 提醒走 `ui.notify` 不落盘，事后无法回查警告原文与审计依据；重放对任意会话 jsonl 输出走到的分支、校验器命令、选中的 manifest（含 mtime 提示：核验的是文件现状）、全部结构错误、逐条交叉核验结果与被点名 URL/命令在会话内的出现位置取证（role/tool 分类），`--sweep` 全量普查。审计核心同轮抽为 `auditSettledSession({stamp})`（`check()` 行为不变；`stamp=false` 只读）。38 个历史调研会话重放：19 警告 19 静默。**已实证但暂未修的噪声源**（修法各有取舍，另行决策）：① `spawn_researcher` 子代理抓取的 URL 只出现在子代理返回文本里，主会话无 bash/web_fetch 记录 → 误报"从未抓取"（08-17 两例、08-19 一例；若简单把子代理返回文本算作抓取记录，会让"编造 URL 写进报告"也过审，需要子代理侧登记真实抓取）；② 附件/长 prompt 含 URL+弱评估词（如 handoff 文档里的"引入"）误触发调研注入 → 非调研任务收尾被点名"未运行校验器"（08-18 网站项目文档更新任务实测）；③ 续做会话新建 manifest 文件不继承旧 manifest 的 session_file 章 → 上会话真实取证被点名（盖章以 manifest 文件为单位，同题续做必须复用原文件——已有单测固化该行为）。同轮确认的真警告样例：08-19 安全审计会话 manifest 用自造简化 schema（128 项结构错误），跑了校验器见 FAIL 仍发布报告——门禁按设计点名。
- v1.6（2026-08-19，v1.5 三大噪声源 + 真警告优化全部落地）：① **spawn_researcher 子代理取证并入交叉核验**——pi-web 侧新增 `server/src/sessions/researchSourceLog.ts`：execute 层逐次记录子代理 web_search/web_fetch 的目标与成败，随报告落盘同名 `-sources.jsonl`（harness 写入，模型无法伪造）；校验器侧 `parseSessionCalls` 从 toolResult(toolName=spawn_researcher) 的「完整报告已存盘: <路径>」锚点派生日志路径读取，web_fetch 记录等价一次主会话抓取（成功文案固定不含 URL/错误词防撞失败样式；web_search 查询词不参与 URL 核验——搜过≠抓过）；日志缺失（旧版运行/已清理）静默降级为原行为。**pi-web server 改动需发版+重启 7318 才对新调研生效**；历史会话无日志，重放结果不变。② **附件误触发修复**——`isResearchPrompt` 先剥离 `<attachment name="...">…</attachment>` 块再匹配（内容≠意图；样式与 pi-web normalizer 拆解正则同族），附件里的 URL/弱评估词/强调研词都不再触发，用户正文意图不受影响。③ **跨 manifest 续用指引**——注入纪律第 7 条 + SKILL.md：新任务需要新 manifest 时从旧 manifest 原样拷贝带章条目（连同 session_file），交叉核验本就按条目回溯出处、与文件无关；禁改动的对象从"字段"收窄为"字段的值"。④ **真警告（自造简化 schema）优化**——注入纪律第 3 条给出示例骨架绝对路径并写明"从示例拷贝骨架改内容、FAIL 修到 PASS 再发布"；收尾警告的结构失败项带前 3 条错误明细（只报条数无法行动）。
- 验证：`node --experimental-strip-types test-evidence-honesty.mjs`（含附件剥离正反例 + 真实事故形态回归 + 只读重放断言）+ `node --test tests/validate-evidence.test.mjs tests/session-cross-check.test.mjs`（含 researcher 日志成功/失败/缺失降级/搜索不算抓取 5 例）+ pi-web `pnpm test`（researchSourceLog 包装器/落盘往返 5 例）。
