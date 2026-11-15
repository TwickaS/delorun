---
description: "Delorun 约定索引：每份约定页面、其类型包，以及消费它的代码。"
---

# Delorun 约定

[English](README.md) | 中文

## 摘要

约定是供工作包按原样使用的规格：代码所消费的类型、线上格式、限额、错误与安全要求，以及证明这些要求的拒绝测试。每份约定页面都有一个状态章节，说明哪些已构建且已接入、哪些已构建但无任何接入、哪些尚未构建；一个安全章节，陈述其要求及对应的拒绝测试；以及一个「本约定不能证明的内容」小节，用于页面的声明有局限之处。状态章节列为尚未构建的要求不保护任何人；[设计](../design/README.md)保存尚未构建的功能的规则。约定 C12（遥测）不属于 Delorun，因此没有页面涵盖它。

## 约定

| 编号 | 约定 | 类型包 | 已构建 | 消费方 |
| --- | --- | --- | --- | --- |
| C1 | [C1 Home 布局与运行时仓库](c01-home-layout.zh.md) | [`@delorun/contract-home-layout`](../../packages/contract-home-layout/README.zh.md) | 部分已构建 | `delorun` 命令、`delorun/packages/home`、npm 启动器、`delorun/packages/runtime-store`、`delorun/packages/home-process`、`delorun/packages/supervisor`、`delorun/packages/home-auth`；上游的沙箱方言 |
| C2 | [C2 发布 manifest 与签名](c02-release-manifest.zh.md) | [`@delorun/contract-release-manifest`](../../packages/contract-release-manifest/README.zh.md) | 部分已构建 | `delorun/apps/release`、`delorun/apps/install` 与 `delorun/apps/npm-launcher`、`delorun/packages/runtime-store`、`delorun verify`、Docker 监管器的镜像检查 |
| C3 | [C3 更新报告](c03-update-report.zh.md) | [`@delorun/contract-update-report`](../../packages/contract-update-report/README.zh.md) | 部分已构建 | `delorun/packages/update`、`delorun update` 与 `delorun recover`、上游的 profile 与插件管理器恢复、`delorun/packages/profile-safety` |
| C4 | [约定 C4：准入与监听器](c04-admission.zh.md) | [`@delorun/contract-admission`](../../packages/contract-admission/README.zh.md) | 部分已构建：仅回环 | 上游的客户端连接与 Web 服务器、Trusted Types 策略、`delorun/packages/home-auth` |
| C5 | [约定 C5：设备批准](c05-device-approval.zh.md) | [`@delorun/contract-device-approval`](../../packages/contract-device-approval/README.zh.md) | 否 | `delorun/packages/home-auth` |
| C6 | [约定 C6：中继协议](c06-relay-protocol.zh.md) | [`@delorun/contract-relay-protocol`](../../packages/contract-relay-protocol/README.zh.md) | 仅中继服务器 | `delorun/apps/relay` |
| C7 | [约定 C7：远程访问提供方](c07-reach-providers.zh.md) | [`@delorun/contract-reach-providers`](../../packages/contract-reach-providers/README.zh.md) | 否 | 无 |
| C8 | [约定 C8：归档格式 v1 与回收站](c08-archive-and-trash.zh.md) | [`@delorun/contract-archive-and-trash`](../../packages/contract-archive-and-trash/README.zh.md) | 部分已构建 | `delorun/packages/archive`、`delorun/packages/trash`、`delorun/packages/plugin-trash`、`delorun export`、`delorun import` 与 `delorun trash` |
| C9 | [C9 运行时与监管器接口](c09-runtime-supervisor.zh.md) | [`@delorun/contract-runtime-supervisor`](../../packages/contract-runtime-supervisor/README.zh.md) | 无任何接入 | `delorun/packages/supervisor`、`delorun/apps/release`；上游的沙箱与 PTC 包 |
| C10 | [约定 C10：host 限定键](c10-host-qualified-keys.zh.md) | [`@delorun/contract-host-qualified-keys`](../../packages/contract-host-qualified-keys/README.zh.md) | 部分已构建 | 上游的客户端 store 与 UI 包、`delorun/packages/trash` |
| C11 | [约定 C11：setup 回答](c11-setup-answers.zh.md) | [`@delorun/contract-setup-answers`](../../packages/contract-setup-answers/README.zh.md) | 部分已构建 | `delorun/apps/cli` 的 setup、`delorun/packages/bundle-local`、`delorun/packages/plugin-onboarding` |
| C13 | [C13 插件索引与撤销列表](c13-catalogue-revocation.zh.md) | [`@delorun/contract-catalogue-revocation`](../../packages/contract-catalogue-revocation/README.zh.md) | 否 | `delorun update` 的报告，它把撤销列表记录为未检查 |
| C14 | [约定 C14：OpenID Connect 与通行密钥](c14-oidc-passkeys.zh.md) | [`@delorun/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.zh.md) | 否 | 无 |
| C15 | [约定 C15：验证检查与报告](c15-verification-checks.zh.md) | [`@delorun/contract-verification-checks`](../../packages/contract-verification-checks/README.zh.md) | 部分已构建：两项检查 | `delorun verify` |
| C16 | [约定 C16：对等组合](c16-parity-composition.zh.md) | [`@delorun/contract-parity-composition`](../../packages/contract-parity-composition/README.zh.md) | 部分已构建 | `delorun/apps/tools`（回放通道、静态扫描、开关扫描）、注册开关的各包、`packages/boot/doctor`（由 `apps/cli` 启动）、上游的快照配置 |
| C17 | [C17 插件版本要求](c17-plugin-versions.zh.md) | [`@delorun/contract-plugin-versions`](../../packages/contract-plugin-versions/README.zh.md) | 部分已构建 | 上游的 app-boot 插件兼容性、`delorun/apps/cli` 的版本输出、更新报告 |
| C18 | [C18 发布日志与见证者](c18-release-log.zh.md) | [`@delorun/contract-release-log`](../../packages/contract-release-log/README.zh.md) | 部分已构建 | `delorun/apps/release`、`delorun/apps/install` 与 `delorun/apps/npm-launcher`、`delorun/packages/release-verify`、`delorun verify` |
| C19 | [C19 Home 进程与更新握手](c19-home-process.zh.md) | [`@delorun/contract-home-process`](../../packages/contract-home-process/README.zh.md) | 部分已构建 | `delorun/packages/home-process`、`delorun/apps/cli`、`delorun/packages/runtime-store`、`delorun/packages/logs` |
| C20 | [C20 运行日志](c20-operational-logs.zh.md) | [`@delorun/contract-operational-logs`](../../packages/contract-operational-logs/README.zh.md) | 部分已构建 | `delorun/packages/logs`、`delorun/apps/cli`（`delorun logs` 与清除）、`delorun/packages/home-process`、`delorun/apps/relay` |
| C21 | [C21 变更](c21-changes.zh.md) | [`@delorun/changes`](../../packages/changes/README.md) | 部分已构建 | `delorun/apps/cli`（`delorun start`、`headless`、`changes`、`verify`、`doctor`）、`delorun/packages/home-process`、`delorun/packages/plugin-changes`、`delorun/packages/plugin-instruction-consent` |
| C22 | [C22 Delorun 版本对插件的承诺](c22-delorun-plugin-interface.zh.md) | [`@delorun/contract-plugin-versions`](../../packages/contract-plugin-versions/README.zh.md) | 部分已构建 | `delorun/apps/release`（补丁规则）、`delorun/apps/cli`（`delorun plugin check`）、插件作者 |

## 约定的变更

约定与消费它的代码在同一次变更中修改，其类型包也在同一个拉取请求中变更。每页的兼容性小节陈述变更可能造成的影响：若某次变更移动、重命名或改变外部接口的含义，则它属于破坏性变更，需要在 `delorun/docs/upgrade-guide/` 下提供升级指南。
