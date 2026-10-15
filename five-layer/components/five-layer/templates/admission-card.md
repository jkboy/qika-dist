# Hook 准入卡

- 规则 ID：
- 已观察失败：（附可重放样本：一句可原样重发的任务措辞 + 期望不再出现的行为；正例/反例即消融 oracle——禁用规则跑正例，不复发即删）
- 关联层与主源：
- 事件：`tool_call` / `before_agent_start` / `agent_settled`
- 确定性检测信号：
- 策略：`warn` / `block` / context / reminder
- 选择该策略的理由：
- 正例：
- 反例：
- 错误策略：`allow` / `block`
- 恢复路径：
- 回滚方式：
- 退出或复核条件：
