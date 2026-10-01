# knowledge-pointer

KNOWLEDGE 层指针推送 + 埋点。与 experience-retrieve 互补:经验层推全文,知识层只推指针。

## 动机

KNOWLEDGE 进入工作流此前全靠模型自觉读 index,而"模型不会主动查索引"已被
experience-retrieve 的埋点数据证实(claude 侧 hits.log 715 条中主动 READ 仅 26 条)。
本扩展给知识层补上与经验层同款的"推送 + 埋点",且刻意更轻:只注指针不注全文。

## 机制

- `before_agent_start`:用户 prompt 对 `knowledge/index.md` 的「触发词」列匹配,
  命中注入指针行(路径 + 摘要),读不读由模型判断。主库 + 项目库(`<cwd>/.pi/knowledge`)都扫。
- 单触发词即命中 → 触发词列只收领域专名,卫生规则写在 index.md 表头上方。
- 每会话每页面注一次;无触发词列的旧表格行自动跳过。可推送状态为**整词** `verified`/`active`
  (`inactive` 不算;2026-09-28 前按子串匹配会误收)。
- 校准参数:`PI_KN_MAX_POINTERS`(每次 prompt 最多指针数,默认 3)、`PI_KN_DIR`(主库目录覆盖,测试用)。
- 埋点 `knowledge/hits.log`(行尾带 `sid=<会话>`,POINTER/READ 同会话配对):
  POINTER(注入)/ READ(模型随后主动 read 知识页,由 tool_result 钩子记录)。READ 认两类:
  `/knowledge/` 目录下的 .md,以及主库/cwd 项目库索引**登记在库外的页**(2026-09-28 起;某项目库 15 条里 13 条
  指向 `文档/*.md`,此前 10 个会话读了 30+ 次却零埋点)。extra 带 `lib=<库目录>`,相对路径与库外页也能归到库。

## 统计

```
node stats.mjs                              # pi 库
node stats.mjs ~/.claude/knowledge/hits.log # claude 库(格式一致,同一脚本)
```

输出直接回答"知识库有没有真正进工作流":

- **指针→阅读转化率**(同会话配对):POINTER 高、READ 低 → 触发词准但内容不值得读(修内容)
- **召回缺口**(READ-without-POINTER 且没走设计好的入口):模型自己找到了、指针没推 → 真值级的"该推没推"样本,照单补触发词
- **经入口召回**(2026-09-28 起单列):READ-without-POINTER 但页面被 AGENTS.md/CLAUDE.md 或 skill 字面点名
  (全局入口 + 该会话 cwd 项目 + 该库所在项目),或同会话先读了同库 index.md——设计好的召回路径,**不补触发词**。
  此前这类全算缺口:某部署页(项目 AGENTS 点名)、governance-decisions(five-layer-governance 点名)是假阳性
- **噪声候选**(POINTER≥3 零转化):考虑收紧触发词或下架
- **索引可解析性**:逐库数「可推送行」,0 行报「⚠ 整库零推送」。库来自 hits.log 路径 + 会话 cwd + Qika 项目列表
  (`~/.pi-web/app-data.json` 的 projects[].path,`PI_WEB_DATA_DIR` 可覆盖)+ 已知 ≥2 个项目的父目录下的兄弟项目
  (零会话、不在 Qika 列表的库也进视野,如刚建库还没开过会话的项目;TEMP 根目录不扫)。主动 READ 按路径或 `lib=` 归库
- POINTER 本身低 → 知识页覆盖与实际任务不重合(补页面,而非修机制)

## 准入卡

- 规则 ID:knowledge-pointer
- 已观察失败:KNOWLEDGE 层召回全靠模型自觉读 index,而"模型不会主动查索引"已被经验层埋点证实(claude 侧 hits.log
  715 条中主动 READ 仅 26 条);知识层上线前无任何推送与观测(2026-09-02 立项)。
- 关联层与主源:HOOK 层(注入型),服务 KNOWLEDGE 层;索引格式主源是各库 index.md 表头规则与 `knowledge/templates`。
- 事件:`before_agent_start`(指针注入)、`tool_result`(READ 埋点)、`session_start`(去重清零)
- 确定性检测信号:用户 prompt 与索引「触发词」列的字面匹配(ASCII 词边界 / CJK 去空白子串);READ 看 read 工具的目标路径。
- 策略:context(只注指针,不注全文,不拦截)
- 选择该策略的理由:注错的代价是约百 token 的一行指针,远低于全文注入;读不读由模型判断,不替模型决定。
- 正例:prompt 含「compaction」→ 注入 `pi-compaction-task-continuity.md` 指针;同会话再提不重复注入。
- 反例:无关 prompt 零注入;维护知识库自身的 prompt(含 `/knowledge` 路径)不匹配;draft/inactive 行、无触发词列的旧行不推。
- 错误策略:allow(handler 全程自兜底,异常一律不注入、不影响会话)
- 恢复路径:指针漏推时模型仍可按 AGENTS 路由读 index.md(设计好的基线入口)。
- 回滚方式:删除 `~/.pi/agent/extensions/knowledge-pointer/` 或移出 extensions 目录;统计脚本独立,可单独保留。
- 退出或复核条件:pi 原生支持知识检索/资源推送时退役;stats「指针→阅读转化率」全库长期 <20% 且「召回缺口」为空
  → 指针无增益,下线。

## 测试

```
npx tsx test-pointer.mjs     # 解析/匹配/注入/去重/防自触发/READ 埋点(含库外登记页、lib=)/inactive 负例/PI_KN_MAX_POINTERS/评测态静音
node test-stats.mjs          # stats 口径:经入口召回分流、Qika 列表与兄弟项目枚举、inactive、lib= 归库
```

fixture 库经 `PI_KN_DIR` 注入(须在 import 前设置),不依赖活数据;fixture 用完即删(stats 的兄弟项目扫描会把残留当项目库)。
fixture 目录必须带 `knowledge/` 路径段——`/knowledge/` 目录内的 READ 埋点靠它识别。

## 对应物

claude 侧同款:`~/.claude/hooks/knowledge-pointer.py`(UserPromptSubmit hook),
埋点在 `~/.claude/knowledge/hits.log`。两侧索引格式不同(claude 是 keywords 列,
pi 是触发词列),各自维护,不跨库——沿用 2026-08-12 经验库隔离决策。
stats.mjs 的 Claude 侧副本是 `~/.claude/hooks/knowledge-stats.mjs`(本扩展无仓库源,两处互为备份,改动两处同步)。
