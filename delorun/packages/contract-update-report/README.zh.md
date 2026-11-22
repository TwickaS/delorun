---
description: "Delorun 更新报告契约（C3）的类型与固定值，供更新前报告、studio 的更新界面与桌面更新程序使用：报告条目与原因、两套安装的更新状态、健康检查标准与回滚触发条件。"
kind: "package-library"
---

# @delorun/contract-update-report

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/contract-update-report` 定义更新应用之前生成的更新报告：其条目及条目的种类、主体、原因、效果与验证，CLI（命令行界面）home 与桌面 Host 的更新状态，健康检查标准与回滚触发条件，以及撤销或恢复的批准提示所列出的内容。本包只包含导出的类型与只读常量，没有运行时代码，因此从不改变任何进程的行为；契约页面 [C3 更新报告](../../docs/contracts/c03-update-report.zh.md) 是权威来源，本包遵循该页面。其入口是 `src/index.ts`，以 `.` 导出。

## 目录

- [使用本包](#use-this-package)
- [已知限制](#known-limitations)

<a id="use-this-package"></a>

## 使用本包

`delorun/packages/update/` 中的更新前报告、studio 的更新界面、`delorun/packages/profile-safety/` 与桌面更新程序使用本包。用 `import type` 导入类型，用值导入从 `@delorun/contract-update-report` 导入常量；读取或写入本契约所定义文件的包仍须在其解析器处验证这些文件，因为这些类型描述的是有效文件，并不检查文件。

<a id="known-limitations"></a>

## 已知限制

- 报告的原因列表对报告格式 3（`delorun.update-report/3`）是封闭的；新增原因需要新的格式版本，如契约页面所述。格式 1 与 2 已停用：没有任何发布版本采用过它们。
- `UncheckedSource` 只有一个值 `revocations`：没有任何发布版本公布撤销列表，因此报告会在 `notChecked` 中列出它。各组合包自身的层以及目标将跳过的组合包都会被读取，它们是条目而不是未检查的来源。
