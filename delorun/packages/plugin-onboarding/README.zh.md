---
description: "Delorun studio 中的首次运行引导，供第一次使用 studio 的本人，以及添加步骤、声明插件的连接或修改终端设置记录所忽略内容的维护者阅读。"
kind: "package-library"
---

# @delorun/plugin-onboarding

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

studio 的第一分钟是一个以 chat 收尾的对话框。「Welcome」设置语言并显示预览版提示。「Models」连接模型提供方：勾选的卡片、逐个走完每个已勾选的提供方，以及一份摘要。「Look」在一个以该外观呈现的小 chat 旁设置配色方案、主题和强调色。「Agents」提供 Claude Code 和 Codex 及其在这台电脑上的登录状态，并请本人确认添加其中一个意味着什么。「Recommended plugins」提供已配置的插件，与本人的连接相符的排在前面。「Phone access」在远程访问关闭期间，显示 Tailscale 距离能提供 studio 服务还差多少。「Workspace」选择默认工作区，或打开新建工作区对话框，该对话框可添加这台电脑上的文件夹、新建文件夹，或从 Git 克隆仓库。「Ready」列出引导设置的内容并打开第一个 chat；「Ready」本身提供三个值得一试的想法，每个都带一个「Copy」按钮。每一步都位于同一个框架中：步骤名称和「Step n of N」连同进度条位于顶部，其中 N 只统计该本人会看到的步骤（手机上以及设置完成后会省略「Phone access」，终端设置已涵盖的步骤也会省略），正文可滚动，「Skip」「Back」和「Continue」位于底部，在任何宽度下都相同；最后一步没有「Skip」。Models and Agents share cards (icon slot, title, a two-line summary with More, Add, Adding… or ✓ Added) with full-width state lines under them. Recommended plugins draws each plugin as the plugin market's entry row, ui-primitives' `PluginEntryCard`: its artwork in a 48px frame, or the guide's coloured letter tile when it has none, the title, the same two-line summary with More, what it fits in a quiet line, and Add, Adding… or ✓ Added at the end, with the state lines under the text.引导会省略终端设置已涵盖的内容，可从设置 → 通用 → 入门再次显示，并且只在 Delorun 外观开启时加载。

## 目录

- [步骤](#the-steps)
- [设置中的“浏览器”页面](#the-browser-page-in-settings)
- [约定](#contract)
- [连接](#connections)
- [配置](#configuration)
- [限制](#limits)
- [测试](#tests)

<a id="the-steps"></a>

## 步骤

| 步骤 | 显示条件 | 作用 |
| --- | --- | --- |
| Welcome | 始终，第一步 | 语言芯片（上游的语言区域服务）。预览版提示尚待确认期间（它存在、此浏览器尚未确认且引导没有被重新打开），显示来自 `@delorun/bundle-local` 字典的标题和段落，「Continue」通过 `ctx.delorunNotice` 记录确认，所以该提示自己的步骤无需第二个对话框即可完成；在此之前隐藏「Skip」。 |
| Models | 始终，第二步 | 起始页：对每个仅凭密钥即可连接的提供方路线显示一张卡片，取自 harness 的可配置提供方目录（官方 DeepSeek 路线、已声明的路线，以及自身认证读取 `*_API_KEY` 变量且不涉及区域或账户的目录路线；`hiddenProviders` 所列的会被省略）。密钥已存储或已在环境中的卡片显示「Key found」，默认勾选并排在最上面。其余每条路线，无论是否已配置，都位于「Add another provider」之下（先显示前六个，然后是「Show all」），末尾是一张 OpenAI 兼容端点卡片，它要求填写名称、基础 URL 和密钥，在挂载了 `llm-pi-ai` 命名空间的地方提供；按钮显示为「Connect N →」。逐个走完：每个已勾选的提供方一屏（第 k 个，共 N 个），含 API 密钥输入框；在 `KEY_PAGES` 中有对应页面时，含指向提供方自己页面的「Get a key」链接；以及「More settings」，仅对已声明的路线提供基础 URL。输入的密钥在停止输入 600 毫秒后，用免费的模型列表请求（`remote.llm.discoverModels`，不发送也不花费任何内容）进行测试，仅当携带该密钥的请求得到了模型列表应答时，才显示「✓ Key works · N models」和默认模型。目录提供方在其自己的列表接口上被询问（OpenAI、Anthropic、Google Gemini、Groq、Mistral、xAI、Moonshot AI、Together AI、Fireworks AI 和 Cerebras 会在那里拒绝错误的密钥）；目录中已安装的模型从不使用，因为它们不需要密钥。列表公开或未知的提供方会显示该密钥无法测试，「Next」将其保存为「Key saved, not tested」。「Next」把密钥保存到「设置 → 模型」保存的位置（先 `remote.settings.mutate` 写入 profile 的 `apiKeyEnv`，再 `remote.credentials.set`），在 profile 没有该路线的配置时先写入该路线的 profile，并以其自定义提供方卡片的方式声明端点（端点的模型、一个 `providers.<id>` profile，然后是密钥）。已存储的密钥从不被读回：密钥测试的应答会指出每个已持有密钥的来源（一个 `KEY_SOURCE_KINDS` 值和变量名，来自凭据服务的 `describe`，绝不包含值），找到的密钥显示为带该来源的文字和一条「How does Delorun know?」说明，没有输入框，焦点落在「Next」上，直到「Replace key」展开输入框（「Keep the key I have」可返回）。摘要：每个提供方显示「Connected」「Key saved」或「Skipped」，以及一个「Add another provider」按钮，它返回到起始页并保留已勾选项（已经结束的提供方不会再被询问），然后是对话框的「Continue」。 |
| Look | 除非设置记录涵盖 `look` | 配色方案的芯片（上游的主题服务）、带浅色和深色色板的调色板，以及选择 Soft 调色板时的强调色预设，旁边是以所选外观绘制的一段 chat。最后一个选择「Delorun」或「Stock」，会在作出选择之前说明：stock 外观会关闭 Delorun 的 studio 增强功能和本引导，而设置 → 通用 → 外观可以切换回来。每组芯片是一个带标签的单选组，只有一个 Tab 停靠点，位于所选芯片上；方向键移动并选择，循环往复，Home 和 End 移到两端。在「Delorun」或「Stock」这一组中，方向键只移动焦点，由空格或 Enter 选择，所以方向键绝不会关闭 Delorun 的外观。 |
| Agents | 除非设置记录涵盖 `agents` | `@deepseek-ai/dsh-subagent-claude-code` 和 `@deepseek-ai/dsh-subagent-codex` 的卡片，带有来自插件管理器的状态以及它们在这台电脑上的登录状态：已登录；未登录并给出登录用的命令；或 Delorun 无法判断。「Add」会打开一个说明添加该 agent 意味着什么的分组：当 agent 从 chat 中启动时，Delorun 先在这台电脑上询问，除非本人已为该工作区允许它，手机无法应答；只读 chat 从不启动 agent，运行停留在 chat 的工作区内并在 30 分钟后停止，设置 → 安全 → 外部 agent 可撤销它；它在 Delorun 的沙箱和权限提示之外运行；它可以读取和更改其自身设置允许的任何文件，包括 Delorun 的文件；它的使用按它自己的登录计费。第二个按钮添加该 bundle。此安装无法安装的 bundle 会在其卡片下显示一行「Not included in this installation」，带一个「Open Plugins」按钮；添加失败会显示带「Try again」的错误行。 |
| Recommended plugins | 行的 `plugins` 或 `optionalRows` 列表不为空，且设置记录不涵盖 `plugins` 时 | A market entry per configured package except the Browser pack, which the Browser step offers, with the title and description the plugin manager lists, or, for Delorun's packs, the downloads panel's title and the guide's own description. A package that declares [connections](#connections) the person has comes first, with Fits and their names in the entry's quiet line; one that declares none follows them without a note; one that declares only connections the person lacks is left out, and when every package is left out the step says so. Packages that are not installed are read from the npm registry only after the person presses Check plugins that are not installed online. An entry per `optionalRows` entry follows them: a row that a bundle inserts disabled, with the title, description and icon of its package and a Turn on button; it is [turned on](#bundled-rows) only when pressed. |
| Browser | `plugins` 列出 `@delorun/bundle-browser` 且设置记录不涵盖 `plugins` 时，或该插件包已在配置档中时 | 共用的“浏览器”选项（[`@delorun/browser-setup`](../browser-setup/README.zh.md)）：“独立浏览器”或“不使用浏览器”。尚未完成设置的新 home 若从未选择，则选中独立浏览器，并在步骤打开时添加该插件包，记录 `on`；已有的 home 若从未选择且没有该插件包，则显示“不使用浏览器”，在本人选择独立浏览器之前不添加任何内容；在向导中、在设置中、或在“插件”中关闭该插件包而选择了“不使用浏览器”的 home 保持关闭；手机不添加任何内容。对 home 而言，该选项就是“浏览器”插件包：选择独立浏览器会通过向导的安装器添加它，选择“不使用浏览器”会通过插件管理器关闭它，并把该选择记录在该行的 `browser` 字段中。选项下方显示“浏览器”是否已就绪，读取自 Host 的需求检查（“插件”页面的“需要设置”状态也读取它），包括 Host 给出的原因及其解决办法，窗口重新获得焦点时会再次读取；或者显示添加插件包的进度。三张卡片说明会发生什么：第一个使用“浏览器”的对话只询问一次是否允许它的浏览器工具 playwright-mcp，之后不再询问。预览开关 `onboarding.previewSteps`（[`@delorun/preview-flags`](../preview-flags/README.zh.md)）打开时，会显示计划中的第三个选项“使用我的浏览器”，它处于禁用状态并带有“预览”标签。 |
| Phone access | 远程访问状态路由应答没有任何远程访问方式就绪，且设置记录没有说明远程访问已设置时 | 按本人修复的顺序排列的四项检查：已安装 Tailscale、这台电脑已登录、tailnet 已开启 HTTPS 证书，以及本人的账户被允许配置 `tailscale serve`。每项显示完成，第一项缺失的显示其修复方法（一个链接、带复制按钮的命令，或管理控制台设置），其余的等待。然后是 `delorun reach on tailscale` 和 `delorun devices approve`，各带一个复制按钮，以及 Tailscale 给出这台电脑的名称之后手机要打开的地址。它说明手机只能在这台电脑上批准、手机获批准后会提示设置 Face ID，并且 Delorun 在没有远程访问时也可在这台电脑上工作。 |
| PIN | 手机访问已开启后，在 home 所在电脑上；在手机上，则是在 PIN 模式关闭且该步骤尚未被推迟时 | 在电脑上：选择一个 PIN 或口令，输入两次，已配对的手机之后就用它解锁。在手机上：单独一栏，说明设置 PIN 要在电脑上完成及其原因，并提供 **Do it on my computer**（把该步骤记为已推迟并继续）和 Skip。 |
| Workspace | 始终 | 默认工作区（当能解析出一个时）或「Another workspace」。「Another workspace」是一个按钮「Choose or make a workspace…」，它在引导之上打开新建工作区对话框（`ctx.delorunNewWorkspace`，以 `from: 'onboarding'` 打开）；对话框打开期间该按钮处于忙碌状态。对话框创建的工作区成为所选工作区，并显示为一张文件夹卡片，连同它包含的内容：代码项目、文件夹或空文件夹；「Choose another」再次打开对话框，取消对话框不会改变任何内容。当配置中没有新建工作区插件时，该步骤会说明之后可以通过侧边栏的「Add workspace」添加文件夹，并且在有默认工作区时仍可用它继续。 |
| Ready | 始终，最后一步 | 每项一行，分别为：模型（密钥有效的提供方，或没有一个有效）、外观、已添加的 agent 和插件、home 有远程访问时的手机访问，以及工作区，然后是「Ideas to try」：三个与文件夹内容（通用、空、代码或文件）相符的想法，每个都带一个「Copy」按钮，把它的文字放进剪贴板。「Start a chat」记录引导已完成，并在所选工作区中打开一个新 chat。没有选择工作区且没有能解析出的工作区时，「Start a chat」返回到「Workspace」。 |

其他插件通过 `ctx.delorunOnboarding` 添加的步骤，位于「Phone access」和「Workspace」之间。「Back」「Continue」和「Skip for now」位于每一步之下；「Skip」记录引导已完成，不打开任何 chat，并把焦点移到页面的消息框。设置 → 通用 → 入门中有一行 `delorun-onboarding`，其「Run setup again」按钮从「Welcome」重新打开流程并保留所有其他设置；每一步都从它实时读取的值开始（设置中保存的语言、模式、主题和强调色，路由报告的密钥、agent 和 Tailscale），手机上的「Phone access」步骤是远程说明；重新打开的流程算作未完成，所以重新加载会再次显示它，直到它被完成或跳过。

「Ready」上的想法跟随文件夹包含的内容，其文字位于字典中，所以每种语言各有自己的文字。复制一个想法不会向消息框写入任何内容，也不会发送任何内容；第一个 chat 打开时是空的。

<a id="the-browser-page-in-settings"></a>

## 设置中的“浏览器”页面

studio 一半还注册 `delorun-browser` 的 `settings.section`（顺序 17，紧随插件下载部分之后；[`src/client/browser/BrowserSettings.tsx`](src/client/browser/BrowserSettings.tsx)），与此插件的其余注册一同提供。该页面通过与向导“浏览器”步骤相同的 hook 读取和写入 home 的选择（[`src/client/browser/use-browser.ts`](src/client/browser/use-browser.ts)；规则和各状态见 [`@delorun/browser-setup`](../browser-setup/README.zh.md#the-homes-choice-and-the-pages-states)）。

- **内置浏览器。** 一个开关，然后是用平实的话说明的状态：关闭、检查中、添加中、较慢、需要重启、就绪、带 Host 原因的需要设置，或带 Try again 的失败（离线、此处不可用、插件管理器自己的话、无法读取的检查或声明）。只有从未选择过的新 home（设置未完成）会在页面打开时添加该插件包，并记录 `on`；从未选择过且没有该插件包的已有 home 显示 Off，在本人打开之前不添加任何内容，选择了关闭的 home 永远不会被添加。On 会添加该插件包，或重新打开被 Plugins 关闭的插件包。Off 通过插件管理器关闭该插件包并记录 `off`；插件包仍保持已下载。记录为 `on` 期间，在 Plugins 中被移除或关闭的插件包，会在页面或步骤下次打开时记录为 `off`。记录为 `off` 期间，页面会注明该插件包读取为已禁用还是已启用（`browserPack`）；在被看到已禁用之后又被看到已启用的插件包，是在 Plugins 中被重新打开了，会记录为 `on`；而因其关闭在等待重启而一直保持启用的插件包，从未被看到已禁用，保持 off。
- **下载。** 当未满足的需求是 Chromium 构建时，页面提供 **Download the browser**，它请 Host 运行 Browser 插件包自己的安装器，并显示用于终端的命令。需求为 Google Chrome 时只显示其命令。
- **测试浏览器。** Browser 就绪时，该按钮请 Host 在内置浏览器中打开一个固定页面并显示其缩略图；不运行任何模型轮次。Host 路由由 [`@delorun/bundle-local`](../bundle-local/README.zh.md#the-browser-page-routes) 提供，只应答 home 自己的电脑；手机会看到在哪里运行该测试。
- **你自己的 Chrome。** `@delorun/bundle-real-browser` 插件包的状态：可添加时显示 **Add your Chrome**，然后是 browse 扩展是否已配对，并带 **Finish in Plugins** 用于配对步骤以及每个对话各自请求的批准。
- **手机。** 从手机打开的 studio 不能添加插件包或关闭它们，因此开关、下载和测试都被保持不可用，页面说明在哪里更改 Browser。

第一个使用 Browser 的对话仍会请你允许浏览器工具一次；页面不允许它，因为在对话启动服务器之前还没有审查。

<a id="contract"></a>

## 约定

- **stock 外观。** studio 一半在 `apply` 之内注入 `delorunStudio`（`ctx.inject(['delorunStudio'], applyStudio)`），所以它的条目在 stock 外观下保持激活，这是上游的 web 启动对每个条目的要求。`@delorun/plugin-theme` 只在 Delorun 外观开启期间提供该服务，所以没有它时，插件不注册任何内容，也不提供任何服务。上游的设置外壳 `settingsShell` 不被注入：「Run setup again」在被按下时用 `ctx.get('settingsShell')` 查找它，所以在某个插件关闭上游的通用设置（`ui-settings-general`）并绘制自己的设置的地方（如 DS Bot），该条目同样保持激活。没有外壳时，「Run setup again」只把引导标记为未完成，下次重新加载时显示它。
- **引导步骤**是一个 `settings.onboarding` 条目，id 为 `delorun-onboarding`，顺序 -200，位于 `@delorun/bundle-local` 的 `delorun-notice`（-100）和上游的 DeepSeek 密钥步骤 `deepseek-official` 之前。它只在 host 提供行 `delorun-onboarding` 时才注册。`done` 已设置且没有 `explicit` 标志时，它立即调用 `complete()`，无法读取的行也是如此。「Models」步骤通过 studio 自己的远程凭据和设置命名空间保存密钥，与设置 → 模型一样。「Start a chat」还会调用 `completeStep('deepseek-official')`，因为「Models」步骤提供的是相同的提供方。`@delorun/bundle-studio` 在 `ui-settings-models` 上设置 `credentialOnboarding: false`，所以上游的密钥步骤从不打开，跳过或重新加载之后也是如此。对话框显示期间拥有页面的 inert 根，每一步都把焦点移到该步骤的标题，且只能通过它自己的按钮关闭。它关闭时，焦点移到消息框（在手机或平板上，移到消息框的卡片，使键盘保持收起），否则移到页面的第一个控件。
- **进度**是该行的易变配置：`done` 和 `step`（所到达步骤的 id，用于恢复流程）。「Run setup again」写入 `done: false` 和空的 `step`，然后请求设置外壳（若存在）打开该步骤。写入失败会被记录日志，流程继续。
- **外观**只通过 `ctx.configForms` 写入主题行的 `palette` 和 `accent`，并通过上游的主题服务写入配色方案。选择「Stock」会调用 `ctx.delorunStudio.useStockLook()`，从而卸载此插件。调色板和强调色的标签来自 `@delorun/plugin-theme` 的字典 `settings.delorunAppearance`，[`src/client/previews.ts`](src/client/previews.ts) 中的预览颜色是副本，由一个测试将其与主题自己的颜色比较。
- **随 bundle 提供的行** <a id="bundled-rows"></a>用 `listBundles` 和 `listPlugins` 读取，它们按行的 id 及其实时条目找到该行。「Turn on」为该条目调用插件管理器的 `setPluginEnabled`，也就是「插件」页面所做的调用，所以它的检查同样适用于这个按钮：受保护的和无法寻址的行会被拒绝，由 profile 自己的补丁记录该更改，而绝不是此插件。`applied` 显示「On」且无需重启，`restart-required` 说明 Delorun 需要重启，其他任何情形，包括没有 bundle 声明的行或无法更改的行，会显示失败或「Not included in this installation」，并带一个打开「插件」的按钮。
- **推迟的步骤** <a id="deferred-steps"></a>是只有 home 所在电脑才能完成的步骤，手机用 **Do it on my computer** 把它们推迟。它们保存在 profile 目录中的 `onboarding-deferred.json` 里（`{ "version": 1, "deferred": [...] }`，至多三个来自封闭列表的 id，权限 0600，通过临时文件和重命名整体替换，写入依次应用），而不是保存在浏览器中，并作为 `deferred` 随设置记录提供。缺失、过大或不可用的文件会被读作没有，并给出一条不引用其内容的警告。在手机上，PIN 步骤会说明它要在电脑上完成及其原因，并在它已被推迟或 PIN 模式已开启时被略去。在电脑上，`sidebar.footer.action` 条目 **Finish setup**（引导尚未完成时回到引导的途径，也是唯一这样的条目：消息框上方没有芯片）在引导完成后显示为 **Finish setup · N left**，它统计有对应界面（`reach`、`pin`）的已推迟步骤，在读取时清除工作已经完成的步骤（远程访问已设置、PIN 模式已开启），通过设置外壳只打开这些步骤的引导，并在为零或不在电脑上时不显示。该引导不保存位置，不开始 chat，并在最后一步之后关闭。
- **Agent 和插件**使用插件管理器的远程命名空间，从 store 中作为 `remote.pluginManager` 服务读取。`listBundles` 只读取。此安装随附的 bundle 用 `setBundleEnabled` 开启；目录条目用 `installBundle` 从其 `installTarget` 安装，然后启用。`applied` 显示「Added」，`restart-required` 显示 Delorun 需要重启，其他任何情形，或无法询问的插件管理器，会在卡片下显示一行失败信息并带「Try again」。没有安装目标或其目标旁有错误的目录条目，显示「Not included in this installation」。没有按下按钮就不会安装任何内容。
- **路由。** harness 一半需要 `connection`，并提供下列精确的路由（[`src/wire.ts`](src/wire.ts)），每个都以不缓存的方式应答 JSON。studio 严格解析每个应答，并对无法读取的路由显示如实的状态。每条路由都应答主目录所在的电脑。已配对的设备可以访问 `@delorun/home-auth` 路由表为它列出的路由：获批后可访问只读路由和 `deferStep`；获批且在 PIN 模式下已解锁后可访问 `keyTest`；只有持有解锁时才能访问 `agentModels`（否则返回 `ELEVATION_REQUIRED`）；其他来源在路由之前就被拒绝。添加文件夹和克隆是 `@delorun/plugin-new-workspace` 的路由，由工作区步骤调用。

  | 路由 | 应答 |
  | --- | --- |
  | `GET /api/delorunOnboarding.setupRecord` | `{ sections?, reachSetUp, deferred? }`：终端设置记录，以及手机推迟到电脑上的步骤（见[推迟的步骤](#deferred-steps)）。 |
  | `POST /api/delorunOnboarding.deferStep` | 请求体为 `{ id, deferred }`，其中 `id` 是 `reach`、`pin` 或 `approve` 之一。推迟或清除一个步骤，并应答 `{ deferred }`，即当前所有被推迟的步骤。已配对的设备无需解锁即可调用它，因为它只记录一条备注，不更改任何设置。任何其他 id 都会被以 400 拒绝。 |
  | `GET /api/delorunOnboarding.start` | `{ startId }`：这次 Delorun 启动的随机 id，只保存在内存中。 |
  | `GET /api/delorunOnboarding.readiness` | Claude Code 和 Codex 的登录状态（`found`、`missing` 或 `unknown`），以及 Tailscale 的状态和这台电脑的 DNS 名称。 |
  | `GET /api/delorunOnboarding.workspaceNotice` | 工作区注册表集在启动时记录到一旁的文件名，最旧的在前（最多 64 个）；没有时为空。 |
  | `POST /api/delorunOnboarding.keyTest` | 每条模型提供方路线的名称和结果：`works`、`rejected`、`unreachable`、`no-key`（未配置凭据）、`untested`（有凭据或不需要凭据，但没有模型列表）或 `failed`。 |
  | `POST /api/delorunOnboarding.recommend` | 每个已配置插件所声明的连接、读取它们的位置，以及是否访问到了注册表。 |
  | `GET /api/delorunOnboarding.localModels` | `{ servers }`：该步骤识别的本地模型服务器（Ollama、LM Studio）中，在回环地址上应答了模型列表的每一个，带地址和模型。 |
  | `POST /api/delorunOnboarding.agentModels` | 请求体 `{ agent }`，取值 `claude-code` 或 `codex`：`listed` 带该已安装智能体通过它自己的进程提供的模型，或 `unavailable` 带 `not-running`、`timeout` 或 `failed`。 |

- **设置记录**读取自 CLI profile 目录（`ctx.profileContext.dir`）中的 `setup-answers.json`，它由 `delorun setup` 写入，引导从不写入。当 `reach.option` 是不为 `none` 的非空字符串时，`reachSetUp` 为 true；`sections` 列出状态为 `seen` 或 `answered` 的部分 id（最多 32 个，每个最长 40 个字符）。只读取这些字段；超过 64 KiB 的文件、不是常规文件的文件，或缺失、无法读取或无效的文件，都应答 `{ reachSetUp: false }`，所以每一步都显示。原因会记录日志而不引用该文件。名为 `look`、`agents` 或 `plugins` 的部分会使对应的步骤被省略；「Welcome」「Workspace」和「Ready」从不被省略。
- **就绪检查**只读取。登录检查只测试 `~/.claude/.credentials.json` 或 Codex 的 `auth.json`（位于 `CODEX_HOME`，否则位于 `~/.codex`）是否存在，从不打开它（设置了 `CLAUDE_CONFIG_DIR` 时，Claude Code 的文件在那里）；在 macOS 上，Claude Code 把登录信息保存在钥匙串中，找到 `~/.claude.json` 时应答 `unknown`。Tailscale 检查通过 `@delorun/reach` 的运行器运行 `tailscale version`、`tailscale status --json` 和 `tailscale serve status --json`，不运行任何会更改内容的命令。
- **密钥测试**向每条提供方路线请求其模型列表，而从不请求补全，所以不消耗 token。需要密钥却没有已配置凭据的路线，在尝试任何列表请求之前就读为 `no-key`：其设置 profile 的 `apiKeyEnv` 引用必须指向凭据服务描述为已配置的引用，而可配置目录未列出的路线则没有该引用。当路线的 profile 指名了一个引用，或适配器报告其认证读取了环境变量时，该路线需要密钥；无需密钥的路线（如本地模型服务器）直接进入发现步骤。适配器注册了模型发现的路线，通过上游的 `llm.discoverModels` 被询问，它在 harness 内使用已存储的密钥；官方 DeepSeek 路线通过 `@deepseek-ai/dsh-llm-deepseek` 的列表请求被询问，所用密钥是其凭据引用解析出的密钥。每条路线有 `keyTestTimeoutMs`。应答给出每条路线及其结果，从不包含密钥、地址或提供方的消息。以成功状态应答、但正文不是模型列表的列表（如强制门户的页面），读作「Could not test this key」，而绝不读作有效。
- **推荐**从已安装的包中读取每个已配置包的 `package.json` 中的 `delorun.connections`（见[连接](#connections)）；未安装的包只在请求声明 `registry: true` 时才在 `registryTimeoutMs` 之内从 `registry` 读取，否则为 `unknown`。注册表请求是此路由唯一的网络请求。
- **密钥状态。** 插件提供 `ctx.modelKeyStatus`（由 `ui-settings-models` 声明）：每条模型路线最新的免费密钥测试结果，保存在内存中，绝不包含密钥。引导的「Models」卡片、无密钥横幅和设置 → 模型读取它，所以一个密钥在各处显示同一个状态。
- **无密钥横幅。** `conversation.input.dock` 中的一个条目（id 为 `delorun-onboarding.key-banner`，顺序 5）显示「Add a model key to start chatting」，并带一个按钮，在密钥测试发现没有任何可用或可能可用的提供方期间打开设置 → 模型（`ctx.settingsShell.openSection('models')`）：即每条路线都是 `no-key` 或 `rejected`，或没有任何路线。路线有效、无法访问、失败或为 `untested`（它有凭据，或像本地模型服务器那样无需凭据，且其模型无法列出），以及无法读取的密钥测试，都不显示任何内容。横幅在输入框挂载时询问一次，显示期间每 5 秒询问一次，所以一旦添加了密钥它就会离开；它从不打开对话框。它只在 Delorun 外观开启时才注册。
- **搁置提示。** `conversation.input.dock` 中的一个条目（id 为 `delorun-onboarding.set-aside`，顺序 6），在工作区注册表启动时有记录被搁置的情况下，显示「Some workspace records could not be read and were set aside: <files>. Run delorun doctor for details.」并带一个「Dismiss」按钮。它在输入框挂载时读取一次 `GET /api/delorunOnboarding.workspaceNotice`，该路由列出来自注册表 `quarantined` 的被搁置的文件名（不含路径）；列表为空或应答无法读取时不显示任何内容。关闭它会将其隐藏，直到 studio 重新加载。它只在 Delorun 外观开启时才注册。
- **`rename_workspace` 行。** 一个带键的 `tool.call.toolview` 条目，把 `@delorun/plugin-workspaces` 的工具调用绘制成旧名称、一个箭头和新名称（取自结果中持久化的 `from` 和 `to`），或绘制成以 agent 的措辞给出的拒绝。只要插件在 Delorun 外观开启时加载，它就会注册，在其他情形下回退到通用行。
- **第一个 chat。** 对话框打开时，它调用一次 `ctx.workspaces.initializeDefault()`，host 以现有的默认工作区应答它，并且仅在 host 没有工作区也没有 chat 时才创建一个。「Start a chat」以所选的工作区调用 `ctx.uiWorkspace.openWorkspace`。查找没有解析出任何结果、存在其他工作区且本人没有选择任何工作区的情形，则采用工作区 UI 自己的「New Session」。没有 `ctx.uiWorkspace` 时，采用「New Session」。对话框显示期间，它通过 `ctx.uiWorkspace.holdDefaultWorkspaceNotice()` 持有工作区 UI 的 `defaultWorkspaceFailed` 提示；它关闭时，如果「Workspace」说明没有默认工作区，则丢弃该提示，否则显示它。
- **`ctx.delorunOnboarding.registerStep(step)`** 添加一个 `OnboardingStep`（`id`、`order`（600 到 999）、`title`、接收 `next` 的 `component`）并返回它的释放函数；与更早步骤同 id 的步骤会替换它。
- **文案**位于命名空间 `delorunOnboarding` 之下，有英文和中文（[`src/client/locales.ts`](src/client/locales.ts)）；studio 的其他语言回退到英文。「插件」页面的插件名称来自 [`locale/`](locale/en.json)。CSS 只使用主题令牌。在 768 px 以下，对话框占满整个窗口，步骤列表变为带进度条的计数，页脚保持在底部；对粗指针，行增高到 44 px。

<a id="connections"></a>

## 连接

插件在自己的 `package.json` 中说明它适用于本人的哪些连接，「Recommended plugins」步骤读取该字段，且只读取该字段：

```json
{
  "name": "@scope/codex-quota",
  "delorun": { "connections": ["agent:codex"] }
}
```

id 的形式是：设置 → 模型所列的模型提供方路线 `provider:<id>`（如 `provider:deepseek-official`）；在这台电脑上已登录的编程 agent `agent:claude-code` 或 `agent:codex`；或 Tailscale 安装之后的 `tool:tailscale`；每个包最多 16 个。没有声明任何连接的包适合任何设置。仓库的包状态门禁接受 Delorun 包上的该字段。

<a id="configuration"></a>

## 配置

行 `delorun-onboarding` 有下列字段（[`src/config.ts`](src/config.ts)），在配置加载时校验。前七个是易变字段，在 studio 运行时更改。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `done` | `false` | 本人是否完成或跳过了引导。 |
| `step` | 空 | 所到达步骤的 id。 |
| `browser` | 空 | 本人在设置或引导中为 Browser 所作的选择：`on` 或 `off`。从未选择时为空：新 home 此时会添加该插件包，已有的 home 则显示 Browser 为关闭。在 Plugins 中关闭了该插件包的 home 也读作关闭。 |
| `browserPack` | 空 | 当 `browser` 为 `off` 时：Browser 插件包上次被看到是 `enabled` 还是 `disabled`（被关闭或被移除）。在 `disabled` 之后又被看到 `enabled` 的插件包，是在 Plugins 中被重新打开了。每次记录的选择都会清除它。 |
| `pausedStart` | 空 | 本人按下「Finish later」的那次 Delorun 启动，取自 `GET /api/delorunOnboarding.start`。当它指向当前这次启动时，引导保持关闭，无论在哪个标签页或重新加载之后都是如此，下次启动时会再次显示。从侧边栏页脚的「Finish setup」条目再次打开引导会清除它。 |
| `plugins` | 空 | 「Recommended plugins」步骤提供的最多十二个 npm 包名。没有任何包且没有 `optionalRows` 时，该步骤被省略。 |
| `optionalRows` | 空 | 最多十二个行 id（如 `delorun-cost-meter`），即 bundle 以禁用状态插入的行；该步骤提议逐个开启。每个都必须是 profile 的行，否则插件在加载时停止并给出指名它的错误。 |
| `registry` | `https://registry.npmjs.org` | 读取未安装包时所用的 `https://` npm 注册表，仅在本人请求时才使用。 |
| `registryTimeoutMs` | `10000` | 注册表请求合计最多可花费的时间，1000 到 60000。 |
| `keyTestTimeoutMs` | `15000` | 一个提供方的密钥测试最多可花费的时间，1000 到 60000。 |
| `hiddenProviders` | `[]` | 密钥测试和引导的提供方列表所省略的模型提供方路线 id。这些路线仍保持挂载。 |

[`@delorun/bundle-studio`](../bundle-studio/README.zh.md) 把 `plugins` 设为随 DeepSeek Harness 一起发布的五个实验性插件：会话搜索、终端 bundle、worktree 工具、会话标题和 DeepSeek 网站 chat 导入（可选 bundle，开启前保持关闭），并把 `optionalRows` 设为「思考」标签页（`delorun-thinking-rsvp`）和费用计量器（`delorun-cost-meter`）。

<a id="limits"></a>

## 限制

- **委派同意。** 添加 Claude Code 或 Codex 需要在其卡片上按两次。之后，从 chat 中启动的 agent 受 Delorun 自己的委派同意约束，「Agents」步骤对此有描述：Delorun 先在这台电脑上询问，除非本人已为该工作区允许它，手机无法应答，只读 chat 从不启动 agent，运行停留在 chat 的工作区内并在 30 分钟后停止。此插件不实现该同意；该步骤的文案必须跟随它。
- **密钥结果。** 上游的 pi-ai 发现对被拒绝的密钥和无法访问的端点报告相同的错误码，所以这样的路线在两种情形下都显示「Could not test this key」，而官方 DeepSeek 路线能区分「The provider rejected this key」和「Could not reach the provider」。
- **连接。** 没有随附的插件声明连接，所以每个预置的插件都适合任何设置。没有找到可推荐的 Codex 配额或 Command Code 插件。

<a id="tests"></a>

## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts --maxWorkers=2 delorun/packages/plugin-onboarding/` 运行这些规格；加上 `--coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.include='delorun/packages/plugin-onboarding/src/**'` 可得到覆盖率，覆盖是完整的。

- [`tests/host.spec.ts`](tests/host.spec.ts) 检查配置、面对缺失、格式错误、过大、以目录命名和恶意文件的记录读取器，以及 harness 挂载的路由。
- [`tests/readiness.spec.ts`](tests/readiness.spec.ts)、[`tests/key-test.spec.ts`](tests/key-test.spec.ts) 和 [`tests/recommend.spec.ts`](tests/recommend.spec.ts) 检查登录和 Tailscale 检查、文件夹类型、针对本地列表服务器的每种密钥结果，以及来自磁盘和注册表的已声明连接。
- [`tests/steps.client.spec.tsx`](tests/steps.client.spec.tsx)、[`tests/workspace.client.spec.tsx`](tests/workspace.client.spec.tsx)、[`tests/bundles.client.spec.tsx`](tests/bundles.client.spec.tsx)、[`tests/guide.client.spec.tsx`](tests/guide.client.spec.tsx) 和 [`tests/dialog.client.spec.tsx`](tests/dialog.client.spec.tsx) 检查每一步、单选组的 Tab 停靠点和按键、agent 确认、bundle 仅在按下按钮时安装、「Workspace」步骤的对话框按钮及其状态、引导的共享状态、提示的确认、恢复、跳过、被省略的步骤，以及焦点的落点。
- [`tests/focus.client.spec.tsx`](tests/focus.client.spec.tsx) 检查焦点；[`tests/plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) 检查各项注册、「Run setup again」、记录加载器、默认工作区查找、新建工作区服务和第一个 chat；[`tests/starters.client.spec.tsx`](tests/starters.client.spec.tsx) 检查起始提示词；[`tests/key-banner.client.spec.tsx`](tests/key-banner.client.spec.tsx) 检查无密钥横幅；[`tests/set-aside-banner.client.spec.tsx`](tests/set-aside-banner.client.spec.tsx) 检查搁置提示；[`tests/rename-row.client.spec.tsx`](tests/rename-row.client.spec.tsx) 检查重命名行；[`tests/previews.spec.ts`](tests/previews.spec.ts) 检查预览颜色；[`tests/locales.spec.ts`](tests/locales.spec.ts) 检查英文和中文文案。
- [`tests/browser-settings.client.spec.tsx`](tests/browser-settings.client.spec.tsx) 检查 Browser 页面：开关及其记录的选择、用平实的话说明的每种状态、下载、测试及其缩略图、你自己的 Chrome 卡片，以及手机上被保持不可用的控件。
- [`tests/browser.client.spec.tsx`](tests/browser.client.spec.tsx) 检查“浏览器”步骤：独立浏览器只为从未选择过的新 home 添加一次该插件包，从不为从未选择过的已有 home 或选择了关闭的 home 添加；“不使用浏览器”会关闭它并记录这一点；添加的每种状态；获得焦点时的重新读取；以及该步骤在向导中的位置。
- [`tests/preview-flags.spec.ts`](tests/preview-flags.spec.ts) 检查 Host 部分声明的开关与本包清单在 `delorun.previewFlags` 下列出的开关一致。
