# 五层体系 starter（给同事）

让你的 pi agent 学会**踩过的坑不再踩、查过的事实下次直接用**的一套基础机制。Qika 自带，默认不开，想用时执行：

```bash
qika five-layer init          # 先看会做什么：qika five-layer init --dry-run
```

执行后**重启 Qika**，新会话生效（命令行 `pi` 同样会加载）。

## 装了什么

五层是按「这条长期信息该放哪」分的层，边界见装好后的 `~/.pi/agent/FIVE-LAYER.md`：

| 层 | 放什么 | 装进来的东西 |
|---|---|---|
| AGENTS | 跨任务通用原则 + 到其他层的路由 | `~/.pi/agent/AGENTS.md` 起步版（**归你**） |
| SKILL | 某类任务的完整工作流 | `five-layer-governance`（治理五层）、`knowledge-sediment`（沉淀项目坑与事实）、`task-tracker`（长任务计划与恢复）、`evidence-contract`（调研必须有证据）、`doctor`（配置体检） |
| KNOWLEDGE | 可复查的事实 | 空索引 `knowledge/index.md`（**归你**）+ `knowledge-pointer` 扩展：你登记的页面命中触发词时自动推一行指针 |
| EXPERIENCE | 带「A 失败 / B 成功」试错链的教训 | 空索引 `experience/INDEX.md`（**归你**）+ `experience-retrieve` 扩展：命中关键词时把条目注入、执行前拦一次 |
| HOOK | 确定性的注入与门禁 | `five-layer`（每轮注入真实日期、调研任务注入证据纪律）、`task-continuity`（上下文压缩后先读 task 文件） |

**库是空的**——这套东西不带任何人的经验条目，别人的坑在你的环境里多半不成立。它从你自己的第一次踩坑开始长：
工具报错 → 换了方案跑通 → 收尾时会提醒「考虑沉淀 EXPERIENCE」→ 让 agent 按 `five-layer-governance` 写一条、登记进 INDEX →
下次同样的报错出现时它会自动弹出来。

## 更新会不会覆盖我改的东西

不会。规则只有两条：

- **归你的内容永远不碰**：`AGENTS.md`、两个索引、你写的条目与知识页、你自己建的技能和扩展。
- **随包的机制组件**（上表里的扩展和技能、`FIVE-LAYER.md`、两库模板）：你**没改过**就随 `qika-update` 自动升级；**改过**就整个组件保留你的版本，新版放到 `~/.pi/agent/.five-layer/upstream/<组件>/`，`qika doctor` 第 12 节会一直提示，直到你合并。你删掉的组件不会被装回来。

合并上游新版：`diff -ru ~/.pi/agent/<组件目录> ~/.pi/agent/.five-layer/upstream/<组件>` 看差异，把想要的改动搬过去；
想直接放弃自己的改动换成上游版：`qika five-layer add <组件> --force`（先备份到 `.five-layer/backup/`）。

## 不想要某样东西（不用改机制文件）

改随包组件的文件会让它从此收不到修复，所以优先用开关：

| 想关的 | 做法 |
|---|---|
| 某个技能 | `~/.pi/agent/settings.json` 的 `skills` 加 `"!技能名"` |
| five-layer 的某条规则（如每轮日期注入 `current-date`） | 环境变量 `PI_FIVE_LAYER_DISABLE=current-date`（多个用逗号分隔） |
| 经验库的「执行前拦一次」（只留注入） | `PI_EXP_REARM_LIMIT=0` |
| 压缩后读 task 的拦截次数 | `PI_TASK_CONTINUITY_MAX_BLOCKS=<次数>`（到次数后自动降级为提醒） |
| 整个组件 | 直接删它的目录（以后不会被装回；要装回：`qika five-layer add <组件>`） |
| 整个 starter | 删 `~/.pi/agent/.five-layer/`：之后更新不再同步，已装的文件就此完全归你 |

还有一条可选规则「先规划后编辑」（跨文件改动前先停下来等你确认计划），在 `~/.pi/agent/.five-layer/optional/`，喜欢这种节奏就粘进 AGENTS.md。

## 建议

- **把 `~/.pi/agent` 纳入 git**：五层的「过时就删」依赖 git 保留历史。init 结束时会打印命令（起步版 `.gitignore` 已排除秘钥与会话数据）。
- **隔段时间跑一次 `qika doctor`**：第 12 节报组件状态、有没有待合并的上游新版、你的索引能不能被扩展解析（格式写错会整库不生效）。
- 让 agent「审计一下五层」时它会加载 `five-layer-governance`，按里面的清单查重、消融、清理过期条目。
