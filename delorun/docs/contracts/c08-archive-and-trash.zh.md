---
description: "约定 C8：归档格式 v1 及其 manifest（元数据清单）、封闭的定制 schema 及其被拒绝的行、签名校验、上限、暂存与发布、错误分类、未受信任的导入 chat，以及回收站与清除。"
---

# 约定 C8：归档格式 v1 与回收站

[English](c08-archive-and-trash.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>
## 摘要

归档是一个或多个工作区及其 chat、附件与定制内容的导出文件。其格式带有版本。导入先在暂存目录中校验整个归档，然后才写入任何内容，并以原子方式发布每个新工作区，且从不覆盖已有的工作区。定制内容是封闭 schema 下的数据，不能包含代码，也不能设置沙箱模式、凭据引用、远程访问选项或出口限制。回收站将被删除的 chat 或工作区保留 30 天，清除则会把其内容从所有保存它的存储中移除。

<a id="status"></a>
## 状态

导出、导入、回收站、清除，以及 stock DeepSeek Harness home 的导入均已构建；使用归档导入所存储的内容尚未构建。

- **已构建并已使用：** `delorun export`、`delorun import`、`delorun setup export` 与 `delorun setup import`（[setup 归档](#the-setup-archive)）、`delorun trash`，CLI profile 中经 `@delorun/plugin-trash` 提供的 studio 回收站与清除，以及 `delorun import-home` 与 setup 的 `import` 一节（[stock home 导入](#the-stock-home-import)）。
- **已构建，但无人使用：** 在 profile 启动之前撤回被中断的 stock home 导入（`recoverInterruptedImport`），启动路径不调用它；下一次 `delorun import-home` 会撤回被中断的导入。
- **尚未构建：** 打开已导入的 chat，CLI profile 的任何行都不读取它们；它们的未受信任状态、横幅，以及把某个 chat 标记为受信任的操作；应用定制行（导入只列出而从不写入），及其差异界面和针对已导入技能、预设与插件声明的规则；以及 stock home 导入所复制 chat 的未受信任状态，studio 目前把它们当作本人自己的 chat 打开。这些规则见[导入 chat 设计](../design/imported-chats.zh.md)。

下文中，本列表称为尚未构建的要求与拒绝测试，在某次改动构建它们之前，不保护任何人。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [归档文件](#archive-file)
  - [manifest（元数据清单）](#manifest)
  - [定制 schema](#customisation-schema)
  - [签名](#signature)
  - [上限](#limits)
  - [导入与导出](#import-and-export)
  - [setup 归档](#the-setup-archive)
  - [stock home 导入](#the-stock-home-import)
  - [错误](#errors)
  - [已导入的 chat](#untrusted-imported-chats)
  - [回收站与清除](#trash-and-purge)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="archive-file"></a>
### 归档文件

归档是一个 ZIP 文件。其根目录包含以下条目。

- `manifest.json`：下文所述的 manifest。
- `customisation.json`：定制文档，始终存在，即使它不列出任何行。
- `signature.json`：对 `manifest.json` 的签名。仅当导出 home 对归档签了名时才存在。
- `objects/<sha256>`：每个不同内容对应一个条目，以其字节的 SHA-256 命名。附件、chat 代次与工作区实体记录都通过摘要引用对象。

除此之外不得有其他顶层条目。归档不包含工作区的项目文件，因为工作区的代码位于本人自己的仓库中。它包含工作区实体、其 chat、其附件与其定制内容。

<a id="manifest"></a>
### manifest（元数据清单）

`manifest.json` 是一个 JSON 对象，包含下列字段。

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `formatVersion` | 整数 `1`。 | 读取者以 `ARCHIVE_UNSUPPORTED_VERSION` 拒绝任何其他值。 |
| `createdBy` | 字符串。 | 写入归档的 Delorun 版本。它仅供参考，不改变归档的读取方式。 |
| `exportedAt` | UTC 的 RFC 3339 时间。 | 导出完成的时间。 |
| `origin` | 含 `homeKeyId` 与 `publicKey` 的对象，二者均为 base64url。 | 导出 home 的密钥。无论归档是否签名都存在。`homeKeyId` 是该密钥的指纹；任何其他值都以 `ARCHIVE_SCHEMA_INVALID` 拒绝。 |
| `content` | `chats` 或 `setup`；可选。 | 归档所含内容。没有该字段的 manifest 是 `chats` 归档。`setup` 归档不列出工作区，也不列出 `chat-generation`、`attachment`、`workspace-entity` 类型的条目；`chats` 归档不列出 `setup-document` 或 `plugin-file` 类型的条目；违反者以 `ARCHIVE_SCHEMA_INVALID` 被拒绝。 |
| `workspaces` | 数组。 | 每个工作区一个对象：归档所用的 `id`、名称，以及其 chat、附件与对象。 |
| `entries` | 数组。 | 每个对象与文档一个对象：`path`、`sha256`、以字节计的 `size`，以及 `kind`。`kind` 为 `chat-generation`、`attachment`、`workspace-entity`、`customisation`、`setup-document` 与 `plugin-file` 之一。 |

每个 `path` 都经过规范化、为相对路径，且不含 `..` 段，并指向归档中的一个条目。manifest 中每个条目只列出一次。manifest 或定制文档的任何文本字段都不得含有 C0 或 C1 控制字符、DEL 或双向控制字符，因为导入会打印这些字段；含有它们的归档以 `ARCHIVE_SCHEMA_INVALID` 拒绝。

<a id="customisation-schema"></a>
### 定制 schema

`customisation.json` 是一个 JSON 对象，其 `schemaVersion` 为 `1`，并带有数组 `rows`。每一行都有一个取自下表的 `kind`。任何其他 kind，以及该 kind 的 schema 未定义的字段，都会被拒绝。

| 行 kind | 保存的内容 | 规则 |
| --- | --- | --- |
| `bundle` | bundle 包名。 | 由导入列出。从不安装。 |
| `profile-row` | 行 id 与该行的普通配置值。 | 取值是数据。表达式与 `insert` 行被拒绝。 |
| `preset` | 预设定义。 | 由导入列出。 |
| `skill` | skill 的文件。 | 由导入列出。 |
| `theme` | 主题取值。 | 仅为数据。 |
| `plugin-declaration` | 插件名称及其固定版本。 | 由导入列出。从不安装。 |

被拒绝的行 kind 为 `sandbox-mode`、`credential-reference`、`reach-row` 与 `egress`。设置沙箱模式、凭据引用、远程访问选项或出口限制的行会被拒绝。任何 `!!js` 表达式与任何 `insert` 行都会在求值之前被拒绝，因此归档不会引起任何求值。

导入列出每一行的 kind 与目标，并且不应用任何行：不安装任何 bundle 或插件，也不写入任何预设、skill、主题或 profile 行。`delorun export` 不写出任何行。在差异屏幕之后应用这些行，其中导入的 skill 以禁用状态开始，导入的预设无法提升权限，这在[导入 chat 设计](../design/imported-chats.zh.md)中，尚未构建。

<a id="signature"></a>
### 签名

`signature.json` 是一个 JSON 对象，其 `algorithm` 为 `ed25519`，包含签名密钥的 `homeKeyId`，以及 base64url 编码的 `signature`。签名覆盖 `manifest.json` 的精确字节。签名密钥是导出 home 的密钥，即 [C5](c05-device-approval.zh.md) 的 home 密钥，位于 `secrets/home-auth/home-key.pem`，在此前没有其他组件创建它时，由该 home 的第一次导出创建。密钥的指纹是其原始 32 字节公钥的 SHA-256（base64url），即 C5 的 home 密钥 id；本人需要比对并确认该指纹，因为归档会自己选择其声明的 `homeKeyId`。

导入只在签名者已被本人接受时才继续：

- 无法校验通过的签名，或指向 manifest 的 origin 之外的另一个密钥的签名，以 `ARCHIVE_SIGNATURE_INVALID` 拒绝。
- 由导入 home 所担保的密钥给出的签名是已校验状态。home 担保它自己的 home 密钥，以及本人在导入时通过键入其指纹而确认的密钥。
- 由任何其他密钥给出的签名，在本人确认该密钥之前，以 `ARCHIVE_SIGNER_UNTRUSTED` 拒绝。
- 没有 `signature.json` 的归档，在本人接受其未校验状态之前，以 `ARCHIVE_SIGNER_UNTRUSTED` 拒绝。

校验在写入任何内容之前完成。`delorun import` 在提问之前，先打印 Delorun 所检查的内容，即签名者的指纹以及 home 是否信任它，然后打印归档对自身的陈述，其中每个由归档控制的字符串都加引号并转义所有控制字符。本人通过键入指纹来确认未知密钥，通过键入 `unverified` 来接受未签名的归档，肯定回答不能代替它。

<a id="limits"></a>
### 上限

导入会拒绝超出下列上限的归档，并返回 `ARCHIVE_TOO_MANY_ENTRIES`、`ARCHIVE_ENTRY_TOO_LARGE`、`ARCHIVE_TOTAL_TOO_LARGE` 或 `ARCHIVE_RATIO_EXCEEDED`。

| 上限 | 取值 |
| --- | --- |
| 一个归档中的条目数 | 100,000 |
| 整个归档解压后的大小 | 4 GiB |
| 一个条目解压后的大小 | 1 GiB |
| 一个条目解压后与压缩后大小的比率 | 100:1 |

检查基于中央目录与条目头所声明的大小进行，并再次基于实际读取的字节进行，因此声明的大小小于实际读取字节数的归档会被拒绝。将归档保存在内存中的读取者可以设置更低的上限：`delorun import` 最多读取 1 GiB 的文件，并拒绝超过 512 MiB 的条目，因为它一次把一个条目解压到内存中。校验不保留任何条目的内容；每个条目在暂存时再次读取。

<a id="import-and-export"></a>
### 导入与导出

`delorun export <chat-or-workspace> --out <file>` 从 home 的存储中写出一个 chat，或一个工作区及其 chat：每个 chat 最新的会话代，以及 chat 按内容摘要指名、且 home 的附件存储持有的附件。导出把每个对象写入归档，并把其 SHA-256 与大小记入 manifest。导出会就其在 chat 历史中发现的密钥向本人发出警告，按种类和 chat 指明每一项发现，从不给出其值，并在本人决定继续之前不写入任何内容。归档文件以模式 0600 新建，从不替换已有文件。

`delorun import <file>` 在读取文件之前，就拒绝大于总大小上限的文件。随后导入在读取任何条目之前，先检查中央目录声明的大小，并依次校验 manifest、校验和、路径、条目、上限、定制内容与签名。只有经过完整校验、且其签名者已被本人接受的归档才会被写入：它先暂存在 home 的 `archive/staging/` 下，每个新工作区通过一次原子重命名发布到 `archive/imported/`，两者位于同一文件系统。发布中途失败时，会移除同一次导入已经发布的每个工作区，因此失败的导入不会留下部分工作区或 chat。导入从不覆盖已有的工作区或 chat。标识符已存在时，导入会分配一个新的标识符。已导入的 chat 保留在 `archive/imported/` 中，不进入任何模型请求；定制行只被列出，不被应用。

导入在其暂存根目录旁保留一份日志，在发布之前写明每个工作区。被崩溃中断的导入会留下它的日志和暂存根目录；下一次导入首先撤回日志所指明的每个工作区，并移除保存着已解码 chat 内容的暂存根目录。只有当撤回本身失败时，日志才会保留。暂存父目录、工作区存储根目录，以及保存二者之一的目录，都不能是符号链接，并且发布会拒绝已存在的目标，包括重命名本会替换的空目录。

`delorun trash` 的恢复与清除、`delorun export` 和 `delorun import` 在命令持有 home 中每个 profile 的 home 锁期间运行，因为每个 profile 共享它们读取和更改的存储。home 进程在运行的 profile 会拒绝该命令，且命令持有锁期间不会启动任何 home 进程。命令还在 `run/data-users/` 下注册为存储的独占使用者（[C1](c01-home-layout.zh.md)）：当 `delorun headless` 或其他使用者已注册，或有更新、回滚或会话数据副本的恢复正在进行时，它会拒绝；它运行期间，`delorun headless` 也会拒绝。

stock DeepSeek Harness home 的导入不是归档导入；[stock home 导入](#the-stock-home-import)对它作出规定。

<a id="the-setup-archive"></a>
### setup 归档

`delorun setup export --out <file>` 把某人添加的插件、其模型选择与设置写成一个以 home 密钥签名的 `setup` 归档；`delorun setup import <file>` 读取它。归档含一个没有任何行的 `customisation.json`、一个 `setup-document` 条目，以及此人自己编写的插件的每个不同文件各一个 `plugin-file` 条目。`delorun import` 以 `ARCHIVE_WRONG_KIND` 拒绝 `setup` 归档，`delorun setup import` 同样拒绝 `chats` 归档。

setup 文档是封闭的 JSON schema（`schemaVersion` 为 `1`）：`profile`（仅供参考）、可选的 `note`（至多 500 个字符，导入时显示在签名者旁边）、`includesSettings`、`plugins`、`models` 与 `settings`。`models` 保存设置默认模型、模型提供方和模型设置的补丁条目，它们总会随行；`settings` 保存其他被携带的条目，`includesSettings` 为 false 时为空。没有 `files` 的本地插件只有名称：导出方略去了它的代码，导入方既不安装也不移除它。来自注册表的插件为 `{ name, source: "registry", version, integrity? }`，带确切版本与 lockfile 的 integrity；此人自己编写的插件为 `{ name, source: "local", version?, files }`，每个文件带经归档检查的 `path`、`sha256`、`size` 与 `executable`，且含一个 `package.json`。名称、版本与摘要遵循固定的模式，路径经过[路径规则](#archive-file)，一个插件至多 20,000 个文件，一个 setup 至多 200 个插件与 500 个补丁条目；文本值含控制字符、以 `!` 开头或含 `!!` 时被拒绝（表达式形式为 `ARCHIVE_EXPRESSION_REFUSED`）。`models` 与 `settings` 以数据形式保存 profile 的补丁条目。

setup 带什么，在导出时决定，在导入时由同一策略（`@delorun/changes` 的 `setup-transfer`）再决定一次：

- `@delorun/` 与 `@deepseek-ai/` 范围内的插件从不被携带、移除或替换。
- 补丁条目只有在设置默认模型、某个模型提供方、模型设置或 studio 的外观（`agent-default-model`、`llm-deepseek`、`llm-pi-ai`、`ui-settings-models`、`delorun-theme`、`delorun-cost-meter`、`delorun-thinking-rsvp`），或 setup 所带插件以其自有 id 插入的行（id 以该插件的名称开头，且不使用 Delorun 或上游各行的 id，如 `delorun-…`、`session-…` 或 `sandbox…`，也不使用 profile 的任何 bundle 的某一行所持有的 id，`setup-transfer` 在规划导出或导入时从 bundle 中读取这些 id；名称等于此类 id 的插件同样没有插入的行，因为补丁按 id 查找行，若第二行也用该 id，就会接收原本要给保护那一行的后续补丁）时才被携带；以插件名义去设置已有行的条目不被携带。其余条目，如插件安装检查、隐私默认值，以及权限、变更保护、沙箱、网络、设备、reach 与凭据的行（包括每个沙箱、权限、网络、设备、reach 与凭据行），都留在它所保护的那台电脑上，并被列为未应用。端点必须是 `https` URL，或本机上的 `http`。提供方在 `apiKeyEnv` 中只能指名它自己的默认密钥变量（DeepSeek 为 `DEEPSEEK_API_KEY`，其他提供方为大写的提供方名称加 `_API_KEY`），因为凭据引用会回退到进程环境，任何其他名称都会把该变量的值发给归档所指名的端点；指名了其他变量的条目不被携带。端点不是该提供方已知默认值的导入（除 DeepSeek 以外的提供方，任何主机都算）会被拒绝，直到本人单独于其余内容确认：请求与该提供方的密钥将发往该主机。
- 被携带的条目中若含凭据字段（密钥、secret、令牌、密码、口令、凭据、cookie 或授权字段）的值、header 值、JSON Web Token、Google API 密钥、URL 中名为 `key`、`token`、`auth`、`secret`、`password` 或签名的查询参数，或匹配密钥模式的文本，则导出与导入都会停止（`SETUP_REFUSED`），并以位置命名，从不以值命名。`!!js` 表达式不会被导出。
- 在导出电脑上自己编写的插件，以其已批准副本的文件携带；链接不携带。

`openSetup` 运行 `inspect` 的所有验证步骤，但不以签名者作为门槛：未签名的归档与由未知密钥签名的归档，会连同密钥指纹一起作为未验证返回；无法通过验证的签名仍以 `ARCHIVE_SIGNATURE_INVALID` 被拒绝。导入随后替换本人所选的部分，这些都在询问本人之前列出：模型条目总是被替换；其他设置除非本人关闭或归档不含设置，否则被替换（归档没有的设置恢复默认）；以及归档所列的插件；归档未列出的插件只有在本人选择移除时才被移除。导入先保存一个 profile 历史版本，再通过 `@delorun/changes` 的插件请求操作应用，因此安装检查、被扣留的构建脚本与对本地代码的审阅都适用。本地插件的文件被写入 `archive/setup-plugins/<profile>/` 下的新文件夹，插件从该处链接，这会把其内容记录为一个等待审阅的变更。注册表插件的 integrity 在包管理器运行之后、Host 重新加载或变更被记录之前，对照 lockfile 检查；不匹配时，`package.json` 与 lockfile 会被放回原样，且不再应用任何内容。导入所保留的插件保留其设置行，被导入移除的插件失去其行；退回到所保存的版本，会丢弃导入创建且仍在等待的代码审阅。

<a id="the-stock-home-import"></a>
### stock home 导入

`delorun import-home [--from <dir>] [--dry-run] [--merge] [--max-size <bytes>]` 把 stock DeepSeek Harness home（`~/.dsh` 或 `--from` 所指的目录）复制到 Delorun home 中。setup 把同一导入的数据部分作为其 `import` 一节提供（[C11](c11-setup-answers.zh.md#modes-and-sections)）。stock home 是敌对输入，因为模型、插件或克隆的仓库都可能向其中写入内容，导入只读取它：不以写入方式打开任何 stock 文件，导入之后 stock home 的文件字节完全相同。不含 chat、不含带 `package.json` 的 profile、也不含工作区列表的目录不是 stock home，会被拒绝。

导入在一次确认之后复制数据：chat、附件和工作区列表。凡是可能改变 Delorun 运行内容或智能体所得指示的内容，都是本人在看过之后单独被问及的类别，除非本人确认，否则每一类都关闭：profile、设置层、指示、技能和 DeepSeek 密钥。setup 只复制数据。`--dry-run` 显示预览，完全不写入任何内容。预览写明各 chat；每个工作区的标题与其文件夹（标题从不单独显示）以及它是否被扣留；每个 profile 及其每个组合包和插件是被沿用、待安装、已添加还是未沿用及其原因；每个设置层及其将落地的行和被扣留的每一行及原因；指示的长度；每个技能及其描述、文件和大小；按名称给出的已存密钥；以及每个被留下的条目及其原因。在每个类别提问之前，终端分页显示将落地的全部文本：每个 profile 的 manifest 和 patch 层、每个设置层以及完整的 `AGENTS.md`；对于技能，它列出每个文件，并在本人要求时完整显示每个技能的 `SKILL.md`。提前停止阅读的人会被告知其余部分未显示，而该问题仍默认为否。终端打印来自 stock home 的每个名称和文本时，会转义其控制字符、双向控制字符、行分隔符和零宽字符。

| stock 条目 | 导入的处理 |
| --- | --- |
| `sessions/<project>/<session>/` | 数据。一个 chat：每一代都逐字节复制，因此 Delorun home 读取它的方式与上游相同。chat 要么整体复制，要么完全不复制：含有比本构建能读取的更新的一代、未压缩的一代、是链接或不是普通文件或有第二个硬链接的一代，或其最新一代的日志无法读取的 chat，都被留下。最新一代按流读取，解压比率上限为 100 比 1：其头部必须写明其文件夹所指明的 Session，结束于某一轮中间的日志会被留下，因为恢复它会提供其未完成的工具调用供重试。归在某个工作区下的 chat，按其头部的 `cwd`，必须在该工作区的文件夹之内或之下工作；不归在任何工作区下的 chat，不得在敏感文件夹（见下）中工作。旧版扁平布局中的项目目录被留下。日志显示以完全访问权限运行的 chat，会以更安全的预设打开，直到本人在此 home 中为其工作区允许完全访问（[C16](c16-parity-composition.zh.md#changed-defaults) 的 `permission_defaults`）。 |
| `attachments/v1/objects`、`file-objects`、`files` | 数据。当文件的字节具有其路径所指明的 SHA-256（`<store>/<aa>/<digest>` 或 `files/<aa>/<digest>/<name>`）时复制，规划时检查，复制期间再次检查；任何其他文件被留下。文件别名继续共用其对象的 inode。`attachments/v1/request-images` 是缓存，被留下。 |
| `storages/workspace.json` | 数据。工作区注册信息，用上游的记录 schema 读取，并检查上游注册表启动所需的一致性；变更中途被中断的列表会使导入被拒绝。该列表按其解析后的值写入，绝不来自 stock 字节，且只含导入所沿用的工作区与 chat。文件夹敏感的工作区连同其 chat 被扣留：文件系统根目录、本人的主目录本身、其下直接的隐藏文件夹或其中的任何内容（例如 `.ssh`、`.config`、`.gnupg`），以及任一 Harness home 或其中的任何内容，同时按所写文件夹与其真实路径判断，因此指向此类位置的链接，或位于其下的文件夹，同样被扣留。没有列表的 Delorun home 接收所沿用的列表；有列表的 Delorun home 保留每条记录，其文件夹已注册的 stock 工作区把它的 chat 加到该工作区，任何其他 stock 工作区加在自己的位置之后。 |
| `profiles/<name>/` | profile 类别。以自己的名称沿用，manifest 重新写出：名称、`private`、以版本范围或标签指名注册表包的依赖，以及追加了 `@delorun/bundle-local` 的组合包列表。不落地任何脚本、pnpm 设置、覆盖、路径或其他字段；来自路径、链接、git 地址、URL 或别名的依赖被列为未沿用。patch 层的拆分方式与 home patch 相同。`compatibility.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 被留下；profile 接收上游为新 profile 提供的 pnpm 设置，它不批准任何构建，因此 `delorun plugin --profile <name> install` 只有在本人批准之后才运行插件的安装脚本。桌面应用的 `desktop` profile、[C1](c01-home-layout.zh.md#profiles) 保留或不接受作为 profile 名称的名称（例如 `delorun headless` 为自己设置的 `headless`）、Delorun home 已持有或 setup 正在创建的名称，以及会被 shell 拆分的名称都被留下。 |
| `cordis.patch.yml`、`settings.yaml` | 设置类别。每一层都被解析而从不被求值，并由允许列表拆分：只有当一行所含的每个设置都是列表为该行指名的设置时，该行才落地。只有当 Delorun home 没有同名文件时，一层才落地。 |
| `AGENTS.md` | 指示类别，除非 Delorun home 已有自己的指示。 |
| `skills/<name>/` | 技能类别，每个技能都复制，除非 Delorun home 已有同名技能，或其 `SKILL.md` 超过 1 MiB（预览无法显示它）。 |
| `.credentials.yaml` | DeepSeek 密钥类别：只提供 `DEEPSEEK_API_KEY` 引用和 `llm-deepseek/<name>` api-key 记录的 `key`，按名称给出且从不显示，并以模式 0600 复制到 Delorun home 的凭据文档中。记录的 `env` 映射和其他每个键都被列为未沿用。 |
| 其他任何内容 | 连同原因一起被留下：日志、缓存、已安装的运行时与包、profile 历史、`.env`、匿名标识符、工具权限授予、已安排的后续跟进、spill 的工具输出、实时共享链接、Delorun 自己的条目、锁和写了一半的文件、位于另一个文件系统上的条目，以及导入不认识的每个条目。 |

落地的设置是行与设置组合的允许列表（[`layers.ts`](../../packages/archive/src/dsh-import/layers.ts) 中的 `CARRIED_SETTINGS`）：studio 的主题和字体（`ui-theme`）、chat 与输入框的显示方式（`ui-chat`、`ui-conversation`）、语言（`locale`），以及按提供方和模型名称给出的默认模型（`agent-default-model`）。每个值必须是布尔值、有限数字，或不含控制字符且最多 200 个字符的字符串；字体族由 studio 写入其样式，只能包含字母、数字、空格、逗号、连字符和引号，最多 100 个字符。无论名称如何，其他每一行都被扣留：列表未指名的行或设置、`disabled` 标志、插件替换、任何包的每个插入行、任何位置的表达式或 loader 标签，以及任何其他值。无法解析、使用锚点、别名或合并键，或不是其 loader 读取的列表或映射的层，整体被扣留。被扣留的行落在 `archive/stock-import/import-<id>/held/` 中（每行之前附有原因），任何 loader 都不读取那里。

沿用的 profile 通过 `@delorun/profile-safety` 的沿用检查，该检查针对导入只读取一次的文本：本人原有的 profile（在 stock home patch 之下）与落地后的 profile（在 Delorun home 将应用的 home patch 之下）作比较，每个不能沿用的行或设置都列在预览中。导入从不运行插件、生命周期脚本、`!!js` 表达式或 `pnpm install`。

遍历通过 `lstat` 对每个条目分类。符号链接、管道、套接字或设备、位于与 stock home 根目录不同设备上的条目，以及上游不会写出的名称（含分隔符、控制字符或 `..`）都被列出，并且从不读取。遍历没有在 stock home 内遇到的硬链接所指向的文件，从不被复制；导入要解析的文档，只要有第二个链接，就在读取之前被拒绝。每个目录以不跟随最终链接的方式打开，并从其描述符列出，其标识必须是遍历所记录的标识，其路径必须是所遍历的路径，因此途中被换成链接或另一个目录的目录会使导入被拒绝。每个文件以不跟随最终链接、且不等待管道的方式打开，并在读取之前与之后，对照遍历所记录的标识（设备、inode、链接数、大小、修改时间和状态变更时间）及所遍历的路径，在打开的描述符上检查，因此预览之后被换掉或写入的文件会使导入被拒绝，包括把修改时间调回的重写。导入复制的每个文件（chat、附件、技能和指示）在规划时计算哈希，并在复制期间必须具有相同的摘要；计划从中得出文本的每个文档（包括工作区列表、各层和 manifest），在该文本落地之前再次计算哈希。导入拒绝超过 100,000 个已列出的名称、大于 1 GiB 的文件，以及总量超过 4 GiB；`--max-size <bytes>` 提高总量上限，且没有文件可以超过它。预览按每种原因列出 100 个被留下的条目，并统计每一个。

已经含有 chat 的 Delorun home 会被拒绝，除非给出 `--merge`。Delorun home 以其他内容持有、或在另一个项目目录中持有其标识符的 chat，以其他字节持有其地址的附件，以及为另一个文件夹持有的工作区标识符，都属于冲突，导入因此被拒绝；Delorun home 逐字节持有的 chat 或文件已经存在，不会再次复制。setup 严格执行其预览所显示的计划，如果 Delorun home 此后新增了 chat，则拒绝。

每个文件都暂存在 `archive/stock-import/staging-<id>/` 下并同步，其旁边有一份日志，在放置它的重命名之前同步，并在第一次放置之前写明导入创建的每个目录和放置的每个文件，及其所放置字节的摘要。新文件通过一次在已有路径上会失败的硬链接放置；导入要添加内容的文档（合并时的工作区列表、凭据文档、记录）先在暂存根目录中链接到一旁，再通过一次重命名替换。收到链接的目录在日志移除之前同步，日志的移除即完成导入，因此 Delorun home 要么拥有一次导入的全部内容，要么一无所有。失败会撤回其 inode 仍是暂存 inode、且字节仍具有所记录摘要的每个文件，放回被替换的每个文档，并在所创建的目录为空时移除它们；当撤回也失败时，拒绝信息写明两个失败，日志被保留。崩溃会留下日志，下一次 `delorun import-home` 首先撤回它。撤回会原样保留并报告放置之后字节发生变化的文件，例如某个 profile 写入过的 chat。日志的暂存目录已不存在，或其路径不是由安全段组成的 home 相对路径，其目录不在它所指明文件的路径上，它两次指明同一文件，或缺少摘要时，该日志会被保留，并使撤回被拒绝。已完成的导入把它所沿用的内容、所复制 chat 的 Session 标识符以及本人选取的类别追加到 `archive/stock-import/imports.json`。导入持有每个 profile 的 home 锁，并像 `delorun import` 那样注册为唯一的独占数据使用者，因此当另一个进程使用该 home 的数据，或任何 profile 有未完成的更新、回滚或恢复时，它会拒绝。

启动路径不会撤回被中断的导入（[路线图](../guide/roadmap.zh.md)）。`recoverInterruptedImport`（[`delorun/apps/cli/src/import-home/recover.ts`](../../apps/cli/src/import-home/recover.ts)）是会这样做的调用，它位于 `startForeground` 中、profile 检查之后且 home 进程注册之前，以及 `runHeadless` 中、其共享注册之前：当有日志在等待时，它注册为独占数据使用者，在另一个活动的数据使用者存在或更新未完成时拒绝，并撤回该导入；它无法信任的日志会使 profile 无法启动。它的拒绝是 `DshImportError`，一旦启动路径调用它，共享的拒绝渲染器就会与归档的其他拒绝一起描述它。

<a id="errors"></a>
### 错误

每次拒绝都带有下表中的一个代码。拒绝不写入任何内容。

| 代码 | 原因 |
| --- | --- |
| `ARCHIVE_UNSUPPORTED_VERSION` | `formatVersion` 或定制内容的 `schemaVersion` 不是读取者所认识的版本。 |
| `ARCHIVE_TRUNCATED` | ZIP 结构或某个条目提前结束，或声明的大小与实际字节不符。 |
| `ARCHIVE_CHECKSUM_MISMATCH` | 某个条目的字节与 manifest 中的 SHA-256 不符。 |
| `ARCHIVE_PATH_REJECTED` | 路径为绝对路径、含有 `..`、含有反斜杠，或使用了保留的设备名。 |
| `ARCHIVE_LINK_REJECTED` | 某个条目是符号链接或硬链接。 |
| `ARCHIVE_CASE_COLLISION` | 两个路径仅在字母大小写上不同。 |
| `ARCHIVE_TOO_MANY_ENTRIES` | 归档超出条目数上限。 |
| `ARCHIVE_ENTRY_TOO_LARGE` | 某个条目超出单条目大小上限。 |
| `ARCHIVE_TOTAL_TOO_LARGE` | 归档超出总大小上限。 |
| `ARCHIVE_RATIO_EXCEEDED` | 某个条目超出压缩比率上限。 |
| `ARCHIVE_SCHEMA_INVALID` | manifest 或定制文档与其 schema 不符，包括含有控制字符的文本字段，以及不是 `publicKey` 指纹的 `homeKeyId`。 |
| `ARCHIVE_EXPRESSION_REFUSED` | 某一行含有 `!!js` 表达式，或是 `insert` 行。 |
| `ARCHIVE_DENIED_ROW` | 某一行属于被拒绝的 kind。 |
| `ARCHIVE_WRONG_KIND` | 归档装的是 chat 而命令读的是 setup，或者相反。 |
| `ARCHIVE_SIGNATURE_INVALID` | `signature.json` 存在，但其签名校验失败。 |
| `ARCHIVE_SIGNER_UNTRUSTED` | 签名密钥不是导入所在 home 所担保的密钥且本人未确认，或归档未签名而本人未接受其未校验状态。 |
| `ARCHIVE_STAGING_FAILED` | 暂存目录或导入的日志无法写入，原子重命名失败，或暂存父目录、工作区存储根目录，或保存二者之一的目录是符号链接。 |

本人已接受的签名缺失不是错误，它就是未校验状态。

stock home 导入以下表中的一个代码拒绝，并且不会在 Delorun home 中写入任何在拒绝之后仍然存在的内容。

| 代码 | 原因 |
| --- | --- |
| `DSH_IMPORT_SOURCE_UNUSABLE` | stock home 不存在、不是目录、不含 chat、profile manifest 或工作区列表，与 Delorun home 重叠，或某个条目无法读取。 |
| `DSH_IMPORT_HOME_HAS_CHATS` | Delorun home 含有 chat 且未给出 `--merge`。 |
| `DSH_IMPORT_ID_COLLISION` | Delorun home 以其他内容持有的 chat、附件或工作区标识符。 |
| `DSH_IMPORT_TOO_MANY_ENTRIES` | stock home 持有的条目多于导入所读取的数量。 |
| `DSH_IMPORT_ENTRY_TOO_LARGE` | 某个文件超过单文件上限。 |
| `DSH_IMPORT_TOTAL_TOO_LARGE` | 要复制的文件超过总上限，`--max-size` 可提高该上限。 |
| `DSH_IMPORT_SOURCE_CHANGED` | stock 文件或目录在预览之后被更改或替换，或某个文件或文档不再含有计划所读取的字节。 |
| `DSH_IMPORT_TARGET_REFUSED` | 导入要写入的 Delorun home 目录是链接、不是目录或不可读，计划的路径已出现，工作区列表已更改，或 home 无法持有来自暂存根目录的硬链接。 |
| `DSH_IMPORT_REGISTRY_REFUSED` | Delorun home 的工作区列表无法读取，或任一列表在变更中途被中断。 |
| `DSH_IMPORT_CREDENTIALS_REFUSED` | 复制凭据时，凭据文档无法读取。 |
| `DSH_IMPORT_STAGING_FAILED` | 暂存根目录、日志或某个文件无法写入，失败之后的撤回也失败，被中断导入的日志无法读取或无法信任，或其暂存目录已不存在；一旦启动路径撤回被中断的导入，这也会使 profile 无法启动。 |

<a id="untrusted-imported-chats"></a>
### 已导入的 chat

`delorun import` 把已导入的工作区及其 chat 发布到 `archive/imported/`，不创建任何会话，并在其报告中说明已导入的 chat 不进入任何模型请求，也无法在 studio 中打开。CLI profile 的任何行都不读取 `archive/imported/`，因此已导入的 chat 不会到达任何 Host 插件，也不会进入任何模型请求。已导入的 chat 没有受信任状态、横幅或信任操作，回收站与清除也不涉及它。把已导入的 chat 作为未受信任的 chat 打开，在本人将其标记为受信任之前，其历史保持在模型上下文之外，这在[导入 chat 设计](../design/imported-chats.zh.md)中，尚未构建。

上述规则尚未构建（[路线图](../guide/roadmap.zh.md)），而 stock home 导入把它的 chat 发布到 `sessions/`，studio 把它们当作本人自己的 chat 打开。它所给予的保护更少：它复制的每个 chat 都按其 Session 标识符记入 `archive/stock-import/imports.json`，`@delorun/archive/dsh-import` 的 `readImportedChats` 会把它读回，因此界面可以标记它；结束于某一轮中间的 chat 不会被沿用，因此来自另一个安装的工具调用不会被提供重试，预览和报告会说明有多少被留下，以及本人仍然可以在未改动的 stock home 中阅读它们；以完全访问权限运行过的 chat 以更安全的预设打开。只要该规则尚未构建，studio 就不会在这类 chat 上显示横幅，本人继续它时，其历史会进入模型。

<a id="trash-and-purge"></a>
### 回收站与清除

删除 chat 或工作区会把它移入回收站。在 studio 中，chat 或工作区菜单里的「Move to trash」操作会归档其 chat 并停止其正在运行的工作，把每个 chat 的会话目录移入 home 下的 `trash/`，对于工作区，还会记录并移除其注册。其会话锁被活动写入方持有的 chat 保留在原位，处于已归档并隐藏的状态，直到下一次启动才把它移入。设置中的回收站一节列出每个条目及其剩余天数；`delorun trash list` 打印相同的内容。回收站为每个条目保留 30 天。本人可以在保留期结束之前从回收站恢复条目：其 chat 回到原位，工作区连同其 chat 重新注册，删除时被归档的每个 chat 都取消归档。home 进程的每次启动都会清除保留期已结束的每个条目。回收站在清除之前保留条目中的密钥。

删除会在移动 chat 之前先写入条目的记录，写明每个 chat 在回收站中的去向，而每次启动都会移入内容仍在原位的 chat，因此两步之间的崩溃不会丢失任何内容。恢复会在移动任何内容之前检查每个目标，拒绝已存在会话目录的目标，并在每个 chat 返回后重写记录，因此中途停止的恢复会留下一份恰好记录回收站仍持有内容的记录。记录把其 chat 的位置写为配置的会话根目录之下的两个已编码路径段；任何其他记录都是已损坏的。已损坏的条目目录连同其目录和原因一起被列出，没有任何操作会恢复、清除或使其过期。`delorun trash restore` 只恢复 chat：工作区在设置的回收站一节中恢复，因为恢复会把它重新注册到 home 进程所拥有的工作区列表中。

保留期清理只在一定范围内信任时钟。当条目的删除时间晚于时钟读数，或时钟读数早于它记录在 `trash/retention.json` 中的上次清理时，它不清除任何内容。当时钟读数比上次清理晚 365 天以上时，该次清理不清除任何内容，记录新的时间，并在下一次启动时运行。

清除会把条目从保存其内容的每个存储中移除。

- `session-query-sqlite` 的 SQLite FTS5 全文索引中该条目的行。
- 条目中每个 chat 的会话目录，包括其中的每一代，即每个 `session*.jsonl.zstd` 文件。
- 条目中每个 chat 的投影缓存存储文档，其中保存该 chat 的缓存标题、第一条消息、计划、目标与待办，以及缓存在丢弃无效记录时移开的副本。
- 条目的 chat 所指名的、且 sessions 根目录下没有任何 chat 和没有其他回收站条目指名的附件：对每个这样的附件，清除 `attachments/v1/` 下的图像对象、文件对象和文件别名目录。仍被其他 chat 指名的附件会被保留，清除会报告保留了多少。`attachments/v1/request-images/` 下的请求图像缓存按每个缩放变体的哈希为键，不在清除范围内。
- `spill` 存储中该条目的 spill 文件。
- 在执行清除的浏览器中，按 host 限定键约定，该条目在每个 host 作用域下的草稿条目，以及没有 host id 的页面所写入的无限定键下的草稿条目。由 `delorun trash` 执行的清除，或在保留期结束时执行的清除，没有任何浏览器执行，因此不涉及任何草稿。

已清除内容的片段可能残留在运行日志中，直至这些日志被删除。依据运行日志约定，每条运行日志记录最多保留 14 天。清除会说明这一残留。studio 的清除会提议一次清除 home 的所有运行日志（包括当前文件与轮转文件），而不只是该条目的记录，并在本人接受之前说明这一点；`delorun trash purge` 与 `delorun trash empty` 只在给出 `--clear-logs` 时才清除它们，否则打印残留情况和移除它的命令。本人接受时，清除会删除这些日志；无法清除的日志会连同其失败原因一起报告，清除随后说明残留，而不报告日志已清除。清空回收站时，会在最后一次清除中清除日志。

<a id="consumers"></a>
## 消费方

- `delorun/packages/archive/`：导出、导入、校验，以及 home 密钥的加载。
- `delorun/packages/trash/`：回收站、恢复与清除，以及回收站保留期。
- `delorun/packages/plugin-trash/`：studio 的「Move to trash」操作、回收站一节及其在 host 限定键约定下的草稿条目，以及启动时的清除；`@delorun/bundle-local` 在每个 CLI profile 中挂载它。
- `delorun trash`、`delorun export` 和 `delorun import`（`delorun/apps/cli/`），它们打印列表、写出已签名的归档并打印验证报告。
- `delorun import-home` 与 setup 的 `import` 一节（`delorun/apps/cli/`），它们打印 stock home 导入的预览和报告；`@delorun/archive/dsh-import` 对其进行规划、暂存、发布和撤回。
- `delorun/packages/contract-archive-and-trash/`：manifest、行 kind、错误代码、上限与保留期常量。

<a id="compatibility"></a>
## 兼容性

归档格式由 `formatVersion` 标记版本，其值为 `1`。读取者拒绝任何其他版本，任何读取者都不会回退到旧格式，也不会降级归档。未来的格式是一个新版本，并拥有自己的读取者。旧版本的归档由该版本的读取者读取。

归档内的会话数据遵循上游的会话读取器与迁移。当前的会话格式版本记录在[会话格式状态页](../../../docs/session-format-status.zh.md)中，本约定不重复其取值。

定制内容的 `schemaVersion` 仅在某个行 kind 发生不兼容变更时才改变。新增行 kind 即为新版本。移除被拒绝的 kind 属于破坏性变更，需要升级指南。

回收站保留期是本人可以依赖的行为。改变它需要修改本约定，并附上升级指南。

<a id="security"></a>
## 安全

要求：

- 在整个归档于暂存目录中通过校验之前，不写入任何内容。
- 归档从不求值 `!!js` 表达式，也从不写入含有该表达式的行。
- 被拒绝 kind 的行会被拒绝，因此归档无法改变沙箱模式、凭据引用、远程访问选项或出口限制。
- 签名不校验的归档会被拒绝。由 home 不信任的密钥签名的归档，在本人确认该密钥的指纹之前被拒绝；不带签名的归档，在本人接受其未校验状态之前被拒绝，导入在提问之前会说明这一点。
- 不应用任何定制行：不安装任何插件声明或 bundle，也不写入任何预设、skill、主题或 profile 行。
- 已导入的 chat 保存在 CLI profile 的任何行都不读取的位置。导入的 skill 以禁用状态开始、导入的预设无法提升权限，以及导入的 chat 以未受信任状态开始，是[导入 chat 设计](../design/imported-chats.zh.md)的要求，该设计尚未构建。
- 导入从不覆盖工作区或 chat。
- 回收站在清除之前保留密钥，清除会把内容从本约定列出的每个存储中移除。被篡改的回收站记录无法移动或读取 sessions 根目录之外的目录，或另一个条目的内容。预置在存储根目录、或承载版本化根目录的目录上的符号链接会被拒绝而不会被跟随，因此清除不会删除它所指定存储之外的任何内容。
- 导出在写入归档之前，会就 chat 历史中的密钥发出警告，并在本人确认之前不写入任何内容。
- 当活动写入方持有 chat 的会话锁时，删除从不移动该 chat 的会话目录。
- 恢复从不覆盖会话目录，中途停止的恢复不会在清除的路径上留下已恢复的 chat。
- 导入只在 Delorun 检查过的内容之后才打印由归档控制的文本，归档的文本不能携带终端控制字符。
- 导入只写入不是符号链接的目录，被中断导入已解码的 chat 内容会被下一次导入移除。
- `delorun trash`、`export` 和 `import` 从不与任何 profile 的活动 home 进程同时运行。
- stock home 导入只读取 stock home：从不跟随链接，从不跨入另一个文件系统，从不读取其中的管道、套接字或设备；从不复制与外部有硬链接的文件；从不运行 profile 所指名的任何内容；只从其允许列表沿用设置；在本人看过完整文本并单独确认之前，不落地任何 profile、设置层、指示、技能或密钥；扣留位于敏感文件夹中的工作区或 chat，以及位于其工作区文件夹之外、或结束于某一轮中间的 chat；只以模式 0600 复制 DeepSeek 密钥；从不覆盖 chat、附件或工作区；从不撤回其后已被某个 profile 写入的文件；并使 Delorun home 要么拥有一次导入的全部内容，要么一无所有。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `archive with a !!js expression causes no evaluation or write` | 含有 `!!js` 的定制行在求值之前被拒绝，且不写入任何文件。 |
| `archive with an insert row is refused` | `insert` 形式的定制行以 `ARCHIVE_EXPRESSION_REFUSED` 被拒绝。 |
| `archive that sets a sandbox mode, credential reference, reach row or egress is refused` | 每个此类行都以 `ARCHIVE_DENIED_ROW` 被拒绝，且没有任何行被应用。 |
| `traversal, link, size, ratio, case, truncation, version and canary fixtures cause no write` | 每个夹具都以其错误代码被拒绝，且工作区存储保持不变。 |
| `unverified archive imports only with the unverified label` | 没有签名的归档只有在本人接受之后才会导入，导入在提问之前会说明它没有签名。 |
| `a signature that does not verify is refused` | manifest 在签名之后被更改，或签名属于另一个密钥的归档，以 `ARCHIVE_SIGNATURE_INVALID` 拒绝，且不写入任何内容。 |
| `an unknown signer is refused until its fingerprint is typed` | 由 home 不信任的密钥签名的归档，在本人键入该密钥的指纹之前以 `ARCHIVE_SIGNER_UNTRUSTED` 拒绝，且不写入任何内容。 |
| `an import that fails partway leaves no workspace` | 同一次导入在先前的工作区已发布之后发布失败时，会移除该工作区。 |
| `a deleted chat leaves the session list until it is restored` | 回收站中的 chat 不出现在上游的会话列表中，也无法打开；恢复会返回每个事件。 |
| `a chat a live writer holds stays pending` | 会话锁被持有的 chat 保留在原位，直到锁被释放且某次启动把它移入回收站。 |
| `import into an existing identifier never overwrites` | 标识符已存在的导入会写入一个新工作区，并使已有的工作区保持不变。 |
| `canary is absent from the index and every generation after purge` | 清除之后，canary 文本不出现在全文索引中，也不出现在该 chat 的任何会话代次中。 |
| `purge refuses a symbolic link at a store` | 预置在附件存储上的符号链接被以 `TRASH_STORE_REFUSED` 拒绝，其指向的文件保持不变。 |
| `purge leaves no cached title or first message on disk` | 清除之后，该 chat 的投影缓存文档不存在，因此该 chat 的缓存标题、第一条消息、计划、目标与待办都不再留在磁盘上。 |
| `purge with clear-logs chosen leaves no canary residue anywhere` | 接受清理提议并清除之后，canary 文本不出现在任何存储与任何日志文件中。 |
| `purge without clear-logs leaves residue only in retained process logs` | 未接受清理提议并清除之后，canary 文本只残留在保留期内的运行日志中。 |
| `export warns about secrets found in chat history` | 对含有植入密钥的 chat 导出，会在写入归档之前显示警告。 |
| `a restore that would overwrite a chat moves nothing back` | 后面的目标已有会话目录的恢复不移回任何 chat，并保持该条目完整。 |
| `a restored chat is never purged after a restore that failed on a later chat` | 恢复在其第二个 chat 上失败之后，对该条目的清除会让第一个已恢复的 chat 保持原位。 |
| `a crash before the move leaves the chat at its origin, and a restore deletes nothing` | 在写入其记录之后停止的删除，让 chat 保留在原位，而对该条目的恢复不删除任何内容。 |
| `a crash after the move leaves a record a restore follows back` | 在移动之后停止的删除，留下一份写明 chat 所在位置的记录，恢复会将其返回。 |
| `cannot make settle move a directory outside the sessions root` | chat 的原位置越出 sessions 根目录的记录是已损坏的，不会移动任何目录。 |
| `cannot make a restore read content from another item` | 写明另一个条目内容的记录是已损坏的，该内容保留在原处。 |
| `a damaged record is reported with its directory and never expires` | 不可读的记录连同其目录和原因一起被列出，保留期清理会跳过它。 |
| `purges nothing when an item was deleted later than the clock reads` | 对删除时间晚于时钟读数的条目，保留期清理不清除任何内容。 |
| `pauses once when the clock jumps more than a year past the last pass, and resumes at the next start` | 时钟向前跳过 365 天以上时，该次启动不清除任何内容。 |
| `canary attachment is purged from every layout only when no other chat names it` | 只有在没有其他 chat 或条目指名其摘要时，清除才会移除附件的对象、文件对象和别名目录。 |
| `reports a clear that failed as not cleared, with each failure` | 失败的日志清除会报告每个失败，并且不报告日志已清除。 |
| `a workspace name holding %s is refused before anything is written` | manifest 的文本字段含有转义序列、回车、C1 控制字符、DEL 或双向控制字符时，以 `ARCHIVE_SCHEMA_INVALID` 在写入任何内容之前被拒绝。 |
| `a customisation target holding a control character is refused` | 目标含有双向控制字符的定制行被拒绝。 |
| `is validated without scanning its directory once per entry` | 含 400 个条目的归档，以固定次数的目录扫描完成校验和导入。 |
| `is read again entry by entry as it is staged, not held whole before the staging root exists` | 只有在暂存根目录存在之后，才读取条目的内容用于暂存。 |
| `is finished by a recovery that withdraws what its journal names and removes what it staged` | 崩溃的导入已发布的工作区和已暂存的 chat 内容，会被恢复流程移除。 |
| `never lands on an existing directory, even an empty one a rename would replace` | 发布到已存在的空目录上会失败，两个目录都保持不变。 |
| `refuses a staging parent that is a symbolic link, or sits in one, before it writes anything` | 经过链接暂存父目录的导入或恢复被拒绝，链接的目标保持不变。 |
| `refuses a workspace store root that is a symbolic link, or sits in one` | 发布到链接的存储根目录会被拒绝，链接的目标保持不变。 |
| `that is unsigned imports only after the person types unverified, which a yes is not` | 未签名归档的 `delorun import` 拒绝 `y` 与 `yes`，只有在键入 `unverified` 之后才导入。 |
| `escapes every archive-controlled field, after the line Delorun checked` | `delorun import` 先打印签名者行，然后打印由归档控制的每个字段，其控制字符均被转义。 |
| `with an entry over the terminal's lower ceiling is refused on its declarations` | `delorun import` 在读取之前，就拒绝声明大于 512 MiB 的条目。 |
| `refuses while a profile's home process runs, runs nothing, and leaves no lock it took` | home 有运行中 profile 的命令会拒绝，不运行任何内容，并释放它持有的每个锁。 |
| `leaves a workspace to the studio, which registers it again, and moves nothing` | 对工作区条目运行 `delorun trash restore` 会被拒绝，并指向 studio 的回收站一节。 |
| `are read by no row of the shipped composition` | 发布组合中没有任何行指名 `archive/`，因此已导入的 chat 到不了任何 Host 插件。 |
| `leaves a symbolic link at sessions/ behind and never reads through it` | stock home 中作为链接的 `sessions/` 被列出，其后的 chat 都不落地。 |
| `leaves a chat whole when a generation is a link to a file outside the stock home or to the Delorun home's secrets` | 该 chat 被列出并留下，两个文件的字节都不会到达 Delorun home。 |
| `leaves a file hard-linked to one outside the stock home behind, and carries an alias whose every link is inside` | 与外部文件有硬链接的 chat、文档或附件被留下，而每个链接都在内部的附件别名则落地。 |
| `leaves a pipe behind without opening it, so the import does not wait on it` | 代替某一代、文档或技能文件的管道被列出，导入完成。 |
| `leaves each such name behind as unsafe or unknown` | 含控制字符、双向控制字符、保留设备名，或上游不会写出的形式的名称被留下。 |
| `refuses one file over the per-file limit and a total over the total limit, naming --max-size, and writes nothing` | 每一种大小方面的拒绝都带有其代码，Delorun home 保持为空。 |
| `runs no !!js expression, no lifecycle script and no install when it plans and copies a profile` | 被求值的表达式或脚本会写入的 canary 不存在，也没有包树落地。 |
| `refuses a chat whose identifier the Delorun home holds with other content or in another project, and never overwrites it` | 每个冲突都是阻塞项，Delorun home 保持不变。 |
| `refuses a stock file that a link replaced after the plan, and writes nothing` | 预览之后被换成链接的文件以 `DSH_IMPORT_SOURCE_CHANGED` 拒绝。 |
| `is withdrawn by the next recovery when a crash stopped it after any publication, and the replaced documents come back` | 在任一放置处崩溃之后，恢复使 Delorun home 回到导入之前的样子。 |
| `copies the credentials only when the person said yes, at mode 0600, beside the ones the Delorun home holds` | 没有确认则不落地任何凭据；确认之后，每个所提供的凭据以模式 0600 落地，且任何值都不会进入报告或记录。 |
| `prints every name from the stock home with its controls escaped` | 预览不含原始转义字符、响铃或双向控制字符。 |

<a id="decided-values"></a>
## 决定的取值

- 归档上限为：100,000 个条目，解压后总计 4 GiB，单个条目 1 GiB，单个条目的压缩比率为 100:1。
- 回收站为每个条目保留 30 天。
- 已清除的内容在运行日志中至多保留 14 天，即运行日志约定的保留期。
- 已导入的 chat 保留在 `archive/imported/` 中，CLI profile 的任何行都不读取它。
- 归档签名算法为 Ed25519，签名密钥为导出 home 的密钥。
