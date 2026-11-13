# KNOWLEDGE 索引

> 存放可从文档、源码、配置或稳定事实源复查的参考。两条召回路：①knowledge-pointer 扩展每轮用用户 prompt 匹配下表「触发词」列，命中即注入一行指针（路径 + 摘要，不注全文），模型按需 read；②手动查询——未被推送但任务涉及外部事实时，先读本索引再按需读取命中的页面。项目级 `<project>/.pi/knowledge/index.md` 同一格式、同样被推送。
> 起步版为空表（`qika five-layer init` 写入，归你维护，Qika 更新不会改它）。

## 使用规则

1. 只在任务涉及外部工具、平台、API、框架事实或跨项目参考时扫描本索引。
2. 根据 `摘要` 与 `read_when` 选择页面，不全量读取。
3. 新增页面必须填写来源、状态、更新时间、召回条件与使用者，并加入下表。
4. 动态事实写明 `reverify_when`；过时页面从运行索引移除或迁入 `deprecated/`。
5. 带 A 失败 / B 成功试错链且尚未归位的内容应放 EXPERIENCE，不放这里。
6. 日期以页面 frontmatter 的 `updated` 为唯一来源；下表「更新日期」列只为保持 7 列解析格式，统一填「见 frontmatter」。
7. 「状态」列只用四个词：`verified`、`active`（会被推送）、`draft`、`deprecated`（不推送）。其他词一律不推送。

## 页面

> 表格必须保持 7 列、列序 `页面 | 摘要 | read_when | used_by | 状态 | 更新日期 | 触发词`（扩展按固定列位解析，少一列即整库零推送，`qika doctor` 第 12 节会报）。单元格里不要出现 `|`。**单触发词即命中，故只收领域专名**（某个工具名、错误码、协议名这类）；「文档」「训练」等宽词勿入，触发词用 `、` 分隔。埋点见 `knowledge/hits.log`（POINTER/READ）。

| 页面 | 摘要 | read_when | used_by | 状态 | 更新日期 | 触发词 |
|---|---|---|---|---|---|---|

## 模板

新建页面时使用 [`templates/entry.md`](templates/entry.md)，完成后把页面登记到上表。
