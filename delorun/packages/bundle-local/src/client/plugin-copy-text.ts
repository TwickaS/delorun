/** Delorun's wording for the Add plugin dialog lines, as plain data that host and client programs both type. */

/** Upstream's plugin manager dictionary namespace (`NS` of `@deepseek-ai/dsh-client-ui-plugin-manager`), restated because a client bundle may not import another plugin's values; a spec compares the two. */
export const PLUGIN_MANAGER_NS = 'pluginManager'

/** Delorun's text for each overridden key, by language. */
export const PLUGIN_COPY = {
  en: {
    installGuideSafety: 'Install only plugins you trust: they run with your permissions and can damage Delorun or leak your data.',
    installUpgradeNotice: 'On-demand official plugins offer Update when their version differs from Delorun\'s. To update other plugins, uninstall and reinstall them.',
  },
  zh: {
    installGuideSafety: '请确认插件来源可信。插件在本机以你的权限运行，来源不明的插件可能损坏 Delorun，或读取和泄露你的数据。',
    installUpgradeNotice: '按需安装的官方插件会在版本与 Delorun 不同时提供“更新”。其他插件请先卸载再安装新版。',
  },
} as const
