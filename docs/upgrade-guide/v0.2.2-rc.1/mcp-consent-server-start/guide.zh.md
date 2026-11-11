---
kind: upgrade-guide
description: "MCP 添加时同意改为审查解析后的整个服务器启动项，因此 McpServerCommand 新增字段，McpConsentRefusedError 与同意存储的 accept 接收启动项，版本 1 至 3 的接受存储不再生效。"
---

# MCP 添加时同意审查整个服务器启动项

[English](guide.md) | 中文

## 变更

stdio MCP 服务器的添加时同意现在覆盖命令、其参数、其工作目录以及其配置的环境变量，以及它们解析得到的内容。`@deepseek-ai/dsh-mcp-client` 中的 `McpServerCommand` 新增必填字段 `env`、`cwd`、`resolvedCommand`（`PATH` 查找得到的绝对文件，在 Windows 上还会用到 `PATHEXT`，例如 `C:\Program Files\nodejs\npx.cmd`）、`resolvedCwd`（规范工作目录，`cwd` 为空时为 Host 的工作目录），以及可选字段 `resolvedShell`（运行 Windows `.cmd` 或 `.bat` 文件的 `COMSPEC` 的规范路径）。挂载了同意时，mcp-client 用新的 `resolveServerStart` 解析启动项、审查它，并以完全相同的解析路径启动；无法解析的启动项以 `McpServerStartUnresolvedError` 停止。在 Windows 上，这包括 `.exe`、`.com`、`.bat` 或 `.cmd` 以外的文件、带 `#!` 行的文件，以及没有指向文件的绝对 `COMSPEC` 的包装脚本；查找跳过工作目录。

- `new McpConsentRefusedError(serverName, command, args, reason)` 改为 `new McpConsentRefusedError(start, reason)`，其中 `start` 是被拒绝的 `McpServerCommand`。该错误新增 `cwd`、`envNames`、`resolvedCommand`、`resolvedCwd` 与 `resolvedShell`；其消息写明这些内容，不含环境变量的值。
- `@delo/plugin-mcp-consent` 中的 `DeloMcpConsent.accept(command, args)` 改为 `accept(start)`，其中 `start` 带有 `command`、`args`、`cwd`、`env`、绝对路径 `resolvedCommand` 与 `resolvedCwd`，以及可能存在的 `resolvedShell`。
- 接受存储，即 Delo home 下的 `secrets/mcp-add-consent/acceptances.json`，升级到版本 4：每条接受以上述各项为键，并保存环境的摘要而非其值。版本 1、2 与 3 的存储被视为已被取代：其中的接受都不生效，因此它们接受过的每个 stdio 服务器都会被再次询问。向其中接受会写出只含这条新接受的版本 4 存储。
- 提供 `mcpAddConsent` 服务的插件以模块导出 `providesMcpAddConsent = true` 声明这一点。mcp-client 行会等待每个作此声明的 Loader 行；该行未能启动时，以 `McpConsentUnavailableError` 让服务器保持停止。

受影响的是构造 `McpConsentRefusedError`、调用 `accept`、提供自己的 `McpAddConsent` 或读取存储文件的插件，以及存储中仍有更早接受记录的每个人。

## 迁移

1. 用 `@deepseek-ai/dsh-mcp-client` 的 `resolveServerStart(config)` 构造启动项，或在桩与测试中自行提供 `resolvedCommand` 与 `resolvedCwd`。
2. 把 `new McpConsentRefusedError(name, command, args, reason)` 改为 `new McpConsentRefusedError(start, reason)`，把 `consent.accept(command, args)` 改为 `consent.accept(start)`；启动项带有服务器行的 `env`（没有时为空对象）与 `cwd`（Host 工作目录时为空字符串）。
3. 在提供 `McpAddConsent` 服务的模块中加入 `export const providesMcpAddConsent = true`。
4. 同意再次询问时重新接受每个 stdio 服务器；不要从更早的存储复制条目。
5. 启动该 profile 以确认：已接受的服务器能够连接，存储文件的 `v` 字段为 `4`。
