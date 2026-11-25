---
description: "@delorun/setup-apply 库：把一项设置答案应用到 profile 的写入操作，由 delorun 命令与 studio 的 How Delorun runs 控件共用。"
---

# @delorun/setup-apply

[English](README.md) | 中文

## 摘要

这个包持有把一项设置答案变成 profile 运行所需文件的那些写入操作，因此 `delorun setup` 与 studio 的 How Delorun runs 控件通过同一份定义写入它们。它读取行并把行合并进 profile 的 `cordis.patch.yml`，构建提示词答案、studio 端口与 Tailscale 私有远程访问方式的补丁行，读取并写入 home-auth 行的 `pairing` 选择，并重写 profile 的 `setup-answers.json`。它不检查谁可以请求：命令在终端检查本人，而 studio 的路由在调用它之前检查调用方。

## 导出

- `setPatchRow`、`readPatchRow`、`updateRowConfig` 与 `setRowFields`：把一行合并进 profile 的补丁列表、读取某一行的配置，并以设置服务的形式保存一个 bundle 行。补丁行会替换 bundle 行的整个 `config`。文件中的注释在重写后不会保留。
- `promptRows`、`writePromptRows` 与 `readPromptsRows`：提示词答案（`safer`、`stock` 或 `dangerous`）的补丁行、它们的写入，以及补丁所持有的答案。`PROMPT_SWITCH_ROWS` 指名每个开关所在的行，`FULL_ACCESS_EVERYWHERE_KEY` 指名危险模式所设置的键。插件只在危险模式授权文件有效时才认可该键，而本包从不写入该授权。
- `DANGEROUS_WARNING_LINES` 与 `runsAsRoot`：本人在开启危险模式之前读到的警告，以及本进程是否以 root 运行（若是则拒绝）。
- `STUDIO_ROW_ID` 与 `studioRow`：持有 studio 端口的 web 服务器行。
- `readReachRowAt`、`writeReachRowAt`、`reachRowsOf`、`listenerPortFor`、`signInAddress`、`REACH_OFF` 与 `REACH_ROW_ID`：`delorun-reach` 行的 Tailscale 私有选项及其 serve 监听端口。`TRUST_STATEMENT` 是手机访问让一台设备能做什么、以及什么在保护 home，正如 `delorun reach on` 所打印的那样。
- `readPairingAt`、`writeMayAskAt` 与 `HOME_AUTH_ROW_ID`：`delorun-home-auth` 行的 `pairing` 选择。
- `readAnswersRecord`、`promptsOf`、`backgroundOf`、`updateAnswersRecord` 与 `ANSWERS_FILENAME`：读取 `setup-answers.json`、它所持有的提示词与后台答案（记录缺失或无法读取时用设置的默认值），并以模式 0600 原子地重写它。没有记录的 profile 会被拒绝重写，因为它从未运行过设置。
- `SetupApplyError`：对本包无法使用的文件的拒绝。它的消息是一个完整的句子。

两个叶子模块也各自导出，以便浏览器规范无需仅限 Node 的其余部分即可读取它们：`@delorun/setup-apply/warning`（危险模式警告）与 `@delorun/setup-apply/trust`。

## 限制

这里的任何函数都不加锁。调用方在一次读取与随后的写入期间持有 home 的写锁（`apps/cli/src/home-exclusion.ts`）。

## 开发

测试在 `tests/` 中；它们只写入临时目录。
