---
description: "你的第一个 Delorun 插件，从零到在 studio 中看到它：需要安装什么、制作一个小的工具插件、加载它、在 studio 的 Plugins 页面找到它、在它运行时修改它，以及再把它移除。"
---

# 你的第一个插件

[English](first-plugin.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页带你从一个空文件夹走到一个能在 studio 中看到的插件，然后再把它移除。这个插件是一个按名字问候某人的小工具。你需要一个已完成 setup 的 Delorun、Node.js 24.9 或更新版本，以及 pnpm；第一节说明如何检查它们。这里的任何步骤都不需要模型密钥。读完之后，你会制作一个插件、在 Delorun 运行时修改它，并把它卸载。[为 Delorun 编写插件](plugins.zh.md)是完整的参考，[什么该在哪里定制](../customising/customise.zh.md)帮你判断插件是否适合你的更改。

## 目录

- [你需要什么](#what-you-need)
- [制作插件](#make-the-plugin)
- [加载它](#load-it)
- [在 studio 中查看](#see-it-in-the-studio)
- [在它运行时修改它](#change-it-while-it-runs)
- [移除它](#remove-it)
- [深入了解](#go-further)

<a id="what-you-need"></a>

## 你需要什么

- 一个已完成 setup 的 Delorun：`delorun setup` 已经结束（[安装与首次运行](../get-started/install.zh.md)）。
- [Node.js](https://nodejs.org) 24.9 或更新版本。用 `node --version` 检查。
- pnpm，由你自己安装。Delorun 自带的 pnpm 只供 `delorun plugin` 内部使用，不在你的命令路径上。用 `npm install -g pnpm` 安装 pnpm，或按 [pnpm.io](https://pnpm.io/installation) 的说明安装，并用 `pnpm --version` 检查。

插件以你的权限在 Delorun 内部运行，在限制 agent 命令的沙箱之外，所以只安装你信任其代码的插件。这个插件是你自己的，你可以读完它的全部代码。

<a id="make-the-plugin"></a>

## 制作插件

在你存放项目的文件夹中运行：

```text
delorun plugin new hello-plugin
cd hello-plugin
pnpm install
pnpm run build
```

`delorun plugin new` 写出一个名为 `hello-plugin` 的文件夹，并打印它生成的文件：`package.json`、`cordis.patch.yml`、`locale/en.json`、`src/index.ts`、`tsdown.config.ts`、`tsconfig.json`、`.gitignore` 和 `README.md`。`src/index.ts` 就是整个插件：它注册一个工具 `hello_plugin`，返回 `Hello, <name>!`。`pnpm install` 获取构建工具，`pnpm run build` 写出 `lib/index.js`，也就是 Delorun 加载的文件。

检查你的 Delorun 是否接受这个插件：

```text
delorun plugin check .
```

它会打印插件的 `package.json` 所允许的 Delorun 和 DeepSeek Harness 版本，并以 `The installer admits it on this release.` 结尾。

<a id="load-it"></a>

## 加载它

```text
delorun start
delorun plugin dev .
```

`delorun start` 在后台启动 Delorun。`delorun plugin dev .` 把该文件夹链接进你的 profile 并持续运行，所以请让那个终端保持打开，并用另一个终端执行后面的步骤。每次你保存文件，它都会重新构建并重新加载插件。

在第二个终端中，询问 Delorun 做了什么：

```text
delorun changes list
```

在 `Recent changes` 下，它列出 `Loaded without review: hello-plugin from` 和该文件夹。Delorun 会记录对它所运行内容的每一次更改。变更保护默认关闭，所以你链接的插件不会等你就加载；[修改你的 harness](../customising/changing-your-harness.zh.md)说明了保护开启时会怎样。

<a id="see-it-in-the-studio"></a>

## 在 studio 中查看

用 `delorun open` 打开 studio。如果它已经打开，请刷新页面。在侧边栏中选择 Plugins。在 Installed plugins 下，你现在会看到 Hello plugin，以及这一行：`Gives the agent the hello_plugin tool, which greets someone by name.` 选择它即可看到它的页面：它的版本 `v0.1.0`、它的 README 和一个 Uninstall 按钮。

标题和这一行来自你文件夹中的 `locale/en.json`。这个插件为 agent 提供 `hello_plugin` 工具；要在 chat 中使用它，你需要一个模型密钥（[模型提供方](../get-started/providers.zh.md)）。

<a id="change-it-while-it-runs"></a>

## 在它运行时修改它

在 `delorun plugin dev .` 仍在运行时，打开 `src/index.ts`，把工具的描述从 `Greet someone by name.` 改为 `Greet someone warmly by name.` 保存文件。Delorun 会构建插件并加载新代码，无需重启，`delorun changes list` 会显示第二行，`Loaded without review: hello-plugin: changes in` 和该文件夹。

如果你开启了变更保护，编辑会转而等待你的审阅，只有在你应用之后才会加载。要在保护开启时实时加载你自己的编辑，请先运行 `delorun changes work hello-plugin`，完成后运行 `delorun changes done hello-plugin`（[修改你的 harness](../customising/changing-your-harness.zh.md#working-on-a-plugin)）。

<a id="remove-it"></a>

## 移除它

1. 在运行 `delorun plugin dev .` 的终端中按 Ctrl+C。插件仍保持已安装。
2. 在 studio 中，选择侧边栏的 Plugins，然后选择 Hello plugin，再选择 Uninstall。studio 会提示 `What it provides goes away once it is uninstalled.` 再次选择 Uninstall 确认。Hello plugin 不再出现在 Installed plugins 中，`delorun doctor` 也不再列出它。

`delorun changes undo <id>` 会撤销一项已记录的更改，但它只是停止该更改所加载的内容，并不卸载插件：在你卸载之前，Hello plugin 会在 Plugins 页面中显示为未运行，撤销时会打印卸载它的命令：`delorun plugin remove hello-plugin`。你的 `hello-plugin` 文件夹不会被删除；不再需要时请自行删除。

<a id="go-further"></a>

## 深入了解

- [为 Delorun 编写插件](plugins.zh.md)：其他种类的插件（agent 预设、studio 中的页面、一组设置的 bundle）、从文件夹、git 或 npm 安装、版本范围、日志、调试器和安全模式。
- [修改你的 harness](../customising/changing-your-harness.zh.md)：审阅、应用、丢弃和撤销你的插件和 agent 所做的更改。
- DeepSeek Harness 的[编写工具](../../../../docs/user/develop/basic/tool.zh.md)教程。
