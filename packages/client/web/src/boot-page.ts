/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer. When
 * the page names a distribution's recovery routes (`dshRecoveryRoutes`), the
 * failure report, the page at `/recovery`, and a page that has not mounted in
 * time also show a recovery screen built from DOM elements alone: what failed,
 * Turn off, Undo, safe mode and, when the page names the update routes too (`dshRecoveryUpdateRoutes`), going back
 * to the release before the last update, posted to those routes.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Create an element with one module class and optional text. */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string | undefined, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  return element('div', className, text)
}

/**
 * The `globalThis` property through which a distribution names its product on the boot page, set by a `global` index
 * injection row before the page loads.
 */
export const BOOT_WORDMARK_GLOBAL = 'dshBootWordmark'

/** Longest product name the boot page shows; a longer value keeps the default wordmark. */
const WORDMARK_MAX_LENGTH = 40

/**
 * The wordmark the boot page shows.
 * @param scope - the object holding the page global; `globalThis` by default.
 * @returns the distribution's product name when one is set and fits, otherwise `HARNESS`.
 */
export function bootWordmark(scope: object = globalThis): string {
  const value: unknown = Reflect.get(scope, BOOT_WORDMARK_GLOBAL)
  return typeof value === 'string' && value.trim() !== '' && value.length <= WORDMARK_MAX_LENGTH ? value : 'HARNESS'
}

/**
 * The `globalThis` property through which a distribution names the path prefix of its recovery routes, set by a
 * `global` index injection row. Without it the boot page offers no recovery screen.
 */
export const RECOVERY_ROUTES_GLOBAL = 'dshRecoveryRoutes'

/**
 * The `globalThis` property through which a distribution names the path prefix of its update routes, set by a `global`
 * index injection row. The recovery screen offers "Roll back" only on a page that names it; its `state` route answers
 * `rollback.available`, and its `rollback` route is posted with `{ chats, profileOnly }`.
 */
export const RECOVERY_UPDATE_ROUTES_GLOBAL = 'dshRecoveryUpdateRoutes'

/** The page path that shows the recovery screen instead of loading any client plugin. */
export const RECOVERY_PATH = '/recovery'

/** How long the boot page waits for the application to mount before it offers the recovery screen. */
export const RECOVERY_AFTER_MS = 30_000

/**
 * The recovery routes' prefix the page names.
 * @param scope - the object holding the page global; `globalThis` by default.
 * @returns the prefix, such as `/delorun/changes`, or undefined when the page names none or names one that is not a path.
 */
export function recoveryRoutes(scope: object = globalThis): string | undefined {
  const value: unknown = Reflect.get(scope, RECOVERY_ROUTES_GLOBAL)
  return typeof value === 'string' && /^(?:\/[a-z0-9-]+)+$/.test(value) ? value : undefined
}

/**
 * The update routes' prefix the page names.
 * @param scope - the object holding the page global; `globalThis` by default.
 * @returns the prefix, such as `/delorun/update`, or undefined when the page names none or names one that is not a path.
 */
export function recoveryUpdateRoutes(scope: object = globalThis): string | undefined {
  const value: unknown = Reflect.get(scope, RECOVERY_UPDATE_ROUTES_GLOBAL)
  return typeof value === 'string' && /^(?:\/[a-z0-9-]+)+$/.test(value) ? value : undefined
}

/** The recovery screen's words in each language it speaks. */
const RECOVERY_TEXT = {
  en: {
    title: 'Recovery',
    intro: 'Turn off a plugin, undo a recent change, or start in safe mode.',
    loading: 'Loading…',
    unreadable: 'Recovery could not read what failed: ',
    atComputer: 'This needs you at your computer.',
    failed: 'What failed',
    nothingFailed: 'Nothing failed at the last start.',
    notLoaded: 'did not load',
    plugins: 'Plugins',
    turnOff: 'Turn off',
    recent: 'Recent changes',
    noRecent: 'No changes yet.',
    undo: 'Undo',
    safeMode: 'Safe mode',
    safeModeHint: 'The next start leaves out every plugin Delorun does not ship.',
    safeModeOn: 'Safe mode is on since ',
    startSafeMode: 'Start in safe mode',
    leaveSafeMode: 'Leave safe mode',
    confirmLeaveSafeMode: 'Leave safe mode? The next start loads your whole profile again.',
    rollback: 'Go back',
    rollbackHint: 'Delorun {0} started after an update. Going back returns to {1}; chats made since are set aside, not deleted.',
    rollbackNoCopy: 'No copy of your chats was taken before the update, so only your settings can go back; the chats stay as they are.',
    rollBack: 'Roll back to {0}',
    rollBackSettings: 'Go back to {0} (settings only)',
    confirmRollback: 'Roll back to {0}? Running chats finish first, then Delorun restarts.',
    confirmRollbackSettings: 'Go back to {0} with your settings only? Your chats stay as they are, and Delorun restarts.',
    rollbackBegun: 'Going back to {0}. This page loses its connection for a moment; reload it when Delorun is back.',
    confirmOff: 'Turn off {0}? It stops running until you turn it on again.',
    confirmUndo: 'Undo {0}?',
    confirmSafeMode: 'Start in safe mode next time?',
    working: 'Working…',
    done: 'Done.',
    wentBack: 'Delorun failed to load it and went back: ',
    restart: 'Restart Delorun to load it: delorun stop, then delorun start.',
    notDone: 'It did not work: ',
  },
  zh: {
    title: '恢复',
    intro: '关闭某个插件、撤销最近的更改，或以安全模式启动。',
    loading: '正在加载…',
    unreadable: '恢复页面无法读取失败信息：',
    atComputer: '这需要你在自己的电脑前操作。',
    failed: '失败的内容',
    nothingFailed: '上次启动时没有失败项。',
    notLoaded: '未加载',
    plugins: '插件',
    turnOff: '关闭',
    recent: '最近的更改',
    noRecent: '暂无更改。',
    undo: '撤销',
    safeMode: '安全模式',
    safeModeHint: '下次启动将不加载 Delorun 自带插件以外的任何插件。',
    safeModeOn: '安全模式已开启，开始于 ',
    startSafeMode: '以安全模式启动',
    leaveSafeMode: '退出安全模式',
    confirmLeaveSafeMode: '要退出安全模式吗？下次启动会重新加载你的整个 profile。',
    rollback: '回滚',
    rollbackHint: 'Delorun {0} 在一次更新后启动。回滚会回到 {1}；此后产生的对话会被搁置，不会被删除。',
    rollbackNoCopy: '更新前没有备份对话数据，因此只能回滚你的设置；对话保持原样。',
    rollBack: '回滚到 {0}',
    rollBackSettings: '回到 {0}（仅设置）',
    confirmRollback: '要回滚到 {0} 吗？正在运行的对话会先结束，然后 Delorun 重新启动。',
    confirmRollbackSettings: '要只用你的设置回到 {0} 吗？对话保持原样，Delorun 会重新启动。',
    rollbackBegun: '正在回到 {0}。此页面会短暂断开；Delorun 恢复后请刷新。',
    confirmOff: '要关闭 {0} 吗？在你重新开启之前它不会运行。',
    confirmUndo: '要撤销 {0} 吗？',
    confirmSafeMode: '下次以安全模式启动吗？',
    working: '正在处理…',
    done: '已完成。',
    wentBack: 'Delorun 加载失败，已恢复到之前的状态：',
    restart: '重新启动 Delorun 后生效：先运行 delorun stop，再运行 delorun start。',
    notDone: '操作未成功：',
  },
} as const

/** One language's words. */
type RecoveryText = { readonly [K in keyof typeof RECOVERY_TEXT.en]: string }

/**
 * The recovery screen's words in the browser's language.
 * @param language - the browser's language, such as `zh-CN`.
 * @returns the words for it: Chinese for a `zh` language, English otherwise.
 */
export function recoveryText(language: string | undefined): RecoveryText {
  return language?.toLowerCase().startsWith('zh') === true ? RECOVERY_TEXT.zh : RECOVERY_TEXT.en
}

/** What the recovery screen reaches outside the page; the browser's own by default. */
export interface RecoveryEnvironment {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  readonly confirm: (question: string) => boolean
  readonly language: string | undefined
}

/** One logged change as the state route answers it. */
interface RecoveryEntry {
  readonly id: string
  readonly summary: string
  readonly state: string
  readonly undoable?: boolean
  readonly lastFailure?: { readonly failure: string }
}

/** The state route's answer, read as data: every field is checked before it is shown. */
interface RecoveryState {
  readonly atComputer: boolean
  readonly failures: readonly string[]
  readonly plugins: readonly string[]
  readonly recent: readonly RecoveryEntry[]
  readonly safeModeSince?: string
}

/** What the update routes' `state` answers that the recovery screen shows: whether a rollback is possible. */
interface RollbackState {
  readonly to: string
  readonly from: string
  readonly dataCopyMissing: boolean
}

/**
 * @param value - a JSON value.
 * @returns it as a record, or an empty one.
 */
function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * @param value - a JSON value.
 * @returns the records it lists, or none.
 */
function records(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.map(record) : []
}

/**
 * @param value - a JSON value.
 * @returns it when it is a string.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Read the update routes' answer.
 * @param body - the parsed JSON.
 * @returns the rollback on offer, or undefined when none is.
 */
function readRollback(body: unknown): RollbackState | undefined {
  const state = record(body)
  const rollback = record(state.rollback)
  const to = text(rollback.to)
  const from = text(record(state.release).delorun)
  if (state.available !== true || rollback.available !== true || to === undefined || from === undefined) return undefined
  return { to, from, dataCopyMissing: rollback.dataCopyMissing === true }
}

/**
 * Read the state route's answer.
 * @param body - the parsed JSON.
 * @param words - the screen's words.
 * @returns what the screen shows.
 */
function readState(body: unknown, words: RecoveryText): RecoveryState {
  const state = record(body)
  const lastStart = record(state.lastStart)
  const plugins = records(lastStart.plugins)
  const failure = text(lastStart.failure)
  const failures = [
    ...failure === undefined ? [] : [failure],
    ...plugins.filter(plugin => plugin.loaded === false).map(plugin => `${String(text(plugin.plugin))}: ${text(plugin.error) ?? words.notLoaded}`),
    ...records(state.leftOut).map(entry => `${String(text(entry.summary))}: ${text(record(entry.lastFailure).failure) ?? words.notLoaded}`),
    ...Array.isArray(state.problems) ? state.problems.flatMap(problem => text(problem) ?? []) : [],
  ]
  const recent = records(state.recent).flatMap((entry): RecoveryEntry[] => {
    const id = text(entry.id)
    return id === undefined ? [] : [{ id, summary: text(entry.summary) ?? id, state: text(entry.state) ?? '', undoable: entry.undoable === true }]
  })
  const since = text(record(state.safeMode).since)
  return {
    atComputer: state.atComputer === true,
    failures,
    plugins: plugins.flatMap(plugin => text(plugin.plugin) ?? []),
    recent,
    ...since === undefined ? {} : { safeModeSince: since },
  }
}

/**
 * The recovery screen: what failed, the plugins and recent changes with Turn off and Undo, and safe mode, read from and
 * posted to the distribution's recovery routes. It needs no client plugin, every string it shows from the routes is
 * set as text, and its words come in English and Chinese.
 */
class RecoveryScreen {
  readonly element: HTMLElement
  private readonly words: RecoveryText
  private readonly notice: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly body: HTMLDivElement

  /**
   * @param routes - the recovery routes' prefix.
   * @param environment - the browser's fetch, confirmation and language.
   * @param updateRoutes - the update routes' prefix, when the page names one: it offers Roll back.
   */
  constructor(
    private readonly routes: string,
    private readonly environment: RecoveryEnvironment,
    private readonly updateRoutes: string | undefined = undefined,
  ) {
    this.words = recoveryText(environment.language)
    this.element = element('section', css.recovery)
    this.element.dataset.dshRecovery = ''
    this.element.lang = this.words === RECOVERY_TEXT.zh ? 'zh' : 'en'
    this.element.setAttribute('aria-labelledby', 'dsh-recovery-title')
    const title = element('h1', css.recoveryTitle, this.words.title)
    title.id = 'dsh-recovery-title'
    title.tabIndex = -1
    this.notice = div(css.recoveryNotice)
    this.notice.setAttribute('role', 'alert')
    this.status = div(css.recoveryStatus)
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    this.body = div(undefined, this.words.loading)
    this.element.append(title, div(css.hint, this.words.intro), this.notice, this.status, this.body)
    void this.load()
  }

  /** Read the state route and show it. */
  async load(): Promise<void> {
    let state: RecoveryState
    try {
      const response = await this.environment.fetch(`${this.routes}/state`)
      if (!response.ok) throw new Error(`${String(response.status)} ${text(record(await response.json().catch(() => ({}))).message) ?? ''}`.trim())
      state = readState(await response.json(), this.words)
    } catch (error) {
      this.body.replaceChildren(div(css.failedItem, `${this.words.unreadable}${error instanceof Error ? error.message : String(error)}`))
      return
    }
    if (!state.atComputer) this.notice.textContent = this.words.atComputer
    const rollback = await this.readRollbackOffer()
    const lines = (items: readonly string[], empty: string): HTMLElement[] =>
      (items.length === 0 ? [empty] : items).map(line => div(css.failedItem, line))
    const plugins = state.plugins.map(plugin =>
      this.row(plugin, this.words.turnOff, 'off', { plugin }, this.words.confirmOff.replace('{0}', plugin)))
    const recent = state.recent.map(entry => entry.undoable === true
      ? this.row(`${entry.summary} (${entry.state})`, this.words.undo, 'undo', { id: entry.id }, this.words.confirmUndo.replace('{0}', entry.summary))
      : div(css.failedItem, `${entry.summary} (${entry.state})`))
    this.body.replaceChildren(
      this.section(this.words.failed, lines(state.failures, this.words.nothingFailed)),
      ...plugins.length === 0 ? [] : [this.section(this.words.plugins, plugins)],
      this.section(this.words.recent, recent.length === 0 ? lines([], this.words.noRecent) : recent),
      ...rollback === undefined || this.updateRoutes === undefined ? [] : [this.rollbackSection(rollback, this.updateRoutes)],
      this.section(this.words.safeMode, state.safeModeSince === undefined
        ? [div(css.hint, this.words.safeModeHint), this.button(this.words.startSafeMode, 'safe-mode', {}, this.words.confirmSafeMode)]
        : [div(css.failedItem, `${this.words.safeModeOn}${state.safeModeSince}`), this.button(this.words.leaveSafeMode, 'exit-safe-mode', {}, this.words.confirmLeaveSafeMode)]),
    )
  }

  /**
   * Read whether the update routes offer a rollback. A page without them, or a Host that cannot answer, offers none.
   * @returns the offer, or undefined.
   */
  private async readRollbackOffer(): Promise<RollbackState | undefined> {
    if (this.updateRoutes === undefined) return undefined
    try {
      const response = await this.environment.fetch(`${this.updateRoutes}/state`)
      return response.ok ? readRollback(await response.json()) : undefined
    } catch (error) {
      console.warn('recovery: the update state was not read, so no rollback is offered:', error)
      return undefined
    }
  }

  /**
   * @param offer - the rollback on offer.
   * @param base - the update routes' prefix.
   * @returns the section with Roll back, or with the settings-only choice when no copy of the chats exists.
   */
  private rollbackSection(offer: RollbackState, base: string): HTMLElement {
    const fill = (template: string): string => template.replace('{0}', offer.to)
    return this.section(this.words.rollback, [
      div(css.hint, this.words.rollbackHint.replace('{0}', offer.from).replace('{1}', offer.to)),
      ...offer.dataCopyMissing ? [div(css.hint, this.words.rollbackNoCopy)] : [],
      this.button(
        fill(offer.dataCopyMissing ? this.words.rollBackSettings : this.words.rollBack), 'rollback', { chats: 'wait', profileOnly: offer.dataCopyMissing },
        fill(offer.dataCopyMissing ? this.words.confirmRollbackSettings : this.words.confirmRollback), base,
      ),
    ])
  }

  /**
   * @param heading - the section's heading.
   * @param children - its content.
   * @returns the section.
   */
  private section(heading: string, children: readonly HTMLElement[]): HTMLElement {
    const section = element('section', undefined)
    section.append(element('h2', css.failedTitle, heading), ...children)
    return section
  }

  /**
   * @param label - what the row names.
   * @param action - the button's label.
   * @param path - the action route under the prefix.
   * @param body - the request's body.
   * @param question - the confirmation.
   * @returns a row with its label and one action.
   */
  private row(label: string, action: string, path: string, body: object, question: string): HTMLElement {
    const row = div(css.recoveryRow)
    const button = this.button(action, path, body, question)
    button.setAttribute('aria-label', `${action}: ${label}`)
    row.append(div(css.failedItem, label), button)
    return row
  }

  /**
   * @param label - the button's label.
   * @param path - the action route under the prefix.
   * @param body - the request's body.
   * @param question - the confirmation.
   * @param base - the routes' prefix; the recovery routes' by default.
   * @returns the button.
   */
  private button(label: string, path: string, body: object, question: string, base: string = this.routes): HTMLButtonElement {
    const button = element('button', css.recoveryButton, label)
    button.type = 'button'
    button.addEventListener('click', () => { void this.act(path, body, question, base) })
    return button
  }

  /**
   * Ask, post one action and show what it did.
   * @param path - the action route under the prefix.
   * @param body - the request's body.
   * @param question - the confirmation.
   * @param base - the routes' prefix the path is under.
   */
  private async act(path: string, body: object, question: string, base: string): Promise<void> {
    if (!this.environment.confirm(question)) return
    this.notice.textContent = ''
    this.status.textContent = this.words.working
    let answer: Readonly<Record<string, unknown>>
    let response: Response
    try {
      response = await this.environment.fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      answer = record(await response.json().catch(() => ({})))
    } catch (error) {
      this.status.textContent = ''
      this.notice.textContent = `${this.words.notDone}${error instanceof Error ? error.message : String(error)}`
      return
    }
    this.status.textContent = ''
    if (response.status === 403 && (answer.code === 'LOOPBACK_REQUIRED' || answer.code === 'ELEVATION_REQUIRED')) {
      this.notice.textContent = this.words.atComputer
      return
    }
    if (!response.ok) {
      this.notice.textContent = `${this.words.notDone}${text(answer.message) ?? String(response.status)}`
      return
    }
    const reload = record(answer.reload)
    const lines = Array.isArray(answer.lines) ? answer.lines.flatMap(line => text(line) ?? []) : []
    if (path === 'rollback') {
      this.status.textContent = this.words.rollbackBegun.replace('{0}', text(answer.target) ?? '')
      return
    }
    this.status.textContent = reload.kind === 'went-back'
      ? `${this.words.wentBack}${text(reload.failure) ?? ''}`
      : [this.words.done, ...lines, ...reload.kind === 'not-running' || path === 'safe-mode' ? [this.words.restart] : []].join(' ')
    await this.load()
  }
}

/**
 * @returns the browser's fetch, confirmation dialog and language.
 */
function browserEnvironment(): RecoveryEnvironment {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),
    confirm: question => globalThis.confirm(question),
    language: globalThis.navigator.language,
  }
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined
  private recovery: RecoveryScreen | undefined
  private recovering = false

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   * @param environment - what the recovery screen reaches; the browser's fetch, confirmation and language by default.
   */
  constructor(container: HTMLElement, private readonly environment: RecoveryEnvironment = browserEnvironment()) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.wordmark = div(css.wordmark, bootWordmark())
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'Loading plugins…')
    this.card.append(this.wordmark, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /**
   * Show the recovery screen below any failure report, when the page names recovery routes: at {@link RECOVERY_PATH},
   * and when the application has not mounted after {@link RECOVERY_AFTER_MS}.
   * @returns whether the page names recovery routes, so the screen shows.
   */
  recover(): boolean {
    if (recoveryRoutes() === undefined) return false
    this.recovering = true
    this.render()
    return true
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /**
   * The recovery screen, built once, when the page names recovery routes.
   * @returns its element, or undefined without routes.
   */
  private recoveryElement(): HTMLElement | undefined {
    const routes = recoveryRoutes()
    if (routes === undefined) return undefined
    this.recovery ??= new RecoveryScreen(routes, this.environment, recoveryUpdateRoutes())
    return this.recovery.element
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0 && !this.recovering) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
      }
      return
    }
    const report = div(css.failed)
    if (this.failure !== undefined || failed.length > 0) {
      report.append(div(css.failedTitle, 'Failed to load plugins'))
      for (const id of failed) report.append(div(css.failedItem, id))
      if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    }
    const recovery = this.recoveryElement()
    const shown = recovery?.isConnected === true
    this.card.replaceChildren(this.wordmark, ...report.childElementCount === 0 ? [] : [report], ...recovery === undefined ? [] : [recovery])
    if (recovery !== undefined && !shown) recovery.querySelector<HTMLElement>('h1')?.focus()
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
