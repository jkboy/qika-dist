# Five-layer Hook Framework

这是 Pi 五层体系的通用 HOOK 框架。它使用 Pi TypeScript extension 事件，规则经显式 registry 注册，每条带准入卡。具有独立生命周期的具体 hook 可放在单独 extension；当前 task 压缩恢复机制位于 `../task-continuity/`。

## 文件

- `index.ts`：dispatcher 与 `/five-layer` 状态命令。
- `types.ts`：规则契约。
- `rules/index.ts`：规则唯一 registry（清单以该文件为准，`/five-layer` 只数 `enabled !== false` 的）。2026-09-28 时注册 4 条、现役 3 条：before_agent_start `evidenceResearchContext`、`currentDateContext`；agent_settled `evidenceSettledAudit`；tool_call `duplicateSearchGate` 已退役（`enabled:false`，理由与恢复条件见其准入卡）。
- `rules/admission-*.md`：各规则准入卡。
- `templates/`：新增规则的代码模板与准入卡。

Pi 会从 `~/.pi/agent/extensions/five-layer/index.ts` 自动发现此 extension；修改后在交互会话运行 `/reload`，或重启 Pi。

## 支持的事件

| 规则类型 | Pi 事件 | 用途 | 能否阻断 |
|---|---|---|---|
| `ToolCallRule` | `tool_call` | 检查工具名、参数、路径、命令等 | `mode: "block"` 可阻断 |
| `PromptContextRule` | `before_agent_start` | 根据确定性信号注入本轮上下文 | 否 |
| `SettledReminderRule` | `agent_settled` | Agent 完全停止后的用户提醒 | 否 |

`agent_settled` 不是 Stop hook，不能撤回已经给出的最终答复。需要完成前验证的语义流程应放 SKILL；只有能在工具调用前确定性检查的条件才适合 block。

## 新规则准入

先填写 [`templates/admission-card.md`](templates/admission-card.md)，并满足：

1. 有真实漏报、误操作或重复遗忘证据。
2. 信号只依赖路径、命令、事件字段或状态文件，不要求 LLM 理解语义。
3. 已查重 AGENTS、SKILL、KNOWLEDGE、EXPERIENCE，确认自动化确有必要。
4. 默认先 warn；block 仅用于高损失、低误判场景。
5. 有正例、反例、错误策略和回滚方式。

然后从 [`templates/tool-call-rule.ts.txt`](templates/tool-call-rule.ts.txt) 复制到 `rules/`，在 `rules/index.ts` 显式导入并注册。不要做目录自动扫描；显式 registry 便于审计活动规则。

## 验证

- 结构：所有规则 ID 唯一，`enabled !== false` 才运行。
- 正例：危险输入应产生预期 warn 或 block。
- 反例：相似但安全的输入必须放行。
- 非交互模式：warn 不弹 UI；block 仍生效。
- 错误策略：默认 `onError: "allow"` 并警告；高风险规则可显式设为 `"block"`。

运行 `/five-layer` 可查看入口路径和当前活动规则数量。
