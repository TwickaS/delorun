/**
 * Browser half of Delo's Settings layout: registers the layout with
 * upstream's Settings shell, sizes the panel and adds the Tool settings
 * section, which opens each tool's page in Plugins. It loads only while the
 * Delo look is on (the `deloStudio` service exists) and upstream's general
 * Settings provides `settingsLayout`; disposing it restores upstream's flat
 * list and its panel size.
 * @module @delo/plugin-settings-layout/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.settingsLayout merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'settings.section' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the 'plugins.item' SlotMap entry and the ctx.pluginNavigation merge.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { deloSettingsLayout, SECTIONS } from './layout.ts'
import { en, zh, type SettingsLayoutLocaleKey } from './locales.ts'
import { ToolSettingsSection, type ToolSettingsEntry, type ToolSettingsInjected } from './ToolSettingsSection.tsx'

export { deloSettingsLayout, HIDDEN_ITEMS, ITEMS, SECTIONS } from './layout.ts'
export type { SettingsLayoutLocaleKey } from './locales.ts'
export type { ToolSettingsEntry, ToolSettingsInjected, ToolSettingsSectionProps } from './ToolSettingsSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Delo's Settings layout copy. */
    'settings.deloLayout': SettingsLayoutLocaleKey
  }
}

/** Package id: the tag of the panel-size style element. */
export const PLUGIN_ID = '@delo/plugin-settings-layout'

/**
 * Services every registration needs. `deloStudio`, which `@delo/plugin-theme` provides only while the Delo look is on,
 * and `settingsLayout`, which upstream's general Settings provides, are injected inside {@link apply} instead, so the
 * entry stays active under the stock look and where a plugin turns upstream's general Settings off, and registers
 * nothing there.
 */
export const inject = ['locale', 'slots']

const NS = 'settings.deloLayout'

/**
 * The panel's size: about 1080 wide and 88% of the window tall, with a navigation
 * 220 wide at most and no more than two fifths of a narrow window. Rows fill the
 * content column, so each control sits at its right edge. Upstream's own narrow
 * rule takes the panel to the full window below 768px.
 */
export const PANEL_STYLE = ':root{--dsh-settings-panel-width:1080px;--dsh-settings-panel-height:88vh;--dsh-settings-nav-width:min(220px,40vw)}'

/**
 * While the Delo look provides `deloStudio` and upstream's Settings shell provides `settingsLayout`, register the
 * layout, the panel size and the Tool settings section.
 * @param ctx - the client context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['deloStudio', 'settingsLayout'], applyStudio)
}

/**
 * Everything the plugin registers while both services exist; disposed with either.
 * @param ctx - the browser plugin context, holding `deloStudio` and `settingsLayout`.
 */
export function applyStudio(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delo-settings-layout: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.settingsLayout.register(deloSettingsLayout(t)), 'delo-settings-layout: layout')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.textContent = PANEL_STYLE
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'delo-settings-layout: panel size')
  const tools = toolSettings(ctx)
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: SECTIONS.toolSettings, order: 30, label: () => t('tools.settings'), locale: NS, inject: () => tools,
  }, ToolSettingsSection)), 'delo-settings-layout: Tool settings')
}

/**
 * The Tool settings section's services: the `plugins.item` ledger, read while
 * the Plugins page declares it, and the Plugins panel's navigation, while it
 * exists.
 * @param ctx - the client context.
 * @returns the section's injected services.
 */
export function toolSettings(ctx: Context): ToolSettingsInjected {
  let key = ''
  let entries: readonly ToolSettingsEntry[] = []
  const read = (): readonly ToolSettingsEntry[] => {
    // Without the navigation a row could not open its page, so the list stays empty.
    const next = ctx.get('pluginNavigation') === undefined
      ? []
      : ctx.slots.entries('plugins.item').flatMap(entry => (entry.options.id === undefined ? [] : [{ id: entry.options.id, label: resolveSlotLabel(entry.options.label) ?? entry.options.id }]))
    const nextKey = JSON.stringify(next)
    if (nextKey !== key) {
      key = nextKey
      entries = next
    }
    return entries
  }
  return {
    tools: {
      getSnapshot: read,
      subscribe: (listener) => {
        const offs = [ctx.slots.subscribe('plugins.item', listener), ctx.locale.subscribe(listener)]
        return () => { for (const off of offs) off() }
      },
    },
    open: (id) => { ctx.get('pluginNavigation')?.openItem(id) },
  }
}
