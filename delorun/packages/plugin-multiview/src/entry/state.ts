/**
 * The per-chat Multiview state behind the `multiview` service: pins, layout, open flag and the arrangement each chat follows,
 * each chat's kept in this browser through {@link MultiviewPersistence}; and the defaults for new Multiviews (the default layout,
 * "Yours", the Main and stack options and the main share), kept in the Host's settings for the studio or a workspace so every
 * device sees them. Pins are the source of truth; the layout only places them and is reconciled with the pins on every change.
 * @module @delorun/plugin-multiview/entry/state
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MultiviewSettings, RememberScope } from '../config.ts'
import {
  arrangeLayout, capacityRefusal, clampShare, cycleChoice, DEFAULT_PRESET, layoutOf, MAIN_SHARE_STEP, reconcileLayout, resizePaneShare,
  shapeOf, slotOrder,
  type CapacityRefusal, type ChatArrangement, type LayoutArea, type LayoutChoiceId, type LayoutLimits, type LayoutModel, type LayoutNode,
  type LayoutPreset, type LegacyLayoutPreset, type MainSide, type PaneActivity, type PaneId, type StackStyle,
} from '../layout/index.ts'
import {
  EMPTY_CHAT_MULTIVIEW, type AdoptReason, type AdoptResult, type ChatMultiview, type DefaultsRevision, type LayoutDefaults, type MultiviewPersistence,
  type MultiviewService, type PinResult,
} from '../client/contract.ts'
import { effectiveScope, planDefaults, planResetToAuto, resolveDefaults, type DefaultValues, type SettingsPatch } from '../store/scope.ts'

/** What the store needs from its surroundings. */
export interface MultiviewStoreOptions {
  /** The settings now in force. */
  readonly settings: HostObservable<MultiviewSettings>
  /** Where chats' state is kept. */
  readonly persistence: MultiviewPersistence
  /** The window's size, used for "screen full" until the layout reports its own area. */
  readonly windowArea: () => LayoutArea
}

/**
 * The limits the settings give.
 * @param settings - the multiview settings.
 * @returns the pane count, the minimum pane size and the space between panes they allow.
 */
export function limitsOf(settings: MultiviewSettings): LayoutLimits {
  return { maxPanes: settings.maxPanes, minPaneWidth: settings.minPaneWidth, minPaneHeight: settings.minPaneHeight, paneGap: settings.paneGap }
}

/** Writes settings the layout picker and a drag change, on the Host; resolves false when the Host refused. */
export type SettingsWriter = (patch: Partial<MultiviewSettings>) => Promise<boolean>

/** What {@link MultiviewStore.undoDefault} restores. */
interface UndoRecord {
  readonly chat: SessionId
  readonly before: ChatMultiview
  readonly settings: Partial<MultiviewSettings>
}

/** How long a run of main-share changes (a divider drag) settles before it is written, in milliseconds. */
const SHARE_WRITE_DELAY_MS = 400

/** The per-chat state of every chat the page has touched. */
export class MultiviewStore implements MultiviewService {
  readonly #chats = new Map<SessionId, SnapshotStore<ChatMultiview>>()
  #area: LayoutArea | undefined
  /** The settings now in force. */
  readonly settings: HostObservable<MultiviewSettings>
  readonly #options: MultiviewStoreOptions
  #pending: Partial<MultiviewSettings> = {}
  #pendingFor: MultiviewSettings | undefined
  #undo: UndoRecord | undefined
  #writer: SettingsWriter | undefined
  #workspaceOf: (chat: SessionId) => string | undefined = () => undefined
  #shareTimer: ReturnType<typeof setTimeout> | undefined
  #revision = 0
  readonly #defaults: SnapshotStore<DefaultsRevision>
  readonly #resolved = new Map<SessionId, { readonly revision: number; readonly value: LayoutDefaults }>()

  /** @param options - the settings, the persistence and the window measure. */
  constructor(options: MultiviewStoreOptions) {
    this.#options = options
    this.settings = options.settings
    this.#defaults = createSnapshotStore<DefaultsRevision>({ revision: 0, canUndo: false })
    options.settings.subscribe(() => { this.#bump() })
  }

  /**
   * Connect the store to the Host and the workspaces: where the layout settings are written, and which workspace a chat is in.
   * @param host - the settings writer (undefined keeps choices for this page only) and the workspace lookup.
   */
  attachHost(host: { readonly write?: SettingsWriter | undefined; readonly workspaceOf?: ((chat: SessionId) => string | undefined) | undefined }): void {
    this.#writer = host.write
    this.#workspaceOf = host.workspaceOf ?? (() => undefined)
    this.#bump()
  }

  /** The settings in force: the Host's, with values written here and not yet echoed back laid over them. */
  #settings(): MultiviewSettings {
    const settings = this.settings.getSnapshot()
    // A value written here holds until the Host's settings change, which carries it or a newer value from the Settings page.
    if (this.#pendingFor !== settings) {
      if (this.#pendingFor !== undefined) this.#pending = {}
      this.#pendingFor = settings
    }
    return Object.keys(this.#pending).length === 0 ? settings : { ...settings, ...this.#pending }
  }

  #bump(): void {
    this.#revision += 1
    this.#defaults.set({ revision: this.#revision, canUndo: this.#undo !== undefined })
  }

  #writeSettings(patch: Partial<MultiviewSettings>): void {
    if (Object.keys(patch).length === 0) return
    this.#settings()
    this.#pending = { ...this.#pending, ...patch }
    this.#bump()
    this.#writer?.(patch).catch((_refused: unknown) => {
      // A refused write leaves the Host's value in force; the value chosen here holds for this page until the settings change.
    })
  }

  /** Changes whenever the defaults of any chat may have changed; read a chat's with {@link MultiviewStore.defaultsOf}. */
  get defaults(): HostObservable<DefaultsRevision> {
    return this.#defaults
  }

  /** The defaults that apply to a chat: its workspace's where it has its own, else the studio's. */
  defaultsOf(chat: SessionId): LayoutDefaults {
    const cached = this.#resolved.get(chat)
    if (cached !== undefined && cached.revision === this.#revision) return cached.value
    const settings = this.#settings()
    const resolved = resolveDefaults(settings, this.#workspaceOf(chat))
    const value: LayoutDefaults = {
      ...resolved,
      mainShare: clampShare(settings.mainShare),
      autoColumns: settings.autoColumns,
      mosaicMotion: settings.mosaicMotion,
      scope: settings.rememberScope,
      saveOn: settings.saveOn,
      canUndo: this.#undo !== undefined,
    }
    const same = cached !== undefined && JSON.stringify(cached.value) === JSON.stringify(value)
    this.#resolved.set(chat, { revision: this.#revision, value: same ? cached.value : value })
    return same ? cached.value : value
  }

  #store(chat: SessionId): SnapshotStore<ChatMultiview> {
    const known = this.#chats.get(chat)
    if (known !== undefined) return known
    const created = createSnapshotStore<ChatMultiview>(this.#options.persistence.load(chat) ?? EMPTY_CHAT_MULTIVIEW)
    this.#chats.set(chat, created)
    return created
  }

  #write(chat: SessionId, next: ChatMultiview): void {
    const settled = next.arrangement === undefined ? this.#settle(chat, next) : next
    this.#store(chat).set(settled)
    this.#options.persistence.save(chat, settled, this.settings.getSnapshot().keepChats)
  }

  /** Give a chat written for the first time its arrangement: a layout saved before choices were remembered stays as it is, otherwise the default. */
  #settle(chat: SessionId, state: ChatMultiview): ChatMultiview {
    if (state.layout !== null) return { ...state, arrangement: 'custom' }
    const defaults = this.defaultsOf(chat)
    if (defaults.layout === 'yours' && defaults.shape !== undefined) return { ...state, arrangement: 'yours', shape: defaults.shape }
    return { ...state, arrangement: defaults.layout === 'yours' ? DEFAULT_PRESET : defaults.layout }
  }

  /** What a chat's layout follows now. */
  arrangementOf(chat: SessionId): ChatArrangement {
    const state = this.#store(chat).getSnapshot()
    return state.arrangement ?? this.#settle(chat, state).arrangement ?? DEFAULT_PRESET
  }

  #limits(): LayoutLimits {
    return limitsOf(this.#settings())
  }

  /** The chat's state as an observable. */
  of(chat: SessionId): HostObservable<ChatMultiview> {
    return this.#store(chat)
  }

  /** Why one more agent cannot be pinned, or undefined. */
  capacityRefusal(chat: SessionId): CapacityRefusal | undefined {
    return capacityRefusal(1 + this.#store(chat).getSnapshot().pins.length, this.#limits(), this.#area ?? this.#options.windowArea())
  }

  /** Pin an agent's chat. */
  pin(chat: SessionId, agent: SessionId): PinResult {
    if (agent === chat) return { ok: false, reason: 'main-chat' }
    const state = this.#store(chat).getSnapshot()
    if (state.pins.includes(agent)) return { ok: false, reason: 'already-pinned' }
    const refusal = this.capacityRefusal(chat)
    if (refusal !== undefined) return { ok: false, reason: refusal }
    const pins = [...state.pins, agent]
    this.#write(chat, { ...state, pins, layout: state.layout === null ? null : reconcileLayout(state.layout, chat, pins) })
    return { ok: true }
  }

  /** Remove a pin and its pane. */
  unpin(chat: SessionId, agent: SessionId): void {
    const state = this.#store(chat).getSnapshot()
    if (!state.pins.includes(agent)) return
    const pins = state.pins.filter(pin => pin !== agent)
    const slots = state.slots?.filter(slot => slot !== agent)
    this.#write(chat, { ...state, pins, slots, layout: state.layout === null ? null : reconcileLayout(state.layout, chat, pins) })
  }

  /** Pin each agent until the limit is reached. */
  pinAll(chat: SessionId, agents: readonly SessionId[]): { readonly pinned: number; readonly refused: number } {
    let pinned = 0
    let refused = 0
    for (const agent of agents) {
      const result = this.pin(chat, agent)
      if (result.ok) pinned += 1
      else if (result.reason === 'max-panes' || result.reason === 'no-room') refused += 1
    }
    return { pinned, refused }
  }

  /** Open Multiview for a chat. */
  open(chat: SessionId): void {
    this.#write(chat, { ...this.#store(chat).getSnapshot(), open: true })
  }

  /** Return to the normal chat. */
  close(chat: SessionId): void {
    this.#write(chat, { ...this.#store(chat).getSnapshot(), open: false })
  }

  /** Replace the layout without changing what the chat follows: a tab shown, or a layout from elsewhere. */
  setLayout(chat: SessionId, layout: LayoutModel): void {
    this.#write(chat, { ...this.#store(chat).getSnapshot(), layout })
  }

  /** Rearrange the panes in a preset. */
  applyPreset(chat: SessionId, preset: LayoutPreset | LegacyLayoutPreset): void {
    this.chooseLayout(chat, preset === 'main-column' ? 'main-stack' : preset)
  }

  /** Go back to the default for new Multiviews. */
  resetLayout(chat: SessionId): void {
    this.#follow(chat, this.defaultsOf(chat).layout)
  }

  /** Make a chat follow a choice, without changing the default. The layout it then shows is kept too, as the chat's last layout. */
  #follow(chat: SessionId, choice: LayoutChoiceId): void {
    const state = this.#store(chat).getSnapshot()
    const shape = choice === 'yours' ? state.shape ?? this.defaultsOf(chat).shape : undefined
    const next: ChatMultiview = shape !== undefined
      ? { ...state, arrangement: 'yours', shape }
      : { ...state, arrangement: choice === 'yours' ? DEFAULT_PRESET : choice, shape: undefined }
    this.#write(chat, { ...next, layout: this.#arrange(chat, next, this.#area) })
  }

  #scopeOf(chat: SessionId): RememberScope {
    return effectiveScope(this.#settings().rememberScope, this.#workspaceOf(chat))
  }

  #planFor(chat: SessionId, values: DefaultValues): SettingsPatch {
    return planDefaults(this.#settings(), this.#settings().rememberScope, this.#workspaceOf(chat), values)
  }

  /** Show a choice in a chat and make it the default for new Multiviews at the person's scope. */
  chooseLayout(chat: SessionId, choice: LayoutChoiceId): void {
    this.#follow(chat, choice)
    if (choice === 'yours' && this.#store(chat).getSnapshot().arrangement !== 'yours') return
    this.#writeSettings(this.#planFor(chat, { defaultLayout: choice }))
  }

  /** Keep the person's own arrangement as the chat's and, at the person's scope, as "Yours". */
  adoptArrangement(chat: SessionId, layout: LayoutModel, reason: AdoptReason): AdoptResult {
    const before = this.#store(chat).getSnapshot()
    if (reason === 'resize' && this.#settings().saveOn === 'move') {
      // With "moving panes only", a resize stays with this chat.
      this.#write(chat, { ...before, arrangement: before.arrangement === 'yours' ? 'yours' : 'custom', layout, shape: before.arrangement === 'yours' ? shapeOf(layout, this.#slots(chat)) : before.shape })
      return { saved: false }
    }
    const shape = shapeOf(layout, this.#slots(chat))
    const patch = this.#planFor(chat, { defaultLayout: 'yours', yours: shape })
    const settings = this.#settings()
    const previous: Partial<MultiviewSettings> = {}
    for (const key of Object.keys(patch) as (keyof SettingsPatch)[]) Object.assign(previous, { [key]: settings[key] })
    this.#undo = { chat, before, settings: previous }
    this.#write(chat, { ...before, arrangement: 'yours', shape, layout })
    this.#writeSettings(patch)
    this.#bump()
    return { saved: true, scope: this.#scopeOf(chat) }
  }

  /** Undo the last adopted arrangement. */
  undoDefault(): void {
    const undo = this.#undo
    if (undo === undefined) return
    this.#undo = undefined
    const now = this.#store(undo.chat).getSnapshot()
    const { before } = undo
    // The pins may have changed since; only the arrangement goes back.
    this.#write(undo.chat, { ...now, arrangement: before.arrangement ?? this.#settle(undo.chat, before).arrangement, shape: before.shape, layout: before.layout, slots: before.slots })
    this.#writeSettings(undo.settings)
    this.#bump()
  }

  /** Clear "Yours" where the chat sees it and make Auto the default. */
  resetToAuto(chat?: SessionId): void {
    this.#undo = undefined
    this.#writeSettings(planResetToAuto(this.#settings(), chat === undefined ? undefined : this.#workspaceOf(chat)))
    if (chat !== undefined) this.#follow(chat, 'auto')
    this.#bump()
  }

  /** Set the main share; a run of changes is written to the Host once it settles. */
  setMainShare(share: number): void {
    const mainShare = Math.round(clampShare(share))
    if (mainShare === this.#settings().mainShare) return
    this.#pending = { ...this.#pending, mainShare }
    this.#bump()
    if (this.#shareTimer !== undefined) clearTimeout(this.#shareTimer)
    this.#shareTimer = setTimeout(() => {
      this.#shareTimer = undefined
      this.#writer?.({ mainShare }).catch((_refused: unknown) => {
        // A refused write leaves the Host's value in force once the settings change.
      })
    }, SHARE_WRITE_DELAY_MS)
  }

  /** Set the Main and stack options at the person's scope; the chat scope writes the studio's. */
  setStackOptions(options: { readonly mainSide?: MainSide; readonly stackStyle?: StackStyle }, chat?: SessionId): void {
    const values: DefaultValues = { ...(options.mainSide === undefined ? {} : { mainSide: options.mainSide }), ...(options.stackStyle === undefined ? {} : { stackStyle: options.stackStyle }) }
    const settings = this.#settings()
    const scope = settings.rememberScope === 'workspace' ? 'workspace' : 'studio'
    this.#writeSettings(planDefaults(settings, scope, chat === undefined ? undefined : this.#workspaceOf(chat), values))
  }

  /** Show the next or previous choice. */
  cycleLayout(chat: SessionId, step: 1 | -1): void {
    const hasYours = this.#store(chat).getSnapshot().shape !== undefined || this.defaultsOf(chat).shape !== undefined
    this.chooseLayout(chat, cycleChoice(this.arrangementOf(chat), step, hasYours))
  }

  /** The chat's panes in slot order. */
  #slots(chat: SessionId): readonly PaneId[] {
    const state = this.#store(chat).getSnapshot()
    return slotOrder(state.slots, chat, state.pins)
  }

  /** Swap a pane with the one in the main place. */
  swapWithMain(chat: SessionId, pane: PaneId): void {
    const slots = [...this.#slots(chat)]
    const at = slots.indexOf(pane)
    if (at <= 0) return
    const first = slots[0]!
    slots[at] = first
    slots[0] = pane
    const state = this.#store(chat).getSnapshot()
    const swap = (id: PaneId): PaneId => (id === pane ? first : id === first ? pane : id)
    // The stored layout swaps the two panes in place, which is what a layout saved before choices were remembered shows.
    const layout = state.layout === null ? null : layoutOf(swapNode(reconcileLayout(state.layout, chat, state.pins).root, swap))
    this.#write(chat, { ...state, slots, layout })
  }

  /** Grow or shrink the main place. */
  resizeMain(chat: SessionId, step: 1 | -1): void {
    const arrangement = this.arrangementOf(chat)
    if (arrangement !== 'custom' && arrangement !== 'yours') {
      this.setMainShare(this.#settings().mainShare + step * MAIN_SHARE_STEP)
      return
    }
    const state = this.#store(chat).getSnapshot()
    const slots = this.#slots(chat)
    const current = this.layoutFor(chat)
    const next = resizePaneShare(current, slots[0]!, step * MAIN_SHARE_STEP)
    if (next === current) return
    this.#write(chat, { ...state, layout: next, ...(arrangement === 'yours' ? { shape: shapeOf(next, slots) } : {}) })
  }

  /**
   * The layout a chat shows: its arrangement for its panes, the area and the activity, panes under the least size as tabs.
   * @param chat - the chat.
   * @param area - the rectangle the layout fills, if measured.
   * @param activity - each pane's activity, for the mosaic.
   * @returns the arranged layout.
   */
  layoutFor(chat: SessionId, area?: LayoutArea, activity?: ReadonlyMap<PaneId, PaneActivity>): LayoutModel {
    return this.#arrange(chat, this.#store(chat).getSnapshot(), area, activity)
  }

  #arrange(chat: SessionId, state: ChatMultiview, area?: LayoutArea, activity?: ReadonlyMap<PaneId, PaneActivity>): LayoutModel {
    const defaults = this.defaultsOf(chat)
    const limits = this.#limits()
    return arrangeLayout({
      arrangement: state.arrangement ?? this.#settle(chat, state).arrangement ?? DEFAULT_PRESET,
      slots: slotOrder(state.slots, chat, state.pins),
      stored: state.layout ?? undefined,
      shape: state.shape,
      options: {
        mainSide: defaults.mainSide, stackStyle: defaults.stackStyle, mainShare: defaults.mainShare, autoColumns: defaults.autoColumns,
        area, limits, activity,
      },
      limits,
    })
  }

  /** Report the area the layout fills. */
  reportArea(area: LayoutArea | undefined): void {
    this.#area = area
  }
}

function swapNode(node: LayoutNode, swap: (pane: PaneId) => PaneId): LayoutNode {
  return node.kind === 'leaf'
    ? { ...node, panes: node.panes.map(swap), active: swap(node.active) }
    : { ...node, children: node.children.map(child => swapNode(child, swap)) }
}
