---
description: "Delorun 的归档格式 v1（C8）：ZIP 读取器与写入器，对路径、链接、大小和压缩比的拒绝，封闭的定制化 schema，签名与本人接受的签名者，导入的暂存与原子发布，带密钥警告的导出，用于签名的 home 密钥，以及 stock DeepSeek Harness home 的导入。"
---

# @delorun/archive

[English](README.md) | 中文

## 摘要

本包实现[约定 C8](../../docs/contracts/c08-archive-and-trash.zh.md) 的归档一半：导出把一个或多个工作区连同其 chat 和附件写成一个 ZIP 文件，其中含清单、定制化文档和 Ed25519 签名；导入在写入任何内容之前，检查该文件的每一个字节。归档在通过全部检查之前都是不可信输入。`delorun export` 和 `delorun import`（[`@delorun/cli`](../../apps/cli/README.zh.md)）是触达它的命令。`./dsh-import` 导出项执行[stock home 导入](../../docs/contracts/c08-archive-and-trash.zh.md#the-stock-home-import)，`delorun import-home` 和安装设置会触达它。

## 目录

- [导入](#import)
- [签名者](#the-signer)
- [导出](#export)
- [home 密钥](#the-home-key)
- [setup 归档](#the-setup-archive)
- [stock home 导入](#the-stock-home-import)
- [测试](#tests)

<a id="import"></a>

## 导入

`ArchiveImporter`（[`importer.ts`](src/importer.ts)）在读取任何条目之前，先检查中央目录声明的大小，因为读取会按其记录的声明分配内存；然后依次检查清单、校验和、路径、条目、限额、定制化文档和签名。以下情形各自以对应的 C8 错误码拒绝：路径为绝对路径、用 `..` 向上跳转、含反斜杠、控制字符或保留设备名；成员是链接或设备；两个路径仅在字母大小写或 Unicode 规范化上不同；声明的大小与实际字节不符；条目超出大小或压缩比限额。`inspect` 运行全部检查且不写入任何内容，因此调用方可以在询问之前先向本人展示该归档。清单和定制化文档的每个文本字段，只要含控制字符或双向字符（`hasControlCharacter`，[`text.ts`](src/text.ts)）就会被拒绝，并且来源的 `homeKeyId` 必须是其密钥的指纹。校验不保留任何条目的内容，在内存中持有归档的调用方应传入更低的 `limits`。`import` 把校验过的内容暂存到一个新的 0700 目录下，文件为 0600，写入每个条目时会再次读取它；它以一次从不替换现有目录（即使是空目录）的重命名发布每个工作区，并为已被占用的标识符分配新标识符；发布失败时，导入已发布的每个工作区都会被撤回。暂存根目录旁的日志会在发布每个工作区之前记下它，`recover` 会撤回崩溃导入的日志所记录的内容，并移除其暂存根目录。暂存父目录、存储根目录以及容纳这两者的目录若是符号链接，则被拒绝。

<a id="the-signer"></a>

## 签名者

`checkArchiveSignature`（[`signature.ts`](src/signature.ts)）只有在签名针对清单的精确字节验证通过，且所用密钥是 home 所担保的密钥（`trustedPublicKeys` 中的密钥，或本人确认过的密钥）时，才报告 `verified`。确认绑定的是公钥，而不是归档声明的标识符。导入器以 `ARCHIVE_SIGNATURE_INVALID` 拒绝验证失败的签名；对既未被担保也未被确认的密钥，以及本人没有以 `acceptUnsigned` 接受的未签名归档，则以 `ARCHIVE_SIGNER_UNTRUSTED` 拒绝。`keyFingerprint`（[`fingerprint.ts`](src/fingerprint.ts)）是本人用来比对的值：原始公钥的 SHA-256，采用 base64url 编码，它也是该密钥的 `homeKeyId`。

<a id="export"></a>

## 导出

`exportArchive`（[`exporter.ts`](src/exporter.ts)）先扫描 chat 中的密钥，并按类型和 chat（绝不按值）返回扫描结果，在调用方传入 `confirmSecrets` 之前不产生归档。它把每个对象按其 SHA-256 存储，在提供签名者时对清单签名，并按导入所用的限额重新打开完成的归档，因此绝不会交回其自身导入也会拒绝的文件。读取 home 的存储由调用方负责。

<a id="the-home-key"></a>

## home 密钥

`loadHomeKey`（[`home-key.ts`](src/home-key.ts)）通过 C1 的受保护文件规则，读取[约定 C5](../../docs/contracts/c05-device-approval.zh.md) 的 home 密钥 `secrets/home-auth/home-key.pem`（PKCS #8，权限 0600）；home 中没有该密钥时，按请求创建。新密钥先完整写入临时文件再链接到位，因此两次同时进行的首次使用只会保留一个密钥。

<a id="the-setup-archive"></a>

## setup 归档

`exportSetupArchive`（[`setup.ts`](src/setup.ts)）把一个 profile 的插件、模型选择与设置写成 `content` 为 `setup` 的归档：一个 `setup-document` 条目（其封闭 schema 由 `parseSetupDocument` 在两侧应用），以及此人自己编写的插件的每个不同文件各一个 `plugin-file` 条目。`ArchiveImporter.openSetup` 运行 `inspect` 的所有验证步骤，以 `ARCHIVE_WRONG_KIND` 拒绝 chats 归档（`inspect` 与 `import` 则拒绝 setup 归档），检查文档所列的每个文件都是大小一致的 `plugin-file` 条目，且没有未被命名的 `plugin-file` 条目，然后连同签名者状态返回文档。未签名的归档或未知密钥，会连同指纹一起作为未验证返回，而不是被拒绝，因为调用方会展示并询问；无法通过验证的签名仍被拒绝。profile 可以从 setup 取走什么，由 [`@delorun/changes`](../changes/README.zh.md) 的策略决定，而不是由这一格式决定。参见[合约](../../docs/contracts/c08-archive-and-trash.zh.md#the-setup-archive)。

<a id="the-stock-home-import"></a>

## stock home 导入

`@delorun/archive/dsh-import` 把 stock DeepSeek Harness home 复制到 Delorun home，并且只读取 stock home，将其视为不可信输入。

- `planDshHomeImport`（[`plan.ts`](src/dsh-import/plan.ts)）读取两个 home，不写入任何内容。它通过 `lstat`，沿布局表（[`layout.ts`](src/dsh-import/layout.ts)）所列的条目遍历 stock home，并返回：其携带的数据（chat、字节摘要与路径所示一致的附件、工作区列表）；本人需逐项确认的类别（profile、设置层、指令、skill、DeepSeek 密钥），附带将要落地的确切文本；每个被留下的条目及原因，每种原因最多列出 100 项但全部计数；以及使其无法继续的阻塞项：Delorun home 已有 chat 而未传 `merge`，以及每处冲突。没有 chat、profile 清单或工作区列表的目录会被拒绝，超出上限的大小限制会抛出错误。链接、管道、套接字或设备、位于另一设备上的条目以及上游不会写入的名称都被留下；chat 要么整体迁移，要么完全不迁移。
- `SourceReader`（[`source.ts`](src/dsh-import/source.ts)）以 `O_NOFOLLOW` 和 `O_DIRECTORY` 打开每个 stock 目录并从描述符列出其内容，以 `O_NOFOLLOW` 和 `O_NONBLOCK` 打开每个 stock 文件；它把每个打开的描述符与遍历时记录的标识和路径核对，读取量不超过记录的大小，并把每个列出的名称计入条目上限。它会统计遇到的硬链接，因此在 stock home 之外存在链接的文件绝不会被复制。
- `splitPatchLayer` 和 `splitSettingsLayer`（[`layers.ts`](src/dsh-import/layers.ts)）在不求值的情况下解析补丁层或更早的设置，只携带 `CARRIED_SETTINGS` 允许列表中、值为普通值的行和设置对，并把其余各行连同原因作为无效文件留下。
- `ChatLogScan`（[`chats.ts`](src/dsh-import/chats.ts)）在计算哈希的同时，以有界流方式读取 chat 的最新代（generation）：文件头中的 Session 和工作文件夹，以及日志是否结束于某个轮次之内。`sensitiveFolder`、`restrictRegistry` 和 `serializeRegistry`（[`workspaces.ts`](src/dsh-import/workspaces.ts)）留下位于敏感文件夹中的工作区，并根据解析后的值只写出被携带的内容来生成列表。
- `landManifest` 和 `carryNotes`（[`profiles.ts`](src/dsh-import/profiles.ts)）重新写出带有名称、`private`、注册表依赖及 bundle 列表的 profile 清单，把每个 bundle 和插件列为已携带、待安装、已添加或未携带，并对只读取一次的文本运行 [`@delorun/profile-safety`](../profile-safety/README.zh.md) 的携带检查。
- `parseRegistry` 和 `mergeRegistries`（[`workspaces.ts`](src/dsh-import/workspaces.ts)）用上游自己的记录 schema 读取其工作区单元，并在不覆盖任何记录的前提下合并两个列表。凭据由上游的解析器（[`credentials.ts`](src/dsh-import/credentials.ts)）读取，它只提供 DeepSeek 密钥；值绝不会被返回或打印。
- `applyDshHomeImport`（[`apply.ts`](src/dsh-import/apply.ts)）按本人选取的类别执行计划：它把每个文件暂存并同步到 `archive/stock-import/staging-<id>/` 下，再次核对每个文档的摘要，写入并同步一份记录它将放置的每个目录和文件的日志，用一次在路径已存在时失败的硬链接放置每个新文件，对于被追加内容的文档，先把原文件链接到一旁，再以一次重命名替换，最后移除日志以完成。失败时它撤回已放置的内容并还原被替换的内容，但保留放置后字节已改变的文件；`recoverDshImport` 对崩溃的导入做同样的处理，拒绝其暂存目录已不存在的日志，并移除每个暂存根目录，`recoverStockImport` 是启动路径应在 profile 启动前调用的形式。`readDshImportRecord` 返回已完成的导入所携带的内容。

<a id="tests"></a>

## 测试

在仓库根目录运行 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/archive`，会运行这些规格：解压拒绝、大小上限、暂存目录、签名者同意、预览、中途失败、定制化 schema、导出往返、home 密钥，以及 C8 针对控制字符、惰性读取、更低限额、恢复和被链接目录的拒绝测试。`dsh-import` 规格覆盖 stock home 导入：它携带和留下的内容，对链接、管道、挂载点、被替换的目录、硬链接、名称、大小和冲突的拒绝，每一类被留下的行，作为数据的 profile，以及在任何放置步骤发生失败或崩溃后日志的撤回。
