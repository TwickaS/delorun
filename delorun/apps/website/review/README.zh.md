# 评审轮次

[English](README.md) | 中文

这些脚本为主页的每一轮评审生成证据：用生产构建得到同样的图片和一份审计。它们只做测量和报告，从不改动页面。

## 运行一轮

```sh
cd delorun/apps/website
node review/run-pass.ts --pass 1 --build
```

`--build` 会先在 `nice -n 19` 下运行 `vite build`（部署用的构建切勿设置它）；不带它时，直接提供现有的 `out/`。该命令会等到有 4 GB 内存和 5 GB 磁盘空闲，在 18680 端口提供 `out/`（`--port` 可更改），并写入 `~/delorun-rc-release/site-pass-<n>/`（`--release-dir` 更改其父目录）。它会输出汇总计数。`--audit-only` 只写入 `audit.md` 和 `report.json`，不生成图片，`--suffix b` 把文件夹命名为 `site-pass-<n>b`。对同一个构建再运行一次会写出相同的文件名；该文件夹中先前的图片和报告会先被删除。

## 文件夹里有什么

- 图片，命名为 `page__section__w<width>__<look>-<scheme>__<state>.png`（见 `naming.ts`），列在 `index.md` 中。
  - 每个小节和整个页面，在 390、768、1440 和 1920 px 宽度下，使用 Soft 浅色和深色。
  - 在 390 和 1440 px 下：主视觉区和设置条带在其他六种外观下的浅色和深色；减少动态效果；关闭脚本；每个键盘焦点停靠点一张图片（`k-NN`）；每个回放最多三个章节（`chapter-NN`）。
  - 404、隐私和通知页面，在 390 和 1440 px 下。
  - 最坏情况（页面 `worst`）：最长的插件名称和句子、没有头条、复制失败、订阅被拒绝、链接中的未知外观、320 和 1920 px。
- `audit.md` 和 `report.json`：主页、隐私、通知、博客和 404 页面的头部标签（404 页面为 noindex，因此不需要 canonical 或 og:url；结构化数据只要求出现在主页上）（标题、描述、规范地址、链接预览标签、结构化数据，存在或缺失）；构建没有头条时，“最新动态”记为缺失；控制台错误和失败的请求，在 320、390、768、1440 和 1920 px 下的横向溢出，小于 24 px 的点按目标，减少动态效果时被隐藏的文本，带有实测对比度的无障碍违规，Tab 顺序，跳转链接，没有可见样式的焦点停靠点，落在不可见元素上的焦点，手机配置下的最大内容绘制和布局偏移，体积表，以及在 1440 px 和手机配置下的滚动流畅度。手机配置下的绘制和滚动各测量三次并取中位数判断，同时记下空闲内存（`review/phone-repeat.ts` 只重复这两项）。

小节通过地标（id、标签或第一个标题）查找，而不是固定的选择器。页面缺少的小节列在“Missing sections”下并被跳过。回放章节是回放小节内页面的 `[data-chapter]` 或 `[role="tab"]` 控件。

## 文件

- `run-pass.ts`：该命令。
- `capture.ts`、`worst.ts`：生成图片。`audit.ts`：测量。`page-tools.ts`：打开页面和查找小节。
- `naming.ts`、`report.ts`：图片名称和报告格式，其规格在 `tests/review-format.spec.ts` 中。
- `serve.ts`、`browser.ts`、`resources.ts`：静态服务器（文本类型使用 brotli 或 gzip，并带 `Content-Encoding` 和 `Vary`，与 Cloudflare 的发送方式一致；`report.json` 在 `serverEncoding` 下记录这些编码）、浏览器（来自 `apps/tools` 的 Playwright）以及对空闲内存和磁盘的等待。
- `scroll-trace.ts`、`trace-summary.ts`：`node review/scroll-trace.ts` 提供一个已构建的 `out/`，并在无头 Chromium 中追踪两次滚动，即首屏的缩放和展示每张图片的墙，每次运行打印帧间隔、丢帧、长任务、样式、布局、绘制、光栅与解码时间以及图层数。选项：`--out`、`--port`（默认 18681）、`--runs`、`--scenario hero|wall|all`、`--width`、`--scheme`、`--cpu`（CPU 降速）与 `--trace-dir`（保留每次追踪）。它在一台机器上比较两次构建；在软件渲染器上，光栅与解码比在真实显卡上更贵。摘要的规范是 `tests/trace-summary.spec.ts`。

每个浏览器上下文都会拒绝任何不是发往本地服务器的请求，并将其记录为“blocked, would have left the machine”（否则订阅字段会从 Cloudflare 加载 Turnstile）。订阅被拒绝的情形在没有 Turnstile 的条件下运行。

无障碍检查需要网站的开发依赖中有 `axe-core`；没有它时，审计会记录一条警告并跳过该检查。无头 Chromium 没有真正的 GPU，因此帧率只是下限。
