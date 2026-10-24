# Task Continuity Extension

把 `task-tracker` 的磁盘状态与 Pi 原生 compaction 事件连接起来，防止压缩后只凭摘要继续而发生目标、边界或验证状态漂移。

## 运行链路

1. `session_before_compact` 查找项目 `.pi/tasks/` 中最近更新、状态为 `in_progress` / `blocked` 的 task。
2. 把该 task 的“当前状态”和“恢复入口”作为 continuity anchor 加入 Pi 默认摘要器输入（共 6000 字符：恢复入口先保至多 3000，当前状态吃剩余、从头截——曾整体截断，长期运营 task 的当前状态退化成日志后把恢复入口整节挤出摘要）。若其他 extension 完全接管 compaction，能否消费该 anchor 取决于 handler 加载顺序；压缩后 read 门禁不依赖这一优化。
3. `session_compact` 在新 compaction entry 后写入持久恢复状态，并给模型加入隐藏恢复消息。
4. 恢复状态清除前，`tool_call` 只允许 `read` 精确读取该 task；本次恢复以来的 read 读回内容**合并计算**，两个恢复节都出现过即清除门禁（大文件一次读不全，模型分页读是理性行为）。恢复消息与拦截文案带两节的行号，已读到一节时点名缺哪节、从哪行读（2026-09-28：一个长期运营 task 21 次压缩里模型从头小页翻、够不到第 74 行的恢复入口，降级 3 次）。**宽限降级**（2026-08-17 五层审计整改）：拦截达 `PI_TASK_CONTINUITY_MAX_BLOCKS`（默认 3）次仍未读成功（task 文件损坏/缺节/read 反复失败）→ 门自动降级为建议式——不再拦工具，恢复消息继续注入并带降级警示；降级后读成功仍照常解门。防用户不在场时的准死端（补下限机制不该自己变成死端）。
5. `/reload` 或恢复 session 时，从 session custom entry 重建未完成门禁。

摘要中的 task 片段只是双保险。压缩后仍必须读取磁盘文件，主源优先级是：

```text
最新用户消息 > task 恢复入口 > 文件/代码/验证事实 > 压缩摘要 > 模型记忆
```

## 边界

- 没有活动 task：不注入、不提醒、不阻断。
- 项目未受 Pi trust：不读取项目 `.pi/tasks/`。
- checkpoint 超过 10 分钟：压缩时警告，但不取消压缩，避免临近上下文上限时再追加一轮导致 overflow。
- 自定义 compactor：如果它在本 extension 之前生成结果，摘要可能不含 task anchor；持久恢复状态和 read 门禁仍生效。
- 手动、threshold、overflow 三类 compaction 都设置压缩后恢复门禁。
- 如果用户明确放弃旧任务，运行 `/task-continuity skip`；这是显式逃生口，不做语义猜测。
- Hook 只能识别状态、路径和工具结果，不能判断业务进度；阶段 checkpoint 仍由 `task-tracker` 工作流负责。

## Hook 准入记录

- 已观察失败：长任务压缩后依赖摘要继续，注意力漂移，遗漏当前步骤、用户边界或验证状态。
- 主层：SKILL（checkpoint 工作流）+ HOOK（compaction 后确定性恢复门禁）。
- 召回入口：全局 AGENTS → `task-tracker`；Pi 自动发现本 extension。
- 检测信号：task 状态、mtime、compaction event、tool name/path、tool result error 字段。
- 策略：压缩前 message-only/warn；压缩后 block，直到精确 task read 成功。
- 正例：有活动 task 的 compaction 后，非 task-read 工具被阻断；精确 read 成功后放行。
- 反例：无活动 task、已 done task或未发生 compaction时不阻断。
- 错误策略：找不到/读不了 task 时不伪造状态，保持门禁并提示用户使用显式 skip。
- 回滚：移走 `~/.pi/agent/extensions/task-continuity/` 后 `/reload`；task 文件仍可手工恢复。
- 退出条件：Pi 提供内建、可验证的 task checkpoint/recovery 主源机制，或真实任务证明该门禁持续误伤。

## 命令

```text
/task-continuity       # 查看 trust、活动 task 与门禁状态
/task-continuity skip  # 用户显式放弃当前恢复门禁
```

修改 extension 后运行 `/reload`，或重启 Pi。
