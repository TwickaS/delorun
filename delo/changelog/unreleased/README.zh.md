# 未发布的变更

[English](README.md) | 中文

每项人们能察觉到的变更，在此文件夹中添加一个片段文件，并用使用 Delo 的人能理解的文字写成。发布时，片段会汇总进 `CHANGELOG.md` 和发布说明，加上 `From upstream` 部分，已使用的文件移入 `releases/<version>/`。`gates:changelog` 门禁拒绝改动产品文件、却既没有添加片段、也没有 `Changelog: none (<reason>)` 尾注的提交。`gates:commits` 在整个范围内检查该尾注的理由。

## 格式

文件以变更命名，使用小写单词并以连字符分隔，例如 `upstream-changed-lane.md`。文件开头是前置元数据，其中包含一个 `section:` 字段，之后是一行或多行项目符号：

```markdown
---
section: Fixed
---

- The recorded-session replay no longer fails every scenario when the build is missing; the checks build first.
```

| `section` | 用于 |
| --- | --- |
| Added | 新的功能或选项 |
| Changed | 已有功能的行为变化 |
| Fixed | 已修复的缺陷 |
| Security | 已修复的漏洞或新增的保护 |
| Removed | 被移除的内容，以及替代方案 |
| From upstream | Delo 现已包含、且人们会注意到的 DeepSeek Harness 变更 |

发布说明按以下顺序排列各部分：Security、Added、Changed、Fixed、Removed、From upstream。

只写变更对用户意味着什么，不写代码如何改动。不要使用内部名称、议题或拉取请求编号、工作包名称或决策编号；门禁会拒绝 `#` 后接数字、`WP` 后接数字，以及 `D`、`A`、`C` 后接至多三位数字的写法。破坏性变更还需链接 `delo/docs/upgrade-guide/` 下的升级指南。

## 无需片段的情形

用户无法察觉的变更，在每个提交末尾添加一行尾注，并给出理由：

```text
Changelog: none (tests only)
```

只改动 Markdown 文件，或只改动 `delo/docs/`、`docs/`、`.agents/`、`delo/apps/tools/`、`delo/apps/release/`、`.github/` 或本文件夹下文件的提交，既无需片段，也无需尾注。
