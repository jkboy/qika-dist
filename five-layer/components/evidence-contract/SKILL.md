---
name: evidence-contract
description: 为依赖外部事实的调研、比较、选型和高影响建议提供方法中立的证据发布契约。遇到动态事实、版本/派生关系、社区最佳实践、否定性结论、来源冲突或用户要求可核验调研时使用；纯本地代码、创作和格式任务不使用。Use for evidence-backed research and recommendations; enforce publishability without prescribing a search method or report format.
---

# 证据契约

目标：约束“什么结论有资格发布”，不规定模型如何搜索、思考或组织报告。

## 适用强度

- `standard`：单一稳定事实或低影响查询。
- `strict`：选型/最佳实践、派生物与多版本、否定结论、来源冲突或不可达、快速变化事实，以及医疗/法律/安全/重大采购等高影响任务。
- 强度由任务风险决定，不按模型名、provider 或 reasoning level 决定。执行者可主动加严，不得自行低于任务所需等级。

## MUST：发布不变量

1. 明确问题、截止时间和决策依赖的关键主张。
2. 关键实体具有与任务相称的身份字段；版本化对象至少核对 owner、canonical id、version/revision 与日期。
3. 每个决策主张都由实际支持它的证据覆盖；引用存在不等于引用支持。
4. 证据只在其实体、版本、时间、硬件和测试条件范围内有效，禁止局部缺席外推为全局否定。
5. fork、转述、共同上游和同一作者按同一 `lineage_group` 计算，不冒充独立复现。
6. `unknown`、`conflicted`、`refuted` 的关键前提会阻断依赖它的确定结论；结构、篇幅和其他正确项不能抵消。
7. “没有/不存在/无人验证”等否定主张记录搜索范围、查询入口和限制。
8. 区分直接事实、自报、独立复核、推断与建议；主来源不可达时不得把间接证据提升为确定事实。

## 方法自由

允许采用任何当前或未来方法，只要产生等价或更强的可审计证据并通过相同门禁。不得强制特定网站、搜索顺序、工具、表格或可见思考过程。

`SHOULD` 默认策略仅用于降低遗漏：先解析实体和关键前提，再收集证据、追踪来源血缘、主动寻找反例，最后生成报告。更好的方法可替代整套默认策略。

## 证据记录

- 简单 `standard` 任务可在回复或 task 中保留精简的主张、来源、范围和状态。
- 多来源、长任务或 `strict` 任务使用结构化 manifest，统一保存为 `<项目根>/.pi/tasks/evidence-<任务slug>-manifest.json`（固定目录与命名；收尾审计优先按校验命令回读，解析不到时回退到规范位置——优先取本会话提及过文件名的 `evidence-*.json`，再退最新文件）。新题用新 slug 勿与既有 manifest 重名，同题续做才复用原文件；同一话题不要并行开多个会话同时写一份 manifest（文件级无锁）。字段语义见 [references/CONTRACT.md](references/CONTRACT.md)，起始模板见 [references/manifest.example.json](references/manifest.example.json)。**结构勿凭记忆手写：从示例拷贝骨架改内容**——自造简化 schema（缺 lineage_group/claim_links/decision 等）必然过不了校验，实测一次性产生 128 项结构错误；校验器报 FAIL 必须修到 PASS 再发布。
- 运行：`node scripts/validate-evidence.mjs <manifest.json>`，manifest 传绝对路径（`cd` 后传裸文件名会让收尾审计按项目根解析落空）；追加 `--session <session.jsonl>` 可交叉核验每条来源是否在会话中被真实抓取/执行过（从未请求、抓取全部失败或从未执行的取证会被点名）。
- 来源写法：`url` 必须是实际请求过的裸 URL（备注写 `locator`）；抓取走 `web_fetch` 工具或 bash（curl 等）均参与交叉核验——**bash 抓取时该 URL 的完整字面量必须逐字出现在命令里，禁止用 for 循环变量 / `$var` / 字符串拼接构造 URL**（`--session` 交叉核验按字面匹配，变量拼接抓到的 URL 因命令里无完整字面串会被误报"从未抓取"、断言降 provisional，实测 RECUR=12；`web_fetch` 的 url 参数天然是完整字面量，无此顾虑）；`spawn_researcher` 子代理抓取的来源可直接登记——其每次 web_fetch 的目标与成败随报告落盘为同名 `-sources.jsonl`（宿主写入），交叉核验会经报告存盘锚点读取（旧版宿主无此日志时子代理来源仍会被点名，此时改为主会话亲自补抓一次）；转运获得的内容加 `retrieved_via` 记实际请求的 URL；本地取证（跑测试、读本地安装文件）用 `local_command` 记执行过的命令，此时 `url` 可省略或仅作规范引用。**`local_command` 必须逐字粘贴会话中真实执行过的命令**（选最有代表性的一条），禁止概述/翻译/伪命令——结构校验会拒绝含独立中文词的散文式命令，收尾交叉核验按逐字子串匹配。本地文件取证一律用 bash 执行（cat/grep/sed/`python -c`），`read` 等结构化工具的取证不参与交叉核验。
- 会话出处（`session_file`）：收尾审计对交叉核验通过的证据条目自动盖章出处会话路径，manifest 由此可跨会话续用——续做会话里带章的历史条目按出处会话回溯核验，无需重新抓取；**该字段只由审计写入，不要手填或改动它的值**。新任务需要新 manifest 但沿用先前调研的证据时，从旧 manifest **原样拷贝带章条目（连同 `session_file` 字段）**——重新登记成无章条目会被误判从未取证。出处会话文件缺失时相关条目报"无法核验"，断言降为 `provisional` 或在本会话重新取证。
- 结构校验只能检查确定性关系，不能替代“来源是否真正蕴含主张”的语义审查。

## 发布门禁

结论状态只用：

- `publishable`：所有决策关键主张及依赖均为 `verified`/`supported`，结构校验通过；`strict` 还需要独立语义复核覆盖依赖闭包。
- `provisional`：证据有限但边界已明确，只能发布条件式结论。
- `blocked`：身份、引用支持、范围或关键依赖未通过；不得给确定推荐。

硬规则：`strict` 任务缺少通过结构校验的 manifest 时，结论状态封顶 `provisional`，不得声明 `publishable`。取证失败（限流/404/超时/空响应）的信息必须显式标注未能核验，不得写成确定事实——维护状态、作者信誉、测试/CI 存在性、兼容性均属此列。会话收尾时 five-layer HOOK（`evidence-settled-audit`）会自动交叉核验 manifest 来源与会话内真实抓取记录。

最终报告按用户需要组织，不因证据矩阵、阶段标题或篇幅获得可信度。先验证账本，再写结论。

## 退出与维护

具体站点、命令和当前工具放在其他 skill 或可替换参考中，不进入本契约。规则若不再防止实测失败、持续误拦截正确结论，或平台提供等价原生门禁，应压缩、替换或废弃；不要为单个案例堆特例。
