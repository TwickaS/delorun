/**
 * Delo's Settings layout: topic groups, the pages in each, and the cards that
 * gather upstream's General rows. Section and row ids are the registrations'
 * own; a page whose sections and rows are all absent does not show, and anything
 * this layout does not place appears under the shell's trailing group.
 * @module @delo/plugin-settings-layout/client/layout
 */
import {
  IconAgentPresetOutlineMedium, IconCordisPluginOutlineMedium, IconDataOutlineMedium, IconDatabaseOutlineMedium,
  IconGlobeOutlineMedium, IconInfoOutlineMedium, IconNewChatOutlineMedium, IconPanelLeftOutlineMedium,
  IconShieldOutlineMedium, IconSparkleMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsLayout, SettingsLayoutItem } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { SettingsLayoutLocaleKey } from './locales.ts'

/** Ids of the `settings.section` registrations the layout places. */
export const SECTIONS = {
  account: 'account',
  appearance: 'delo-appearance',
  conversation: 'delo-conversation',
  sidebar: 'delo-sidebar',
  chatStates: 'delo-chat-states',
  privacy: 'delo-privacy',
  permissions: 'delo-permissions',
  models: 'models',
  modes: 'agent-presets',
  toolSettings: 'delo-tool-settings',
  inventory: 'plugins',
} as const

/** Ids of the `settings.general.item` rows the layout places, by the name its copy uses. */
export const ITEMS = {
  fontSize: 'font-size',
  composerEnter: 'composer-enter',
  shortcuts: 'shortcuts',
  linkOpening: 'link-opening',
  performanceUsage: 'performance-usage',
  developerTools: 'developer-tools',
  language: 'language',
  permission: 'permission',
  currentVersion: 'current-version',
  onboarding: 'delo-onboarding',
} as const

/**
 * Upstream's General rows the layout hides: its Light, Dark and System row,
 * which Delo's Appearance section replaces, its Work details row, which
 * Delo's Conversation section replaces, and its session-log upload switch,
 * which Delo's Privacy section replaces with the same switch behind its
 * consent dialog.
 */
export const HIDDEN_ITEMS = ['appearance', 'transcript-view', 'session-log-deepseek'] as const

/** A row name the layout's copy defines. */
type ItemName = keyof typeof ITEMS

/**
 * Build the layout with its copy bound to the locale.
 * @param t - the layout's translator.
 * @returns the layout to register.
 */
export function deloSettingsLayout(t: (key: SettingsLayoutLocaleKey) => string): SettingsLayout {
  const text = (key: SettingsLayoutLocaleKey) => () => t(key)
  const item = (name: ItemName): SettingsLayoutItem => ({
    id: ITEMS[name], label: text(`item.${name}`), keywords: text(`item.${name}.keywords`),
  })
  return {
    groups: [
      {
        id: 'you',
        label: text('group.you'),
        pages: [
          {
            id: 'appearance', label: text('page.appearance'), icon: IconSparkleMedium, keywords: text('page.appearance.keywords'),
            blocks: [
              { kind: 'section', id: SECTIONS.appearance },
              { kind: 'items', id: 'text', heading: text('card.text'), items: [item('fontSize')] },
              { kind: 'section', id: SECTIONS.conversation },
            ],
          },
          {
            id: 'sidebar', label: text('page.sidebar'), icon: IconPanelLeftOutlineMedium, keywords: text('page.sidebar.keywords'),
            blocks: [{ kind: 'section', id: SECTIONS.sidebar }, { kind: 'section', id: SECTIONS.chatStates }],
          },
          {
            id: 'chat', label: text('page.chat'), icon: IconNewChatOutlineMedium, keywords: text('page.chat.keywords'),
            blocks: [
              { kind: 'items', id: 'composer', heading: text('card.composer'), items: [item('composerEnter'), item('shortcuts')] },
              { kind: 'items', id: 'links', heading: text('card.links'), items: [item('linkOpening'), item('performanceUsage')] },
              { kind: 'items', id: 'view', heading: text('card.view'), items: [item('developerTools')] },
            ],
          },
          {
            id: 'language', label: text('page.language'), icon: IconGlobeOutlineMedium,
            blocks: [{ kind: 'items', id: 'language-card', items: [item('language')] }],
          },
          {
            id: 'privacy', label: text('page.privacy'), icon: IconDatabaseOutlineMedium, keywords: text('page.privacy.keywords'),
            blocks: [{ kind: 'section', id: SECTIONS.privacy }],
          },
          {
            id: 'account', label: text('page.account'), icon: IconUserOutlineMedium, keywords: text('page.account.keywords'),
            blocks: [{ kind: 'section', id: SECTIONS.account }],
          },
        ],
      },
      {
        id: 'agent',
        label: text('group.agent'),
        pages: [
          { id: 'agent-models', label: text('page.models'), icon: IconDataOutlineMedium, blocks: [{ kind: 'section', id: SECTIONS.models }] },
          {
            id: 'modes', label: text('page.modes'), icon: IconAgentPresetOutlineMedium, keywords: text('page.modes.keywords'),
            blocks: [{ kind: 'section', id: SECTIONS.modes }],
          },
          {
            id: 'permissions', label: text('page.permissions'), icon: IconShieldOutlineMedium, keywords: text('page.permissions.keywords'),
            blocks: [
              { kind: 'items', id: 'new-chats', heading: text('card.newChats'), items: [item('permission')] },
              { kind: 'section', id: SECTIONS.permissions },
            ],
          },
          {
            id: 'tools', label: text('page.tools'), icon: IconCordisPluginOutlineMedium, keywords: text('page.tools.keywords'),
            blocks: [{ kind: 'section', id: SECTIONS.toolSettings }, { kind: 'section', id: SECTIONS.inventory }],
          },
        ],
      },
      {
        id: 'delo',
        label: text('group.delo'),
        pages: [
          {
            id: 'about', label: text('page.about'), icon: IconInfoOutlineMedium, keywords: text('page.about.keywords'),
            blocks: [
              { kind: 'items', id: 'version', heading: text('card.version'), items: [item('currentVersion')] },
              { kind: 'items', id: 'onboarding', heading: text('card.onboarding'), items: [item('onboarding')] },
            ],
          },
        ],
      },
    ],
    hiddenItems: HIDDEN_ITEMS,
    other: { label: text('group.other'), itemsLabel: text('page.general') },
    search: { placeholder: text('search.placeholder'), empty: text('search.empty') },
  }
}
