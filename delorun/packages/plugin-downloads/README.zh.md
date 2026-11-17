---
description: "studio 的下载面板：列出安装队列正在处理的每个插件，显示进度和排队位置，并提供取消、重试或移除按钮。"
---

# @delorun/plugin-downloads

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

studio 的下载面板。它列出安装队列正在处理的每个插件，显示图标、名称、进度和在队列中的位置，并允许用户取消排队中或正在进行的安装，或者重试或移除失败的安装。

<a id="what-it-shows"></a>

## 显示什么

| 位置 | 内容 |
| --- | --- |
| 电脑 | 右下角的一张浮动卡片，位于页面和设置引导窗口之上。标题显示“正在安装，第 2 个，共 5 个”，并可把卡片收起为一行。只有正在运行的进度条使用强调色。最后一个安装完成时，会显示几秒“已添加 5 个插件”，然后卡片隐藏。失败时卡片保持打开，直到被关闭。 |
| 手机，在设置引导中 | `OnboardingDownloadsRow`：在“返回”和“继续”之上的一行淡色文字，带一条细细的灰色进度线。没有强调色，除进度外没有任何动效。失败时显示为一个小小的中性标记。点按该行会就地列出这些插件。 |
| 手机，其他位置 | 页眉里一个带数量角标的下载图标。它会打开一个底部面板，显示同样的列表。 |

卡片只在有项排队或刚刚完成时出现。开启减弱动态效果时，淡入淡出和收起动画会关闭。一个礼貌型的实时区域会对完成或新出现的失败只朗读一次；它从不朗读百分比。

<a id="the-data-seat"></a>

## 数据来源

面板读取一个 `DownloadsSource`，并不了解安装队列的远程接口：

```ts
interface DownloadsSource {
  snapshot(): readonly DownloadItem[]   // stable until an item changes
  subscribe(listener: () => void): () => void
  cancel(key: string): void
  retry(key: string): void
  remove(key: string): void
}
```

`DownloadItem` 有 `key`（包名）、`title`、`iconUrl`、`state`、`receivedBytes`、`totalBytes`、`position` 和 `failure`。状态有 `queued`、`waiting-for-unlock`、`downloading`、`verifying`、`installing`、`ready`、`needs-reload`、`failed` 和 `cancelled`。

`createFakeDownloadsSource(items)` 把各项保存在内存中；它的 `set` 和 `update` 用于驱动测试和试验页面。`createRemoteDownloadsSource(ctx)` 是 `@delorun/plugin-packs` 的 `packs` 远程接口的适配器：当有界面订阅时它读取安装列表（在 Host 发出安装通知时、连接重置之后，以及有项排队或进行中时每 1.5 秒一次），并发送取消、重试、移除和关闭请求。要求解锁的拒绝会让该行保持在“等待解锁”。没有插件包的 Host 显示为空列表。

<a id="in-the-setup-guide"></a>

## 在设置引导中

`plugin-onboarding` 在手机宽度下，把 `<OnboardingDownloadsRow />` 渲染在“返回”和“继续”之上。该行读取此插件提供的来源；它显示时，页眉图标会让开。

<a id="look"></a>

## 外观

界面只使用 studio 的设计令牌。文案在 `src/client/locales.ts` 中（英文和中文，英文为句首大写）。

<a id="tests"></a>

## 测试

`pnpm exec vitest run --config delorun/vitest.config.ts delorun/packages/plugin-downloads` 运行组件测试：每种状态、摘要及其隐藏、保持显示的失败、收起和展开、安静的行、角标以及键盘操作。

<a id="harness-page"></a>

## 试验页面

`harness/` 是一个基于模拟来源的静态页面：`pnpm exec vite --config delorun/packages/plugin-downloads/harness/vite.config.ts` 在端口 18571 上提供它。`?scene=mixed|done|failure|unlock` 选择各项，`?mode=card|row|sheet` 选择呈现方式，`?dark=1` 选择深色方案。
