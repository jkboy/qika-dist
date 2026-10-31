# Task Continuity Extension

把 `task-tracker` 的磁盘状态与 Pi 原生 compaction 事件连接起来，防止压缩后只凭摘要继续而发生目标、边界或验证状态漂移。

## 运行链路

1. `session_before_compact` 选 task：**只认本会话 `edit`/`write` 过的** `<项目>/.pi/tasks/*.md`（从会话分支回填，与 pi-web 的 todo 镜像同口径；最近写的优先，已 `done` 的顺延到更早绑定的活动 task），且状态为 `in_progress` / `blocked`、带恢复契约。**不按项目目录里“mtime 最新的活动 task”选**——task 目录是同项目多会话共享的，那样会把别的会话（或长期 `blocked` 等日期的复审 task）的内容塞进本会话的摘要并强制 read（2026-10-28 实测：调研 Strata 的会话压缩时被塞进 18 小时前的「复审ETN三季报」；pi-web 的 todo 镜像 09-13 因同一原因就废弃了这个启发式，本扩展当时没同步）。`read` 不算绑定：恢复门自己会强制 read task，算了会把一次误选固化成永久绑定。
2. 把该 task 的“当前状态”和“恢复入口”作为 continuity anchor 加入 Pi 默认摘要器输入（共 6000 字符：恢复入口先保至多 3000，当前状态吃剩余、从头截——曾整体截断，长期运营 task 的当前状态退化成日志后把恢复入口整节挤出摘要）。若其他 extension 完全接管 compaction，能否消费该 anchor 取决于 handler 加载顺序；压缩后 read 门禁不依赖这一优化。
3. `session_compact` 在新 compaction entry 后写入持久恢复状态，并给模型加入隐藏恢复消息。
4. 恢复状态清除前，`tool_call` 只允许 `read` 精确读取该 task；本次恢复以来的 read 读回内容**合并计算**，两个恢复节都出现过即清除门禁（大文件一次读不全，模型分页读是理性行为）。恢复消息与拦截文案带两节的行号，已读到一节时点名缺哪节、从哪行读（2026-09-28：一个长期运营 task 21 次压缩里模型从头小页翻、够不到第 74 行的恢复入口，降级 3 次）。**宽限降级**（2026-08-17 五层审计整改）：拦截达 `PI_TASK_CONTINUITY_MAX_BLOCKS`（默认 3）次仍未读成功（task 文件损坏/缺节/read 反复失败）→ 门自动降级为建议式——不再拦工具，恢复消息继续注入并带降级警示；降级后读成功仍照常解门。防用户不在场时的准死端（补下限机制不该自己变成死端）。
5. `/reload` 或恢复 session 时，从 session custom entry 重建未完成门禁。

摘要中的 task 片段只是双保险。压缩后仍必须读取磁盘文件，主源优先级是：

```text
最新用户消息 > task 恢复入口 > 文件/代码/验证事实 > 压缩摘要 > 模型记忆
```

## 边界

- 本会话没有 edit/write 过的活动 task：不注入、不提醒、不阻断（项目里别的会话遗留的活动 task 一律不碰）。留痕：项目里确有活动 task 时在 `session_compact` 追加一条 `task-continuity-state` 的 `recovery-skipped` 条目（`candidates` = 被忽略的候选，`readByThisSession` = 其中本会话 read 过的）。`readByThisSession` 为空 = 正常跳过；非空 = 本会话读过却从没写过它，**疑似接手型会话漏报**（用户说“继续”→ 读旧 task → 一直没 checkpoint）。复核命令：`grep -rh '"state":"recovery-skipped"' ~/.pi/agent/sessions | grep -v '"readByThisSession":\[\]'`；有命中就看那个会话是否确实在做该 task，是的话要放宽绑定口径（例如把“压缩前最近一次 read”并入）。接手型会话想被覆盖：第一次 checkpoint 写一次该 task 文件即绑定（SKILL 已写明）。
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
- 检测信号：本会话分支里对 `.pi/tasks/*.md` 的 edit/write 调用（归属）、task 状态与恢复契约、mtime（仅用于陈旧提示）、compaction event、tool name/path、tool result error 字段。
- 策略：压缩前 message-only/warn；压缩后 block，直到精确 task read 成功。
- 正例：本会话写过活动 task 的 compaction 后，非 task-read 工具被阻断；精确 read 成功后放行。
- 反例：本会话没写过任何 task（即使项目里有更新的活动 task）、已 done task、未发生 compaction 时不阻断、不注入摘要。回归用例：`test-extension.mjs`「事故复现」段（旧实现在此断言失败）。
- 判别式归类：这是缩小既有 C 类护栏（压缩后读门）的作用范围、去掉一个误伤源，不是扩大；护栏登记见 docs/dsh-adoption-plan.md W8。
- 错误策略：找不到/读不了 task 时不伪造状态，保持门禁并提示用户使用显式 skip。
- 回滚：移走 `~/.pi/agent/extensions/task-continuity/` 后 `/reload`；task 文件仍可手工恢复。
- 退出条件：Pi 提供内建、可验证的 task checkpoint/recovery 主源机制，或真实任务证明该门禁持续误伤。

## 命令

```text
/task-continuity       # 查看 trust、本会话的 task、项目里被忽略的其他活动 task 数、门禁状态
/task-continuity skip  # 用户显式放弃当前恢复门禁
```

修改 extension 后运行 `/reload`，或重启 Pi。
