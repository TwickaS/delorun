/**
 * Delorun's Settings layout: topic groups, the pages in each, and the cards that
 * gather General rows under a heading. Section and row ids are the
 * registrations' own; a page whose sections and rows are all absent does not
 * show. After the layout's own groups come the plugin groups, one per
 * third-party plugin that names its sections, and anything neither places
 * appears under the shell's trailing group.
 * @module @delorun/plugin-settings-layout/client/layout
 */
import {
  IconAgentPresetOutlineMedium, IconChecklistOutlineMedium, IconClockOutlineMedium, IconCordisPluginOutlineMedium, IconDataOutlineMedium, IconFlatListOutlineMedium,
  IconEyeOutlineMedium, IconGlobeOutlineMedium, IconInfoOutlineMedium, IconNewChatOutlineMedium, IconPanelLeftOutlineMedium,
  IconSearchOutlineMedium, IconSettingsOutlineMedium, IconShieldOutlineMedium, IconSlidersTwoOutlineMedium, IconSparkleMedium, IconUserOutlineMedium,
  IconUsersOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsLayout, SettingsLayoutGroup, SettingsLayoutItem, SettingsLayoutText } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { SettingsLayoutLocaleKey } from './locales.ts'

/** Ids of the `settings.section` registrations the layout places. */
export const SECTIONS = {
  appearance: 'delorun-appearance',
  sidebar: 'delorun-sidebar',
  chatStates: 'delorun-chat-states',
  conversation: 'delorun-conversation',
  account: 'account',
  models: 'models',
  modes: 'agent-presets',
  toolSettings: 'delorun-tool-settings',
  inventory: 'plugins',
  createPlugin: 'delorun-create-plugin',
  pluginInstalls: 'delorun-plugin-installs',
  browser: 'delorun-browser',
  permissions: 'delorun-permissions',
  externalAgents: 'delorun-external-agents',
  network: 'delorun-network',
  privacy: 'delorun-privacy',
  devices: 'delorun-devices',
  pinMode: 'delorun-pin-mode',
  trash: 'delorun-trash',
  setupVersions: 'delorun-setup-versions',
  changes: 'delorun-changes',
  about: 'delorun-about',
  setupCommands: 'delorun-setup-commands',
} as const

/** Ids of the `settings.general.item` rows the layout places, by the name its copy uses. */
export const ITEMS = {
  language: 'language',
  look: 'delorun-look',
  updateCheck: 'delorun-update-check',
  versions: 'delorun-versions',
  shortcuts: 'shortcuts',
  onboarding: 'delorun-onboarding',
  developerTools: 'developer-tools',
  typeface: 'delorun-typeface',
  fontSize: 'font-size',
  density: 'delorun-density',
  composerEnter: 'composer-enter',
  effortLabels: 'delorun-effort-labels',
  linkOpening: 'link-opening',
  performanceUsage: 'performance-usage',
  permission: 'permission',
} as const

/**
 * Upstream's General rows the layout hides: its Light, Dark and System row,
 * which Delorun's Appearance section replaces, its Work details row, which
 * Delorun's Conversation section replaces, and its session-log upload switch,
 * which Delorun's Privacy section replaces with the same switch behind its
 * consent dialog, and its version row, which names Delorun's version alone
 * where the Updates card has `delorun-versions` and Settings → About shows both.
 */
export const HIDDEN_ITEMS = ['appearance', 'transcript-view', 'session-log-deepseek', 'current-version'] as const

/** A row name the layout's copy defines. */
type ItemName = keyof typeof ITEMS

/**
 * One third-party plugin's own group: its sections, each on a page of its own
 * titled with the section's registered label, under the plugin's display title.
 */
export interface SettingsPluginGroup {
  /** The plugin's package name; one group per plugin. */
  readonly id: string
  /** The plugin's display title, which heads the group. */
  readonly label: SettingsLayoutText
  /** The plugin's `settings.section` ids, in page order. */
  readonly sections: readonly string[]
}

/**
 * Build the layout with its copy bound to the locale.
 * @param t - the layout's translator.
 * @param plugins - the third-party plugin groups, in registration order; they follow the layout's own groups.
 * @param sectionLabel - the registered label of a section, which titles its page in a plugin group.
 * @returns the layout to register.
 */
export function delorunSettingsLayout(
  t: (key: SettingsLayoutLocaleKey) => string,
  plugins: readonly SettingsPluginGroup[] = [],
  sectionLabel: (id: string) => string = id => id,
): SettingsLayout {
  const text = (key: SettingsLayoutLocaleKey) => () => t(key)
  const item = (name: ItemName): SettingsLayoutItem => ({
    id: ITEMS[name], label: text(`item.${name}`), keywords: text(`item.${name}.keywords`),
  })
  const card = (id: string, heading: SettingsLayoutLocaleKey | undefined, names: readonly ItemName[]) =>
    ({ kind: 'items', id, ...heading === undefined ? {} : { heading: text(heading) }, items: names.map(item) }) as const
  const section = (id: string) => ({ kind: 'section', id }) as const
  const placed = new Set<string>(Object.values(SECTIONS))
  const pluginGroups = plugins.map((plugin): SettingsLayoutGroup => ({
    id: `plugin:${plugin.id}`,
    label: plugin.label,
    pages: plugin.sections.filter(id => !placed.has(id)).map(id => ({ id, label: () => sectionLabel(id), blocks: [section(id)] })),
  }))
  return {
    groups: [
      {
        id: 'general',
        label: text('group.general'),
        pages: [
          {
            id: 'studio-general', label: text('page.general'), icon: IconSettingsOutlineMedium, keywords: text('page.general.keywords'),
            blocks: [
              card('language', undefined, ['language']),
              card('look', 'card.look', ['look']),
              card('updates', 'card.updates', ['updateCheck', 'versions']),
              card('shortcuts', undefined, ['shortcuts']),
              card('getting-started', 'card.gettingStarted', ['onboarding']),
              section(SECTIONS.setupCommands),
              card('advanced', 'card.advanced', ['developerTools']),
            ],
          },
          {
            id: 'appearance', label: text('page.appearance'), icon: IconSparkleMedium, keywords: text('page.appearance.keywords'),
            blocks: [section(SECTIONS.appearance), card('text', 'card.text', ['typeface', 'fontSize', 'density'])],
          },
          {
            id: 'sidebar', label: text('page.sidebar'), icon: IconPanelLeftOutlineMedium, keywords: text('page.sidebar.keywords'),
            blocks: [section(SECTIONS.sidebar), section(SECTIONS.chatStates)],
          },
          {
            id: 'conversation', label: text('page.conversation'), icon: IconFlatListOutlineMedium, keywords: text('page.conversation.keywords'),
            blocks: [section(SECTIONS.conversation)],
          },
          {
            id: 'chat', label: text('page.chat'), icon: IconNewChatOutlineMedium, keywords: text('page.chat.keywords'),
            blocks: [card('composer', 'card.composer', ['composerEnter', 'effortLabels']), card('links', 'card.links', ['linkOpening', 'performanceUsage'])],
          },
          {
            id: 'account', label: text('page.account'), icon: IconUserOutlineMedium, keywords: text('page.account.keywords'),
            blocks: [section(SECTIONS.account)],
          },
        ],
      },
      {
        id: 'agent',
        label: text('group.agent'),
        pages: [
          { id: 'agent-models', label: text('page.models'), icon: IconDataOutlineMedium, keywords: text('page.models.keywords'), blocks: [section(SECTIONS.models)] },
          {
            id: 'modes', label: text('page.modes'), icon: IconAgentPresetOutlineMedium, keywords: text('page.modes.keywords'),
            blocks: [section(SECTIONS.modes)],
          },
          {
            id: 'tools', label: text('page.tools'), icon: IconSlidersTwoOutlineMedium, keywords: text('page.tools.keywords'),
            blocks: [section(SECTIONS.toolSettings)],
          },
          {
            id: 'plugins', label: text('page.plugins'), icon: IconCordisPluginOutlineMedium, keywords: text('page.plugins.keywords'),
            blocks: [section(SECTIONS.inventory), section(SECTIONS.pluginInstalls), section(SECTIONS.createPlugin)],
          },
          { id: 'browser', label: text('page.browser'), icon: IconSearchOutlineMedium, keywords: text('page.browser.keywords'), blocks: [section(SECTIONS.browser)] },
        ],
      },
      {
        id: 'safety',
        label: text('group.safety'),
        pages: [
          {
            id: 'permissions', label: text('page.permissions'), icon: IconShieldOutlineMedium, keywords: text('page.permissions.keywords'),
            blocks: [card('new-chats', 'card.newChats', ['permission']), section(SECTIONS.permissions)],
          },
          {
            id: 'external-agents', label: text('page.externalAgents'), icon: IconUsersOutlineMedium, keywords: text('page.externalAgents.keywords'),
            blocks: [section(SECTIONS.externalAgents)],
          },
          {
            id: 'network', label: text('page.network'), icon: IconGlobeOutlineMedium, keywords: text('page.network.keywords'),
            blocks: [section(SECTIONS.network)],
          },
          {
            id: 'privacy', label: text('page.privacy'), icon: IconEyeOutlineMedium, keywords: text('page.privacy.keywords'),
            blocks: [section(SECTIONS.privacy)],
          },
          // No icon here: the PIN mode section registers its own lock under its id.
          { id: SECTIONS.pinMode, label: text('page.pinMode'), keywords: text('page.pinMode.keywords'), blocks: [section(SECTIONS.pinMode)] },
        ],
      },
      {
        id: 'devices',
        label: text('group.devices'),
        pages: [
          // No icon here: the Devices section registers its own under its id.
          { id: SECTIONS.devices, label: text('page.devices'), keywords: text('page.devices.keywords'), blocks: [section(SECTIONS.devices)] },
        ],
      },
      {
        id: 'data',
        label: text('group.data'),
        pages: [
          // No icon here: the Trash section registers its own under its id.
          { id: SECTIONS.trash, label: text('page.trash'), keywords: text('page.trash.keywords'), blocks: [section(SECTIONS.trash)] },
          {
            id: 'setup-versions', label: text('page.setupVersions'), icon: IconClockOutlineMedium, keywords: text('page.setupVersions.keywords'),
            blocks: [section(SECTIONS.setupVersions)],
          },
          {
            id: 'changes', label: text('page.changes'), icon: IconChecklistOutlineMedium, keywords: text('page.changes.keywords'),
            blocks: [section(SECTIONS.changes)],
          },
          {
            id: 'about', label: text('page.about'), icon: IconInfoOutlineMedium, keywords: text('page.about.keywords'),
            blocks: [section(SECTIONS.about)],
          },
        ],
      },
      ...pluginGroups,
    ],
    hiddenItems: HIDDEN_ITEMS,
    other: { label: text('group.other'), itemsLabel: text('page.otherItems') },
    search: { placeholder: text('search.placeholder'), empty: text('search.empty') },
  }
}
