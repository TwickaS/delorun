/**
 * Registers Multiview's layer in the main Conversation's content and the slots it renders its panes through (the pane header, the
 * pane body, and the phone pager's dots in each chat's reply-box dock), the layout keys, the layout copy, and the Multiview section
 * of Settings.
 * @module @delorun/plugin-multiview/panel/register
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the conversation slots the panel and the dots use.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.uiWorkspace and ctx.workspaces merges.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the ctx.shortcuts merge.
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
// Type-only: the ctx.configForms merge.
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { IconPanelLeftOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { MULTIVIEW_LAYER_ID } from '../client/contract.ts'
import { MULTIVIEW_ROW_ID, type MultiviewSettings } from '../config.ts'
import type { MultiviewStore } from '../entry/state.ts'
import { en as layoutsEn, LAYOUTS_NS, zh as layoutsZh } from '../layout/locales.ts'
import { createLayerRegistry, registerLayoutKeys } from './keys.ts'
import { MULTIVIEW_SECTION, MultiviewSettingsSection, type SettingsSectionInjected } from './settings/Section.tsx'
import { en, PANES_NS, zh, type PanesLocaleKey } from '../panes/locales.ts'
import { PaneBody } from '../panes/PaneBody.tsx'
import { PaneHeader } from '../panes/PaneHeader.tsx'
import { createPhoneDots, DotsDock, type DotsInjected } from './dots.tsx'
import { MultiviewLayer, type LayerInjected } from './Layer.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Multiview panes' copy. */
    'delorunMultiviewPanes': PanesLocaleKey
  }
}

/** What the layer registration needs from its surroundings besides the context. */
export interface LayerOptions {
  /** The store behind the service the entry points provide. */
  readonly multiview: MultiviewStore
  /** Formats an epoch-millisecond time of day for the limits line. */
  readonly clock: (epochMs: number) => string
}

/**
 * Register the layer and its slots.
 * @param ctx - the browser context; needs `slots`, `locale`, `sessions` and `uiWorkspace`.
 * @param options - the service and the clock.
 */
export function registerLayer(ctx: Context, options: LayerOptions): void {
  ctx.effect(() => ctx.locale.register(PANES_NS, { en, zh }), 'delorun-multiview: pane dictionaries')
  ctx.effect(() => ctx.locale.register(LAYOUTS_NS, { en: layoutsEn, zh: layoutsZh }), 'delorun-multiview: layout dictionaries')
  const layoutsT = ctx.locale.bind(LAYOUTS_NS)
  const { multiview } = options
  // The layout defaults for the studio and each workspace are Host settings, so every device of the studio sees them.
  const form = ctx.configForms.get<Partial<MultiviewSettings>>(MULTIVIEW_ROW_ID)
  multiview.attachHost({
    write: patch => form.mutate(Object.entries(patch).map(([field, value]): SetOp => ({ op: 'set', path: [field], value: jsonOf(value) }))),
    workspaceOf: chat => ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(chat))?.workspaceId,
  })
  ctx.effect(() => () => { multiview.attachHost({}) }, 'delorun-multiview: host settings')
  const layers = createLayerRegistry()
  registerLayoutKeys(ctx, multiview, layers, layoutsT)
  const dots = createPhoneDots()
  const layer: LayerInjected = {
    multiview,
    sessions: ctx.sessions,
    clock: options.clock,
    dots,
    layoutsT,
    layers,
    // The chat's Multiview stays open in its own state, so coming back to it shows the panes again.
    openFull: (id) => { ctx.uiWorkspace.openSession(ctx.sessions.subagentAddress(id) ?? id) },
  }
  const dotsInjected: DotsInjected = { dots }
  ctx.effect(() => ctx.slots.inject('conversation.main.body', function* () {
    yield ctx.slots.register({
      name: 'conversation.main.body',
      id: MULTIVIEW_LAYER_ID,
      locale: PANES_NS,
      inject: () => layer,
      children: {
        'multiview.pane.header': { kind: 'single', scope: 'session' },
        'multiview.pane.body': { kind: 'single', scope: 'session' },
      },
    }, MultiviewLayer)
    yield ctx.slots.register({ name: 'multiview.pane.header', locale: PANES_NS }, PaneHeader)
    yield ctx.slots.register({ name: 'multiview.pane.body' }, PaneBody)
  }), 'delorun-multiview: layer')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'multiview-dots', order: 100, locale: PANES_NS, inject: () => dotsInjected,
  }, DotsDock)), 'delorun-multiview: phone dots')
  const section: SettingsSectionInjected = { multiview, form, t: layoutsT, mainChat: () => mainChatId(ctx) }
  ctx.effect(() => ctx.configForms.whileServed([MULTIVIEW_ROW_ID], () => {
    const disposers = [
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: MULTIVIEW_SECTION.id, order: MULTIVIEW_SECTION.order, label: () => layoutsT('section.nav'), locale: LAYOUTS_NS, inject: () => section,
      }, MultiviewSettingsSection)),
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: MULTIVIEW_SECTION.id }, IconPanelLeftOutlineMedium)),
    ]
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }), 'delorun-multiview: settings section')
}

/** One settings write; its value is plain JSON. */
type SetOp = Extract<Parameters<ConfigForm<object>['mutate']>[0][number], { op: 'set' }>

/** A settings value as the plain JSON a write carries: every Multiview setting is JSON already, so this copies it. */
function jsonOf(value: unknown): SetOp['value'] {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** The chat in the main view, whose Multiview the section's picker previews, if one is open. */
function mainChatId(ctx: Context): SessionId | undefined {
  const list = ctx.sessions.list.getSnapshot()
  return list.ids.find(id => (list.byId[id]?.retainedBy.mainView ?? 0) > 0)
}
