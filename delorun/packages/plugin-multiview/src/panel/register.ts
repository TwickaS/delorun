/**
 * Registers the `multiview` main panel and the slots it renders its panes through: the pane header, the pane body, and the phone
 * pager's dots in each chat's reply-box dock.
 * @module @delorun/plugin-multiview/panel/register
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the conversation slots the panel and the dots use.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.uiWorkspace merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MultiviewService } from '../client/contract.ts'
import { MULTIVIEW_PANEL_ID } from '../client/contract.ts'
import { en, PANES_NS, zh, type PanesLocaleKey } from '../panes/locales.ts'
import { PaneBody } from '../panes/PaneBody.tsx'
import { PaneHeader } from '../panes/PaneHeader.tsx'
import { createPhoneDots, DotsDock, type DotsInjected } from './dots.tsx'
import { MultiviewPanel, type PanelInjected } from './Panel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Multiview panes' copy. */
    'delorunMultiviewPanes': PanesLocaleKey
  }
}

/** What the panel registration needs from its surroundings besides the context. */
export interface PanelOptions {
  /** The service the entry points provide. */
  readonly multiview: MultiviewService
  /** Formats an epoch-millisecond time of day for the limits line. */
  readonly clock: (epochMs: number) => string
}

/**
 * Register the panel and its slots.
 * @param ctx - the browser context; needs `slots`, `locale`, `sessions` and `uiWorkspace`.
 * @param options - the service and the clock.
 */
export function registerPanel(ctx: Context, options: PanelOptions): void {
  ctx.effect(() => ctx.locale.register(PANES_NS, { en, zh }), 'delorun-multiview: pane dictionaries')
  const dots = createPhoneDots()
  const panel: PanelInjected = {
    multiview: options.multiview,
    sessions: ctx.sessions,
    clock: options.clock,
    dots,
    openFull: (id) => { ctx.uiWorkspace.openSession(ctx.sessions.subagentAddress(id) ?? id) },
  }
  const dotsInjected: DotsInjected = { dots }
  ctx.effect(() => ctx.slots.inject('main', function* () {
    yield ctx.slots.register({
      name: 'main',
      key: MULTIVIEW_PANEL_ID,
      locale: PANES_NS,
      inject: () => panel,
      children: {
        'conversation.header': { kind: 'single', scope: 'session-maybe' },
        'multiview.pane.header': { kind: 'single', scope: 'session' },
        'multiview.pane.body': { kind: 'single', scope: 'session' },
      },
    }, MultiviewPanel)
    yield ctx.slots.register({ name: 'multiview.pane.header', locale: PANES_NS }, PaneHeader)
    yield ctx.slots.register({ name: 'multiview.pane.body' }, PaneBody)
  }), 'delorun-multiview: panel')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'multiview-dots', order: 100, locale: PANES_NS, inject: () => dotsInjected,
  }, DotsDock)), 'delorun-multiview: phone dots')
}
