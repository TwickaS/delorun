# Agent Note: Delorun 文档采用英文与中文，每页配有一致性记录

Status: implemented

[English](2026-11-06-delorun-bilingual-documentation.md) | 中文

## 问题

Delorun 的文档由英文与中文读者阅读。只有一种语言的页面会使另一语言的读者缺少同样的事实，而与源文脱节的译文会让两类读者得到不同的事实。上游的配对约定已经规定了一页与其对侧文件如何保持一致。Delorun 的文档需要同样的保证，并且其术语在每一页上的含义都必须一致。

## 决策

`delorun/docs/` 下的每一页都是一对英文与中文页面，并配有其一致性记录，遵循[上游双语约定](../../../../docs/i18n/README.zh.md)。配对门禁覆盖 `delorun/docs/`。Delorun 的文档只提供英文与中文。Delorun 的界面屏幕会以上游的每种界面语言发布，这与文档是两回事。

Delorun 的产品术语及其中文译法保存在[术语来源](../../../../docs/i18n/terminology.md)中，Delorun 术语表为每个概念提供条目。译文使用术语来源中的译法。

文档标准要求 Delorun 文档网站为每一页同时提供 HTML 与 Markdown 两种形式，并为编码 agent 提供 `llms.txt` 索引，且每一页都注明其所描述的 Delorun 版本。

## 验证

`pnpm run verify-translation-pairing` 检查 `delorun/docs/` 与上游范围内每一对页面的一致性记录、语言切换行与结构。文档门禁 `pnpm run verify-md-wrap`、`pnpm run verify-md-links`、`pnpm run doc-typecheck` 与 `pnpm run verify-doc-budgets` 检查同样的页面。门禁通过只确认结构与已记录的哈希，而审阅则确认两种语言表达的是同一件事。

## 相关决策

已归档的[分节配对记录决策](../../archived/process/2026-09-23-section-keyed-translation-pairing-records.md) 记录了一致性记录的格式。该决策已经冻结，本笔记按照当前双语约定所陈述的格式使用它。

## 曾考虑的替代方案

**仅英文。** 阅读中文的人会缺少同样的事实，文档也无法服务于它所面向的读者。

**更多语言。** 每增加一种语言，每一页都要多一个完整的配对，并需要该语言的读者进行审阅。Delorun 的审阅者阅读英文与中文，因此第三种语言会在没有能够核对它的审阅者的情况下被翻译。

## 后果

每次文档改动都在同一次改动中更新两种语言，审阅者同时检查含义与结构。

每页的一致性记录是该页改动的一部分，因此未重新记录配对的页面编辑会使门禁失败。

网站发布两种语言以及每一页的 Markdown 副本，因此每一页都有不止一种需要保持正确的已发布形式。
