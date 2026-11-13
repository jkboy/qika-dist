---
name: knowledge-sediment
description: 把项目里踩过的坑和可复查的项目事实沉淀进项目库（试错教训 → .pi/experience/，可复查事实 → .pi/knowledge/），任务开始时也用它查这两个库。一个问题试了 2 种以上方案才解决、发现与文档/直觉相反的行为、外部服务的坑，或用户说"记下来"时使用。Use after solving a tricky problem, when asked to remember something, or to look up project experience/knowledge at task start.
---

# 项目沉淀

项目内两个库（随 git 走，换机器不丢），按内容形态分：

| 内容 | 放哪 | 判据 |
|---|---|---|
| 能从文档、源码、配置、测试复查的事实：API 语义、版本边界、项目约定、根因已固化进代码的规则 | `.pi/knowledge/` | 能复查就是 knowledge——反直觉不等于经验 |
| 试错链：方案 A 失败 → 方案 B 成功，只能踩坑得来、查不到 | `.pi/experience/` | 有 A❌/B✅ 且查不到 |
| 换个项目也会踩的环境坑（Windows、git-bash、代理、tailscale…） | 不放项目库，按 five-layer-governance 评估进全局库 | 跨项目 |
| 常识、一次就成功的常规操作、大段日志原文 | 不记 | |

## 查（任务开始时）

1. `.pi/experience/INDEX.md` 存在：拿当前任务涉及的工具名、报错串对「关键词」列，命中才读正文。
2. `.pi/knowledge/index.md` 存在：对「摘要」「read_when」列，命中才读页面。
3. 都没命中就不读，省上下文。

knowledge 库会被 knowledge-pointer 按用户 prompt 的触发词自动推指针；experience 库没有自动注入，只靠这一步和 AGENTS 路由召回。

## 记 experience

1. 写 `.pi/experience/<短横线英文名>.md`，≤15 行：

```markdown
# <一句话标题>

- **现象**：<错误信息关键行 / 可观察信号>
- **试过**：方案 A ❌ <为什么不行>；方案 B ✅ <成功证据>
- **结论**：<下次遇到同样信号直接怎么做，可复制的命令或代码>
- **边界**：<版本、平台、前置条件>
- **来源**：<task 文件或会话日期>
- **退出条件**：<何时删除或提升，如「上游修复发版后复测通过即删」>
```

2. 在 `.pi/experience/INDEX.md` 表格加一行（文件不存在先建，表头照抄）：

```markdown
| 关键词 | 条目 | 触发现象 | 状态 |
|---|---|---|---|
| <关键词1>、<关键词2> | [`<名>.md`](<名>.md) | <一句话现象> | active |
```

关键词只写**真实报错或命令输出里会字面出现的串**（如 `EADDRINUSE`、`status=1/FAILURE`）；不写描述性短语（「端口冲突」）、不写结论里推荐的命令或参数（会拦住正确做法）、不用项目名/功能名/常见英文单词。关键词只写在 INDEX，正文不再抄一份。

3. 同一个坑的新发现追加到原条目，不新开文件。

## 记 knowledge

1. 写 `.pi/knowledge/<主题>.md`：

```markdown
---
summary: <一句话摘要>
status: verified
updated: YYYY-MM-DD
sources:
  - <可复查来源：文档 URL / 源码路径 / 测试名>
reverify_when: <何时重新核对；稳定事实写 never>
---

# <标题>

## 结论

<只写可复查事实，不写试错过程。>

## 适用边界

<版本、平台、前置条件和不适用场景。>
```

2. 在 `.pi/knowledge/index.md` 表格加一行（7 列，表头照抄）：

```markdown
| 页面 | 摘要 | read_when | used_by | 状态 | 更新日期 | 触发词 |
|---|---|---|---|---|---|---|
| [`<主题>.md`](<主题>.md) | <摘要> | <什么任务该读> | <谁会用> | verified | YYYY-MM-DD | <领域专名1>、<专名2> |
```

少于 7 列、或状态不是 `verified` / `active` 的行不会被推送（未核实写 `draft`）。触发词对用户 prompt 单词即命中，只收领域专名（`meshoptimizer`、`R2V`、`exit 49`），不收宽词（「文档」「优化」「训练」）。

## 新建库时

项目 `AGENTS.md` 加一行路由（experience 库必须加，它没有自动注入；已有就不重复）：

```markdown
- 项目经验库 `.pi/experience/INDEX.md`、知识库 `.pi/knowledge/index.md`：排障或动手前先扫；新坑按 knowledge-sediment 沉淀。
```
