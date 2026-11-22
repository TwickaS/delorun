# Terminology

本表约定本仓库的中英术语统一译法。

**通用规则：**
- "中文"列为中文译文的正文默认用词。若该列为英文，则中文译文的正文中保留英文不翻译。
- 首次出现按"首次出现"列书写（带括号注释）；后续出现只写括号前的部分（可能为中文，也可能为英文），不出现括号内的注释。
- "不要译作"列为严格禁止的译法。
- 如果某术语已经作为另一个术语的组成部分被括注过（如 `agent loop（智能体循环）` 中已包含 `agent` 的括注），则该术语后续单独出现时无需再次括注。

## 缩写类（中英文文本中均使用缩写）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| ACP | ACP | ACP（Agent Client Protocol） | | |
| AI | AI | AI（人工智能） | | |
| API | API | | | |
| CI | CI | | | |
| CLI | CLI | CLI（命令行界面） | | |
| e2e | e2e | | | |
| HMR | HMR | HMR（热模块替换） | | |
| JSON Schema | JSON Schema | | | |
| JSONL | JSONL | | | |
| LLM | LLM | LLM（大语言模型） | | |
| MCP | MCP | | | |
| PR | PR | PR（Pull Request） | | |
| RAG | RAG | RAG（检索增强生成） | | |
| SDK | SDK | | | 只指受支持的 Python 与 TypeScript SDK 所使用的 JSON-RPC 客户端／服务器协议；DeepSeek Harness 项目本身不是 SDK |
| SSE | SSE | SSE（Server-Sent Events） | | |

## 英文类（中英文文本中均使用英文）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| agent | agent | agent（智能体） | | |
| Agent Note | Agent Note | | 智能体注记、智能体笔记 | 仓库定义的文档类型，涵盖提案、已实现决策和被否决提案；中文对侧 H1 保持固定前缀 `# Agent Note: `，标题中不加术语括注 |
| agent harness | agent harness | agent harness（智能体框架） | | agent 组合词（agent harness/workflow/loop/skill 等）整体保留英文；未括注过 agent 时首现按对应组合词或 agent 行处理 |
| agent loop | agent loop | agent loop（智能体循环） | | |
| blob hash | blob hash | | | `git hash-object` 的结果 |
| coding agent | coding agent | coding agent（编程智能体） | | agent 组合词，正文保留英文 |
| Cordis | Cordis | | | |
| dispose | dispose | dispose（资源释放） | | |
| doc-sync | doc-sync | doc-sync（文档同步门禁） | | |
| fiber | fiber | | | |
| fixture | fixture | fixture（测试前置数据） | | |
| fork | fork | | | |
| Function Calling | Function Calling | Function Calling（函数调用） | | |
| harness | harness | | | |
| harness engineering | harness engineering | | | |
| KV Cache | KV Cache | | | 专有技术名称，保持大小写与空格 |
| lint | lint | | | |
| mock | mock | | | 保留英文；指测试替身 |
| loader | loader | | | |
| manifest | manifest | manifest（元数据清单） | | |
| monorepo | monorepo | | | |
| Round | Round | | 回合、目标回合、Ralph 回合 | 外层策略使用 Round 时，领域层级为 Session > Round > Turn（轮次） > Step（步骤）；Round 是可选的外层策略迭代，并非每个会话轮次都具有的通用层级。Goal Round 与 Ralph Round 均保留英文。一个 Round 承载一个轮次，步骤隶属于该轮次；明确的零步骤轮次仍保持原义。 |
| schema | schema | | | |
| schema DSL | schema DSL | | | |
| seam | seam | | 接缝 | 一个可替换能力的整体，包含 Service Definition / Service Provider / Consumer 三种角色；角色需要独立演化时才拆包，也可由同一包承担多个角色。以 `packages/shell` 为范例；Service Definition 是 Cordis `Service`（抽象类或具体 registry 服务），不是 TypeScript interface。任何单一角色、普通边界或扩展点都不能称为 seam。本仓库正文保留英文；与 `extension point` 是不同概念 |
| Service Provider | Service Provider | | Service provider | 能力 seam 的命名角色；单数固定写作 Service Provider，复数写作 Service Providers。泛指提供服务的 provider 不适用本词条 |
| skill | skill | skill（技能） | | |
| slot | slot | | 坑位、孔位 | 客户端架构中的具名可注册位置，保留英文 |
| spill | spill | | | 工具输出超限落盘机制；组合词写 `spill 文件`、`spill 路径` |
| spawn | spawn | | | |
| steering | steering | steering（中途引导） | | |
| job id | job id | | 任务 id | 保留英文 |
| subagent | subagent | | | 文档正文保留英文；中文 UI 中译作「子智能体」，不使用「子代理」 |
| transcript | transcript | transcript（文本记录） | | 指会话渲染给用户或编辑器的完整文本，区别于事件日志 |
| Typert | Typert | | TypeRT、typeRT、Type RT | DeepSeek Harness 类型图、生成器、loader 与运行时 registry 的产品拼写 |
| waterfall | waterfall | waterfall（瀑布式事件） | | |
| wheel | wheel 包 | | | Python 打包格式 |
| worktree | worktree | | | git 工作区概念 |
| Zstandard | Zstandard | | | RFC 8878 compression format; `zstd` remains a code value. |

## 双语类（中英文文本各自使用中英文）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| adapter | 适配器 | | | |
| adapter contract | 适配器约定 | 适配器约定（adapter contract） | | |
| append-only | 仅追加 | | | |
| artifact | 产物 | | 制品 | |
| backend | 后端 | | | |
| binder | 绑定器 | | | 命名角色：把已声明接口绑定到调用方 context 或生命周期 |
| config | 配置 | | | 命名角色：一个已解析配置值或边界严格的配置记录 |
| controller | 控制器 | | | 命名角色：接受意图并改变一项既有领域或展示状态 |
| directory | 目录 | | | 命名角色：暴露供发现或选择的条目及元数据 |
| engine | 引擎 | | | 命名角色：实现领域算法或有状态执行模型 |
| gateway | 网关 | | | 命名角色：适配进程、网络、RPC 或 API 边界 |
| handle | 句柄 | | | 命名角色：引用并控制或观察一个实时资源 |
| policy | 策略 | | | 命名角色：决定允许、选择、限制或观察什么 |
| presenter | 展示转换器 | | | 命名角色：把领域值纯转换为渲染意图 |
| resolver | 解析器 | | | 命名角色：根据输入计算或定位一个答案 |
| store | 存储 | | | 命名角色：拥有一组数据并主要提供数据操作 |
| background job | 后台任务 | | | |
| block | 块 | | | |
| build target | 构建目标 | | | |
| cancel | 取消 | | | |
| canary test | canary 测试 | | 金丝雀测试 | 本仓库保留 `canary` |
| capability | 能力 | | | 必须与 `feature` → `功能` 区分 |
| capability seam | 能力 seam | | 功能 seam、能力接缝 | 本仓库 Service Definition、Service Provider 与 Consumer 三种角色组成完整可替换能力的命名架构概念；普通 `seam` 仍按其词条处理 |
| feature | 功能 | | 能力 | SDK 产品与工程模型中的可管理产品单元 |
| feature option | 功能选项 | | variant | 一项 SDK 功能内有限、可选择的实现或配置 |
| checkpoint | 检查点 | | | |
| chunk | 分片 | | | |
| compaction | 压缩 | 压缩（compaction） | | |
| companion tool | 配套工具 | | | |
| composition bundle | 组合包 | | | 只约束应用或插件的组合语境，不约束所有 `bundle` |
| Cordis plugin config | Cordis 插件配置 | | | Cordis 插件公开的 `Config` 对象或配置结构 |
| config key | 配置键 | | | Cordis 插件配置中的单个字段 |
| consumer | 消费方 | | 消费者 | |
| content block | 内容块 | | | |
| Cookbook | 实操手册 | | | 文档标题用语 |
| context | 上下文 | | | |
| counterpart | 对侧文件 | | 对应物、配对物 | 双语配对语境；泛指"另一侧"时可写「另一侧」 |
| configurable-provider directory | 可配置提供方目录 | | | llm seam 中 `registerConfigurableProviders()` 维护的目录；沿用 Service Catalog →「服务目录」先例 |
| context compaction | 上下文压缩 | 上下文压缩（context compaction） | | |
| contract | 约定 | | | 如：`pairing contract` →`配对约定` |
| Cordis config entry | Cordis 配置项 | | | 指 `cordis.yml` 插件列表中的一项；插件实现本身写`Cordis 插件` |
| Cordis plugin | Cordis 插件 | | | Cordis 加载的插件实现，不指 `cordis.yml` 中的一项配置 |
| crash recovery | 崩溃恢复 | | | |
| deploy root | 部署根目录 | | | |
| dormant | 休眠 | | 睡眠、蛰伏 | 指已声明可配置但当前未注册路由的提供方 |
| durability | 持久性 | | | |
| feature requirement | 功能依赖 | | | 功能或功能选项通过 `requires` 声明的关系 |
| event | 事件 | | | |
| event log | 事件日志 | | | |
| event stream | 事件流 | | | |
| event-sourced | 事件溯源 | | | 沿用 DDD 社区通行译法 |
| exchange | 交互段 | | 回合、交换 | Chat 中从真人输入开启的轮次起、到下一个这样的轮次为止的连续轮次；见术语表 |
| Executive summary | 摘要 | | | 事故复盘标题用语 |
| executor | 执行器 | | | |
| expected output | 预期输出 | | 金标 | 指 snapshot 比较产物；翻译语料的人工校准样例不在此列 |
| extension | 扩展 | | | |
| extension point | 扩展点 | | | 注意与 `seam` 区分 |
| fail-fast | 快速失败 | | | |
| fenced code block | 围栏代码块 | | | 沿用 MDN 中文翻译 |
| fingerprint | 指纹 | | | 通用内容指纹；双语配对机制使用 sidecar record 按分节记录两侧 hash |
| finish reason | 结束原因 | | | |
| fold | 折叠区 | | | 配置界面语境：默认收起的字段分区（collapsed →「收起」）|
| foreground run | 前台运行 | | | |
| freshness | 新鲜度 | | | 沿用 MDN 中文翻译；在本项目中指译文相对源文的同步状态 |
| hook | 钩子 | | | |
| implementation | 实现 | | | |
| inference | 推理 | 推理（inference） | | 需要和 `reasoning` 区分时保留英文括注 |
| info string | 信息字符串 | | | 沿用 CommonMark 中文翻译；指代码围栏 ``` 之后的语言标注 |
| injection | 注入 | | | |
| integration | 集成 | | | |
| interface | 接口 | | | |
| language switcher | 语言切换行 | | | i18n 配对机制用语：双语配对文件顶部的互链行 |
| merge | 合并 | | | |
| message | 消息 | | | |
| mod | 模组 | | | |
| model provider | 模型提供商 | | | 指为模型提供 API 的厂商或网关：模型设置页文案、用户指南 providers 与 `ui-settings-models` README 用「提供商」；llm seam 的开发者文档（可配置提供方目录、dormant 等）沿用「提供方」 |
| model selection | 模型选择 | | 模型目标 | 面向 Agent 的提供方、模型和可选推理强度选择。 |
| module | 模块 | | | |
| non-escalation | 非升权 | | 非升级、不可升级 | 仅用于安全与权限语境，指主体不得获得超出既有授权的权限；普通升级不适用此行 |
| npm dependency | NPM 依赖 | | | `package.json` 中的包关系；`dependencies`、`devDependencies` 等字段保持原样 |
| opt-in | 选择加入项 | 选择加入项（opt-in） | | 本人主动打开后才生效的数据共享项，例如桌面端分析与 DeepSeek 会话日志上传 |
| opt-out ratio | opt-out 比例 | | 退出检查比例 | |
| orphan | 遗留 | | 孤儿、孤立 | 指英文源已不存在的 `.zh.md`（如「遗留译文」）；进程语境按 OS 惯用语译「孤儿进程」 |
| orphan branch | 孤立分支 | | 孤儿分支 | 沿用 git 官方中文翻译 |
| OTLP collector | OTLP 收集器 | OTLP 收集器（OTLP collector） | | 接收 OpenTelemetry（OTLP）日志的服务端；OTLP 保留英文 |
| package | 包 | | | 指 npm 包（`@deepseek-ai/dsh-*`）；`package.json` 等代码标识保持原样 |
| pairing | 配对 | | | |
| parent-subset grants | 父级子集授权 | | 父集合授权 | 指授权范围仅限于父级所持授权的子集 |
| peer dependency | 对等依赖 | 对等依赖（peer dependency） | | |
| permission | 权限 | | | |
| persistence | 持久化 | | | |
| pipeline | 流水线 | | | |
| plugin | 插件 | | | |
| postmortem | 事故复盘 | 事故复盘（postmortem） | 事后分析、事故记录 | 事故记录与分析文档；目录或路径中的 `postmortem` 保持代码形式 |
| prompt | 提示词 | | | |
| provider | 提供方 | | | 泛指的提供方（搜索、检查、settings 文件、subagent 等）；模型厂商或网关见 model provider 行 |
| provider-neutral | 提供方无关 | | 提供方中立 | |
| quality gate | 质量门禁 | | | |
| quiescence | 完全停稳 | | 静默、静止状态 | 指生命周期工作全部结算后的状态 |
| reasoning | 推理 | 推理（reasoning） | | 需要和 `inference` 区分时保留英文括注 |
| reasoning_content | 思考内容 | | | |
| registry | 注册表 | | | |
| replay | 回放 | | | |
| resume | 恢复 | | | |
| runtime | 运行时 | | | |
| same-world subprocess | 与宿主共享文件系统和内核的子进程 | | 同世界子进程 | |
| sandbox | 沙箱 | | | |
| service | 服务 | | | |
| serving interface | 对外服务接口 | | | |
| session | 会话 | | | |
| session event | 会话事件 | | | |
| setup card | 设置卡片 | | | 首次运行时代替行卡直接展开的配置卡 |
| sidecar file | 伴随文件 | | | 指与文档同目录的普通伴随文件 |
| sidecar record | 伴随记录 | | 旁挂记录 | 指与文档同目录的伴随记录文件 |
| smoke test | 冒烟测试 | | | |
| snapshot | 快照 | | | |
| source of truth | 真源 | | 事实来源、唯一来源 | |
| spine | 主干 | | | |
| stale | 陈旧 | | 过期 | 与 `fresh`（`新鲜`）成对；门禁输出中保留英文 `stale` 不翻译；`expired` 才译为`过期` |
| step | 步骤 | | | |
| stream | 流 | | | |
| structural signature | 结构签名 | | | i18n 配对机制用语：门禁比对两侧文件时提取的有序结构序列（标题层级、代码块、列表等） |
| Summary | 概述 | | | 事故复盘标题用语 |
| system prompt | 系统提示词 | | | |
| taxonomy | 分类体系 | | | |
| token usage | token 用量 | | | |
| tool | 工具 | | | |
| tool call | 工具调用 | | | |
| tool result | 工具结果 | | | |
| tool schema | 工具 schema | | | |
| toolkit | 工具包 | | | |
| turn | 轮次 | | | |
| VFS | VFS | 虚拟文件系统（VFS） | | |
| typecheck | 类型检查 | | | |
| vocabulary | 词汇 | | | |
| wire format | 协议格式 | 协议格式（wire format） | | |
| workflow | 工作流 | | | |
| wrapper | 包装层 | | | 软件层或 SDK 包装层 |
| wrapper script | 包装脚本 | | | 可执行脚本包装层 |

## Delorun 术语（Delorun 专有名词）

以下译法由 Delorun 文档与界面文本使用，适用于 `delorun/` 之下的文档与其他 Delorun 制品；上游术语仍以上文各表为准。Delorun 术语没有上游先例，译法由 Delorun 维护者确定。

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| the person | 本人 | 本人（the person） | user、用户 | 维护者文档用 "the person"，界面文本用「你」；"user" 是上游模型对话中的用户角色 |
| augmentation | 增强功能 | 增强功能（augmentation） | 扩展功能 | 超出 stock 工作流、由本人选择开启的附加功能 |
| studio additions | studio 附加功能 | | | Delorun 的主题、侧边栏、对话状态等附加功能，默认开启 |
| main chat | 主对话 | 主对话（main chat） | 主 chat 区域 | 所有工作区之外的一个 chat，本人在其中询问、引导其他 chat，并在某个工作区开始工作 |
| owner note | 所有者备注 | 所有者备注（owner note） | | 主对话应本人要求写在工作区 `AGENTS.md` 末尾的带日期备注 |
| guard | 守卫 | 守卫（guard） | | 主对话在调用非只读工具前向本人询问的机制 |
| Your chats | 你的对话 | | | 界面标签：主对话旁列出等待本人或正在工作的 chat 的标签页 |
| preset | preset | | | 保留英文；agent preset，chat 运行所用的模式；上游部分中文文档写作「预设」 |
| stock | stock | | 原版 | 保留英文；指上游按原样发布的 DeepSeek Harness |
| stock look | stock 外观 | | | 关闭 studio 附加功能后的 Delorun 外观 |
| studio | studio | | | 保留英文；Delorun 的网页界面 |
| home | home | | 主目录、cell、instance、VM、sandbox、hub | 保留英文；唯一保存本人 studio、harness 配置、机器列表与 chat 历史的位置 |
| chat | chat | | | 保留英文；绑定到单台机器的对话，对应上游的 session |
| machine | 机器 | 机器（machine） | | 运行 chat 的计算机 |
| target | 目标设备 | 目标设备（target） | 目标 | 不运行 Delorun、由 agent 通过工具访问的设备 |
| native | 原生 | 原生（native） | | 运行时的一种形态 |
| layer | 层 | 层（layer） | 层级 | 组合包、profile patch、home patch 或 overlay 之一 |
| tier | 层级 | 层级（tier） | | 具有单一职责的一类文档 |
| runtime closure | 运行时发行包 | 运行时发行包（runtime closure） | 运行时闭包 | 一次已签名的 `delorun` 发布 |
| runtime store | 运行时仓库 | 运行时仓库（runtime store） | | 运行时发行包的安装集合 |
| Docker supervisor | Docker 监管器 | Docker 监管器（Docker supervisor） | | 唯一调用 Docker 的 Delorun 组件 |
| home process | home 进程 | home 进程（home process） | | 持有 CLI profile 锁并运行 Host 的后台进程 |
| update channel | 更新通道 | | | `delorun update` 与 studio「Update now」使用的套接字 |
| handover | 交接 | 交接（handover） | | home 进程把 profile 移交给新运行时上的后继进程 |
| successor | 后继进程 | 后继进程（successor） | | 交接中在目标版本上启动、处于 `standby` 的 home 进程 |
| predecessor | 前任进程 | 前任进程（predecessor） | | 交接中正在运行、把锁移交出去的 home 进程 |
| confinement | 隔离 | 隔离（confinement） | 限制、禁锢 | 沙箱对受限命令可读、可写、可连接范围的约束 |
| dialect | 方言 | 方言（dialect） | | 沙箱的一种实现，如 bwrap、Landlock、Seatbelt |
| drain | 排空 | 排空（drain） | | 等待运行中的 chat 结束，期间拒绝新的轮次 |
| reach | 远程访问 | 远程访问（reach） | | 从另一台设备或网络打开 studio |
| reach option | 远程访问方式 | | | 远程访问的一种途径 |
| Tailscale reach | Tailscale 远程访问 | | | 通过 tailnet 的远程访问 |
| Delorun relay | Delorun 中继 | Delorun 中继（Delorun relay） | 隧道 | Delorun 的中继 |
| relay control | 中继控制面 | | | 中继的 Cloudflare Workers 部分 |
| relay data plane | 中继数据面 | | | 转发加密字节的无状态直通服务器 |
| self-hosted relay | 自托管中继 | | | 由本人运行的同一中继数据面 |
| studio address | studio 地址 | | | 能够访问 home 的 studio 的地址 |
| gate | 门控 | 门控（gate） | 网关、闸门 | 附加监听器在任何路由、upgrade 处理器或回退之前裁决每个请求的函数 |
| pre-login | 登录前 | | 预登录 | 远程访问监听器在登录之前即可处理的请求、路由或允许列表 |
| end-to-end encrypted reach | 端到端加密远程访问 | 端到端加密远程访问（end-to-end encrypted reach） | 零信任（指 Delorun 中继） | TLS 在本人的 home 上终止的远程访问 |
| certificate alert | 证书告警 | | | 公开证书日志显示未申请证书时的阻断性警告 |
| owner code | 所有者验证码 | 所有者验证码（owner code） | | home 为第一台设备认领而打印的一次性代码 |
| trusted device | 受信任设备 | 受信任设备（trusted device） | | 已由 home 批准、绑定到某个 studio 地址的设备 |
| device approval | 设备批准 | 设备批准（device approval） | | 由受信任设备在实时会话中批准新设备 |
| identity factor | 身份因子 | 身份因子（identity factor） | | 远程访问中证明本人身份的登录方式 |
| passkey | 通行密钥 | | | 身份因子的一种形式 |
| recovery kit | 恢复套件 | 恢复套件（recovery kit） | | 恢复审批权限的已保存密钥 |
| profile | profile | | | 保留英文，与 `docs/architecture.zh.md` 一致 |
| profile history | profile 历史 | profile 历史（profile history） | | profile 的每个已保存版本 |
| undo | 撤销 | | | 恢复到最近一次之前的 profile 版本 |
| safe mode | 安全模式 | | | 启动时保留附加内容但不加载 |
| eject | eject | | | 保留英文；将插件源码复制为可编辑替代 |
| source mode | 源码模式 | | | 从 git 检出版本运行 Delorun |
| update report | 更新报告 | | | 更新应用前显示的变更与破坏性影响 |
| trash | 回收站 | | | 已删除的 chat 与工作区的等待区 |
| export file | 导出文件 | | | 工作区、chat 与定制内容的导出 |
| verification status | 验证状态 | | | `delorun verify` 的检查结果 |
| fetch guard | 抓取防护 | | | 拒绝回环、链路本地与私有网络目标的插件 |
| instruction-layer file | 指令层文件 | | | skill、预设或 `AGENTS.md` 等会加载为指令的文本 |
| operational log | 运行日志 | | | 进程运行记录，经轮转且不含密钥 |
| session and turn keys | 会话与轮次键 | | | 运行日志记录携带的上游会话与轮次 id |
| activity history | 活动历史 | | | 基于会话日志的只读视图 |
| system-stats panel | 系统状态面板 | | | 每台机器的实时资源占用 |
| catalogue | 插件索引 | | 目录 | Discover 列出的公开插件索引；「目录」保留给 directory |
| compatibility badge | 兼容徽章 | | | 「tested with Delorun X」 |
| revocation list | 撤销列表 | | | 已签名的被停用插件版本列表 |
| listed findings | 列出的发现 | | 审计结果 | 目录条目列出的、作者或评审者的主张 |
| plugin security review | 插件安全审查 | | | 安装前可选运行的 agent 预设 |
| waitlist | 候补名单 | | | delorun.com 上的报名 |
| documentation website | 文档网站 | | | `docs.delorun.com` |
| divergence ledger | 差异台账 | | | `delorun/upstream-patches.json` |
| divergence record | 差异记录 | | | 对某个上游插件的重大修改及合并方式 |
| divergence budget | 差异预算 | | | 一次发布可新增的台账条目与差异块上限 |
| parity checklist | 对等清单 | | | 每项 stock 功能及其证据 |
| parity composition | 对等组合 | | | 关闭 studio 组合包与 Delorun 模型可见修改的运行时 |
| parity replay | 对等回放 | | | 上游场景在对等组合上的原样运行 |
| extension-point-first rule | 扩展点优先规则 | | | Delorun 行为位于 `delorun/` 之下，上游的修改只增加扩展点 |
| rehearsal merge | 预演合并 | | | 发布前对上游最新标签的试验性合并 |
| work package | 工作包 | | | 具有拥有路径与验收证据的并行工作单元 |
| denial test | 拒绝测试 | | | 证明禁止操作会失败的测试 |
| check runner | 检查运行器 | 检查运行器（check runner） | | Delorun 运行改动所涉及检查的命令（`pnpm check`） |
| changelog fragment | changelog fragment | | | 保留英文；位于 `delorun/changelog/unreleased/` 下，每项可察觉改动一个文件 |
| brief | brief | | | 保留英文；由维护者创建、加 `brief` 标签并锁定的 agent 工作 issue |
| SBOM | SBOM | SBOM（软件物料清单） | | 保留英文；发布中组件的机器可读清单 |
| upstream standard | 上游标准 | | | 上游的 AGENTS、文档标准与门禁规则，Delorun 就地改写后适用于 Delorun |
| architecture notes | 架构说明 | | | `delorun/docs/architecture/` |
| consistency record | 一致性记录 | | | `<page>.i18n.yaml`，按小节保存两侧哈希 |
| zero-trust | 零信任 | | | 只在「应避免的用词」中出现，不用于描述 Delorun 中继 |
| nation of geniuses | 一个天才之国 | | | 「Delorun 的目标」一句中的说法，以「」标出 |
| start token | 启动令牌 | 启动令牌（start token） |  | home 进程每次启动写入的随机令牌 |
| capability report | 能力报告 | 能力报告（capability report） |  | `report()` 返回的限制状态陈述 |
| read exemption | 读取豁免 | 读取豁免（read exemption） |  | 受限命令可读取的目录 |
| launch protocol | 启动协议 | 启动协议（launch protocol） |  | 运行时入口、参数与环境变量的编号 |
| egress proxy | 出站代理 | 出站代理（egress proxy） |  | 工作区唯一的对外路由：原生工作区网络为 allowlist 时的代理，或 Docker 工作区的代理 |
| workspace network | 工作区网络 | 工作区网络（workspace network） |  | 原生工作区为沙箱中命令与 web_fetch 设定的网络：open、allowlist 或 off |
| egress allowlist | 出站允许列表 | 出站允许列表（egress allowlist） |  | Docker 工作区的默认出站模式 |
| container denial marker | 容器拒绝标记 | 容器拒绝标记（container denial marker） |  | 环境拒绝文件访问时的结果行 |
| S2 helper channel | S2 辅助通道 | S2 辅助通道（S2 helper channel） |  | S2 工作区容器内的 SSH 辅助程序 |
| supervisor roots | 监管器根目录 | 监管器根目录（supervisor roots） |  | Docker 监管器可创建工作区根目录的父目录 |
| update journal | 更新日志 | 更新日志（update journal） |  | `run/<profile>/update.json` |
| owner claim | 所有者认领 | 所有者认领（owner claim） |  | 首台设备对无所有者 home 的认领 |
| tunnel token | 隧道令牌 | 隧道令牌（tunnel token） |  | 中继协议中授权一次隧道尝试的令牌 |
| release manifest | 发布 manifest | 发布 manifest（release manifest） |  | 已签名的发布描述文件 |
| root metadata | 根元数据 | 根元数据（root metadata） |  | 列出密钥、阈值与轮换的已签名文件 |
| key roles | 密钥角色 | 密钥角色（key roles） |  | root、targets、timestamp 与 catalogue 四个签名角色 |
| release log | 发布日志 | 发布日志（release log） |  | Sigstore 公开 Rekor 日志中的发布条目 |
| witness | 见证者 | 见证者（witness） |  | 发布日志检查点的共同签名方 |
| advisory acceptance | 安全公告接受记录 | 安全公告接受记录（advisory acceptance） |  | 依赖安全公告检查的评审条目 |
