# @delorun/plugin-instruction-consent

指令层同意：接缝背后的服务，防止模型的文件工具在没有批准的情况下改写本人的指令层文件（skill、预设和工作区的 `AGENTS.md`）；批准会说明其效果并展示差异。只有上游的文件工具（`write`、`edit`、`apply_patch` 和 `str_replace_editor`）会通过文件系统的写入、编辑和删除意图咨询它：沙箱允许写入工作区的 shell 命令或 PTC 脚本，不经询问就能更改 `AGENTS.md` 或项目 skill。`@delorun/bundle-local` 在 `delorun` 启动的 CLI profile 中开启并挂载它；`delorun headless` 和桌面应用运行不挂载它的上游 profile。


[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。
## 提供什么

- `writeConsent`：写入工具在模型撰写的文件提交前咨询它。目标被归类为指令层文件的写入需要一次批准，批准文本说明这些指令会在该范围的每个未来 chat 中加载，并附上差异，同时带有 `grants: "workspace-management"`，使 Host 可以只在自己的电脑上保留授予它的答复（`@delorun/home-auth` 拒绝来自远程访问设备的答复）；拒绝则文件保持不变。

会话模式接缝的 `sandboxModeGuard` 不由本插件提供：该接缝只有一个提供方，即 [`@delorun/plugin-permission-defaults`](../plugin-permission-defaults/README.zh.md) 的完全访问同意。一个不拒绝任何切换的守卫证明不了接缝自身规格尚未证明的任何事情。

该服务不理会权限预设：同意适用于每个预设，包括完全访问。本人在 studio 自己的编辑器中做的写入不会触发新的询问：接缝只看到模型文件工具的写入。

该同意是对文件工具写入的提示，而不是针对拥有 shell 的模型的边界。它审查 `fs/write-intent`、`fs/edit-intent` 和 `fs/delete-intent` waterfall 所携带的每一次写入，这些由 `write`、`edit` 和 `apply_patch` 发出；当 `@deepseek-ai/dsh-tool-fs` 挂载在它旁边时，`str_replace_editor` 也会发出，因为该包在这些意图上注册了门控。写入指令文件的 shell 命令不经过这类意图，也就没有审查。

## 分类

下面提到的每个目标和每个根，都解析为其最近的已存在祖先的真实路径加上缺失的尾部，这就是 `@deepseek-ai/dsh-fs-local` 所写入的路径；最后一个名称是符号链接的目标，还会解析为该链接自身的位置。当目标的某个已存在祖先与根的已存在部分按设备和 inode 相同，且从那里往下到目标的各个名称以根的缺失尾部开头时，目标匹配该根。标识涵盖任一侧的符号链接、已存在名称的字母大小写和 Unicode 规范化、短名称以及硬链接；文本只比较缺失的尾部和下面的名称规则。不是绝对路径的路径（远程后端可能这样报告）只适用名称规则，按其书写形式比较。

当容纳目标或根的第一个缺失名称的已存在目录位于不区分大小写的卷上时，文本会折叠字母大小写。探测取该目录中名称含有 ASCII 字母的第一个条目，并检查其大小写翻转后的写法是否指向同一个 inode；没有这样的条目的目录按不区分大小写计。每个同意实例按目录记住答案；平台不做任何决定。

根来自读取它们的代码，每次审查都重新读取。目标按它遇到的第一条规则分类：

1. skill：位于 harness home 或共享 agent 根目录的 `skills` 之下的路径（`@deepseek-ai/dsh-skill-filesystem` 的 `HOME_SKILL_DIR`），位于任何 `.dsh/skills` 或 `.agents/skills` 目录之下的路径（`PROJECT_SKILL_DIRS`），或位于已挂载的 skill 提供方通过 `ctx.skills.configuredRoots()` 报告的根之下的路径，该方法保存自定义根和随附根。
2. 预设：profile 启动器为 `ctx.profileContext` 读取的组合文件，顺序为 `readProfilePatches` 所应用的顺序：每个被选中的组合包所声明的补丁文件（来自 `loadProfileDirectory`）、profile 的 `cordis.patch.yml`，以及 home 的 `cordis.patch.yml`。没有 `ctx.profileContext` 时，没有任何文件被归类为预设。
3. home 指令：直接位于 harness home 或共享 agent 根目录中、名称在 `@deepseek-ai/dsh-agent-instructions` 的 `DEFAULT_INSTRUCTION_FILE_NAMES` 中的文件，或这样的路径所解析到的文件。
4. 文件夹的指令：具有这些名称之一的任何其他文件。

各个 home 在审查运行时从 `DSH_HOME` 和 `DSH_AGENTS_HOME` 解析，同时也按同意挂载时（即工作区指令加载器解析它自己的 home 的时刻）它们解析出的样子解析；配置了其他 home 的 skill 提供方行，通过 `configuredRoots()` 报告它们的 skill 存储。目标或根因不存在以外的原因（例如链接循环或搜索权限被拒绝）而无法解析时，审查会抛出错误，接缝拒绝该写入。

审查在运行时读取文件系统，所以在审查与写入之间创建或替换的链接不会被看到。接缝不携带工作区，所以直接写向项目已链接的 `.agents/skills` 所指目录、写向文件夹已链接的 `AGENTS.md` 所指文件，或写向文件夹 `AGENTS.md` 的硬链接的写入，都不会被归类。部署通过 `instructionFileCandidates` 添加的指令文件名，以及 `--patch` 叠加层文件，同样不会被归类。写入文件的 shell 命令在本审查之外。

## 向已批准插件的文件夹写入

在 `approvedPluginWrites` 开启且「变更」的保护开启时，插件还会在 agent 于 chat 中首次写入本人在「变更」下批准过的插件的 `source` 文件夹之前询问（[C21](../../docs/contracts/c21-changes.zh.md#the-agent-and-plugins)）；保护关闭（默认）时，这样的写入不询问，因为该文件夹的内容本来就无需审阅即加载。在两种保护设置下，对写入 profile 在 Delorun home 之下的活动目录（只有「变更」会写入那里），它都不经询问直接拒绝。询问的文字是「The agent is changing what your harness runs: <plugin>. The change will wait for your review in Changes.」，有英文和中文，并带有工具携带的差异。[`src/plugin-folders.ts`](src/plugin-folders.ts) 在每次写入时，从 Host 所运行的 profile（`ctx.profileContext`）读取保护设置（home 的 `readProtection`）和批准记录，所以 `delorun changes protection on|off` 在下一次写入时生效而无需重启；没有该记录的 profile 没有插件文件夹；无法读取的保护记录或批准记录会拒绝该写入。写入是在文件后端写入的路径上比较的，即目标的 `targetKey`（上游本地后端的真实路径），对照以同样方式计算的文件夹真实路径；当该路径或其词法路径位于文件夹处或其下方（在对文件夹自己的路径以另一种大小写探测后发现是同一目录的地方忽略大小写），或目标的某个已存在祖先就是该文件夹的目录时，目标在文件夹之内，所以符号链接、链接之后的 `..` 和大小写变体同样会询问。监听器位于每个写入者针对每个目标发出的三个文件系统意图上，像 `writeConsent` 门控那样被前置，所以 shell 命令向插件文件夹的写入不会被询问。本人允许之后，同一个 chat 中此后对该插件文件夹的写入直接通过，直到 Host 重启；另一个 chat 会再次询问，而拒绝会让文件保持不变，并给出类型化的 `FS_CONSENT_DENIED` 拒绝。

## 配置

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `false` | Delorun 的 C16 开关 `instruction_layer_consent`，在对等组合中关闭；开启时，同意门控指令层写入。 |
| `approvedPluginWrites` | `false` | Delorun 的 C16 开关 `approved_plugin_write_consent`，在对等组合中关闭；开启且保护开启时，agent 在 chat 中首次写入已批准插件的文件夹会询问，并且在两种保护设置下，向活动目录的写入都会被拒绝。 |

## 测试

`tests/consent.spec.ts` 覆盖分类规则、带差异的审查备注、询问流程、解析失败和开关。`tests/denial.spec.ts` 覆盖通过符号链接、写向硬链接、以另一种字母大小写、以及写入环境变化之前解析出的 home，每一种都会询问，并覆盖对临时目录所在卷的大小写敏感性探测。`tests/loader-roots.spec.ts` 在一个测试夹具上运行指令加载器的发现、文件系统 skill 提供方和 profile 启动器，并要求同意对它们读取的每个文件都询问。`tests/plugin-folders.spec.ts` 在本地文件系统上运行上游的 `write` 工具：向已批准插件的文件夹的第一次写入会询问，而同一 chat 中的第二次不会，另一个 chat 会再次询问，符号链接、链接之后的 `..`、相对路径和大小写变体会询问，向活动目录的写入被拒绝，经过悬空链接的写入不询问任何内容而由上游拒绝，拒绝会让文件保持未写入，无法读取的记录会拒绝；保护关闭时，没有任何询问，活动目录仍被拒绝，在同一插件实例的两次写入之间切换该记录无需重启即切换行为，无法读取的保护记录会拒绝；开关关闭时，没有任何询问。
