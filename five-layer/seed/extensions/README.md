# ~/.pi/agent/extensions —— 全局扩展清单（HOOK 层入口）

pi 从本目录自动发现扩展（`*.ts` 单文件或 `<名>/index.ts`），另加 `settings.json` 的 `packages`（git 包）。
本表是全部全局扩展的清单：新增、退役时同步改这里。审计时先跑 `qika doctor` 拿真实加载集，再和本表对账——不在表里的就是孤岛。
这份文件归你维护（`qika five-layer init` 写入起步版，Qika 更新不会改它）。

「类型」按对模型/会话的作用分：**门禁**（block 工具调用）· **注入**（往上下文追加内容）· **提醒**（只给人看）· **能力**（注册工具）· **基础设施**（不面向模型）。门禁和注入受 FIVE-LAYER §4/§5 的 HOOK 准入约束。

| 扩展 | 类型 | 做什么 | 来源 | 关掉它 | 观测入口 |
|---|---|---|---|---|---|
| `experience-retrieve/` | 注入 + 门禁（一次性减速带） | EXPERIENCE 条目按关键词注入工具结果；bash 命令命中时拦一次（原样重发即放行，复发后再拦的次数 `PI_EXP_REARM_LIMIT`，默认 1） | Qika five-layer starter | 只要注入不要拦截：`PI_EXP_REARM_LIMIT=0`；整个不要：删目录 | `../experience/hits.log` + `node experience-retrieve/stats.mjs` |
| `knowledge-pointer/` | 注入（只推指针不推全文） | 按 knowledge 索引触发词每轮推送页面指针（主库 + `<cwd>/.pi/knowledge`），每次最多 `PI_KN_MAX_POINTERS` 条 | Qika five-layer starter | 删目录 | `../knowledge/hits.log` + `node knowledge-pointer/stats.mjs` |
| `five-layer/` | 注入 + 提醒 | 规则 registry：`current-date`（每轮注入真实日期）、`evidence-research-context`（调研任务注入发布纪律）、`evidence-settled-audit`（收尾核验证据来源） | Qika five-layer starter | 单条规则：`PI_FIVE_LAYER_DISABLE=规则id,…`；整个不要：删目录 | 交互 `/five-layer` |
| `task-continuity/` | 门禁（压缩后恢复读门，拦 `PI_TASK_CONTINUITY_MAX_BLOCKS` 次后降级为建议） | 上下文压缩后先读活动 task 文件再干活 | Qika five-layer starter | 删目录 | `qika doctor` 第 10 节 |

来源为「Qika five-layer starter」的扩展：你没改过就随 `qika-update` 自动升级；改过就保留你的版本，新版放在 `~/.pi/agent/.five-layer/upstream/`，`qika doctor` 第 12 节会提示。想加自己的规则或扩展，新建目录并登记到上表；改随包扩展的文件会让它从此收不到上游修复，优先用上面的开关。
