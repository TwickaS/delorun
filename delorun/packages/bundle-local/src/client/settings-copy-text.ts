/** Delorun's English wording for upstream Settings pages, as plain data that host and client programs both type. */

/** One upstream dictionary whose English texts Delorun replaces. */
export interface SettingsCopyLayer {
  /** Namespace the upstream plugin registers its dictionary under, restated because a client bundle may not import another plugin's values. */
  readonly ns: string
  /** Replacement texts by key; a key upstream does not define changes nothing. */
  readonly en: Readonly<Record<string, string>>
}

/** Texts that name Delorun, say "chat" for what upstream calls a session, and drop developer wording, by upstream namespace. */
export const SETTINGS_COPY: readonly SettingsCopyLayer[] = [
  {
    ns: 'settings.agentPreset',
    en: {
      sectionIntro: 'Choose the agent’s tools and how it works. Standard mode suits everyday tasks. In Creator mode the agent writes plugins and modes for Delorun.',
      presetCordisDescription: 'Creator mode: the agent writes plugins and modes for Delorun. Customise Delorun through conversation, adding features or screens, or combining tools and prompts into your own mode.',
      createPluginDescription: 'Enter Creator mode and make your own Delorun plugin',
    },
  },
  {
    ns: 'settings.plugins',
    en: {
      intro: 'Inspect the plugins this installation includes.',
      empty: 'This installation has no plugin views.',
    },
  },
  {
    ns: 'chat',
    en: {
      'settings.performance.title': 'Performance and usage',
    },
  },
  {
    ns: 'conversation',
    en: {
      'settings.enter.title': 'Send behaviour while busy',
      'settings.enter.description': 'What Enter and the Send button do while the agent is running; Cmd/Ctrl+Enter uses the other behaviour',
    },
  },
  {
    ns: 'settings.permission',
    en: {
      'title': 'Default permission for new chats',
      'description': 'Choose the permission new chats start with',
      'preset.readOnly': 'Read only',
      'preset.workspaceWrite': 'Workspace write',
      'confirm.description': 'Full access lets new chats reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
    },
  },
  {
    ns: 'permission.access',
    en: {
      'preset.readOnly': 'Read only',
      'preset.workspaceWrite': 'Workspace write',
    },
  },
]
