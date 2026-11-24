# Profile 管理

[English](boot.md) | 中文

[boot 包组](../../packages/boot/README.zh.md)负责 launcher 提供的 profile 访问与插件管理器。[插件管理器](../../packages/boot/plugin-manager/README.zh.md)文档说明持久化、重载与包操作行为。

## 管理记录

`PluginEntryId` 标识一个 Loader 条目；调用方从 `listPlugins` 获取，不自行拼接 patch id。

`PluginInfo` 包含模块标识、实际启停状态、fiber 阶段和可选的展示 `meta`，以及唯一的 `patchId` 或 `readOnlyReason`。

`BundleInfo.official` 标识项目维护的随附可选组合包和按需目录项，独立于安装状态。`availability` 表示可读取的安装随附包、profile 包或 `missing`；按需目录项不计入未声明的传递依赖副本。`installed` 记录 profile 的依赖声明。按需条目的 `installTarget` 包含 Host 生成的精确 spec 和版本。`BundleInfo` 还包含包名、可选的安装版本、组合层选择状态、删除可用性、更新方式（`update`：`registry` 或 `git`，组合包无法更新时不存在）、可选的解析错误或平台不支持错误；由 profile 自身依赖提供、且安装不提供的组合包还带有 `source`，即该依赖在 `pnpm add` 中可用的 spec。它的可选 `meta` 与各行的 `BundleRowInfo.meta` 包含展示文本或元信息诊断；Client 在渲染时选择语言。

`InstallBundleOptions.saveExact` 向共享包安装器传入 `--save-exact`。`InstallBundleOptions.enabled` 默认为 true，false 表示安装但不选择组合包层。`approvedBuilds` 在安装前向指定的待审批包名授予持久脚本权限。`registry` 指定首先询问的注册表；缺省为配置的那个。`expected` 指定该 spec 必须安装的包与清单版本；安装了其他任何内容的运行会连同其 profile 文件与模块一起被撤销，并以 `unexpected-package` 失败，所安装的包未声明组合包的运行以 `not-bundle` 失败，组合包 patch 无法加载的运行则以操作错误失败。

`BundleDetail` 是 profile 中组合包的详细介绍：`{ status: 'found' }` 携带其 `origin`（`locale` 或 `readme`）、在包内的 `path` 和 `markdown`；否则为 `{ status: 'none' }`。[`readBundleDetail`](../../packages/boot/plugin-manager/README.zh.md#bundle-detail-documents) 说明读取顺序和图片路由。`NpmFileSource` 指定一个公共 npm 文件 CDN：`jsdelivr`、`unpkg` 或 `npmmirror`；一次读取的 `npmFileSources` 列出先请求的 CDN。

`PluginRegistries` 携带配置的第一个注册表（`null` 即 pnpm 自身配置指定的那个）、随后依次询问的备选注册表，以及 `resolved`——pnpm 自身配置指向的 URL，未读到时为 `null`。`InspectOptions.registry` 指定一次查询首先询问的注册表。

`ChangeResult.changed` 报告磁盘修改，独立于 `application`：`applied`、`restart-required`、`overridden` 或 `failed`。可选的 `error` 包含可本地化的错误码和外部诊断。`packageResult` 记录运行的退出状态、有界输出、截断标志及完整诊断日志路径；当管理器终止了一个停止打印的运行，或 GitHub 连接检查到达期限，还记录 `timedOut`；被终止的运行记录强制填入的状态 1，因为它的进程没有返回任何状态。被终止的运行不论信号留下什么退出状态都归类为 `timeout`，因此安装与删除都报告失败而非成功，也不会再询问下一个注册表。`pendingBuilds` 列出整个 profile 尚未决定的包；`approvedBuilds` 记录本次操作授予权限的包名；`registries` 按顺序列出一次安装问过的注册表；`bundle` 与 `version` 给出完成的安装新增的包及其清单版本；`failedAt` 说明最后一次失败的运行连不上的是所问的注册表，还是 git 或 tarball spec 自身拉取的主机。

`ProfileVersionId` 标识 profile 历史中的一个版本，即一个 git 提交 id；调用方从 `history` 获得它。`ProfileHistoryInfo` 要么是 `available: true` 并带 `versions`（从新到旧，每个带 `id`、以纪元毫秒表示的时间 `at`、单行 `summary` 和 `changedBy`：`person`、带 `sessionId` 的 `agent`，或 `outside`）以及说明 `plugin-manager/before-record` 为何拒绝保存插件管理之外所做编辑的 `unsaved`，要么是 `available: false` 并带 git 给出的 `reason`。`ChangeResult.undone` 与 `restored` 指明一次撤销取回的版本或一次恢复放回的版本，`changes` 列出它改动的内容。`ProfileVersionPreview` 是 `previewUndo` 与 `previewRestore` 在不保存版本的情况下读到的内容：要么是 `ok: true` 并带目标 `version` 及其 `changes`（新增、移除或改为其他 spec 的依赖，选入或取消选入的组合包，`allowBuilds` 决定，授予或撤销的版本豁免，`cordis.patch.yml` 是否不同，以及无法解析的文件），要么是 `ok: false` 并带该操作将以之结束的拒绝。撤销或恢复会在它带回的每个包的任何代码运行之前，用 `pluginAudit` 审计该包。

`pluginAudit` 是发行版可选的插件审计，一个由管理器消费而不提供的 Service Definition：`audit(target)` 接收一个 `PluginAuditTarget`（包的 `name`、`version`、已安装的 `dir`、用户对它 `accepted` 的摘要、以 `pending` 表示的改动尚待完成的步骤，以及安装所询问的 `registries`），返回一个 `PluginAuditResult`（`decision` 为 `clear`、`accepted`、`needs-acceptance` 或 `refused`，发现项的 `digest`，`findings`，每项含规则、标题、严重程度、文件、行和摘录，以及是否 `truncated`）。管理器在每次安装时以及启用组合包之前询问它；`needs-acceptance` 以 `audit-findings` 拒绝，`refused` 以 `audit-refused` 拒绝，两种错误都带 `audit`。`InstallBundleOptions.acceptedAudit` 指明用户接受的摘要，审计接受之后管理器把它为该包保存在 `.plugin-manager/audits.json` 中；`ChangeResult.audit` 携带一次改动继续进行时所带的发现项。没有该服务时不审计任何内容。

`ConfigEdit` 以 profile patch id 指明 `ConfigEditor.edit` 保存并应用了其配置的条目；`config-editor/edited` 在 profile 的锁释放后携带它，插件管理随即把这次编辑保存为一个版本。`ConfigSave` 是 `config-editor/before-save` 在编辑写入之前收到的内容：Loader `entry` 以及 profile patch 将为其保存的完整 `config`；监听器返回的原因会以 `ConfigEditRefusedError` 拒绝该编辑。`plugin-manager/before-record` 在历史保存版本之前收到受管文件，监听器返回的原因会拒绝该版本。

## 市场记录

[Plugin Market](../../packages/boot/plugin-market/README.zh.md) 读取第 1 版索引格式，校验由 [`dsh-plugin-market-index`](../../packages/util/plugin-market-index/README.zh.md) 完成。

`MarketIndexSummary` 携带一个已配置的索引 URL，以及最近一次成功读取得到的 `title` 和 `description`；最近一次读取失败时，还携带其 `error`。

`MarketQuery` 选择索引的一页：模糊匹配的 `text`、一个 `category`、必须全部具备的 `labels`、一个 `MarketSort`、`offset`、不超过 100 的 `limit`、表示重新获取而不使用缓存文档的 `refresh`，以及用于继续读取同一文档后续页的 `fetchedAt`。`MarketSearchResult` 携带索引 URL、`title`、可选的 `description`、市场 `metadata`、该文档的 `fetchedAt`、本页的 `entries`、匹配总数 `total` 和 `nextOffset`。每个 `MarketListingEntry` 额外携带 `defaultVersion`，即默认安装的版本，以及 `installation`，即该包名在当前 profile 中的状态；其 `versions` 中的每个版本额外携带 `install`，即交给 `installBundle` 的精确 spec 和可选的首选 registry，`compatibility`，即包含版本豁免在内的 `engines.dsh` 评估结果，以及 `update`，即该版本能否通过 `updateBundle` 替换已安装的 Git 副本：它比该副本新，且固定到该副本来源的仓库目录中的一个提交。

`PluginDetail` 是市场条目的详细介绍：`{ status: 'found' }` 携带其 `origin`（`locale`、`readme` 或 `repository`）、`markdown`，以及一个 `document` id，该文档中的图片由 `GET /api/plugin-market/detail-file` 提供；否则为 `{ status: 'none' }`。读取其来源的顺序见[插件市场的说明](../../packages/boot/plugin-market/README.zh.md#plugin-detail-documents)。

## Profile 重新组合

<a id="profile-reconciliation"></a>

```ts type-equiv
/** Outcome of {@link Hmr.reconcileProfile}. */
interface ProfileReconciliation {
  /** Diagnostics for Loader entries left inactive. */
  warnings: string[]
  /** Loaded modules whose files changed on disk and whose previous code keeps running until a restart. */
  pending: PendingModule[]
  /**
   * Why every change waits for a restart: `module-comparison` when module caches cannot be inspected or their files
   * compared, even when no URLs are known; `package-moved` when the runtime resolution cannot publish a moved package;
   * `service-replaced` when the change turns off a row providing a service that must not be swapped under running work.
   */
  restartReason?: 'module-comparison' | 'package-moved' | 'service-replaced'
}
```

```ts type-equiv
/** A changed module that loads only after a restart. */
interface PendingModule {
  url: string
  /**
   * `host-module`: the process entry point's static graph imports it. `unmanaged-plugin`: it is imported by a plugin
   * that runs outside a traversable Loader entry. `module-comparison`: loaded modules could not be compared with disk.
   */
  reason: 'host-module' | 'unmanaged-plugin' | 'module-comparison'
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxactioncards--actioncards"></a>

### `ctx.actionCards` — `ActionCards`

Card tool, kind registry, Session projection, user actions and status notices.

```ts cordis-catalog
/**
 * Register one action kind for the caller's lifetime.
 * @param kind - the kind's skill, details schema, verbs and handler.
 * @returns disposer removing the kind; actions on its cards are then unavailable.
 * @throws when another kind already registered the same action.
 */
register<Details>(kind: ActionCardKind<Details>): () => void

/**
 * Record a card decision in the Session log; the next model request reports it.
 * @param agent - agent whose Session owns the card.
 * @param decision - the card's new state.
 * @throws when no kind ever registered the decision's action with this service, or its phase is one the projection derives.
 */
record(agent: Agent, decision: ActionCardDecision): void

/**
 * Read the cards of one Session.
 * @param session - a Session whose projections are prepared.
 * @returns proposals and decisions by call id.
 */
view(session: Session): ActionCardView

/**
 * Apply a user action to a logged card. Shared checks run first, then the kind reconciles the card; `dismiss` is
 * recorded here and every other verb goes to the card's kind. `dismiss` also works on an unstarted card whose kind
 * is no longer registered. Concurrent actions on one card share one operation.
 * @param agent - live root resolved from the displayed Session.
 * @param callId - the card's `propose_action` call id.
 * @param verb - `dismiss` or one of the kind's verbs.
 * @param payload - kind-defined fields such as a chosen location.
 * @returns acceptance of background work, the decision in effect, or a refusal.
 */
@Remote act(agent: Agent, callId: ToolCallId, verb: string, payload?: Record<string, JsonValue>): Promise<ActionCardResult>
```

Types: [Agent](core.zh.md) · [Session](session.zh.md) · [ToolCallId](core.zh.md)

Source: [`packages/experimental/action-cards/src/index.ts`](../../packages/experimental/action-cards/src/index.ts)

<a id="ctxconfigeditor--configeditor"></a>

### `ctx.configEditor` — `ConfigEditor`

Persist complete raw configs and apply them through the normal Loader path.

```ts cordis-catalog
/** Addressable profile rows; nested Includes have independent configuration ownership.
 * @returns Active entries with unique profile patch ids.
 */
entries(): Entry[]

/** Read inherited and explicit profile values for the active entries.
 * @returns Detached layer values alongside their Loader entries.
 */
configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }>

/** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules. A
 * `config-editor/before-save` listener may refuse the edit before anything is written. A saved edit is announced as
 * `config-editor/edited`.
 * @param entry Current Loader entry, also used to detect replacement during the write.
 * @param change Derive a raw config from the current entry and its inherited layer.
 * @returns Fulfillment after Loader reconciliation completes.
 * @throws {ConfigEditRefusedError} when a `config-editor/before-save` listener refuses the edit.
 */
async edit( entry: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>, ): Promise<void>
```

Source: [`packages/boot/config-editor/src/index.ts`](../../packages/boot/config-editor/src/index.ts)

<a id="ctxdoctor--doctorregistry"></a>

### `ctx.doctor` — `DoctorRegistry`

Registers checks and runs them.

```ts cordis-catalog
/**
 * Add a check for the calling plugin's lifetime.
 * @param check - the check; its id must be unused.
 * @returns the disposer that removes it.
 * @throws when another check already has the id.
 */
register(check: DoctorCheck): () => void

/**
 * Run every registered check concurrently, each under the configured deadline.
 * @param signal - cancels every check still running.
 * @returns one result per check, in registration order.
 */
async run(signal: AbortSignal): Promise<DoctorResult[]>
```

Source: [`packages/boot/doctor/src/index.ts`](../../packages/boot/doctor/src/index.ts)

<a id="ctxheadlessstartup--headlessstartupvalues"></a>

### `ctx.headlessStartup` — `HeadlessStartupValues`

What the runner row reads from HEADLESS_STARTUP_SERVICE.

Source: [`packages/bundle/headless/src/startup.ts`](../../packages/bundle/headless/src/startup.ts)

<a id="ctxhmr--hmr"></a>

### `ctx.hmr` — `Hmr`

Hot reload service with Cordis-compatible module configuration and events.

```ts cordis-catalog
/** Serialize a caller-owned mutation with all automatic reload paths.
 * @param operation Work that must not overlap module or configuration replacement.
 * @returns The operation result after its asynchronous work completes.
 */
runExclusive<T>(operation: () => Promise<T>): Promise<T>

/** Watch a configuration path through the same queue as module replacement.
 * @param filename Absolute path, which may not exist yet.
 * @param refresh Rebuilds configuration from its current files and awaits Loader completion.
 * @returns Disposer closing this registration and waiting for its pending refresh.
 */
async watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>

/** Read direct module dependency URLs from the active Node loader.
 * @param url Module URL.
 * @returns Linked module URLs, or an empty list for an uncached module.
 */
async getLinked(url: string): Promise<string[]>

/**
 * Recompose the profile from its manifest and patch files, replacing running plugins whose loaded files below the
 * profile directory or its linked package targets changed on disk, and publishing its runtime resolution. The
 * distribution's {@link ProfileReconcileCheck}, when one is provided, runs first and refuses the recomposition by
 * throwing before anything stops. Changed
 * modules are evicted and the Loader entries running them stop; app-boot's {@link recomposeProfile} then publishes the
 * resolution, applies the generation, starts the stopped entries with the current files and configuration,
 * imports entries whose import failed again, and judges activation. Afterwards the modules below the mappings the
 * recomposition dropped are evicted, so a removed or deselected package is imported afresh when it returns. Callers run
 * inside {@link runExclusive}.
 * @param requiredIds Entry ids whose inactive state is reported as a failure even when it predates this call.
 * @returns Inactive-entry diagnostics, the changed modules that load after a restart, and a profile-wide restart reason.
 * @throws The patch read, publication, preparation, apply, or activation failure of the recomposition, including a
 * replacement plugin that fails to load or start, whose previous code no longer runs; the distribution check's
 * refusal, with everything still running.
 */
async reconcileProfile(requiredIds: readonly string[] = []): Promise<ProfileReconciliation>
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="ctxpluginaudit--pluginaudit"></a>

### `ctx.pluginAudit` — `PluginAudit`

The optional plugin audit, a Service Definition: the manager asks it before it selects an installed bundle and before it enables a bundle, and refuses the change on `needs-acceptance` and `refused`. An installation asks it first after pnpm resolved the package into the lockfile and before any file is fetched or any script runs, and again once the package is installed; a restore asks it before the build scripts it allows run, and again after them. A distribution provides it as `pluginAudit`; without one, nothing is audited and an installation is a single `pnpm add`.

```ts cordis-catalog
/**
 * Audit a package.
 * @param target The package, its directory and the digests the user accepted for it.
 * @returns The findings, their digest and the decision.
 */
audit(target: PluginAuditTarget): Promise<PluginAuditResult>
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="ctxpluginmanager--pluginmanager"></a>

### `ctx.pluginManager` — `PluginManager`

Manage profile files and apply their declared reload lifecycle.

```ts cordis-catalog
/**
 * Read a bundle's long description: the Markdown file its locale `meta.detail` names in `language`, otherwise its
 * README. An installed bundle is read from its directory without network access; an official bundle the installation
 * offers before it is installed is read from the npm file CDNs at its offered version. Nothing is cached.
 * @param name - the bundle's package name, as `listBundles()` lists it.
 * @param language - the display language, such as `zh-CN`; documents fall back through its prefixes to English.
 * @param options - `npmFileSources` names npm file CDNs to ask first for an offered bundle, in order, such as the one
 *   a Client measured as fastest; configured CDNs it omits follow, and CDNs that are not configured are not asked.
 * @returns the document with its origin and path, or `none`.
 * @throws {RemoteError} `plugin-manager/unknown-bundle`, `plugin-manager/invalid-language`, or
 *   `plugin-manager/detail-unavailable`.
 */
@Remote async readBundleDetail(name: string, language: string, options?: { npmFileSources?: NpmFileSource[] }): Promise<BundleDetail>

/** Read exact plugin-version exemptions saved in this profile.
 * @returns Accepted package-name@version keys with the runtime versions they may run on, and any
 * record or file problem the reader rejected, which the caller reports instead of failing.
 */
@Remote listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] }

/** Grant or revoke one exact plugin/runtime exemption and reevaluate live plugins.
 * @param packageVersion Exact manifest package name followed by @ and its version; never an installation spec or alias.
 * @param runtimeVersion Exact current DSH version for grants; revocation may name a previous runtime.
 * @param enabled Whether to grant rather than revoke the exemption.
 * @param acceptRisk Required true for grants after the user accepts possible crashes and data loss.
 * @returns Saved and runtime outcomes. Startup-only profiles require restart.
 */
@Remote setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeResult>

/**
 * Take back the latest change: put the profile back as the version before the latest held it, and apply it. An edit
 * made outside plugin management since the last change is saved as a version first, so it is that edit undo takes
 * back; when the `plugin-manager/before-record` check refuses to save that edit, undo takes it back by restoring the
 * latest version instead. It installs and audits what it brings back as {@link restore} does. The undo is itself a
 * version, so undoing it is another undo.
 * @returns Saved and runtime outcomes, naming the version taken back as `undone`, or the latest version as `restored`
 * when an unsaved edit was taken back, and listing what changed in `changes`. Fails with `nothing-to-undo` when the
 * history holds fewer than two versions, `history-unavailable` when git cannot keep it, and `audit-findings` or
 * `audit-refused` when the plugin audit refuses a package it brings back.
 */
@Remote undo(): Promise<ChangeResult>

/**
 * Put the profile back as one version held it, and apply it: a restored dependency set is installed from the restored
 * lockfile first, and every package the version brings back is audited before any of its code runs. An edit made
 * outside plugin management is saved as a version first. The restore is itself a version.
 * @param version - the version to restore, as {@link history} lists it.
 * @returns Saved and runtime outcomes, naming the version as `restored` and listing what changed in `changes`. Fails
 * with `unknown-version` when the history holds no such version, `history-unavailable` when git cannot keep it, and
 * `audit-findings` or `audit-refused` when the plugin audit refuses a package it brings back.
 */
@Remote restore(version: ProfileVersionId): Promise<ChangeResult>

/**
 * The profile's versions, newest first, after saving an edit made outside plugin management as a version.
 * @param limit - the most to read, from 1 to 500.
 * @returns the versions, with `unsaved` naming why the edit was not saved when `plugin-manager/before-record` refused
 *   it, or why the profile has no history.
 */
@Remote history(limit: number): Promise<ProfileHistoryInfo>

/**
 * The profile's versions, newest first, as the history holds them. Unlike {@link history}, it saves no version for an
 * edit made outside plugin management and never starts the history, so it writes nothing and runs only git reads.
 * @param limit - the most to read, from 1 to 500.
 * @returns the versions, empty before the history starts, or why git cannot read it.
 */
async listHistory(limit: number): Promise<ProfileHistoryInfo>

/**
 * What {@link undo} would put back if it ran now, read without saving a version or starting the history: the version
 * before the latest, or the latest itself when the managed files differ from it, since undo first saves that outside
 * edit and then takes it back.
 * @returns the version undo restores and what it changes, or the refusal undo would end with.
 */
async previewUndo(): Promise<ProfileVersionPreview>

/**
 * What {@link restore} would put back if it ran now, read without saving a version or starting the history.
 * @param version - the version to restore, as {@link history} lists it.
 * @returns the version and what it changes, or the refusal restore would end with.
 */
async previewRestore(version: ProfileVersionId): Promise<ProfileVersionPreview>

/** Read current plugins, including why a row cannot be changed through the profile patch.
 * @returns Current runtime entries with persistent patch targets.
 */
@Remote async listPlugins(): Promise<PluginInfo[]>

/** Read installed, installation-provided, and offline Official catalog bundles, plus selected non-bundle names.
 * A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
 * @returns Package versions, manifest descriptions, the installable spec of profile dependencies, rows, optional
 * display metadata, activation selections, whether the installation offers the bundle, and removal availability.
 */
@Remote listBundles(): Promise<BundleInfo[]>

/** Read the registries this manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names.
 * @returns The registries in pnpm's comparison form; null is the one pnpm's own configuration names, `resolved` as pnpm reads it now.
 */
@Remote async registries(): Promise<PluginRegistries>

/** Read what a spec names before installing it.
 * @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
 * @param options The registry asked first.
 * @param signal Ends a registry lookup early.
 * @returns The package the spec names, or why it is refused.
 */
@Remote async inspect(spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection>

/** Read the published versions newer than an installed registry package's version, from the first registry that answers.
 * Official bundles follow the DSH version and are not listed.
 * @param name Installed profile dependency name.
 * @param options The registry asked first; absent, the one the package was installed from in this process, else the configured one.
 * @param signal Ends the lookups early.
 * @returns At most `versionListLimit` newer versions, newest first, with their tags, deprecation, bundle declaration,
 * and DSH compatibility, and the registry that answered; or why no list could be read, with every registry asked.
 */
@Remote async listVersions(name: string, options?: ListVersionsOptions, signal?: AbortSignal): Promise<PluginVersionList>

/**
 * Replace an installed bundle with a newer version. A registry copy updates to `name@version`, checked on the registry
 * first: it must exist, declare a bundle, and accept the running DSH version, or nothing changes. A Git copy updates
 * to the Git spec `options.spec` names, which must pin a full commit of the repository directory the copy came from;
 * with HMR, a network failure or timeout reaching its repository stops the update before anything changes. pnpm reads
 * a Git package only while installing it, so its bundle and compatibility are checked then. Either target
 * installation is undone, profile files and modules included, before its bundle loads unless it installs `name` at
 * `version`. With HMR the installed version is removed, so its plugins stop, and the target is installed with the same
 * selection; when that installation fails or is cancelled, the removed version is installed again: a registry copy
 * from the registry it came from, a Git copy from its saved spec. Without HMR the target is installed over the running
 * version and the result reports the restart.
 * @param name Installed profile dependency name.
 * @param version Exact version newer than the installed one.
 * @param options The registry asked first, as for `listVersions`; the Git spec of `version`, required for and accepted
 * only by a bundle `listBundles` lists with `update: 'git'`; and the request id naming the progress and the target
 * installation's logs and cancellation.
 * @returns The versions, the last step that ran with its result, and the reinstallation when one ran.
 */
@Remote async updateBundle(name: string, version: string, options?: UpdateBundleOptions): Promise<PluginUpdateResult>

/** Persist a plugin entry's desired enablement and apply it on live profiles.
 * @param id Loader entry identity returned by listPlugins.
 * @param enabled Whether the plugin should run.
 * @returns Saved and runtime outcomes, including higher-priority overrides.
 */
@Remote setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>

/** Select or remove a bundle layer while retaining installed dependencies.
 * @param name Bundle package name.
 * @param enabled Whether the bundle contributes its patch layer.
 * @returns Persisted and runtime outcomes.
 */
@Remote setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>

/**
 * Install a package using the same pnpm implementation as dsh plugin. GitHub
 * repositories get a connection check bounded by githubConnectionTimeoutMs before pnpm starts;
 * only network failures or timeouts stop installation, and a stop streams the check's diagnostic
 * as the installation's install-log run under its request id, while pnpm owns authentication and transport fallback. An
 * HTTP(S) Git URL on another host is installed over SSH instead when access probes bounded by gitTransportTimeoutMs
 * find that only SSH can read it. With a `pluginAudit` provider composed, pnpm first only resolves the package into
 * the lockfile, the audit answers with `pending: 'install'`, and only then pnpm installs the lockfile; without one the
 * installation is a single `pnpm add`. A run
 * that fails, is cancelled, or adds a package without a bundle patch restores
 * `package.json` and `pnpm-lock.yaml` as they were; downloaded files can stay.
 * @param spec One package spec, including local paths relative to the invocation directory.
 * @param options Whether to activate the installed bundle (defaults to true), the request id a cancellation names,
 * the pending build scripts to allow, whether to save an exact dependency, and the registry asked first.
 * @returns Package-manager diagnostics, the registries asked, and the observed activation outcome.
 */
@Remote installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>

/** Recover the result of an active installation without cancelling it.
 * @param requestId The id supplied when installation started.
 * @returns The installation's outcome after it settles, or null if no active request has that id.
 * Completed results are not retained; null establishes neither success nor cancellation.
 */
@Remote async waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null>

/** Stop an installation this manager owns and wait until its files are back.
 * @param requestId The id the installation was started with.
 * @returns `cancelled` once the Git check or pnpm exited and the files are restored, `too-late` once the bundle is being
 * applied, `not-running` for any other id.
 */
@Remote async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation>

/** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path; a selected name no
 * dependency holds is only deselected.
 * @param name Installed dependency or selected bundle name.
 * @returns Removal diagnostics and the remaining profile state.
 */
@Remote removeBundle(name: string): Promise<ChangeResult>
```

Source: [`packages/boot/plugin-manager/src/index.ts`](../../packages/boot/plugin-manager/src/index.ts)

<a id="ctxpluginmarket--pluginmarket"></a>

### `ctx.pluginMarket` — `PluginMarket`

Fetches, validates, and caches configured market indexes; annotates entries with the profile's installation facts.

```ts cordis-catalog
/**
 * List the configured index sources without fetching them.
 * @returns every source in order, with the title of its last successful read and, when the last read failed, its error.
 */
@Remote listIndexes(): MarketIndexSummary[]

/**
 * Replace the configured index sources through Settings, without remounting this service.
 * `plugin-market/changed` announces the committed list. A URL already configured is kept as written, so a client can
 * add or remove sources beside one that `listIndexes` reports as unusable.
 * @param urls - index URLs in display order.
 * @throws {RemoteError} `plugin-market/invalid-index-url` for an invalid new URL or a repeated URL;
 * `plugin-market/settings-unavailable` without Settings or a profile entry.
 */
@Remote async setIndexes(urls: string[]): Promise<void>

/**
 * Return one page of the plugins of a configured index that match a query. Concurrent reads of a URL share one
 * fetch; a successful document is reused for `cacheTtlMs` unless `refresh` is set. Matching and ordering read only
 * the document; installation status and compatibility are computed for the returned page on every call.
 * @param url - a configured index URL.
 * @param query - text, filters, order, page, and whether to bypass the cached document.
 * @returns the index header, the page's plugins with each plugin's default version and installation status and each
 *   version's compatibility and install arguments, the number of matches, and the next page's offset.
 * @throws {RemoteError} `plugin-market/invalid-query`, `plugin-market/unknown-index`, `plugin-market/invalid-index-url`,
 *   `plugin-market/fetch-failed`, or `plugin-market/invalid-index`.
 */
@Remote async search(url: string, query: MarketQuery): Promise<MarketSearchResult>

/**
 * Read one plugin of a configured index, using the cached document as `search` does.
 * @param url - a configured index URL.
 * @param name - the plugin's package name.
 * @returns the plugin with its default version, installation status, and annotated versions; undefined when the
 *   index does not list it.
 * @throws {RemoteError} `plugin-market/unknown-index`, `plugin-market/invalid-index-url`, `plugin-market/fetch-failed`,
 *   or `plugin-market/invalid-index`.
 */
async entry(url: string, name: string): Promise<MarketListingEntry | undefined>

/**
 * Read the long description of one listed version of a plugin market entry, from the version's source: the npm file
 * CDNs for a public npm version, or its pinned Git commit. The Markdown file the package's locale `meta.detail` names
 * in `language` comes first, then the package's README, then the README of the entry's `repository`, or for an npm
 * version without one, of its `package.json` `repository`, at the default branch. An npm version from another
 * registry has no readable package files, so only the entry's `repository` is read.
 * @param url - a configured index URL.
 * @param name - the plugin's package name.
 * @param version - one listed version.
 * @param language - the display language, such as `zh-CN`; documents fall back through its prefixes to English.
 * @param options - `refresh` reads again instead of reusing a result cached for `cacheTtlMs`; `npmFileSources` names
 *   npm file CDNs to ask first for an npm version, in order; configured CDNs it omits follow, and CDNs that are not
 *   configured are not asked.
 * @returns the document with its origin and image document id, or `none`.
 * @throws {RemoteError} the failures of `search`, `plugin-market/unknown-plugin` for an unlisted plugin or version,
 *   `plugin-market/invalid-query`, or `plugin-market/detail-unavailable`.
 */
@Remote async readEntryDetail( url: string, name: string, version: string, language: string, options?: { refresh?: boolean; npmFileSources?: NpmFileSource[] }, ): Promise<PluginDetail>
```

Source: [`packages/boot/plugin-market/src/index.ts`](../../packages/boot/plugin-market/src/index.ts)

<a id="ctxpluginrecommendations--pluginrecommendations"></a>

### `ctx.pluginRecommendations` — `PluginRecommendations`

Catalog lookups for card text and the enabling behind the `enable_official_plugin` card.

```ts cordis-catalog
/**
 * Read the current catalog text for a logged card.
 * @param agent - Exact live root resolved by the Gateway from the Session id.
 * @param callId - The card's `propose_action` call id, never a package supplied by the browser.
 * @returns the plugin's title, description and selection, or a refusal when the card names no available official plugin.
 */
@Remote async describe(agent: Agent, callId: ToolCallId): Promise<RecommendationDetails>
```

Types: [Agent](core.zh.md) · [ToolCallId](core.zh.md)

Source: [`packages/experimental/plugin-recommendations/src/index.ts`](../../packages/experimental/plugin-recommendations/src/index.ts)

<a id="ctxpluginregistryprobe--pluginregistryprobe"></a>

### `ctx.pluginRegistryProbe` — `PluginRegistryProbe`

Compares public registry responses on the Host; the Client owns the initial selection.

```ts cordis-catalog
/**
 * Race npm and npmmirror HTTPS ping responses through the Host's fetch proxy.
 * Concurrent readers share a probe; a winner cancels and awaits the other request.
 * @returns the first registry with a successful response, or null when disabled or neither responds successfully; results are cached.
 * @throws rejects when the service has been unloaded.
 */
@Remote async fastest(): Promise<string | null>
```

Source: [`packages/client/ui-plugin-manager/src/index.ts`](../../packages/client/ui-plugin-manager/src/index.ts)

<a id="ctxprofilecontext--profilecontext"></a>

### `ctx.profileContext` — `ProfileContext`

Current profile facts; scheduling and mutation belong to their callers.

Source: [`packages/boot/app-boot/src/profile-context.ts`](../../packages/boot/app-boot/src/profile-context.ts)

<a id="ctxprofilehomepatch--profilehomepatch"></a>

### `ctx.profileHomePatch` — `ProfileHomePatch`

The home patch's half of a profile version, a Service Definition: the patch layer at the Harness home (`cordis.patch.yml`), which applies over every profile's own layer and which the history's work tree, the profile directory, cannot hold. A distribution provides it as `profileHomePatch`; the manager then mirrors the home patch into the profile before it saves a version, so a version covers both patch layers, and writes a version's home patch back when it restores one. Without one, a version covers the profile's files alone, as upstream's does.

```ts cordis-catalog
/**
 * Write the home patch's current text into the profile, so the version saved next holds the home layer.
 * @returns the text the profile held before, so a version the admission refuses can put it back.
 */
mirror(): Promise<string | undefined>

/**
 * Put the profile's copy of the home patch back as it was, after a version the admission refused.
 * @param text - what `mirror` returned.
 */
restoreCopy(text: string | undefined): Promise<void>

/**
 * Whether a version's home patch differs from the home's now.
 * @param version - the version.
 * @returns true when the version holds a home patch that differs from the home's.
 */
differs(version: ProfileVersionId): Promise<boolean>

/**
 * Write a version's home patch to the home.
 * @param version - the version.
 * @returns whether the home patch changed.
 */
restore(version: ProfileVersionId): Promise<boolean>
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="ctxprofilereconcilecheck--profilereconcilecheck"></a>

### `ctx.profileReconcileCheck` — `ProfileReconcileCheck`

A check the distribution runs before every profile recomposition, provided as the optional `profileReconcileCheck` service. It runs inside Hmr.runExclusive, before any running plugin stops or any module is evicted, so it may rewrite the profile's files the recomposition reads; a caller such as the plugin manager may hold the profile's `package.json` file lock at that moment, so the check must not wait for that lock while its own process holds it.

```ts cordis-catalog
/**
 * Check, and prepare, the profile's files before HMR recomposes the profile from them.
 * @param profile The profile about to be recomposed.
 * @throws Any error to refuse the recomposition: nothing stops, nothing loads, and {@link Hmr.reconcileProfile}
 * rejects with that error.
 */
check(profile: ProfileContext): Promise<void>
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="app-boot-events"></a>

### `app-boot/*` events

<a id="app-bootconfig-reload--emit"></a>

#### `app-boot/config-reload` — emit

Profile patches were reconciled into the running Loader tree: every entry update settled and no new inactive entry was introduced. Carries no diff; listeners re-read Loader entries.

```ts cordis-catalog
/**
 * Profile patches were reconciled into the running Loader tree: every entry update settled and no new
 * inactive entry was introduced. Carries no diff; listeners re-read Loader entries.
 * @mode emit
 */
'app-boot/config-reload'(): void
```

Source: [`packages/boot/app-boot/src/index.ts`](../../packages/boot/app-boot/src/index.ts)

<a id="config-editor-events"></a>

### `config-editor/*` events

<a id="config-editorbefore-save--bail"></a>

#### `config-editor/before-save` — bail

Admit an edit before it is saved: called under the profile's lock, after the candidate config passed the plugin's schema and before the profile patch is written. A returned reason refuses the edit, which then throws ConfigEditRefusedError with that reason and leaves the file unchanged.

```ts cordis-catalog
/**
 * Admit an edit before it is saved: called under the profile's lock, after the candidate config passed the
 * plugin's schema and before the profile patch is written. A returned reason refuses the edit, which then throws
 * {@link ConfigEditRefusedError} with that reason and leaves the file unchanged.
 * @mode bail
 * @param save - the entry and the complete config the profile patch would hold for it.
 */
'config-editor/before-save'(save: ConfigSave): string | undefined
```

Source: [`packages/boot/config-editor/src/index.ts`](../../packages/boot/config-editor/src/index.ts)

<a id="config-editoredited--emit"></a>

#### `config-editor/edited` — emit

An edit was saved to the profile patch and applied: emitted after the profile's lock is released, in the caller's asynchronous context, so a listener can name who made it.

```ts cordis-catalog
/**
 * An edit was saved to the profile patch and applied: emitted after the profile's lock is released, in the
 * caller's asynchronous context, so a listener can name who made it.
 * @mode emit
 * @param edit - the profile patch id of the entry whose configuration changed.
 */
'config-editor/edited'(edit: ConfigEdit): void
```

Source: [`packages/boot/config-editor/src/index.ts`](../../packages/boot/config-editor/src/index.ts)

<a id="hmr-events"></a>

### `hmr/*` events

<a id="hmrchange--emit"></a>

#### `hmr/change` — emit

A watched file has no module or configuration handler.

```ts cordis-catalog
/** A watched file has no module or configuration handler.
 * @mode emit
 * @param url Canonical file URL.
 */
'hmr/change'(url: string): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="hmrreload--emit"></a>

#### `hmr/reload` — emit

Module replacements have finished loading.

```ts cordis-catalog
/** Module replacements have finished loading.
 * @mode emit
 * @param reloads Replaced plugins and their module locations.
 */
'hmr/reload'(reloads: Map<Plugin, Reload>): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="plugin-manager-events"></a>

### `plugin-manager/*` events

<a id="plugin-managerbefore-record--bail"></a>

#### `plugin-manager/before-record` — bail

Admit a version of the profile before the history saves it, from the managed files as they are about to be saved. A returned reason refuses the version: nothing is saved, and the change, undo, restore or history read that asked for it reports the history as unavailable with that reason.

```ts cordis-catalog
/**
 * Admit a version of the profile before the history saves it, from the managed files as they are about to be
 * saved. A returned reason refuses the version: nothing is saved, and the change, undo, restore or history read
 * that asked for it reports the history as unavailable with that reason.
 * @mode bail
 * @param files - each managed file's text, by name relative to the profile, or undefined for an absent file.
 */
'plugin-manager/before-record'(files: ReadonlyMap<string, string | undefined>): string | undefined
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerchanged--emit"></a>

#### `plugin-manager/changed` — emit

The profile's plugins, bundles, or composition changed: a manager operation completed. A patch generation applied outside the manager, by HMR's watcher after a CLI or hand edit, announces nothing here.

```ts cordis-catalog
/**
 * The profile's plugins, bundles, or composition changed: a manager
 * operation completed. A patch generation applied outside the manager,
 * by HMR's watcher after a CLI or hand edit, announces nothing here.
 * @mode emit
 * @param change - what changed.
 */
'plugin-manager/changed'(change: PluginChange): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-log--emit"></a>

#### `plugin-manager/install-log` — emit

One chunk of an installation run's output, streamed as the run produces it.

```ts cordis-catalog
/**
 * One chunk of an installation run's output, streamed as the run produces it.
 * @mode emit
 * @param chunk - the chunk and the run it belongs to.
 */
'plugin-manager/install-log'(chunk: PluginInstallLogChunk): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-state--emit"></a>

#### `plugin-manager/install-state` — emit

An installation moved between its Host phases. `installing` is announced once per registry the installation asks, with the attempt's registry and position; `cancelling` and `applying` once.

```ts cordis-catalog
/**
 * An installation moved between its Host phases. `installing` is announced once per registry the
 * installation asks, with the attempt's registry and position; `cancelling` and `applying` once.
 * @mode emit
 * @param progress - the installation's request id and phase, with the attempt while installing.
 */
'plugin-manager/install-state'(progress: PluginInstallProgress): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-manageroperation--parallel"></a>

#### `plugin-manager/operation` — parallel

One manager invocation started or ended; subscribers run independently without delaying management.

```ts cordis-catalog
/**
 * One manager invocation started or ended; subscribers run independently without delaying management.
 * @mode parallel
 * @param operation - Correlated operation facts; a start without an end has an unknown outcome.
 */
'plugin-manager/operation'(operation: PluginOperation): void | Promise<void>
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerupdate-state--emit"></a>

#### `plugin-manager/update-state` — emit

An update moved to its next step: checking the target, removing the installed version, installing the target, or reinstalling the removed version after the target failed. Announced once per step.

```ts cordis-catalog
/**
 * An update moved to its next step: checking the target, removing the installed version, installing the target,
 * or reinstalling the removed version after the target failed. Announced once per step.
 * @mode emit
 * @param progress - the update's request id and step.
 */
'plugin-manager/update-state'(progress: PluginUpdateProgress): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-market-events"></a>

### `plugin-market/*` events

<a id="plugin-marketchanged--emit"></a>

#### `plugin-market/changed` — emit

The configured index sources changed.

```ts cordis-catalog
/**
 * The configured index sources changed.
 * @mode emit
 */
'plugin-market/changed'(): void
```

Source: [`packages/boot/plugin-market/src/types.ts`](../../packages/boot/plugin-market/src/types.ts)
<!-- END GENERATED cordis-surface -->
