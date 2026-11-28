# Hook 准入卡：duplicate-search-gate

- 规则 ID：duplicate-search-gate
- 已观察失败：长调研会话对同一 query 反复 web_search，烧预算不产生新信息。机制来源为开源项目 FrontierAgent 的 DuplicateQueryRollbackObserver（其两个 workflow README 均列为三大重复止损之首），经独立评审裁定为最值得转化的机制。
- 关联层与主源：HOOK 层，本规则即唯一主源（原评审档案随 FrontierAgent 本地项目清理，本卡自含全部准入依据）。
- 事件：`tool_call`
- 确定性检测信号：toolName 末段 == `web_search` 且归一化 query（小写/trim/空白折叠）与本会话已执行记录字节级相同；纯字符串匹配，无语义判断。
- 策略：block（一次性减速带）
- 选择该策略的理由：dispatcher 的 warn 只走 `ctx.ui.notify`，模型不可见，防不了模型侧失败模式；block 的 reason 由 SDK 合成 isError 工具结果送达模型，等价于 FrontierAgent 的 skip_with_result。符合 block 三条件：高损失（每次重复搜索烧真实 API 成本与轮次）、低误判（归一化字节级同 query 才拦）、恢复路径清晰（reason 内写明"原样重发即放行"）。
- 正例：同一会话同 query 第二次 web_search 被拦且 reason 指导改写/复用；原样重发第三次放行；第四次重复再次被拦（重新武装，循环搜索每两次烧一次）。
- 反例：不同 query 不拦；非 web_search 工具不拦；query 缺失/非字符串不拦；大小写/空白差异视为同 query（归一化）；新会话不受上一会话记录影响（session_start 经 reset() 清理）。
- 错误策略：`allow`（check 内部全量 try/catch 返 undefined，dispatcher 再兜一层）
- 恢复路径：被拦后原样重发即放行（知情选择）；改写 query 立即放行。
- 回滚方式：`rules/index.ts` 移除注册，或本规则 `enabled: false`。
- 退出或复核条件：pi 平台原生提供搜索去重/回滚后删除；或 hits 观察（如后续加埋点）显示误伤率高于预期时降为提醒类实现。
- 已知限制：tool_call 钩子看不到结果成败，首搜失败后的原样重试会被拦一次（代价一次往返）；同进程并行会话共享模块级状态，行为未验证。

## 退役（2026-09-28，`enabled: false`，代码/注册/测试保留）

- 理由（五层审计 docs/five-layer-audit-20260928.md H3）：①准入依据是外部项目 FrontierAgent 的机制，**无本机失败样本**；②主会话 168 次 web_search 重复 query 为 0、拦截为 0；③重复搜索最可能发生在子代理，但子代理 `noExtensions:true`（pi-web `server/src/sessions/subAgentRunner.ts`），本规则管不到；④`seen` 是模块级 Map，pi SDK 按 cwd 缓存扩展 factory，Qika 同项目并行会话共享它——一个会话的 session_start reset 会清掉另一个会话的记录、也可能误拦对方首搜；⑤无触发埋点，原「如后续加埋点」的复核条件永远不会被触发。
- 恢复条件：出现本地重复搜索样本（主会话同 query 重复 web_search ≥3 次的会话，或子代理放开扩展后的同类样本）。恢复时**同时**把状态改为按会话分桶（键含 sessionId，或状态移入 factory 闭包）并加 hits 埋点，再把 `enabled` 改回 true。
