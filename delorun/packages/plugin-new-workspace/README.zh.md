---
description: "Delorun 的新建工作区流程：添加文件夹、新建文件夹并可选初始化 Git，或从 Git 克隆；超出配置的根目录、或属于 Delorun 从不添加的文件夹时一律拒绝；每个工作区有自己的起始模型。"
---

# @delorun/plugin-new-workspace

[English](README.md) | 中文

Delorun 的新建工作区流程。Host 端提供流程各屏调用的路由：从哪里开始查找、有界的文件夹搜索、单个文件夹的预览、添加已有文件夹、新建文件夹（可选创建 Git 仓库）、从 Git 克隆（可选分支），以及每个工作区的默认设置。它还让工作区里每个新对话以该工作区的模型开始。

## 路由

每条路由都是 `/api/delorunNewWorkspace` 下的精确 `POST`，仅在上游的工作区注册表存在时提供。每条路由都应答本机电脑；已配对的设备只有在持有解锁时才能访问（否则返回 `ELEVATION_REQUIRED`）；其他任何来源在读取请求体之前就被拒绝，返回 `LOOPBACK_REQUIRED`。四条会改变状态的路由（`add`、`create`、`clone`、`setDefaults`）会续期设备的解锁。

| 路由 | 请求体 | 应答 |
| --- | --- | --- |
| `.places` | 无 | 文件夹仍存在的最近工作区、存在于某个根目录内的建议文件夹、主文件夹，以及新文件夹的默认位置。 |
| `.search` | `{ query }`，1 到 100 个字符 | 名称包含查询内容（不区分大小写）的文件夹，最多 50 个，由近及远；以及搜索停止的原因：`complete`、`limit` 或 `time`。 |
| `.preview` | `{ path }` | 文件夹是空的、代码还是普通文件；是否为 Git 仓库及所在分支；是否有 `AGENTS.md`；以及前 24 个可见名称（文件夹在前）。 |
| `.add` | `{ path }` | `added`，带工作区 id、规范路径和类型；或 `refused`，带原因。 |
| `.create` | `{ parent, name, git }` | 创建 `parent/name` 并注册；带 `git` 时运行 `git init` 并写入初始 `.gitignore`。 |
| `.clone`、`.cloneStatus` | `{ url, parent, name, branch? }`，然后 `{ job }` | 开始克隆到 `parent/name` 并报告进度，然后注册该文件夹。 |
| `.defaults`、`.setDefaults` | `{ path }`，然后 `{ path, defaults }` | 单个工作区的模型、思考强度和浏览器选择。 |

## 工作区可以放在哪里

每个路径都检查两次：一次对照 Delorun 从不添加的文件夹（主文件夹本身、Delorun 主目录、原版主目录，以及 `@delorun/home` 的 `workspaceLocationProblem` 列出的系统文件夹）；对搜索、预览、新文件夹和克隆，再对照配置的 `roots`，并解析符号链接。新文件夹或克隆的父文件夹缺失时会被创建，创建后再检查一次，因此期间被植入的链接会被拒绝。拒绝时会说明原因，且不创建任何东西。

预览只读取文件夹的顶层名称和 `.git/HEAD`，在 `searchTimeMs` 内最多读取 2000 个条目；不打开其他文件，不跟随链接。搜索从每个根目录广度优先遍历，最深 `searchDepth` 层、最多 `searchFolders` 个文件夹、最长 `searchTimeMs`。它从不跟随链接，并跳过隐藏文件夹、依赖和构建文件夹（`node_modules`、`vendor`、`dist`、`target`、`venv` 等）、Delorun 主目录和原版主目录。

## Git

`create` 和 `clone` 运行 Git 时关闭钩子、LFS 过滤器和个人模板，不读取系统或全局配置，没有 askpass 程序，也不在终端提示。克隆接受不含用户名或密码的 `https` 地址，以及 `ssh` 和 scp 风格的地址；它跳过子模块，检出时取消所有 `filter` 属性，完成后删除 `.git/info/attributes`。分支名在 Git 运行前按 Git 的规则检查。`@delorun/plugin-workspaces` 的导入克隆使用同一套 `cloneArguments` 和 `createCloneTemplate` 构建参数。

## 每个工作区的模型

`.setDefaults` 把单个工作区的模型（`provider`、`model`，可选 `reasoningEffort`）和浏览器选择保存在 `<Delorun 主目录>/secrets/new-workspace/defaults.json`，权限 0600，以文件夹的真实路径为键，并使用锁文件。同一文件还记录上一次新文件夹或克隆所在的文件夹，`.places` 会把它作为下一次的位置。

当顶层对话在默认设置含有模型的工作区里开始时，插件会在第一个请求之前追加上游的 `model/selection` 事件，因此对话日志会记录它起始使用的模型。恢复、分叉或委派的对话、已经记录了模型的对话，以及模型提供方未连接的工作区都不受影响；最后一种情况会写入日志。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `roots` | `['~']` | 新文件夹和克隆可以放置的位置，以及搜索的范围。 |
| `suggested` | `~/Projects`、`~/src`、`~/code`、`~/Documents`、`~/Desktop` | 作为起点提供的文件夹（存在于某个根目录内时）。 |
| `firstParent` | `~/Projects` | 用户还没有新建过文件夹时，新文件夹或克隆的位置；首次使用时创建。 |
| `searchDepth` | 4 | 搜索在每个根目录下查找的层数。 |
| `searchFolders` | 20000 | 一次搜索最多读取的文件夹数。 |
| `searchTimeMs` | 2000 | 一次搜索或一次预览读取的最长时间。 |
| `cloneTimeoutMs` | 600000 | 一次克隆的最长时间。 |

## 测试

`tests/routes.spec.ts` 挂载插件，并对每条路由检查被拒绝的来源、已锁定的设备和本机电脑。`create.spec.ts`、`clone.spec.ts`、`places.spec.ts` 和 `search.spec.ts` 覆盖主文件夹、Delorun 主目录、根目录之外的文件夹以及离开根目录的链接；`defaults.spec.ts` 覆盖存储文件的权限和格式，以及种子写入的条件。
